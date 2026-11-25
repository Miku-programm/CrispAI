/**
 * 每个会话的 AI 调用频率上限，和后台的「屏蔽」规则无关，始终生效。
 *
 * 屏蔽规则默认是关的，没有这个上限时任何访客都可以靠连续发消息无限消耗 OpenAI 额度。
 * 超过上限只是这段时间不再调用 AI，消息照常转给 Telegram，不会屏蔽访客。
 * AI_SESSION_RATE_LIMIT 设为 0 可关闭。
 */
export const AI_WINDOW_SECONDS = 600;
export const aiSessionLimit = (raw = Bun.env.AI_SESSION_RATE_LIMIT) => {
  if (raw === undefined || raw === "") return 30;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 30;
};

type RedisLike = {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

export async function allowAICall(
  websiteId: string,
  sessionId: string,
  limit = aiSessionLimit(),
  redis?: RedisLike,
  now = Date.now(),
): Promise<boolean> {
  if (limit === 0) return true;
  // 用到时才加载 Redis 连接，纯逻辑测试不需要真的连上 Redis
  redis ??= (await import("@/services/redis.service")).connection;
  const bucket = Math.floor(now / (AI_WINDOW_SECONDS * 1000));
  const key = `crispai:ai:${websiteId}:${sessionId.replace(/^session_/, "")}:${bucket}`;
  const count = Number(await redis.eval(
    `local count = redis.call('INCR', KEYS[1])
     if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
     return count`,
    1, key, AI_WINDOW_SECONDS * 2,
  ));
  return count <= limit;
}
