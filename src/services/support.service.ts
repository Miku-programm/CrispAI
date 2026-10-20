import * as db from "@/services/db.service";
import { connection } from "@/services/redis.service";
import { enqueue } from "@/utils/queue";
import { isSupportOnline } from "@/services/support.policy";
import type { SupportConfig } from "@/types/support";

export const cleanSessionId = (id: string) => id.replace(/^session_/, "");

export async function markHumanActivity(websiteId: string, sessionId: string, eventKey?: string) {
  return db.markHumanActivity(websiteId, cleanSessionId(sessionId), eventKey);
}

/** Count arrival rate before queueing. Fingerprint dedup prevents webhook retries from causing a ban. */
export async function checkAbuse(project: any, sessionId: string, eventKey?: string): Promise<boolean> {
  if (await db.isSessionBlocked(project.websiteId, sessionId)) return true;
  const config: SupportConfig = project.support;
  if (!config.abuse.enabled) return false;
  const key = `crispai:abuse:${project.websiteId}:${cleanSessionId(sessionId)}`;
  const now = Date.now();
  const count = Number(await connection.eval(
    `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
     redis.call('ZADD', KEYS[1], 'NX', ARGV[2], ARGV[3])
     redis.call('EXPIRE', KEYS[1], ARGV[4])
     return redis.call('ZCARD', KEYS[1])`,
    1, key, now - config.abuse.windowSeconds * 1000, now,
    eventKey || crypto.randomUUID(), config.abuse.windowSeconds,
  ));
  if (count <= config.abuse.maxMessages) return false;
  await db.blockSession(
    project.websiteId, sessionId,
    `${config.abuse.windowSeconds} 秒内消息超过 ${config.abuse.maxMessages} 条`, "abuse",
  );
  if (await connection.set(`${key}:notice`, "1", "EX", 86400, "NX")) {
    const telegram = await import("@/services/telegram.service");
    await telegram.notifyBlocked(project.websiteId, sessionId);
  }
  return true;
}

export async function unblockCustomer(websiteId: string, sessionId: string) {
  await db.unblockSession(websiteId, sessionId);
  const key = `crispai:abuse:${websiteId}:${cleanSessionId(sessionId)}`;
  await connection.del(key, `${key}:notice`);
}

export async function armTimeout(project: any, session: Session, body: any, receivedAt = Date.now()) {
  const config: SupportConfig = project.support;
  if (!config.enabled || !config.timeout.enabled || !isSupportOnline(config) || session.fallback_active) return;
  // A human reply received after this queued customer event already answered this waiting round.
  if (session.last_human_at && new Date(session.last_human_at).getTime() >= receivedAt) return;
  const token = session.pending_token || crypto.randomUUID();
  const since = session.pending_since ? new Date(session.pending_since) : new Date(receivedAt);
  const deadline = session.deadline_at
    ? new Date(session.deadline_at)
    : new Date(since.getTime() + config.timeout.seconds * 1000);
  // Persist before enqueue. A scan also recovers pending deadlines if Redis briefly fails here.
  const armed = await db.updateSessionIfVersion(session.session_id, session.control_version ?? 0, {
    pending_token: token, pending_since: since, deadline_at: deadline, pending_message: body,
  });
  if (!armed) return;
  const task = (await import("@/jobs/supportTimeout.task")).default;
  await enqueue(task.queue, "supportTimeout", {
    website_id: session.website_id, session_id: session.session_id, token,
  }, { delay: Math.max(0, deadline.getTime() - Date.now()), jobId: `timeout-${token}` });
}

/** Re-read immediately before sending: human intervention, blocking and config edits invalidate in-flight AI. */
export function replyGuard(project: any, session: Session) {
  const version = session.control_version ?? 0;
  const online = isSupportOnline(project.support);
  return async () => {
    if (await db.isSessionBlocked(session.website_id, session.session_id)) return false;
    const [current, currentProject] = await Promise.all([
      db.getSession(session.session_id), db.getProject(session.website_id),
    ]);
    return !!currentProject && !!current && (current.control_version ?? 0) === version
      && (!project.enableAI || currentProject.enableAI)
      && (!project.support.enabled || isSupportOnline(currentProject.support) === online);
  };
}

export const clearPending = {
  pending_token: null, pending_since: null, deadline_at: null, pending_message: null,
};
