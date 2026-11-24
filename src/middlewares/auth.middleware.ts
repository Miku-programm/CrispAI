import type { Context, Next } from "hono";
import { basicAuth } from "hono/basic-auth";
import { getConnInfo } from "hono/bun";
import logger from "@/services/logger.service";

/**
 * 管理后台的 Basic 认证（单用户）
 *
 * 账号密码来自环境变量 `ADMIN_USER`（默认 admin）/ `ADMIN_PASSWORD`。
 * 没配置 `ADMIN_PASSWORD` 时后台整体拒绝访问，而不是放行或让进程退出：
 * Webhook 照常工作，只是管理页面打不开。
 */
const username = Bun.env.ADMIN_USER || "admin";
const password = Bun.env.ADMIN_PASSWORD;

if (!password) {
  logger.error("未配置 ADMIN_PASSWORD，管理后台和 /api/v1 已禁用");
}

const auth = password
  ? basicAuth({ username, password, realm: "CrispAI" })
  : null;

/**
 * 登录失败限制：同一来源在窗口内输错太多次就暂时拒绝，防止暴力猜密码。
 * 单进程内存计数就够用（单用户后台），重启即清零。
 */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED = 10_000;

export class LoginLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max = LOGIN_MAX_FAILURES,
    private readonly windowMs = LOGIN_WINDOW_MS,
  ) {}

  /** 还要等多少毫秒才能再试；0 表示没被限制 */
  retryAfter(key: string, now = Date.now()): number {
    const entry = this.failures.get(key);
    if (!entry) return 0;
    if (entry.resetAt <= now) {
      this.failures.delete(key);
      return 0;
    }
    return entry.count >= this.max ? entry.resetAt - now : 0;
  }

  fail(key: string, now = Date.now()) {
    const entry = this.failures.get(key);
    if (entry && entry.resetAt > now) {
      entry.count++;
      return;
    }
    // 记录数有上限，伪造大量来源也撑不爆内存：先清过期的，还满就丢最早的
    if (this.failures.size >= MAX_TRACKED) {
      for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
      if (this.failures.size >= MAX_TRACKED) {
        this.failures.delete(this.failures.keys().next().value!);
      }
    }
    this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  succeed(key: string) {
    this.failures.delete(key);
  }
}

const isPrivate = (ip: string) =>
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:|::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i
    .test(ip);

/**
 * 是否信任反向代理传来的 X-Forwarded-For。默认不信任：这个头客户端可以随便写，
 * 只有确认反向代理会追加或覆盖它之后才能打开（Nginx 默认原样转发，必须自己配置，见 README）
 */
const trustProxy = () => /^(1|true|yes|on)$/i.test(Bun.env.TRUST_PROXY ?? "");

/**
 * 请求来源，用作登录限流的计数键。
 *
 * - 默认：只认直接连上来的地址。在反向代理后面时所有人都是代理的地址，共用一个计数
 * - TRUST_PROXY=true：连接来自本机/内网（即反向代理）时，取 X-Forwarded-For 的最后一段，
 *   那是代理自己追加的，前面的部分客户端可以伪造
 */
export const clientKey = (c: Context): string => {
  let remote = "";
  try {
    remote = getConnInfo(c).remote.address ?? "";
  } catch {}
  if (!trustProxy()) return remote || "unknown";
  if (remote && !isPrivate(remote)) return remote;
  const forwarded = (c.req.header("x-forwarded-for") ?? "")
    .split(",").map((part) => part.trim()).filter(Boolean).pop();
  return forwarded || remote || "unknown";
};

/**
 * 分不清真实来源时（没信任代理，而连接来自本机/内网），所有访问者共用一个计数。
 * 这时阈值放宽：既能把暴力猜密码压到很慢，又不至于别人随手输错几次就把管理员也挡在外面
 */
export const SHARED_SOURCE_MAX_FAILURES = 60;
const isSharedSource = (key: string) =>
  !trustProxy() && (key === "unknown" || isPrivate(key.replace(/^mcp:/, "")));

const limiter = new LoginLimiter();
const sharedLimiter = new LoginLimiter(SHARED_SOURCE_MAX_FAILURES);
/** 按来源是否可区分选用对应阈值的计数器 */
export const limiterFor = (key: string, own = limiter, shared = sharedLimiter) =>
  isSharedSource(key) ? shared : own;

export const authMiddleware = async (c: Context, next: Next) => {
  if (!auth) {
    return c.json({ message: "未配置 ADMIN_PASSWORD，管理后台已禁用" }, 503);
  }
  const key = clientKey(c);
  const limiter = limiterFor(key);
  const wait = limiter.retryAfter(key);
  if (wait > 0) {
    c.header("Retry-After", String(Math.ceil(wait / 1000)));
    return c.json({ message: "登录失败次数过多，请稍后再试" }, 429);
  }
  const attempted = !!c.req.header("authorization");
  try {
    const result = await auth(c, next);
    if (attempted) limiter.succeed(key);
    return result;
  } catch (error) {
    // 没带凭据的请求（浏览器第一次弹登录框）不算失败，只统计输错的
    if (attempted && (error as any)?.status === 401) {
      limiter.fail(key);
      if (limiter.retryAfter(key) > 0) logger.warn("后台登录失败次数过多，已临时限制", { ip: key });
    }
    throw error;
  }
};
