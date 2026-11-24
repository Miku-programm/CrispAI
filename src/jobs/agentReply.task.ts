import { Queue } from "bullmq";
import * as db from "@/services/db.service";
import * as crisp from "@/services/crisp.service";
import * as telegram from "@/services/telegram.service";
import { connection } from "@/services/redis.service";
import logger from "@/services/logger.service";

/**
 * 外部助手（MCP）发给客户的回复。
 *
 * 和 Telegram 里客服的回复走同一条会话串行通道：不会和正在进行的自动回复抢着写对话历史，
 * 也保证同一会话的消息按顺序发出。发送失败会抛错，调用方据此告诉助手“没送到”。
 */
/**
 * 失败原因以这个前缀开头，表示“确定没有发给客户”，可以放心重试。
 * 其他任何失败都按“不确定是否送达”处理：重试可能让客户收到两遍
 */
export const NOT_SENT = "NOT_SENT: ";
const notSent = (reason: string) => new Error(NOT_SENT + reason);
const SEND_MARKER_TTL = 7 * 24 * 3600;

export default {
  name: "agentReply.task",
  queue: new Queue("agentReply.task", { connection }),
  processor: async (job: any) => {
    const { website_id, session_id, text, agent } = job.data;
    const project = await db.getProject(website_id);
    if (!project) throw notSent("项目不存在或未启用");
    const session = await db.getSession(session_id);
    if (!session || session.website_id !== website_id) throw notSent("会话不存在");
    if (await db.isSessionBlocked(website_id, session_id)) throw notSent("会话已被屏蔽");

    // 发送前先落一个标记。进程如果在 Crisp 收下消息之后、任务标记完成之前挂掉，
    // BullMQ 会把这个任务当作卡死重新执行；看到标记已存在就不能再发，只能报“不确定”
    const marker = `crispai:agent-send:${job.id}`;
    const firstAttempt = await connection.set(marker, "1", "EX", SEND_MARKER_TTL, "NX");
    if (!firstAttempt) throw new Error("任务被中断后重新执行，无法确认上一次是否已送达");

    const crispSession = "session_" + session.session_id;
    await crisp.composeMessage(website_id, crispSession, true);
    try {
      await crisp.sendMessage(website_id, crispSession, text, project.botName, project.botIcon);
    } catch (error: any) {
      // Crisp 明确以 4xx 拒绝 = 没发出。超时、断线、5xx 都可能是“其实已经收下了”，不能当成没发
      const status = error?.response?.status;
      if (typeof status === "number" && status >= 400 && status < 500) {
        // 确定没发出：撤掉标记，调用方用同一个 key 重试时可以正常再发
        await connection.del(marker).catch(() => {});
        throw notSent(`Crisp 拒绝了这条消息（${status}）`);
      }
      throw new Error("Crisp 没有明确应答，无法确认是否送达");
    } finally {
      await crisp.composeMessage(website_id, crispSession, false);
    }

    // 消息已经发给客户了。之后的记录和同步即使失败也不能让任务失败，
    // 否则调用方会以为没发出去而重发
    try {
      session.thread.push({ role: "assistant", content: text });
      await db.updateSession(session.session_id, { thread: session.thread });
    } catch (error) { logger.error("助手回复已发出，但写入对话历史失败", { message: String(error) }); }

    if (session.group_id && session.topic_id) {
      try {
        await telegram.default.api.sendMessage(
          session.group_id,
          `🤖<b>${telegram.escapeHTML(agent || "外部助手")} 已回复</b>：\n${telegram.escapeHTML(text)}`,
          { message_thread_id: session.topic_id, parse_mode: "HTML" },
        );
        await telegram.refreshSessionControls(session);
      } catch (error) { logger.warn("同步助手回复到 Telegram 失败", { message: String(error) }); }
    }
    return { success: true };
  },
};
