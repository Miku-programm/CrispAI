import type { Context, Next } from "hono";
import Crypto from "crypto";
import logger from "@/services/logger.service";

/**
 * 允许的最大时间差。Crisp 投递失败后会重试，重试带的可能还是原来的时间戳，
 * 所以窗口放得比较宽（默认 24 小时）：主要是让截获的旧请求不能无限期重放，
 * 短时间内的重复投递由 fingerprint 去重负责。CRISP_WEBHOOK_MAX_AGE（秒）可调，0 表示不检查
 */
const maxAgeMs = (raw = Bun.env.CRISP_WEBHOOK_MAX_AGE) => {
  if (raw === undefined || raw === "") return 24 * 3600 * 1000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value * 1000 : 24 * 3600 * 1000;
};
// 时间戳比本机快太多同样不可信（留出时钟误差）
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

export const isFreshTimestamp = (
  timestamp: string,
  now = Date.now(),
  maxAge = maxAgeMs(),
): boolean => {
  if (!/^\d{1,16}$/.test(timestamp)) return false;
  let value = Number(timestamp);
  // 兼容秒级时间戳
  if (value < 1e11) value *= 1000;
  if (value - now > MAX_FUTURE_SKEW_MS) return false;
  return maxAge === 0 || now - value <= maxAge;
};

export const signatureMatches = (
  secret: string,
  timestamp: string,
  body: unknown,
  signature: string,
): boolean => {
  const expected = Crypto.createHmac("sha256", secret)
    .update("[" + timestamp + ";" + JSON.stringify(body) + "]")
    .digest();
  // 先各自再哈希一次，长度固定后才能做恒定时间比较，也不泄露长度信息
  const digest = (value: Buffer | string) =>
    Crypto.createHash("sha256").update(value).digest();
  return Crypto.timingSafeEqual(
    digest(expected.toString("hex")),
    digest(signature.toLowerCase()),
  );
};

export const crispMiddleware = async (c: Context, next: Next) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ message: "无效的请求" }, 400);
  }
  const timestamp = c.req.header("x-crisp-request-timestamp") ?? "";
  const signature = c.req.header("x-crisp-signature") ?? "";
  const secret = Bun.env.CRISP_SECRET;

  if (!secret || !signature || !body || typeof body !== "object" || !timestamp) {
    logger.warn("Hook verification failed", {
      secret: !!secret,
      signature: !!signature,
      body: !!body,
      timestamp: !!timestamp,
    });
    return c.json({ message: "无效的请求" }, 400);
  }

  // 注意：不要把正确的签名写进日志，能看日志的人就能伪造任意 Webhook
  if (!signatureMatches(secret, timestamp, body, signature)) {
    logger.warn("Signature verification failed");
    return c.json({ message: "无效的请求" }, 400);
  }
  if (!isFreshTimestamp(timestamp)) {
    logger.warn("Hook timestamp outside the accepted window", { timestamp });
    return c.json({ message: "无效的请求" }, 400);
  }

  await next();
};
