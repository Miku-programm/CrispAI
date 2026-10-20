import z from "zod";

export const supportActionSchema = z.enum(["ai", "message", "rules", "none"]);
export type SupportAction = z.infer<typeof supportActionSchema>;

const actionFields = {
  action: supportActionSchema.default("none"),
  message: z.string().trim().max(4000, "自动回复内容不能超过 4000 字").default(""),
};

/** 未启用时保留原来的自动回复行为。所有时间统一按秒保存。 */
export const supportSchema = z
  .object({
    enabled: z.boolean().default(false),
    online: z.boolean().default(true),
    availabilityMode: z.enum(["manual", "schedule"]).default("manual"),
    schedule: z.object({
      timezone: z.string().min(1).refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "时区无效，请使用 Asia/Shanghai 等 IANA 时区").default("Asia/Shanghai"),
      days: z.array(z.number().int().min(1).max(7)).min(1, "请至少选择一个营业日")
        .max(7).refine((value) => new Set(value).size === value.length, "营业日不能重复")
        .default([1, 2, 3, 4, 5]),
      start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "开始时间应为 HH:mm").default("09:00"),
      end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "结束时间应为 HH:mm").default("18:00"),
    }).default({}),
    offline: z.object(actionFields).default({}),
    timeout: z
      .object({
        ...actionFields,
        enabled: z.boolean().default(false),
        seconds: z.number().int().min(1).max(86400).default(300),
      })
      .default({}),
    abuse: z
      .object({
        enabled: z.boolean().default(false),
        windowSeconds: z.number().int().min(1).max(3600).default(60),
        maxMessages: z.number().int().min(2).max(1000).default(20),
      })
      .default({}),
  })
  .superRefine((config, ctx) => {
    if (config.schedule.start === config.schedule.end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedule", "end"],
        message: "营业开始和结束时间不能相同",
      });
    }
    if (!config.enabled) return;
    if (config.offline.action === "message" && !config.offline.message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["offline", "message"],
        message: "请填写离线提示内容，包含工单入口或联系邮箱",
      });
    }
    if (
      config.timeout.enabled &&
      config.timeout.action === "message" &&
      !config.timeout.message
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeout", "message"],
        message: "请填写超时提示内容，填写工单入口或联系邮箱",
      });
    }
  });

export type SupportConfig = z.infer<typeof supportSchema>;

/** 旧项目的空配置使用默认值；异常数据不会意外开启客服策略。 */
export const parseSupportConfig = (value: unknown): SupportConfig => {
  const result = supportSchema.safeParse(value ?? {});
  return result.success ? result.data : supportSchema.parse({});
};

/** rules 在 AI 关闭时仍可仅执行关键词；ai 动作必须显式开启项目 AI。 */
export const supportConflictMessage = (
  config: SupportConfig,
  enableAI: boolean,
): string | null => {
  if (!config.enabled || enableAI) return null;
  if (config.offline.action === "ai") {
    return "离线策略选择了 AI 接管，请先在原管理后台开启该项目的 AI 回复，或改用其他动作";
  }
  if (config.timeout.enabled && config.timeout.action === "ai") {
    return "超时策略选择了 AI 接管，请先在原管理后台开启该项目的 AI 回复，或改用其他动作";
  }
  return null;
};
