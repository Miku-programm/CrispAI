import type { SupportConfig, SupportAction } from "@/types/support";

/** Days use ISO numbering: Monday=1, Sunday=7. Overnight shifts belong to their starting day. */
export function isSupportOnline(config: SupportConfig, now = new Date()): boolean {
  if (config.availabilityMode !== "schedule") return config.online;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.schedule.timezone,
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(value("weekday")) + 1;
  const minutes = Number(value("hour")) * 60 + Number(value("minute"));
  const time = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const start = time(config.schedule.start), end = time(config.schedule.end);
  if (start < end) return config.schedule.days.includes(day) && minutes >= start && minutes < end;
  return (config.schedule.days.includes(day) && minutes >= start)
    || (config.schedule.days.includes(day === 1 ? 7 : day - 1) && minutes < end);
}

export function customerAction(
  config: SupportConfig,
  session: Pick<Session, "fallback_active" | "fallback_action">,
  now = new Date(),
): SupportAction | "legacy" | "wait" {
  if (!config.enabled) return "legacy";
  if (!isSupportOnline(config, now)) return config.offline.action;
  if (session.fallback_active) {
    // A timeout notice is sent once per unanswered conversation, not on every follow-up.
    return session.fallback_action === "message" ? "none" : session.fallback_action ?? "none";
  }
  return "wait";
}

export const timeoutIsCurrent = (
  session: Session | null,
  token: string,
  now = new Date(),
) => !!session && session.pending_token === token && !!session.deadline_at
  && new Date(session.deadline_at).getTime() <= now.getTime();

export const noticeIsDue = (session: Session, now = new Date()) =>
  !session.last_auto_reply_at || now.getTime() - new Date(session.last_auto_reply_at).getTime() >= 60_000;
