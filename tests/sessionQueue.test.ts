import { describe, expect, test } from "bun:test";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import {
  SESSION_JOB_RETENTION_SECONDS,
  SESSION_QUEUE_SHARDS,
  SessionQueueRouter,
  dataSessionKey,
  eventJobId,
  sessionQueueKey,
  sessionQueueName,
  type SessionEnvelope,
} from "../src/services/sessionQueue.service";

describe("conversation queue routing", () => {
  test("normalizes Crisp IDs and isolates website IDs", () => {
    expect(sessionQueueKey("site-a", "session_abc")).toBe(sessionQueueKey("site-a", "abc"));
    expect(sessionQueueKey("site-a", "abc")).not.toBe(sessionQueueKey("site-b", "abc"));
    expect(dataSessionKey({ website_id: "site-a", session_id: "session_abc" }))
      .toBe(sessionQueueKey("site-a", "abc"));
    expect(() => sessionQueueKey("", "abc")).toThrow();
  });

  test("configures every lane globally and preserves delay / dedup options", async () => {
    const concurrency: number[] = [];
    const added: any[] = [];
    const router = new SessionQueueRouter((name) => ({
      name,
      setGlobalConcurrency: async (value) => { concurrency.push(value); return 1; },
      add: async (...args: any[]) => { added.push({ queue: name, args }); return {} as any; },
    }));
    const key = sessionQueueKey("site", "session_1");
    await router.add("messageSend.task", "messageSend", { text: "hello" }, {
      sessionKey: key,
      jobId: "dedup-id",
      delay: 100,
    });
    await router.add("telegramReply.task", "telegramReply", { text: "human" }, { sessionKey: key });
    expect(concurrency).toEqual(Array(SESSION_QUEUE_SHARDS).fill(1));
    expect(added[0].queue).toBe(added[1].queue);
    expect(added[0].args[1]).toEqual({
      task: "messageSend.task", sessionKey: key, payload: { text: "hello" },
    });
    expect(added[0].args[2]).toEqual({
      jobId: "dedup-id", delay: 100,
      removeOnComplete: { age: SESSION_JOB_RETENTION_SECONDS },
      removeOnFail: { age: SESSION_JOB_RETENTION_SECONDS },
    });
    await expect(router.add("telegramReply.task", "reply", {})).rejects.toThrow("Missing conversation");
  });

  test("propagates Redis failures and permits retrying configuration", async () => {
    let fail = true;
    const router = new SessionQueueRouter((name) => ({
      name,
      setGlobalConcurrency: async () => {
        if (fail) throw new Error("Redis unavailable");
        return 1;
      },
      add: async () => { throw new Error("Redis add failed"); },
    }));
    const data = { website_id: "site", session_id: "session_1" };
    await expect(router.add("messageSend.task", "send", data)).rejects.toThrow("Redis unavailable");
    fail = false;
    await expect(router.add("messageSend.task", "send", data)).rejects.toThrow("Redis add failed");
  });

  test("dispatch keeps the original job methods and restores its envelope on failure", async () => {
    const router = new SessionQueueRouter(() => { throw new Error("No queue needed"); });
    const envelope: SessionEnvelope = {
      task: "messageSend.task", sessionKey: "key", payload: { content: "hello" },
    };
    const job = { data: envelope, log(text: string) { return `log:${text}`; } } as unknown as Job<SessionEnvelope>;
    router.register("messageSend.task", async (actual) => {
      expect(actual.data).toEqual({ content: "hello" });
      expect(actual.log).toBe(job.log);
      throw new Error("processor failed");
    });
    await expect(router.dispatch(job)).rejects.toThrow("processor failed");
    expect(job.data).toBe(envelope);
  });

  test("event IDs are stable, source-scoped and safe for BullMQ", () => {
    expect(eventJobId("crisp", "site", 123)).toBe(eventJobId("crisp", "site", 123));
    expect(eventJobId("crisp", "site", 123)).not.toBe(eventJobId("telegram", "site", 123));
    expect(eventJobId("crisp", "site", 123)).not.toContain(":");
  });
});

// Run against an isolated Redis database:
// SESSION_QUEUE_TEST_REDIS_URL=redis://127.0.0.1:16379/1 bun test tests/sessionQueue.test.ts
const testRedis = process.env.SESSION_QUEUE_TEST_REDIS_URL;

