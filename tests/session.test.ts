import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  checkCredentials,
  createSessionToken,
  isSameSiteRequest,
  safeNext,
  SESSION_TTL_SECONDS,
  useSecureCookie,
  verifySessionToken,
} from "../src/services/session.service";

const saved = { ...process.env };
beforeAll(() => {
  process.env.ADMIN_USER = "boss";
  process.env.ADMIN_PASSWORD = "correct horse";
  delete process.env.SESSION_SECRET;
  delete process.env.PUBLIC_URL;
});
afterAll(() => {
  for (const key of ["ADMIN_USER", "ADMIN_PASSWORD", "SESSION_SECRET", "PUBLIC_URL"]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

test("credentials must match exactly and never pass when no password is configured", () => {
  expect(checkCredentials("boss", "correct horse")).toBe(true);
  expect(checkCredentials("boss", "correct horse ")).toBe(false);
  expect(checkCredentials("Boss", "correct horse")).toBe(false);
  expect(checkCredentials("boss", "")).toBe(false);
  expect(checkCredentials(undefined, undefined)).toBe(false);
  expect(checkCredentials(["boss"], { a: 1 })).toBe(false);
  const password = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  expect(checkCredentials("boss", "")).toBe(false);
  expect(checkCredentials("boss", "undefined")).toBe(false);
  process.env.ADMIN_PASSWORD = password;
});

test("a session token is valid until it expires and cannot be altered or forged", () => {
  const now = 1_800_000_000_000;
  const token = createSessionToken(now);
  expect(verifySessionToken(token, now)).toBe(true);
  expect(verifySessionToken(token, now + (SESSION_TTL_SECONDS - 1) * 1000)).toBe(true);
  expect(verifySessionToken(token, now + (SESSION_TTL_SECONDS + 1) * 1000)).toBe(false);
  expect(createSessionToken(now)).not.toBe(token);

  const [expires, nonce, signature] = token.split(".");
  // extending the expiry, swapping the nonce or dropping the signature must all fail
  expect(verifySessionToken(`${Number(expires) + 999999}.${nonce}.${signature}`, now)).toBe(false);
  expect(verifySessionToken(`${expires}.AAAA.${signature}`, now)).toBe(false);
  expect(verifySessionToken(`${expires}.${nonce}.`, now)).toBe(false);
  expect(verifySessionToken(`${expires}.${nonce}`, now)).toBe(false);
  for (const junk of ["", "a.b.c", "..", undefined, null, 42, "x".repeat(500)]) {
    expect(verifySessionToken(junk, now)).toBe(false);
  }
});

test("changing the password or SESSION_SECRET signs every browser out", () => {
  const now = Date.now();
  const token = createSessionToken(now);
  process.env.ADMIN_PASSWORD = "new password";
  expect(verifySessionToken(token, now)).toBe(false);
  process.env.ADMIN_PASSWORD = "correct horse";
  expect(verifySessionToken(token, now)).toBe(true);
  process.env.SESSION_SECRET = "rotated";
  expect(verifySessionToken(token, now)).toBe(false);
  delete process.env.SESSION_SECRET;
  delete process.env.ADMIN_PASSWORD;
  expect(verifySessionToken(token, now)).toBe(false);
  process.env.ADMIN_PASSWORD = "correct horse";
});

test("post-login redirect only accepts local paths", () => {
  expect(safeNext("/dashboard/project?id=1")).toBe("/dashboard/project?id=1");
  expect(safeNext("/support")).toBe("/support");
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)",
    "evil", "", undefined, null, "/login", "/login?next=/x", "/a b", 5]) {
    expect(safeNext(bad)).toBe("/");
  }
});

test("cookie-authenticated writes must come from the same site", () => {
  const ctx = (method: string, headers: Record<string, string>) =>
    ({ req: { method, header: (name: string) => headers[name.toLowerCase()] } }) as any;
  expect(isSameSiteRequest(ctx("GET", { "sec-fetch-site": "cross-site" }))).toBe(true);
  expect(isSameSiteRequest(ctx("POST", { "sec-fetch-site": "same-origin" }))).toBe(true);
  expect(isSameSiteRequest(ctx("POST", { "sec-fetch-site": "none" }))).toBe(true);
  expect(isSameSiteRequest(ctx("POST", { "sec-fetch-site": "cross-site" }))).toBe(false);
  expect(isSameSiteRequest(ctx("DELETE", { "sec-fetch-site": "same-site" }))).toBe(false);
  // older browsers: fall back to Origin
  expect(isSameSiteRequest(ctx("POST", { origin: "https://app.example", host: "app.example" }))).toBe(true);
  expect(isSameSiteRequest(ctx("POST", { origin: "https://evil.example", host: "app.example" }))).toBe(false);
  expect(isSameSiteRequest(ctx("POST", { origin: "null", host: "app.example" }))).toBe(false);
  expect(isSameSiteRequest(ctx("POST", { origin: "https://app.example", host: "127.0.0.1:3000",
    "x-forwarded-host": "app.example" }))).toBe(true);
  process.env.PUBLIC_URL = "https://app.example";
  expect(isSameSiteRequest(ctx("POST", { origin: "https://app.example", host: "127.0.0.1:3000" }))).toBe(true);
  delete process.env.PUBLIC_URL;
  // non-browser clients send neither header
  expect(isSameSiteRequest(ctx("POST", {}))).toBe(true);
});

test("the session cookie is Secure whenever the site is https and cannot be downgraded by the request", () => {
  const ctx = (url: string, headers: Record<string, string> = {}) =>
    ({ req: { url, header: (name: string) => headers[name.toLowerCase()] } }) as any;
  const keys = ["PUBLIC_URL", "COOKIE_SECURE"] as const;
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.COOKIE_SECURE;
    process.env.PUBLIC_URL = "https://app.example";
    // TLS terminator -> internal plain-http proxy: forwarded proto says http, host may be rewritten
    expect(useSecureCookie(ctx("http://127.0.0.1:3000/api/v1/login", { "x-forwarded-proto": "http" }))).toBe(true);
    expect(useSecureCookie(ctx("http://127.0.0.1:3000/api/v1/login", { host: "127.0.0.1:3000" }))).toBe(true);
    expect(useSecureCookie(ctx("http://10.0.0.5:3000/x"))).toBe(true);

    delete process.env.PUBLIC_URL; // local development
    expect(useSecureCookie(ctx("http://localhost:3000/x"))).toBe(false);
    expect(useSecureCookie(ctx("http://localhost:3000/x", { "x-forwarded-proto": "https" }))).toBe(true);
    expect(useSecureCookie(ctx("https://localhost:3000/x", { "x-forwarded-proto": "http" }))).toBe(true);
    process.env.PUBLIC_URL = "http://localhost:3000";
    expect(useSecureCookie(ctx("http://localhost:3000/x"))).toBe(false);

    process.env.PUBLIC_URL = "https://app.example";
    process.env.COOKIE_SECURE = "false";
    expect(useSecureCookie(ctx("http://localhost:3000/x"))).toBe(false);
    process.env.COOKIE_SECURE = "true";
    delete process.env.PUBLIC_URL;
    expect(useSecureCookie(ctx("http://localhost:3000/x"))).toBe(true);
  } finally {
    for (const k of keys) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
  }
});
