import { expect, test } from "bun:test";
import { allowIntro, introRateLimit, introSchema } from "../src/services/introGuard.service";

const website = "8c842203-7ed8-4e29-a608-7cf78a7d2fcc";
const session = (n: number) =>
  `session_700c65e1-85e2-465a-b9ac-${String(n).padStart(12, "0")}`;

/** Minimal stand-in that implements exactly what the guard script does. */
const fakeRedis = () => {
  const keys = new Map<string, number>();
  return {
    keys,
    async eval(_script: string, _n: number, ...args: (string | number)[]) {
      const [sessionKey, rateKey, , limit] = args as [string, string, number, number];
      if (keys.has(sessionKey)) return 0;
      keys.set(sessionKey, 1);
      const count = (keys.get(rateKey) ?? 0) + 1;
      keys.set(rateKey, count);
      return count > Number(limit) ? 0 : 1;
    },
  };
};

test("schema only accepts Crisp-shaped identifiers", () => {
  expect(introSchema.safeParse({ website_id: website, session_id: session(1) }).success).toBe(true);
  for (const bad of [
    { website_id: "x", session_id: session(1) },
    { website_id: website, session_id: "abc" },
    { website_id: website, session_id: `${session(1)}/../../x` },
    { website_id: website, session_id: `${session(1)}?a=1` },
    { website_id: `${website}/..`, session_id: session(1) },
  ]) {
    expect(introSchema.safeParse(bad).success).toBe(false);
  }
});

test("schema strips fields the endpoint does not need", () => {
  const parsed = introSchema.parse({
    website_id: website, session_id: session(1), junk: "x".repeat(1000),
  });
  expect(Object.keys(parsed).sort()).toEqual(["session_id", "website_id"]);
});

test("the same session is accepted once per cooldown", async () => {
  const redis = fakeRedis();
  const request = { website_id: website, session_id: session(1) };
  expect(await allowIntro(redis, request, 10, 0)).toBe(true);
  expect(await allowIntro(redis, request, 10, 0)).toBe(false);
});

test("a flood of distinct sessions stops at the per-site limit", async () => {
  const redis = fakeRedis();
  let accepted = 0;
  for (let i = 0; i < 50; i++) {
    if (await allowIntro(redis, { website_id: website, session_id: session(i) }, 5, 0)) accepted++;
  }
  expect(accepted).toBe(5);
});

test("rate limit falls back to the default on bad configuration", () => {
  expect(introRateLimit(undefined)).toBe(300);
  expect(introRateLimit("abc")).toBe(300);
  expect(introRateLimit("-1")).toBe(300);
  expect(introRateLimit("50")).toBe(50);
});