async function withRedis(
  body: (fixture: {
    router: SessionQueueRouter;
    replica: SessionQueueRouter;
    worker: (key: string, router?: SessionQueueRouter) => Worker;
  }) => Promise<void>,
) {
  const connection = new IORedis(testRedis!, { maxRetriesPerRequest: null });
  const prefix = `test-session-${crypto.randomUUID()}`;
  const queues: Queue[] = [];
  const workers: Worker[] = [];
  const makeRouter = () => new SessionQueueRouter((name) => {
    const queue = new Queue(name, { connection, prefix });
    queues.push(queue);
    return queue;
  });
  const router = makeRouter();
  const replica = makeRouter();
  try {
    await Promise.all([router.configure(), replica.configure()]);
    await body({
      router,
      replica,
      worker: (key, handlerRouter = router) => {
        // Intentionally higher than production concurrency: Redis global
        // concurrency must protect even two competing high-concurrency workers.
        const worker = new Worker(
          sessionQueueName(key),
          (job, token) => handlerRouter.dispatch(job, token),
          { connection, prefix, concurrency: 8 },
        );
        workers.push(worker);
        return worker;
      },
    });
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    const unique = new Map(queues.map((queue) => [queue.name, queue]));
    await Promise.all([...unique.values()].map((queue) => queue.obliterate({ force: true })));
    await Promise.all(queues.map((queue) => queue.close()));
    await connection.quit();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Queue test timed out")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!testRedis)("conversation queue with real Redis", () => {
  test("same conversation is FIFO across task types and two worker replicas, without lost history", async () => {
    await withRedis(async ({ router, replica, worker }) => {
      const key = sessionQueueKey("site", "session_fifo");
      const done = deferred();
      let active = 0;
      let peak = 0;
      let history: number[] = [];
      const handler = async (job: Job) => {
        peak = Math.max(peak, ++active);
        const snapshot = history.slice();
        await Bun.sleep(8);
        history = [...snapshot, job.data.index];
        active--;
        if (history.length === 24) done.resolve();
      };
      for (const r of [router, replica]) {
        r.register("messageSend.task", handler);
        r.register("telegramReply.task", handler);
      }
      for (let index = 0; index < 24; index++) {
        await (index % 2 ? router : replica).add(
          index % 2 ? "telegramReply.task" : "messageSend.task", "event", { index }, { sessionKey: key },
        );
      }
      worker(key, router);
      worker(key, replica);
      await bounded(done.promise);
      expect(peak).toBe(1);
      expect(history).toEqual(Array.from({ length: 24 }, (_, index) => index));
    });
  }, 10_000);

  test("different lanes run concurrently", async () => {
    await withRedis(async ({ router, worker }) => {
      const keyA = sessionQueueKey("site", "a");
      let keyB = sessionQueueKey("site", "b");
      for (let index = 0; sessionQueueName(keyA) === sessionQueueName(keyB); index++) {
        keyB = sessionQueueKey("site", `b-${index}`);
      }
      const bothStarted = deferred();
      const finished = deferred();
      let active = 0;
      let peak = 0;
      let count = 0;
      router.register("messageSend.task", async () => {
        peak = Math.max(peak, ++active);
        if (active === 2) bothStarted.resolve();
        await bounded(bothStarted.promise);
        active--;
        if (++count === 2) finished.resolve();
      });
      worker(keyA);
      worker(keyB);
      await router.add("messageSend.task", "first", {}, { sessionKey: keyA });
      await router.add("messageSend.task", "second", {}, { sessionKey: keyB });
      await bounded(finished.promise);
      expect(peak).toBe(2);
    });
  }, 10_000);

  test("delayed timeouts do not block replies and completed event IDs suppress redelivery", async () => {
    await withRedis(async ({ router, worker }) => {
      const key = sessionQueueKey("site", "delay");
      const done = deferred();
      const order: string[] = [];
      router.register("timeout.task", async (job) => {
        order.push(job.name);
        if (order.length === 2) done.resolve();
      });
      router.register("telegramReply.task", async (job) => { order.push(job.name); });
      worker(key);
      await router.add("timeout.task", "timeout", {}, { sessionKey: key, delay: 200 });
      const reply = await router.add("telegramReply.task", "human", {}, { sessionKey: key, jobId: "human-event" });
      await bounded(done.promise);
      expect(order).toEqual(["human", "timeout"]);
      expect(await reply.getState()).toBe("completed");
      const duplicate = await router.add("telegramReply.task", "human", {}, { sessionKey: key, jobId: "human-event" });
      expect(duplicate.id).toBe(reply.id);
      expect(await duplicate.getState()).toBe("completed");
      await Bun.sleep(50);
      expect(order).toEqual(["human", "timeout"]);
    });
  }, 10_000);
});
