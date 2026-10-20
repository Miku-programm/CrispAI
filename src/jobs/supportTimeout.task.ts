import { Queue } from "bullmq";
import * as db from "@/services/db.service";
import * as telegram from "@/services/telegram.service";
import { connection } from "@/services/redis.service";
import { clearPending, replyGuard } from "@/services/support.service";
import { isSupportOnline, timeoutIsCurrent } from "@/services/support.policy";
import { runAutomaticReply } from "@/jobs/messageSend.task";

export default {
  name: "supportTimeout.task",
  queue: new Queue("supportTimeout.task", { connection }),
  processor: async (job: any) => {
    const { website_id, session_id, token } = job.data;
    const session = await db.getSession(session_id);
    if (!timeoutIsCurrent(session, token)) return { skipped: true };
    const project = await db.getProject(website_id);
    if (!session) return { skipped: true };
    if (!project || !project.support.enabled
      || !project.support.timeout.enabled
      || await db.isSessionBlocked(website_id, session_id)) {
      await db.updateSessionIfVersion(session_id, session.control_version ?? 0, clearPending);
      return { skipped: true };
    }
    const version = session.control_version ?? 0;
    if (session.last_human_at && session.pending_since
      && new Date(session.last_human_at) >= new Date(session.pending_since)) {
      await db.updateSessionIfVersion(session_id, version, clearPending);
      return { skipped: true };
    }
    const online = isSupportOnline(project.support);
    const policy = online ? project.support.timeout : project.support.offline;
    const canReply = replyGuard(project, session);
    const reply = await runAutomaticReply(
      session, session.pending_message, project, policy.action, canReply, false, policy.message,
    );
    // Human replies, block actions and configuration edits must win over an in-flight completion.
    if (!(await canReply())) return { skipped: true };
    await db.updateSessionIfVersion(session_id, version, {
      ...clearPending, fallback_active: online, fallback_action: online ? policy.action : null,
      thread: session.thread,
    });
    if (reply && session.group_id && session.topic_id && !(await db.isSessionBlocked(website_id, session_id))) {
      await telegram.default.api.sendMessage(session.group_id, `⏱ 超时接管\n${reply}`, {
        message_thread_id: session.topic_id,
      });
    }
    return { success: true };
  },
};
