import type { Queue } from "bullmq";
import logger from "@/services/logger.service";
import {
  enqueueSessionTask,
  isSessionTask,
  type SessionEnqueueOptions,
} from "@/services/sessionQueue.service";

/**
 * 入队成功才算接收成功。Webhook 必须 await，Redis 失败时让上游重试。
 * 所有会话任务共享同一分片串行通道，包括人工回复和延迟超时任务。
 */
export const enqueue = async (
  queue: Queue,
  name: string,
  data: any,
  options: SessionEnqueueOptions = {},
) => {
  try {
    if (isSessionTask(queue.name)) {
      return await enqueueSessionTask(queue.name, name, data, options);
    }
    const { sessionKey: _, ...jobOptions } = options;
    return await queue.add(name, data, jobOptions);
  } catch (error: any) {
    logger.error("任务入队失败", {
      queue: queue.name,
      name,
      code: error?.code,
      message: error?.message,
    });
    throw error;
  }
};
