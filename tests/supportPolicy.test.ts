import { describe, test, expect } from "bun:test";
import { parseSupportConfig } from "../src/types/support";
import { customerAction, isSupportOnline, timeoutIsCurrent, noticeIsDue } from "../src/services/support.policy";

describe("客服策略优先级与营业时间", () => {
  test("旧项目保留原行为；在线等人工；离线使用配置动作", () => {
    const config = parseSupportConfig({});
    expect(customerAction(config, {})).toBe("legacy");
    config.enabled = true;
    expect(customerAction(config, {})).toBe("wait");
    config.online = false;
    config.offline.action = "ai";
    expect(customerAction(config, {})).toBe("ai");
  });
  test("超时AI持续接管，超时提示只发送一次", () => {
    const config = parseSupportConfig({ enabled: true });
    expect(customerAction(config, { fallback_active: true, fallback_action: "ai" })).toBe("ai");
    expect(customerAction(config, { fallback_active: true, fallback_action: "message" })).toBe("none");
  });
  test("手动模式覆盖营业时间；自动模式按配置时区计算边界", () => {
    const config = parseSupportConfig({ enabled: true, online: false, availabilityMode: "schedule" });
    expect(isSupportOnline(config, new Date("2026-10-19T00:59:00Z"))).toBe(false);
    expect(isSupportOnline(config, new Date("2026-10-19T01:00:00Z"))).toBe(true);
    expect(isSupportOnline(config, new Date("2026-10-19T10:00:00Z"))).toBe(false);
    expect(isSupportOnline(config, new Date("2026-10-18T04:00:00Z"))).toBe(false);
    config.availabilityMode = "manual";
    expect(isSupportOnline(config, new Date("2026-10-19T02:00:00Z"))).toBe(false);
  });
  test("跨午夜班次归属于开始日，跨周也正确", () => {
    const config = parseSupportConfig({
      availabilityMode: "schedule", schedule: { days: [7], start: "22:00", end: "06:00", timezone: "Asia/Shanghai" },
    });
    expect(isSupportOnline(config, new Date("2026-10-18T14:00:00Z"))).toBe(true);
    expect(isSupportOnline(config, new Date("2026-10-18T21:59:00Z"))).toBe(true);
    expect(isSupportOnline(config, new Date("2026-10-18T22:00:00Z"))).toBe(false);
    expect(isSupportOnline(config, new Date("2026-10-19T15:00:00Z"))).toBe(false);
  });
  test("过期token、未到截止时间不能触发；离线提示有冷却", () => {
    const now = new Date("2026-10-20T00:00:00Z");
    const session = { pending_token: "new", deadline_at: new Date(now.getTime() - 1) } as Session;
    expect(timeoutIsCurrent(session, "old", now)).toBe(false);
    expect(timeoutIsCurrent(session, "new", now)).toBe(true);
    session.deadline_at = new Date(now.getTime() + 1);
    expect(timeoutIsCurrent(session, "new", now)).toBe(false);
    expect(noticeIsDue(session, now)).toBe(true);
    session.last_auto_reply_at = new Date(now.getTime() - 59_999);
    expect(noticeIsDue(session, now)).toBe(false);
    session.last_auto_reply_at = new Date(now.getTime() - 60_000);
    expect(noticeIsDue(session, now)).toBe(true);
  });
});
