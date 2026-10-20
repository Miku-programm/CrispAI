import assert from "node:assert/strict";
import { SQL } from "bun";

const adminUrl = Bun.env.CRISPAI_TEST_DATABASE_URL;
if (!adminUrl) throw new Error("CRISPAI_TEST_DATABASE_URL is required");
const redisUrl = Bun.env.CRISPAI_TEST_REDIS_URL;
if (!redisUrl) throw new Error("CRISPAI_TEST_REDIS_URL is required");
Bun.env.REDIS_URL = redisUrl;
const { connection } = await import("../../src/services/redis.service");
const databaseName = `crispai_it_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new SQL(adminUrl);
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${databaseName}`;
let sql: SQL | undefined;
let checks = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`PASS ${name}`);
};

try {
  // databaseName contains only a fixed prefix and random hexadecimal characters.
  await admin.unsafe(`create database "${databaseName}"`);
  Bun.env.DATABASE_URL = testUrl.toString();
  const db = await import("../../src/services/db.service");
  const { supportSchema } = await import("../../src/types/support");
  sql = db.default;
  const legacySchema = await Bun.file(import.meta.dir + "/../fixtures/legacy-schema.sql").text();
  await sql.unsafe(legacySchema);
  const [legacy] = await sql`
    insert into project (name, "websiteId", enabled)
    values ('迁移前项目', 'website-a', true) returning id`;
  const projectId = legacy.id as string;
  await sql`
    insert into session (website_id, session_id, group_id, topic_id, message_id, enable_reply, thread)
    values ('website-a', 'conversation-a', -1001234567890, 42, 70, false,
      '[{"role":"user","content":"迁移前内容"}]'::jsonb)`;

  await check("legacy migration is repeatable and preserves conversations", async () => {
    await db.migrate(1);
    await db.migrate(1);
    const project = await db.getProjectById(projectId);
    assert.equal(project.name, "迁移前项目");
    assert.equal(project.support.enabled, false);
    const session = await db.getSession("conversation-a");
    assert.equal(session.enable_reply, false);
    assert.equal(session.group_id, -1001234567890);
    assert.deepEqual(session.thread, [{ role: "user", content: "迁移前内容" }]);
    assert.equal(session.pending_token, null);
    assert.equal(session.control_version, 0);
    assert.equal(session.fallback_action, null);
  });

  const activeConfig = supportSchema.parse({
    enabled: true,
    online: false,
    offline: { action: "message", message: "请联系 support@example.test 或提交工单" },
    timeout: { enabled: true, seconds: 90, action: "rules" },
    abuse: { enabled: true, windowSeconds: 10, maxMessages: 5 },
  });
  await check("support settings round-trip as JSON and invalidate old waiting jobs", async () => {
    await db.updateSession("conversation-a", {
      pending_since: new Date(),
      deadline_at: new Date(Date.now() + 60_000),
      pending_token: "stale-token",
      pending_message: { content: "hello" },
      fallback_active: true,
      fallback_action: "ai",
    });
    await db.saveProjectSupport(projectId, activeConfig);
    const [raw] = await sql!`select jsonb_typeof(support) as kind from project where id = ${projectId}`;
    assert.equal(raw.kind, "object");
    assert.deepEqual((await db.getProjectById(projectId)).support, activeConfig);
    const session = await db.getSession("conversation-a");
    assert.equal(session.pending_token, null);
    assert.equal(session.pending_message, null);
    assert.equal(session.fallback_active, false);
    assert.equal(session.fallback_action, null);
    assert.equal(session.enable_reply, false);
    assert.equal(session.control_version, 1);
  });

  await check("human activity creates a minimal session and refreshes repeated replies", async () => {
    const first = await db.markHumanActivity("website-a", "session_human-first");
    assert.equal(first.session_id, "human-first");
    assert.equal(first.enable_reply, false);
    assert.equal(first.control_version, 1);
    await Bun.sleep(5);
    const second = await db.markHumanActivity("website-a", "human-first");
    assert.equal(second.control_version, 2);
    assert.ok(second.last_human_at.getTime() >= first.last_human_at.getTime());
    assert.ok(second.enable_time.getTime() >= first.enable_time.getTime());
    const incompatible = await db.markHumanActivity("website-b", "human-first");
    assert.equal(incompatible, null);
    assert.equal((await db.getSession("human-first")).website_id, "website-a");
  });

  await check("human replies atomically invalidate in-flight fallback updates", async () => {
    const initial = await db.getSession("conversation-a");
    await db.updateSession("conversation-a", {
      pending_token: "waiting-on-human",
      pending_since: new Date(),
      deadline_at: new Date(Date.now() + 60_000),
      pending_message: { type: "text", content: "请帮忙" },
      fallback_active: true,
      fallback_action: "rules",
    });
    await db.markHumanActivity("website-a", "conversation-a");
    const stale = await db.updateSessionIfVersion(
      "conversation-a", initial.control_version, { fallback_active: true },
    );
    assert.equal(stale, null);
    const updated = await db.getSession("conversation-a");
    assert.equal(updated.pending_token, null);
    assert.equal(updated.fallback_active, false);
    assert.equal(updated.fallback_action, null);
    const fresh = await db.updateSessionIfVersion(
      "conversation-a", updated.control_version, { last_customer_at: new Date() },
    );
    assert.ok(fresh.last_customer_at instanceof Date);
  });

  await check("redelivered human webhooks cannot cancel a newer customer deadline", async () => {
    const first = await db.markHumanActivity("website-a", "human-dedup", "test-human-update-1");
    await db.updateSession("human-dedup", {
      pending_token: "new-customer-round", pending_since: new Date(),
      deadline_at: new Date(Date.now() + 60_000),
    });
    const repeated = await db.markHumanActivity("website-a", "human-dedup", "test-human-update-1");
    assert.equal(repeated.control_version, first.control_version);
    assert.equal(repeated.pending_token, "new-customer-round");
    assert.equal(repeated.last_human_at.getTime(), first.last_human_at.getTime());
    const [parallelA, parallelB] = await Promise.all([
      db.markHumanActivity("website-a", "human-dedup", "test-human-update-2"),
      db.markHumanActivity("website-a", "human-dedup", "test-human-update-2"),
    ]);
    assert.equal(parallelA.control_version, first.control_version + 1);
    assert.equal(parallelB.control_version, first.control_version + 1);
    assert.equal((await db.getSession("human-dedup")).pending_token, null);
  });

  await check("legacy AI timers cannot overwrite human, block or policy changes", async () => {
    const legacyProject = await db.createProject("Legacy timer");
    await db.updateProject(legacyProject.id, { websiteId: "website-legacy", enabled: true });
    let session = await db.markHumanActivity("website-legacy", "legacy-timer");
    assert.equal(await db.enableSessionIfUnchanged(
      session.session_id, session.enable_time, session.control_version,
    ), true);
    session = await db.markHumanActivity("website-legacy", "legacy-timer");
    await db.markHumanActivity("website-legacy", "legacy-timer");
    assert.equal(await db.enableSessionIfUnchanged(
      session.session_id, session.enable_time, session.control_version,
    ), false);
    session = await db.getSession("legacy-timer");
    await Promise.all([
      db.enableSessionIfUnchanged(session.session_id, session.enable_time, session.control_version),
      db.markHumanActivity("website-legacy", "legacy-timer"),
    ]);
    assert.equal((await db.getSession("legacy-timer")).enable_reply, false);
    await db.blockSession("website-legacy", "legacy-timer");
    session = await db.getSession("legacy-timer");
    assert.equal(await db.enableSessionIfUnchanged(
      session.session_id, session.enable_time, session.control_version,
    ), false);
    await db.unblockSession("website-legacy", "legacy-timer");
    await db.saveProjectSupport(legacyProject.id, activeConfig);
    session = await db.getSession("legacy-timer");
    assert.equal(await db.enableSessionIfUnchanged(
      session.session_id, session.enable_time, session.control_version,
    ), false);
    await db.deleteProject(legacyProject.id);
  });

  await check("blocking normalizes IDs and is scoped to the website", async () => {
    await db.updateSession("conversation-a", { pending_token: "blocked-token", fallback_active: true });
    await db.blockSession("website-a", "session_conversation-a", "频繁骚扰", "abuse");
    assert.equal(await db.isSessionBlocked("website-a", "conversation-a"), true);
    assert.equal(await db.isSessionBlocked("website-a", "session_conversation-a"), true);
    assert.equal(await db.isSessionBlocked("website-b", "conversation-a"), false);
    const blocks = await db.listBlockedSessions("website-a");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].reason, "频繁骚扰");
    assert.equal(blocks[0].source, "abuse");
    const session = await db.getSession("conversation-a");
    assert.equal(session.pending_token, null);
    assert.equal(session.fallback_active, false);
  });

  await check("blocking survives session cleanup; unblock permits later messages", async () => {
    await db.deleteSessions(["conversation-a"]);
    assert.equal(await db.getSession("conversation-a"), null);
    assert.equal(await db.isSessionBlocked("website-a", "conversation-a"), true);
    await db.unblockSession("website-a", "session_conversation-a");
    assert.equal(await db.isSessionBlocked("website-a", "conversation-a"), false);
  });

  await check("retention preserves recent activity and outstanding human deadlines", async () => {
    const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (const name of ["old-customer", "old-human", "old-pending", "truly-expired"]) {
      await db.upsertSession({
        website_id: "website-a", session_id: name,
        enable_reply: false, enable_time: stale, thread: [],
      });
    }
    await db.updateSession("old-customer", { last_customer_at: new Date() });
    await db.updateSession("old-human", { last_human_at: new Date() });
    await db.updateSession("old-pending", {
      pending_token: "must-recover", pending_since: stale, deadline_at: stale,
    });
    await sql!`
      insert into control_event (event_key, created_at)
      values ('expired-control', ${stale}), ('current-control', now())`;
    const deleted = await db.deleteSessionsBefore(cutoff);
    assert.deepEqual(Array.from(deleted), ["truly-expired"]);
    for (const name of ["old-customer", "old-human", "old-pending"]) {
      assert.ok(await db.getSession(name));
    }
    const pending = await db.listPendingSessions();
    assert.ok(pending.some(session => session.session_id === "old-pending"));
    const retainedEvents = await sql!`
      select event_key from control_event where event_key in ('expired-control', 'current-control')`;
    assert.deepEqual(Array.from(retainedEvents, (row: any) => row.event_key), ["current-control"]);
  });

  const supportApi = (await import("../../src/api/support.controller")).default;
  const request = async (path: string, body?: unknown) =>
    supportApi.request(path, body === undefined ? undefined : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

  await check("support API validates actions and persists complete configurations", async () => {
    const invalid = await request("/", {
      project_id: projectId,
      support: { enabled: true, offline: { action: "message", message: "" } },
    });
    assert.equal(invalid.status, 400);
    const aiConflict = await request("/", {
      project_id: projectId, support: { enabled: true, offline: { action: "ai" } },
    });
    assert.equal(aiConflict.status, 400);
    const saved = await request("/", { project_id: projectId, support: activeConfig });
    assert.equal(saved.status, 200);
    const loaded = await request(`/?project_id=${projectId}`);
    assert.equal(loaded.status, 200);
    const body = await loaded.json() as any;
    assert.deepEqual(body.data.support, activeConfig);
  });

  await check("support API blocks and unblocks prefixed session IDs", async () => {
    const blocked = await request("/block", {
      project_id: projectId, session_id: "session_from-api", reason: "manual test",
    });
    assert.equal(blocked.status, 200);
    assert.equal(await db.isSessionBlocked("website-a", "from-api"), true);
    await connection.zadd("crispai:abuse:website-a:from-api", Date.now(), "test-message");
    const unblocked = await request("/unblock", {
      project_id: projectId, session_id: "session_from-api",
    });
    assert.equal(unblocked.status, 200);
    assert.equal(await db.isSessionBlocked("website-a", "from-api"), false);
    assert.equal(await connection.exists("crispai:abuse:website-a:from-api"), 0);
    assert.equal((await request("/block", {
      project_id: projectId, session_id: "session_",
    })).status, 400);
  });

  await check("deleting a project also removes its moderation state", async () => {
    await db.blockSession("website-a", "orphan-block", "cleanup test");
    await db.deleteProject(projectId);
    assert.equal(await db.getProjectById(projectId), null);
    assert.equal((await db.listBlockedSessions("website-a")).length, 0);
    assert.equal(await db.getSession("human-first"), null);
  });
  console.log(`Database integration checks passed: ${checks}`);
} finally {
  await sql?.close();
  await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
  await admin.close();
  await connection.quit();
}
