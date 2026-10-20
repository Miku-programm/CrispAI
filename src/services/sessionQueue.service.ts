import { createHash } from "node:crypto";
import { Queue, type Job, type JobsOptions, type Processor } from "bullmq";

// This count and hash are part of the queue protocol. Changing either while
// jobs exist could place one conversation in two concurrently running lanes.
export const SESSION_QUEUE_SHARDS = 32;
export const SESSION_JOB_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export type SessionEnqueueOptions = JobsOptions & { sessionKey?: string };
export type SessionEnvelope = {
  task: string;
  sessionKey: string;
  payload: unknown;
};

export const isSessionTask = (name: string) => name.endsWith(".task");

export function sessionQueueKey(websiteId: string, sessionId: string): string {
  if (!websiteId || !sessionId) throw new Error("A conversation requires website_id and session_id");
  return JSON.stringify([websiteId, sessionId.replace(/^session_/, "")]);
}

export function sessionQueueName(key: string): string {
  const shard = createHash("sha256").update(key).digest().readUInt32BE(0) % SESSION_QUEUE_SHARDS;
  return `session-lane-${String(shard).padStart(2, "0")}`;
}

export function dataSessionKey(data: any): string | undefined {
  return data?.website_id && data?.session_id
    ? sessionQueueKey(data.website_id, data.session_id)
    : undefined;
}

// BullMQ job IDs may not contain ":"; hashes also avoid storing customer IDs
// in the Redis key itself. Completed IDs remain for seven days for redelivery.
export function eventJobId(source: string, ...identity: unknown[]): string {
  return `${source}-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

type LaneQueue = Pick<Queue, "name" | "add" | "setGlobalConcurrency">;

/**
 * Injectable queue factory keeps routing tests isolated from Redis. All
 * processes use the same lane names and Redis global concurrency limit.
 */
export class SessionQueueRouter {
  private readonly lanes = new Map<string, LaneQueue>();
  private readonly handlers = new Map<string, Processor>();
  private configured?: Promise<void>;

  constructor(private readonly queueFactory: (name: string) => LaneQueue) {}

  queues(): LaneQueue[] {
    for (let shard = 0; shard < SESSION_QUEUE_SHARDS; shard++) {
      const name = `session-lane-${String(shard).padStart(2, "0")}`;
      if (!this.lanes.has(name)) this.lanes.set(name, this.queueFactory(name));
    }
    return [...this.lanes.values()];
  }

  async configure(): Promise<void> {
    if (!this.configured) {
      this.configured = Promise.all(
        this.queues().map((queue) => queue.setGlobalConcurrency(1)),
      ).then(() => undefined).catch((error) => {
        this.configured = undefined;
        throw error;
      });
    }
    await this.configured;
  }

  register(task: string, processor: Processor) {
    this.handlers.set(task, processor);
  }

  async add(task: string, name: string, payload: unknown, options: SessionEnqueueOptions = {}) {
    const { sessionKey: explicitKey, ...jobOptions } = options;
    const sessionKey = explicitKey ?? dataSessionKey(payload);
    if (!sessionKey) throw new Error(`Missing conversation key for ${task}`);
    // Configure before accepting a job, including producers outside the main
    // HTTP process. Worker concurrency alone would not protect multiple replicas.
    await this.configure();
    const queue = this.lanes.get(sessionQueueName(sessionKey))!;
    return queue.add(name, { task, sessionKey, payload } satisfies SessionEnvelope, {
      removeOnComplete: { age: SESSION_JOB_RETENTION_SECONDS },
      removeOnFail: { age: SESSION_JOB_RETENTION_SECONDS },
      ...jobOptions,
    });
  }

  async dispatch(job: Job<SessionEnvelope>, token?: string) {
    const handler = this.handlers.get(job.data.task);
    if (!handler) throw new Error(`Unknown conversation task: ${job.data.task}`);
    // Existing processors keep their original job.data shape and Job methods.
    const originalData = job.data;
    try {
      (job as Job).data = originalData.payload;
      return await handler(job, token);
    } finally {
      job.data = originalData;
    }
  }
}

let runtimeRouter: Promise<SessionQueueRouter> | undefined;

export function getSessionQueueRouter(): Promise<SessionQueueRouter> {
  runtimeRouter ??= import("@/services/redis.service").then(({ connection }) =>
    new SessionQueueRouter((name) => new Queue(name, { connection })),
  );
  return runtimeRouter;
}

export async function enqueueSessionTask(
  task: string,
  name: string,
  payload: unknown,
  options: SessionEnqueueOptions = {},
) {
  return (await getSessionQueueRouter()).add(task, name, payload, options);
}
