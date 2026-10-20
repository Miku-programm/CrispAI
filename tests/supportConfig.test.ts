import { describe, expect, test } from "bun:test";
import {
  parseSupportConfig,
  supportConflictMessage,
  supportSchema,
} from "../src/types/support";

describe("客服接待配置", () => {
  test("旧项目默认不启用新策略，补齐所有可编辑默认值", () => {
    const config = parseSupportConfig({});
    expect(config.enabled).toBe(false);
    expect(config.online).toBe(true);
    expect(config.availabilityMode).toBe("manual");
    expect(config.schedule).toEqual({
      timezone: "Asia/Shanghai", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00",
    });
    expect(config.timeout).toEqual({ enabled: false, seconds: 300, action: "none", message: "" });
    expect(config.abuse).toEqual({ enabled: false, windowSeconds: 60, maxMessages: 20 });
    expect(parseSupportConfig(null)).toEqual(config);
  });

  test("启用消息引导必须填写内容，纯空格不算有效内容", () => {
    expect(supportSchema.safeParse({ enabled: true, offline: { action: "message", message: "  " } }).success).toBe(false);
    expect(supportSchema.safeParse({ enabled: true, timeout: { enabled: true, action: "message" } }).success).toBe(false);
    const config = supportSchema.parse({
      enabled: true, offline: { action: "message", message: "  请联系 support@example.com  " },
    });
    expect(config.offline.message).toBe("请联系 support@example.com");
  });

  test("关闭策略或未启用的超时允许保留尚未填写的消息草稿", () => {
    expect(supportSchema.safeParse({ offline: { action: "message" } }).success).toBe(true);
    expect(supportSchema.safeParse({ enabled: true, timeout: { enabled: false, action: "message" } }).success).toBe(true);
  });

  test("只允许整数秒并限制等待时间在 1 秒至 24 小时", () => {
    for (const seconds of [0, -1, 0.5, 86401, "60"]) {
      expect(supportSchema.safeParse({ timeout: { seconds } }).success).toBe(false);
    }
    for (const seconds of [1, 60, 86400]) {
      expect(supportSchema.parse({ timeout: { seconds } }).timeout.seconds).toBe(seconds);
    }
  });

  test("自动屏蔽窗口与数量都有明确边界", () => {
    for (const abuse of [{ windowSeconds: 0 }, { windowSeconds: 3601 }, { maxMessages: 1 }, { maxMessages: 1001 }, { maxMessages: 2.5 }]) {
      expect(supportSchema.safeParse({ abuse }).success).toBe(false);
    }
    expect(supportSchema.parse({ abuse: { windowSeconds: 1, maxMessages: 2 } }).abuse.maxMessages).toBe(2);
  });

  test("营业时间允许跨午夜，拒绝无效时区、日期与相同起止时间", () => {
    const config = supportSchema.parse({
      availabilityMode: "schedule",
      schedule: { timezone: "Asia/Shanghai", days: [5, 6], start: "22:00", end: "06:00" },
    });
    expect(config.schedule.start).toBe("22:00");
    for (const schedule of [
      { timezone: "Invalid/Timezone" }, { days: [] }, { days: [0] }, { days: [8] },
      { days: [1, 1] }, { start: "24:00" }, { end: "9:00" }, { start: "09:00", end: "09:00" },
    ]) {
      expect(supportSchema.safeParse({ schedule }).success).toBe(false);
    }
  });

  test("AI 接管与项目 AI 开关冲突时返回具体原因", () => {
    const offline = supportSchema.parse({ enabled: true, offline: { action: "ai" } });
    expect(supportConflictMessage(offline, false)).toContain("离线策略");
    expect(supportConflictMessage(offline, true)).toBeNull();
    const timeout = supportSchema.parse({ enabled: true, timeout: { enabled: true, action: "ai" } });
    expect(supportConflictMessage(timeout, false)).toContain("超时策略");
    expect(supportConflictMessage(timeout, true)).toBeNull();
  });

  test("关键词接管在 AI 关闭时仍可保存，不强制开启 AI", () => {
    const config = supportSchema.parse({
      enabled: true, offline: { action: "rules" }, timeout: { enabled: true, action: "rules" },
    });
    expect(supportConflictMessage(config, false)).toBeNull();
    expect(supportConflictMessage(supportSchema.parse({ offline: { action: "ai" } }), false)).toBeNull();
  });

  test("损坏配置回退至未启用默认值，不意外触发接管", () => {
    for (const invalid of [[], "{}", 42, { enabled: "true" }, { enabled: true, timeout: { seconds: -5 } }]) {
      expect(parseSupportConfig(invalid).enabled).toBe(false);
    }
  });
});
