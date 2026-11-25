import Crypto from "crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

/**
 * 登录页用的登录状态（Cookie）。
 *
 * 无状态的签名令牌：`过期时间.随机数.签名`，服务器不保存会话，重启和多副本都不受影响。
 * 签名密钥由管理员账号密码派生，所以改了 ADMIN_PASSWORD 之后所有已登录的浏览器会自动失效；
 * 想在不改密码的情况下让所有登录失效，可以改 SESSION_SECRET。
 */
export const SESSION_COOKIE = "crispai_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

const username = () => Bun.env.ADMIN_USER || "admin";
const password = () => Bun.env.ADMIN_PASSWORD ?? "";

const sha = (value: string) => Crypto.createHash("sha256").update(value).digest();
const safeEqual = (a: string, b: string) => Crypto.timingSafeEqual(sha(a), sha(b));

const signingKey = () =>
  sha(`crispai-session:${username()}:${password()}:${Bun.env.SESSION_SECRET ?? ""}`);
const sign = (payload: string) =>
  Crypto.createHmac("sha256", signingKey()).update(payload).digest("base64url");

/** 账号密码是否正确。两项都做恒定时间比较，不因为用户名不对就提前返回 */
export const checkCredentials = (user: unknown, pass: unknown): boolean => {
  if (!password() || typeof user !== "string" || typeof pass !== "string") return false;
  const userOk = safeEqual(user, username());
  const passOk = safeEqual(pass, password());
  return userOk && passOk;
};

export const createSessionToken = (now = Date.now()): string => {
  const payload = `${Math.floor(now / 1000) + SESSION_TTL_SECONDS}.${Crypto.randomBytes(12).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
};

export const verifySessionToken = (token: unknown, now = Date.now()): boolean => {
  if (!password() || typeof token !== "string" || token.length > 200) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expires, nonce, signature] = parts as [string, string, string];
  if (!/^\d{1,12}$/.test(expires)) return false;
  if (!safeEqual(signature, sign(`${expires}.${nonce}`))) return false;
  return Number(expires) * 1000 > now;
};

export const hasSession = (c: Context) => verifySessionToken(getCookie(c, SESSION_COOKIE));

/**
 * 登录 Cookie 要不要加 Secure（只在 https 下发送）。
 *
 * 以配置为准，不让请求里的信息把它降级：
 * - COOKIE_SECURE=true / false 明确指定
 * - 否则 PUBLIC_URL 是 https 就一律加。正式部署都是 https，无论反向代理怎么转发、
 *   带不带 X-Forwarded-Proto，Cookie 都不会在明文连接上发出去
 * - PUBLIC_URL 不是 https（本机调试）时，才看这次请求本身是不是 https
 */
export const useSecureCookie = (c: Context): boolean => {
  const override = (Bun.env.COOKIE_SECURE ?? "").trim().toLowerCase();
  if (/^(1|true|yes|on)$/.test(override)) return true;
  if (/^(0|false|no|off)$/.test(override)) return false;
  if (/^https:\/\//i.test(Bun.env.PUBLIC_URL ?? "")) return true;
  try {
    if (new URL(c.req.url).protocol === "https:") return true;
  } catch {}
  const forwarded = (c.req.header("x-forwarded-proto") ?? "").split(",")[0]!.trim().toLowerCase();
  return forwarded === "https";
};

/** 发登录 Cookie，返回它是否带了 Secure（登录页据此提示“http 下保存不了登录状态”） */
export const startSession = (c: Context): boolean => {
  const secure = useSecureCookie(c);
  setCookie(c, SESSION_COOKIE, createSessionToken(), {
    path: "/",
    httpOnly: true,
    // Lax：别的网站发起的 POST/PUT/DELETE 不会带上这个 Cookie
    sameSite: "Lax",
    secure,
    maxAge: SESSION_TTL_SECONDS,
  });
  return secure;
};

export const endSession = (c: Context) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
};

/** 登录后跳转的地址只允许站内路径，防止被用来跳到别的网站 */
export const safeNext = (next: unknown): string =>
  typeof next === "string" && /^\/(?![/\\])[^\s]*$/.test(next) && !next.startsWith("/login")
    ? next
    : "/";

/**
 * 已登录（带 Cookie）的写操作必须来自本站页面。
 * 现代浏览器都会带 Sec-Fetch-Site，以它为准；没有这个头时退回比较 Origin
 */
export const isSameSiteRequest = (c: Context): boolean => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return true;
  const site = c.req.header("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = c.req.header("origin");
  if (!origin) return true; // 非浏览器客户端不存在跨站伪造的问题
  try {
    const host = new URL(origin).host;
    const allowed = [c.req.header("host"), c.req.header("x-forwarded-host")];
    try { allowed.push(new URL(Bun.env.PUBLIC_URL ?? "").host); } catch {}
    return allowed.includes(host);
  } catch {
    return false;
  }
};
