import { mock } from "bun:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseSupportConfig } from "../../src/types/support";

const source = (file: string) => path.resolve(import.meta.dir, "../../src", file);
const websiteId = `test-abuse-${crypto.randomUUID()}`;
const project = {
  websiteId,
  support: parseSupportConfig({ abuse: { enabled: true, windowSeconds: 60, maxMessages: 2 } }),
};
const blocked = new Set<string>();
const enqueued = new Set<string>();
let notifications = 0;
let blockDelay = 0;
let failEnqueue = false;

mock.module(source("services/db.service.ts"), () => ({
  getProject: async () => project,
  isSessionBlocked: async (_: string, session: string) => blocked.has(session),
  blockSession: async (_: string, session: string) => {
    if (blockDelay) await Bun.sleep(blockDelay);
    blocked.add(session);
  },
  unblockSession: async (_: string, session: string) => { blocked.delete(session); },
}));
mock.module(source("services/telegram.service.ts"), () => ({
  notifyBlocked: async () => { notifications++; },
}));
mock.module(source("services/logger.service.ts"), () => ({
  default: { info() {}, warn() {}, error() {} },
}));
mock.module(source("utils/queue.ts"), () => ({
  // Acknowledges persistence without executing the job: the AI lane can be
  // stalled indefinitely and ingress abuse detection must still protect it.
  enqueue: async (_queue: any, _name: string, _data: any, options: any) => {
    if (failEnqueue) throw new Error("Redis persistence unavailable");
    enqueued.add(options.jobId);
    return { id: options.jobId };
  },
}));
for (const task of ["messageSend", "messageReceived", "messageUpdated"]) {
  mock.module(source(`jobs/${task}.task.ts`), () => ({
    default: { queue: { name: `${task}.task` } },
  }));
}

const { crispWebhook } = await import("../../src/services/crisp.service");
const { unblockCustomer } = await import("../../src/services/support.service");
const { connection } = await import("../../src/services/redis.service");
const send = (event: string, session: string, fingerprint: number, content: any = "spam") =>
  crispWebhook({
    req: { json: async () => ({ event, data: {
      website_id: websiteId, session_id: `session_${session}`, fingerprint, type: "text", content,
    } }) },
    json: (response: any) => response,
  } as any) as Promise<any>;
const redisKey = (session: string) => `crispai:abuse:${websiteId}:${session}`;

try {
  // No worker ever consumes these messages. A burst is measured when it arrives.
  assert.equal((await send("message:send", "burst", 1)).skipped, undefined);
  await send("message:send", "burst", 1);
  assert.equal(await connection.zcard(redisKey("burst")), 1);
  await send("message:send", "burst", 2);
  assert.equal(enqueued.size, 2);
  assert.equal((await send("message:send", "burst", 3)).skipped, true);
  assert.equal(blocked.has("burst"), true);
  assert.equal(enqueued.size, 2);
  for (let index = 4; index < 20; index++) await send("message:send", "burst", index);
  assert.equal(notifications, 1);

  // Picker updates also count, while redeliveries of the same selection do not.
  enqueued.clear();
  const picker = (value: string) => ({ id: "card", choices: [{ value, selected: true }] });
  await send("message:updated", "picker", 100, picker("one"));
  await send("message:updated", "picker", 100, picker("one"));
  assert.equal(await connection.zcard(redisKey("picker")), 1);
  await send("message:updated", "picker", 100, picker("two"));
  assert.equal(enqueued.size, 2);
  assert.equal((await send("message:updated", "picker", 100, picker("three"))).skipped, true);
  assert.equal(blocked.has("picker"), true);

  // An explicit unblock starts a fresh window rather than immediately re-banning.
  await unblockCustomer(websiteId, "burst");
  assert.equal(blocked.has("burst"), false);
  assert.equal(await connection.exists(redisKey("burst")), 0);
  assert.equal((await send("message:send", "burst", 30)).skipped, undefined);
  assert.equal(blocked.has("burst"), false);

  // Simulate overlapping DB commits from a parallel flood. Only one worker
  // may notify staff, even when many requests observed "not blocked" initially.
  blockDelay = 25;
  const priorNotifications = notifications;
  await Promise.all(Array.from({ length: 15 }, (_, index) =>
    send("message:send", "parallel", index + 1000)));
  assert.equal(blocked.has("parallel"), true);
  assert.equal(notifications - priorNotifications, 1);
  blockDelay = 0;

  // Failure before durable queue acceptance must propagate instead of returning
  // a successful webhook response, and redelivery must not count as extra spam.
  failEnqueue = true;
  await assert.rejects(send("message:send", "retry", 5000), /Redis persistence unavailable/);
  failEnqueue = false;
  assert.equal((await send("message:send", "retry", 5000)).skipped, undefined);
  assert.equal(await connection.zcard(redisKey("retry")), 1);
  process.stdout.write(JSON.stringify({ passed: 5 }));
} finally {
  const keys = await connection.keys(`crispai:abuse:${websiteId}:*`);
  if (keys.length) await connection.del(...keys);
  await connection.quit();
}
