import assert from "node:assert/strict";
import path from "node:path";
import { mock } from "bun:test";
import { supportSchema } from "../../src/types/support";

// The real Hono app and auth middleware are loaded, while external boundaries
// are inert. Importing or requesting these routes must not send external traffic.
Bun.env.ADMIN_USER = "test-admin";
Bun.env.ADMIN_PASSWORD = "test-password";
globalThis.fetch = (() => { throw new Error("Unexpected external request"); }) as unknown as typeof fetch;
const source = (file: string) => path.resolve(import.meta.dir, "../../src", file);
let writes = 0;
const project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test support", websiteId: "test-website", enabled: true,
  enableAI: true, enableKeyword: true, support: supportSchema.parse({}),
};
mock.module("bullmq", () => ({ Queue: class {
  constructor(public name: string) {}
} }));
mock.module(source("services/redis.service.ts"), () => ({ connection: {} }));
mock.module(source("services/logger.service.ts"), () => ({
  default: { info() {}, warn() {}, error() {} },
}));
mock.module(source("services/telegram.service.ts"), () => ({
  default: { isRunning: () => false, start() {} },
  WEBHOOK_SECRET: "test-secret",
}));
mock.module(source("services/crisp.service.ts"), () => ({ crispWebhook: () => {} }));
mock.module(source("services/openai.service.ts"), () => ({
  EMBEDDING_MODEL: "test-embedding",
  createEmbedding: async () => [],
}));
mock.module(source("services/db.service.ts"), () => ({
  getProjectById: async (id: string) => id === project.id ? project : null,
  listBlockedSessions: async () => [],
  saveProjectSupport: async (_: string, support: typeof project.support) => {
    writes++;
    project.support = support;
    return project;
  },
  blockSession: async () => { writes++; },
  unblockSession: async () => { writes++; },
}));

const { default: app, mountWeb } = await import("../../src/services/hono.service");
mountWeb();
const authorization = `Basic ${btoa("test-admin:test-password")}`;
const request = (url: string, authenticated = false, body?: unknown) =>
  app.request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(authenticated ? { Authorization: authorization } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
let passed = 0;
for (const url of ["/support", "/support/", `/api/v1/support?project_id=${project.id}`,
  `/api/v1/support/blocked?project_id=${project.id}`]) {
  const response = await request(url);
  assert.equal(response.status, 401, `${url} requires authentication`);
  assert.ok(response.headers.get("WWW-Authenticate")?.includes("Basic"));
  passed++;
}
assert.equal((await request("/api/v1/support/block", false, {
  project_id: project.id, session_id: "customer",
})).status, 401);
assert.equal(writes, 0);
passed++;
const page = await request("/support", true);
assert.equal(page.status, 200);
assert.match(page.headers.get("Content-Type") ?? "", /text\/html/);
const html = await page.text();
assert.match(html, /客服/);
assert.match(html, /fetch\("\/api\/v1"/);
passed++;
const redirect = await request("/support/", true);
assert.equal(redirect.status, 302);
assert.equal(redirect.headers.get("Location"), "/support");
passed++;
const settings = await request(`/api/v1/support?project_id=${project.id}`, true);
assert.equal(settings.status, 200);
assert.equal((await settings.json() as any).data.project_id, project.id);
passed++;
const saved = await request("/api/v1/support", true, {
  project_id: project.id, support: { enabled: true, online: false, offline: { action: "ai" } },
});
assert.equal(saved.status, 200);
assert.equal(writes, 1);
assert.equal(project.support.offline.action, "ai");
passed++;
assert.equal((await request("/health")).status, 200);
passed++;
console.log(JSON.stringify({ passed }));
