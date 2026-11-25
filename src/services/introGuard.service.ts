import z from "zod";

/**
 * /api/v1/intro 是唯一不需要认证的写接口（访客网站上的 intro.js 跨域调用），
 * 任何人都能调，所以入队之前要自己把关：格式、频率、去重。
 */

// Crisp 的 website_id 是 UUID，session_id 是 "session_" + UUID。
// 这两个值会拼进 Crisp API 的请求路径，不能放任意字符进来
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const introSchema = z.object({
  website_id: z.string().regex(new RegExp(`^${UUID}$`, "i")),
  session_id: z.string().regex(new RegExp(`^session_${UUID}$`, "i")),
});
export type IntroRequest = z.infer<typeof introSchema>;

/** 请求体上限。正常请求不到 200 字节 */
export const INTRO_BODY_LIMIT = 2 * 1024;
/** 同一会话多久内只处理一次欢迎语（页面刷新、多标签页会重复触发） */
export const INTRO_SESSION_COOLDOWN = 60;
/** 每个站点每分钟最多受理多少次，超过的直接丢弃。可用 INTRO_RATE_LIMIT 调整 */
export const introRateLimit = (raw = Bun.env.INTRO_RATE_LIMIT) => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : 300;
};

type RedisLike = {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

/**
 * 原子地做两件事：站点级限流 + 会话级去重。返回 true 表示可以入队。
 * 先判会话去重再计数，重复刷新同一个会话不会消耗站点额度。
 */
export async function allowIntro(
  redis: RedisLike,
  { website_id, session_id }: IntroRequest,
  limit = introRateLimit(),
  now = Date.now(),
): Promise<boolean> {
  const website = website_id.toLowerCase();
  const minute = Math.floor(now / 60_000);
  const result = await redis.eval(
    `if redis.call('SET', KEYS[1], '1', 'EX', ARGV[1], 'NX') == false then return 0 end
     local count = redis.call('INCR', KEYS[2])
     if count == 1 then redis.call('EXPIRE', KEYS[2], 120) end
     if count > tonumber(ARGV[2]) then return 0 end
     return 1`,
    2,
    `crispai:intro:session:${website}:${session_id.toLowerCase()}`,
    `crispai:intro:rate:${website}:${minute}`,
    INTRO_SESSION_COOLDOWN,
    limit,
  );
  return Number(result) === 1;
}

/**
 * 欢迎语任务不需要保留做重投去重，处理完就从 Redis 删掉自己。
 *
 * 注意不能写成 { age, count }：BullMQ 的按时间/数量清理是对整条队列的已完成集合生效的，
 * 而欢迎语和客户消息共用会话通道，那样会把其他 Webhook 任务用来去重的记录一起清掉，
 * 导致 Crisp 重投时重复回复。true 只删除当前这一个任务
 */
export const INTRO_JOB_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: true,
} as const;
