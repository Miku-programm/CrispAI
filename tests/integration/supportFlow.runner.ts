import { mock } from "bun:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseSupportConfig } from "../../src/types/support";

const source = (file: string) => path.resolve(import.meta.dir, "../../src", file);
const copy = <T>(value: T): T => structuredClone(value);
let project: any;
let session: Session;
let blocked = false;
let redisCount = 0;
let aiCalls = 0;
let onCompletion: (() => Promise<unknown>) | undefined;
let onTelegram: ((name: string) => Promise<void>) | undefined;
let crispMessages: string[] = [];
let telegramCalls: string[] = [];
let queued: Array<{ queue: string; name: string; data: any; options: any }> = [];
let passes: string[] = [];

function reset(config: any = { enabled: true, online: true }) {
  project = {
    id: "project", websiteId: "website", enableAI: true, enableAIPic: true,
    enableKeyword: false, keyword: [], payload: "Answer customers.", telegramId: -1001,
    support: parseSupportConfig(config),
  };
  session = {
    website_id: "website", session_id: "customer", group_id: -1001, topic_id: 2,
    message_id: 3, enable_reply: true, enable_time: new Date(), thread: [],
    control_version: 0, fallback_active: false, fallback_action: null,
    pending_token: null, pending_since: null, deadline_at: null, pending_message: null,
  };
  blocked = false;
  redisCount = 0;
  aiCalls = 0;
  onCompletion = undefined;
  onTelegram = undefined;
  crispMessages = [];
  telegramCalls = [];
  queued = [];
}

const humanReply = async () => {
  session.control_version = (session.control_version ?? 0) + 1;
  Object.assign(session, {
    last_human_at: new Date(), enable_reply: false, enable_time: new Date(),
    pending_token: null, pending_since: null, deadline_at: null, pending_message: null,
    fallback_active: false, fallback_action: null,
  });
  return copy(session);
};

mock.module("bullmq", () => ({ Queue: class {
  constructor(public name: string) {}
} }));
mock.module(source("services/redis.service.ts"), () => ({
  connection: { eval: async () => ++redisCount },
}));
mock.module(source("services/logger.service.ts"), () => ({
  default: { warn() {}, info() {}, error() {} },
}));
mock.module(source("services/db.service.ts"), () => ({
  getProject: async () => copy(project),
  getSession: async () => copy(session),
  isSessionBlocked: async () => blocked,
  getOption: async () => [],
  hasPayload: async () => false,
  matchPayloads: async () => [],
  updateSession: async (_: string, patch: any) => {
    Object.assign(session, copy(patch));
    return copy(session);
  },
  updateSessionIfVersion: async (_: string, version: number, patch: any) => {
    if (version !== session.control_version) return null;
    Object.assign(session, copy(patch));
    return copy(session);
  },
  markHumanActivity: humanReply,
  blockSession: async () => {
    blocked = true;
    session.control_version = (session.control_version ?? 0) + 1;
    return { blocked: true };
  },
}));
mock.module(source("services/openai.service.ts"), () => ({
  CHAT_MODEL: "test-model",
  createEmbedding: async () => [],
  default: { chat: { completions: { create: async () => {
    aiCalls++;
    await onCompletion?.();
    return { choices: [{ message: { role: "assistant", content: "AI answer" } }] };
  } } } },
}));
mock.module(source("services/crisp.service.ts"), () => ({
  getMetas: async () => [],
  getMetaData: async () => ({}),
  listPages: async () => [],
  composeMessage: async () => true,
  sendMessage: async (_site: string, _session: string, text: string) => {
    crispMessages.push(text);
    return true;
  },
  sendOption: async () => { crispMessages.push("option"); return true; },
}));
const tg = (name: string) => async (..._args: any[]) => {
  telegramCalls.push(name);
  await onTelegram?.(name);
  return { message_id: 55 };
};
mock.module(source("services/telegram.service.ts"), () => ({
  escapeHTML: (text: string) => text,
  changeAI: () => ({}),
  notifyBlocked: tg("notifyBlocked"),
  default: { api: {
    sendMessage: tg("sendMessage"), sendPhoto: tg("sendPhoto"),
    editMessageText: tg("editMessageText"), editMessageCaption: tg("editMessageCaption"),
    sendVoice: tg("sendVoice"),
  } },
}));
mock.module(source("utils/general.ts"), () => ({
  createResponse: (success: boolean, message: string) => ({ success, message }),
  createTelegramSession: async () => copy(session),
  generateTelegramSession: async () => [],
  emojiConverter: (text: string) => text,
}));
mock.module(source("utils/queue.ts"), () => ({
  enqueue: async (queue: any, name: string, data: any, options: any) => {
    queued.push({ queue: queue.name, name, data: copy(data), options });
    return { id: options?.jobId };
  },
}));

