import * as db from "@/services/db.service";
import * as storage from "@/services/storage.service";
import * as telegram from "@/services/telegram.service";
import * as crisp from "@/services/crisp.service";
import { Queue } from "bullmq";
import path from "path";
import { createResponse } from "@/utils/general";
import axios from "axios";
import { connection } from "@/services/redis.service";
import { markHumanActivity } from "@/services/support.service";
import logger from "@/services/logger.service";

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
    try {
      return await deliver(job);
    } catch (error) {
      // 发给客户失败时任务不会自动重试（重试可能把已发出的部分再发一遍），
      // 所以必须明确提醒客服，而不是只少一个 👌。
      // 出错的位置可能在发出文字之后（比如图片上传失败、写历史失败），所以不能断言“没送到”
      logger.error("客服回复未能送达客户", {
        message: error instanceof Error ? error.message : String(error),
      });
      try {
        await telegram.default.api.sendMessage(
          job.data.chat.id,
          "⚠️ 这条消息可能没有（或只有一部分）发送给客户。请先在 Crisp 里确认客户实际收到了什么，再决定是否重发。",
          {
            message_thread_id: job.data.message_thread_id,
            reply_parameters: {
              message_id: job.data.message_id,
              allow_sending_without_reply: true,
            },
          },
        );
      } catch {}
      throw error;
    }
  },
};

const deliver = async (job: any) => {
    const group_id = job.data.chat.id;
    const topic_id = job.data.message_thread_id!;

    const data = await db.getSessionByTopic(group_id, topic_id);
    if (!data) {
      return createResponse(false, "会话不存在");
    }

    const project = await db.getProject(data.website_id);
    if (!project) {
      return createResponse(false, "未找到项目");
    }
    if (await db.isSessionBlocked(data.website_id, data.session_id)) {
      return createResponse(true, "已屏蔽的会话");
    }
    // Also handles jobs accepted by the old version before ingress tracking existed.
    if (!job.data.human_activity_recorded) await markHumanActivity(data.website_id, data.session_id);
    const msg = job.data.caption || job.data.text;
    // 发送文本内容到 Crisp
    if (msg) {
      await crisp.composeMessage(
        data.website_id,
        "session_" + data.session_id,
        true
      );
      await crisp.sendMessage(
        project.websiteId,
        "session_" + data.session_id,
        msg,
        project.botName,
        project.botIcon
      );
      data.thread.push({ role: "assistant", content: msg });
      await db.updateSession(data.session_id, { thread: data.thread });
      await crisp.composeMessage(
        data.website_id,
        "session_" + data.session_id,
        false
      );

      try {
        await telegram.default.api.setMessageReaction(
          group_id,
          job.data.message_id,
          [
            {
              type: "emoji",
              emoji: "👌",
            },
          ]
        );
      } catch {}
    }

    await telegram.refreshSessionControls(data);
    // 如果有图片，则发送图片到 Crisp
    if (job.data.photo) {
      await crisp.composeMessage(
        data.website_id,
        "session_" + data.session_id,
        true
      );
      const photo = job.data.photo.pop();
      if (!photo) {
        return createResponse(false, "图片不存在");
      }

      const markdownImage = await uploadFile(photo.file_id);

      await crisp.sendMessage(
        project.websiteId,
        "session_" + data.session_id,
        markdownImage,
        project.botName,
        project.botIcon
      );
      await crisp.composeMessage(
        data.website_id,
        "session_" + data.session_id,
        false
      );
      if (!msg) {
        try {
          await telegram.default.api.setMessageReaction(
            group_id,
            job.data.message_id,
            [
              {
                type: "emoji",
                emoji: "👌",
              },
            ]
          );
        } catch {}
      }
    }

    if (job.data.sticker) {
      if (job.data.sticker.is_animated || job.data.sticker.is_video) {
        return createResponse(false, "不支持发送动图或视频贴纸");
      }

      await crisp.composeMessage(
        data.website_id,
        "session_" + data.session_id,
        true
      );
      const sticker = job.data.sticker;
      if (!sticker) {
        return createResponse(false, "贴纸不存在");
      }
      if (sticker.is_animated || sticker.is_video) {
        return createResponse(false, "不支持发送动图或视频贴纸");
      }

      const markdownImage = await uploadFile(sticker.file_id);

      await crisp.sendMessage(
        project.websiteId,
        "session_" + data.session_id,
        markdownImage,
        project.botName,
        project.botIcon
      );
      await crisp.composeMessage(
        data.website_id,
        "session_" + data.session_id,
        false
      );
      if (!msg) {
        try {
          await telegram.default.api.setMessageReaction(
            group_id,
            job.data.message_id,
            [
              {
                type: "emoji",
                emoji: "👌",
              },
            ]
          );
        } catch {}
      }
    }
    return createResponse(true, "任务执行成功");
};

const uploadFile = async (fileId: string) => {
  const file = await telegram.default.api.getFile(fileId);
  const response = await axios.get<ArrayBuffer>(
    `https://api.telegram.org/file/bot${Bun.env.TELEGRAM_TOKEN}/${file.file_path}`,
    { responseType: "arraybuffer" }
  );
  // 带上原始扩展名（照片是 .jpg，贴纸是 .webp），对外提供时才能给出正确的 Content-Type
  const ext = path.extname(file.file_path ?? "") || ".jpg";
  const url = await storage.saveFile(
    fileId + ext,
    new Uint8Array(response.data)
  );
  return `![image](${url})`;
};
