import { Worker, Queue, type Processor } from "bullmq";
import { glob } from "glob";
import logger from "@/services/logger.service";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";
import { serveStatic } from "hono/bun";
import type { JobItem } from "@/types/job";
import { connection } from "@/services/redis.service";
import {
  dataSessionKey,
  eventJobId,
  getSessionQueueRouter,
  isSessionTask,
  sessionQueueKey,
} from "@/services/sessionQueue.service";

// Bull Board 配置
export const serverAdapter = new HonoAdapter(serveStatic);

// 优雅关闭的最长等待时间，超过后强制退出，避免卡住后被 Docker 直接 SIGKILL
const SHUTDOWN_TIMEOUT = 10_000;

// Old releases wrote directly to per-task queues. Those queues now only
// forward into the lanes; they must never run a second copy of the processor.
async function legacySessionKey(data: any): Promise<string> {
  const directKey = dataSessionKey(data);
  if (directKey) return directKey;

  const callback = typeof data === "string" ? data.split("_") : [];
  const groupId = data?.chat?.id ?? Number(callback[1]);
  const topicId = data?.message_thread_id ?? Number(callback[2]);
  if (!Number.isFinite(groupId) || !Number.isFinite(topicId)) {
    throw new Error("Cannot route legacy task without a conversation");
  }
  const { getSessionByTopic } = await import("@/services/db.service");
  const session = await getSessionByTopic(groupId, topicId);
  return session
    ? sessionQueueKey(session.website_id, session.session_id)
    // A deleted conversation has no live lane; its existing handler returns
    // "not found". Keeping a stable fallback still serializes stale callbacks.
    : JSON.stringify(["deleted-telegram-topic", groupId, topicId]);
}

function observeQueue(queue: Queue) {
  queue.on("error", (err) => {
    logger.error("queue error", {
      queue: queue.name,
      code: (err as any)?.code,
      message: err?.message,
    });
  });
}

function observeWorker(worker: Worker) {
  worker.on("failed", (job, err) => {
    logger.error("job failed", {
      queue: worker.name,
      jobId: job?.id,
      name: job?.name,
      attemptsMade: job?.attemptsMade,
      code: (err as any)?.code,
      message: err?.message,
      stack: err?.stack,
    });
  });
  worker.on("error", (err) => {
    logger.error("worker error", {
      queue: worker.name,
      code: (err as any)?.code,
      message: err?.message,
      stack: err?.stack,
    });
  });
  worker.on("stalled", (jobId) => {
    logger.warn("job stalled", { queue: worker.name, jobId });
  });
}

/**
 * 自动加载所有 worker 任务
 */
export async function loadWorkers() {
  const workers: Worker[] = [];
  const queues: Queue[] = [];
  try {
    // 获取所有 .ts 文件
    const taskFiles = await glob("src/jobs/**/*.ts", {
      cwd: process.cwd(),
      absolute: true,
    });

    const router = await getSessionQueueRouter();
    const tasks: JobItem[] = [];

    for (const taskFile of taskFiles) {
      const { default: task }: { default: JobItem } = await import(taskFile);
      if (!task?.name) continue;
      tasks.push(task);
      queues.push(task.queue);
      observeQueue(task.queue);
      if (task.processor && isSessionTask(task.queue.name)) {
        if (typeof task.processor !== "function") {
          throw new Error(`Conversation task ${task.name} requires an inline processor`);
        }
        router.register(task.queue.name, task.processor as Processor);
      }
    }

    const lanes = router.queues() as Queue[];
    lanes.forEach(observeQueue);
    queues.push(...lanes);
    // This Redis-side limit is shared by every application replica.
    await router.configure();

    for (const { name, queue, schedule, processor, concurrency, options } of tasks) {
      if (schedule) {
        await (Bun.env.NODE_ENV !== "production"
          ? queue.removeJobScheduler(name)
          : queue.upsertJobScheduler(name, { pattern: schedule }));
      }
      if (!processor) continue;
      const sessionTask = isSessionTask(queue.name);
      const worker = new Worker(
        queue.name,
        sessionTask
          ? async (job) => {
              const sessionKey = await legacySessionKey(job.data);
              const forwarded = await router.add(queue.name, job.name, job.data, {
                sessionKey,
                jobId: eventJobId("legacy", queue.name, job.id),
              });
              return { forwardedTo: forwarded.queueName, jobId: forwarded.id };
            }
          : processor,
        {
          ...options,
          connection,
          concurrency: sessionTask ? 1 : concurrency || 10,
          autorun: false,
        },
      );
      observeWorker(worker);
      workers.push(worker);
    }

    for (const queue of lanes) {
      const worker = new Worker(queue.name, (job, token) => router.dispatch(job, token), {
        connection,
        concurrency: 1,
        autorun: false,
      });
      observeWorker(worker);
      workers.push(worker);
    }

    // 创建 Bull Board
    createBullBoard({
      queues: queues.map((queue) => new BullMQAdapter(queue)),
      serverAdapter,
    });

    // Register every handler and global limit before consuming any persisted job.
    for (const worker of workers) {
      void worker.run().catch((error) => {
        logger.error("Worker stopped unexpectedly", { queue: worker.name, message: error?.message });
      });
    }
    logger.info(`总共加载了 ${workers.length} 个 Workers`);
    logger.info("Bull Board 已配置完成");

    return { workers, queues };
  } catch (error) {
    await Promise.allSettled(workers.map((worker) => worker.close(true)));
    await Promise.allSettled(queues.map((queue) => queue.close()));
    logger.error("加载 Workers 失败:", error);
    throw error;
  }
}

// 优雅关闭处理
export function setupWorkerShutdown(workers: Worker[], queues: Queue[] = []) {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`接收到 ${signal} 信号，正在关闭 Workers 和队列...`);

    // worker.close() 会等待进行中的任务结束，任务卡住时不能无限等
    const forceExit = setTimeout(() => {
      logger.warn(`关闭超过 ${SHUTDOWN_TIMEOUT / 1000} 秒仍未完成，强制退出`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT);

    try {
      // 关闭所有 Workers
      await Promise.all(workers.map((worker) => worker.close()));

      // 关闭所有队列
      await Promise.all(queues.map((queue) => queue.close()));

      // Queue/Worker 用的是共享的 ioredis 实例，BullMQ 不会替我们断开
      await connection.quit().catch(() => {});

      logger.info("所有 Workers 和队列已关闭");
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      logger.error("关闭 Workers 和队列时出错:", error);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