const messageTask = (await import("../../src/jobs/messageSend.task")).default;
const receivedTask = (await import("../../src/jobs/messageReceived.task")).default;
const timeoutTask = (await import("../../src/jobs/supportTimeout.task")).default;
const { armTimeout } = await import("../../src/services/support.service");
const textBody = (content = "Hello") => ({
  website_id: "website", session_id: "session_customer", type: "text", content,
});
const imageBody = () => ({
  website_id: "website", session_id: "session_customer", type: "file",
  content: { type: "image/png", url: "https://example.test/customer.png" },
});
const message = (data = textBody(), timestamp = Date.now()) => messageTask.processor({ data, timestamp });
const timeout = () => timeoutTask.processor({
  data: { website_id: "website", session_id: "customer", token: session.pending_token },
});
function pending(action: "ai" | "message" | "rules" | "none" = "ai", body = textBody()) {
  reset({
    enabled: true, online: true,
    timeout: { enabled: true, seconds: 1, action, message: "Please email support@example.test" },
  });
  Object.assign(session, {
    pending_token: "round-one", pending_since: new Date(Date.now() - 5000),
    deadline_at: new Date(Date.now() - 1000), pending_message: body,
    thread: [{ role: "user", content: "Hello" }],
  });
}
async function scenario(name: string, run: () => Promise<void>) {
  await run();
  passes.push(name);
}

await scenario("online staff receive the customer message while AI waits", async () => {
  reset({ enabled: true, online: true, timeout: { enabled: true, seconds: 90, action: "ai" } });
  const receivedAt = Date.now();
  await message(textBody(), receivedAt);
  assert.equal(aiCalls, 0);
  assert.equal(crispMessages.length, 0);
  assert.ok(telegramCalls.includes("sendMessage"));
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.queue, "supportTimeout.task");
  assert.equal(new Date(session.deadline_at!).getTime(), receivedAt + 90_000);
  assert.deepEqual(session.thread, [{ role: "user", content: "Hello" }]);
});

await scenario("a follow-up retains the first deadline and updates pending message", async () => {
  pending();
  const originalDeadline = session.deadline_at;
  await armTimeout(project, copy(session), textBody("Follow-up"), Date.now());
  assert.equal(new Date(session.deadline_at!).getTime(), new Date(originalDeadline!).getTime());
  assert.equal((session.pending_message as any).content, "Follow-up");
  assert.equal(queued[0]?.options.jobId, "timeout-round-one");
});

await scenario("timeout invokes AI once and activates fallback", async () => {
  pending();
  await timeout();
  assert.equal(aiCalls, 1);
  assert.deepEqual(crispMessages, ["AI answer"]);
  assert.equal(session.pending_token, null);
  assert.equal(session.fallback_active, true);
  assert.equal(session.fallback_action, "ai");
  assert.equal(session.thread.length, 2);
});

await scenario("human reply while timeout AI is generating cancels the completion", async () => {
  pending();
  onCompletion = humanReply;
  await timeout();
  assert.equal(aiCalls, 1);
  assert.equal(crispMessages.length, 0);
  assert.equal(session.pending_token, null);
  assert.equal(session.fallback_active, false);
  assert.equal(telegramCalls.length, 0);
});

await scenario("a stale timeout token cannot answer a newer waiting round", async () => {
  pending();
  await timeoutTask.processor({
    data: { website_id: "website", session_id: "customer", token: "old-round" },
  });
  assert.equal(aiCalls, 0);
  assert.equal(crispMessages.length, 0);
  assert.equal(session.pending_token, "round-one");
});

