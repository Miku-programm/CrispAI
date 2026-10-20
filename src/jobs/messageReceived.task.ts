import * as db from "@/services/db.service";
import * as telegram from "@/services/telegram.service";
import { createResponse, createTelegramSession } from "@/utils/general";
import { Queue } from "bullmq";
import path from "path";
import { connection } from "@/services/redis.service";
import { markHumanActivity } from "@/services/support.service";

const currentFileName = path.basename(
  import.meta.url,
  path.extname(import.meta.url)
);
export default {
  name: currentFileName,
    queue: new Queue(currentFileName, {
      connection,
      defaultJobOptions: {
        // 任务成功完成后，只保留最新的 100 条（或 1000 条，看你需要）
        removeOnComplete: {
          count: 100,
          age: 24 * 3600, // (可选) 同时限制时间，例如只保留24小时内的
        },
        // 任务失败后，保留最新的 1000 条以便排查错误
        removeOnFail: {
          count: 100,
        },
      },
    }),
  concurrency: 100,
  processor: async (job: any) => {
    const { website_id, session_id, user } = job.data;
    const cleanSessionId = session_id.replace("session_", "");
    // handle origin crisp reply
    if (!user?.type) {
      const project = await db.getProject(website_id);
      if (!project) return createResponse(false, "项目不存在");
      if (await db.isSessionBlocked(website_id, cleanSessionId)) return createResponse(true, "已屏蔽的会话");

      let session = await db.getSession(cleanSessionId);
      if (!session) {
        session = await createTelegramSession(
          cleanSessionId,
          website_id,
          project
        );
      }

      // 客服每次回复都刷新 enable_time，恢复 AI 的倒计时从最后一次人工回复算起
      if (!job.data.human_activity_recorded) await markHumanActivity(website_id, cleanSessionId);
      if (job.data.type === "text" && typeof job.data.content === "string") {
        session.thread.push({ role: "assistant", content: job.data.content });
        await db.updateSession(cleanSessionId, { thread: session.thread });
      }
      if (session.group_id && session.enable_reply) {
        try {
          await telegram.default.api.editMessageReplyMarkup(
            session.group_id,
            session.message_id,
            {
              reply_markup: telegram.changeAI(
                session.group_id,
                session.topic_id,
                false
              ),
            }
          );
        } catch {}
      }
    }
    return createResponse(true, "任务执行成功");
  },
};
