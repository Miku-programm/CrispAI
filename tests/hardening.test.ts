import { expect, test } from "bun:test";
import Crypto from "crypto";
import { isFreshTimestamp, signatureMatches } from "../src/middlewares/crisp.middleware";
import { clientKey, limiterFor, LoginLimiter } from "../src/middlewares/auth.middleware";
import { aiSessionLimit, allowAICall } from "../src/services/aiBudget.service";

const sign = (secret: string, timestamp: string, body: unknown) =>
  Crypto.createHmac("sha256", secret)
    .update("[" + timestamp + ";" + JSON.stringify(body) + "]").digest("hex");

test("webhook signature accepts only the exact HMAC", () => {
  const body = { event: "message:send", data: { a: 1 } };
  const good = sign("secret", "1700000000000", body);
  expect(signatureMatches("secret", "1700000000000", body, good)).toBe(true);
  expect(signatureMatches("secret", "1700000000000", body, good.toUpperCase())).toBe(true);
  expect(signatureMatches("secret", "1700000000001", body, good)).toBe(false);
  expect(signatureMatches("other", "1700000000000", body, good)).toBe(false);
  expect(signatureMatches("secret", "1700000000000", { ...body, x: 1 }, good)).toBe(false);
  expect(signatureMatches("secret", "1700000000000", body, good.slice(0, 10))).toBe(false);
  expect(signatureMatches("secret", "1700000000000", body, "")).toBe(false);
});

test("webhook timestamp must be recent, in ms or seconds", () => {
  const now = 1_800_000_000_000;
  const day = 24 * 3600 * 1000;
  expect(isFreshTimestamp(String(now), now, day)).toBe(true);
  expect(isFreshTimestamp(String(now / 1000), now, day)).toBe(true);
  expect(isFreshTimestamp(String(now - day + 1000), now, day)).toBe(true);
  expect(isFreshTimestamp(String(now - day - 1000), now, day)).toBe(false);
  expect(isFreshTimestamp(String(now + 3600_000), now, day)).toBe(false);
  expect(isFreshTimestamp(String(now - 30 * day), now, 0)).toBe(true);
  for (const bad of ["", "abc", "12abc", "-5", "1e12", " 1"]) {
    expect(isFreshTimestamp(bad, now, day)).toBe(false);
  }
});

test("login limiter locks a source after repeated failures and recovers", () => {
  const limiter = new LoginLimiter(3, 1000);
  expect(limiter.retryAfter("a", 0)).toBe(0);
  limiter.fail("a", 0); limiter.fail("a", 10);
  expect(limiter.retryAfter("a", 20)).toBe(0);
  limiter.fail("a", 20);
  expect(limiter.retryAfter("a", 30)).toBe(970);
  expect(limiter.retryAfter("b", 30)).toBe(0);
  expect(limiter.retryAfter("a", 1001)).toBe(0);
  limiter.fail("c", 0); limiter.fail("c", 0);
  limiter.succeed("c");
  limiter.fail("c", 0);
  expect(limiter.retryAfter("c", 1)).toBe(0);
});

test("AI call budget is per session and can be disabled", async () => {
  const counts = new Map<string, number>();
  const redis = { eval: async (_s: string, _n: number, key: string | number) => {
    const next = (counts.get(String(key)) ?? 0) + 1; counts.set(String(key), next); return next;
  } };
  const results: boolean[] = [];
  for (let i = 0; i < 5; i++) results.push(await allowAICall("w", "session_s1", 3, redis as any, 0));
  expect(results).toEqual([true, true, true, false, false]);
  expect(await allowAICall("w", "s2", 3, redis as any, 0)).toBe(true);
  // the "session_" prefix must not open a second budget for the same conversation
  expect(await allowAICall("w", "s1", 3, redis as any, 0)).toBe(false);
  expect(await allowAICall("w", "s1", 0, redis as any, 0)).toBe(true);
  expect(aiSessionLimit(undefined)).toBe(30);
  expect(aiSessionLimit("0")).toBe(0);
  expect(aiSessionLimit("x")).toBe(30);
});

test("X-Forwarded-For is ignored unless the proxy is explicitly trusted", () => {
  const ctx = (xff?: string) => ({ env: undefined, req: { header: (name: string) =>
    name.toLowerCase() === "x-forwarded-for" ? xff : undefined } }) as any;
  const previous = process.env.TRUST_PROXY;
  try {
    delete process.env.TRUST_PROXY;
    expect(clientKey(ctx("6.6.6.6"))).toBe("unknown");
    expect(clientKey(ctx("1.1.1.1, 2.2.2.2"))).toBe(clientKey(ctx("9.9.9.9")));
    const own = new LoginLimiter(), shared = new LoginLimiter(60);
    expect(limiterFor("unknown", own, shared)).toBe(shared);
    expect(limiterFor("mcp:127.0.0.1", own, shared)).toBe(shared);
    expect(limiterFor("203.0.113.5", own, shared)).toBe(own);

    process.env.TRUST_PROXY = "true";
    // only the last hop, appended by the proxy itself, is used; earlier entries are client-controlled
    expect(clientKey(ctx("6.6.6.6, 203.0.113.9"))).toBe("203.0.113.9");
    expect(clientKey(ctx(undefined))).toBe("unknown");
    expect(limiterFor("203.0.113.9", own, shared)).toBe(own);
    expect(limiterFor("127.0.0.1", own, shared)).toBe(own);
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = previous;
  }
});