await scenario("blocked customers never reach Telegram or AI", async () => {
  reset();
  blocked = true;
  await message();
  assert.equal(telegramCalls.length, 0);
  assert.equal(aiCalls, 0);
  assert.equal(crispMessages.length, 0);
  assert.equal(queued.length, 0);
});

await scenario("legacy image replies honor the disabled AI switch", async () => {
  reset({ enabled: false });
  session.enable_reply = false;
  await message(imageBody() as any);
  assert.equal(aiCalls, 0);
  assert.equal(crispMessages.length, 0);
  assert.ok(telegramCalls.includes("sendPhoto"));
});

await scenario("offline message policy sends the configured ticket/email text", async () => {
  reset({
    enabled: true, online: false,
    offline: { action: "message", message: "Open a ticket or email support@example.test" },
  });
  await message();
  assert.deepEqual(crispMessages, ["Open a ticket or email support@example.test"]);
  assert.equal(aiCalls, 0);
  await message(textBody("Anyone there?"));
  assert.equal(crispMessages.length, 1);
});

await scenario("offline AI action is independent of the previous human reply switch", async () => {
  reset({ enabled: true, online: false, offline: { action: "ai" } });
  session.enable_reply = false;
  await message();
  assert.equal(aiCalls, 1);
  assert.deepEqual(crispMessages, ["AI answer"]);
});

await scenario("timeout rules match a keyword before invoking AI", async () => {
  pending("rules");
  project.enableKeyword = true;
  project.keyword = [{ keyword: "Hello", type: "text", text: "Keyword answer" }];
  await timeout();
  assert.deepEqual(crispMessages, ["Keyword answer"]);
  assert.equal(aiCalls, 0);
});

await scenario("a new timeout round is not suppressed by a notice from the previous round", async () => {
  pending("message");
  session.last_auto_reply_at = new Date(Date.now() - 10_000);
  await timeout();
  assert.deepEqual(crispMessages, ["Please email support@example.test"]);
  assert.equal(session.pending_token, null);
  assert.equal(session.fallback_action, "message");
});

await scenario("ordinary in-flight AI is also canceled by a human response", async () => {
  reset({ enabled: false });
  onCompletion = humanReply;
  await message();
  assert.equal(aiCalls, 1);
  assert.equal(crispMessages.length, 0);
});

await scenario("a human reply received after a queued question suppresses its timeout", async () => {
  reset({ enabled: true, online: true, timeout: { enabled: true, seconds: 1, action: "ai" } });
  const queuedAt = Date.now() - 1000;
  await humanReply();
  await message(textBody(), queuedAt);
  assert.equal(queued.length, 0);
  assert.equal(aiCalls, 0);
});

await scenario("offline AI does not re-answer an older queued question already answered by a human", async () => {
  reset({ enabled: true, online: false, offline: { action: "ai" } });
  const arrivedAt = Date.now() - 1000;
  await humanReply();
  await message({ ...textBody(), _received_at: arrivedAt } as any, Date.now() + 1000);
  assert.equal(aiCalls, 0);
  assert.equal(crispMessages.length, 0);
  assert.equal(queued.length, 0);
});

await scenario("processing an older human reply does not erase the timeout for a later question", async () => {
  reset({ enabled: true, online: true, timeout: { enabled: true, seconds: 30, action: "ai" } });
  await humanReply();
  const humanArrived = Date.now() - 2000;
  const questionArrived = Date.now() - 1000;
  session.last_human_at = new Date(humanArrived);
  await receivedTask.processor({
    timestamp: humanArrived,
    data: { ...textBody("Earlier human answer"), user: {}, human_activity_recorded: true },
  });
  await message(textBody("A new question after the answer"), questionArrived);
  assert.equal(new Date(session.last_human_at!).getTime(), humanArrived);
  assert.equal(queued.length, 1);
  assert.equal(new Date(session.deadline_at!).getTime(), questionArrived + 30_000);
});

await scenario("blocking while Telegram metadata refreshes suppresses the customer forward", async () => {
  reset();
  onTelegram = async (name) => { if (name === "editMessageText") blocked = true; };
  await message();
  assert.deepEqual(telegramCalls, ["editMessageText"]);
  assert.equal(crispMessages.length, 0);
  assert.equal(aiCalls, 0);
});

process.stdout.write(JSON.stringify({ passed: passes.length, scenarios: passes }));
