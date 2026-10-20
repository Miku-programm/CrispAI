import openai, { CHAT_MODEL, createEmbedding } from "@/services/openai.service";
import * as db from "@/services/db.service";
import * as telegram from "@/services/telegram.service";
import * as crisp from "@/services/crisp.service";
import { Queue } from "bullmq";
import path from "path";
import { createResponse } from "@/utils/general";
import {
  createTelegramSession,
  emojiConverter,
  generateTelegramSession,
} from "@/utils/general";
import { GrammyError, InputFile } from "grammy";
import type { ChatCompletionMessageParam } from "openai/resources";
import type { Message } from "grammy/types";
import ffmpeg from "fluent-ffmpeg";
import axios from "axios";
import { connection } from "@/services/redis.service";
import { armTimeout, markHumanActivity, replyGuard } from "@/services/support.service";
import { customerAction, isSupportOnline, noticeIsDue } from "@/services/support.policy";
import type { SupportAction } from "@/types/support";
import logger from "@/services/logger.service";

const currentFileName = path.basename(
  import.meta.url,
  path.extname(import.meta.url),
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
    const { session_id, website_id } = job.data;
    const cleanSessionId = session_id.replace("session_", "");

    const project = await db.getProject(website_id);
    if (!project) {
      return createResponse(false, "未找到项目");
    }
    if (await db.isSessionBlocked(website_id, cleanSessionId)) {
      return createResponse(true, "已屏蔽的会话");
    }

    let session = await db.getSession(cleanSessionId);

    if (session) {
      const error = await updateTelegramSession(session, project);
      if (error) {
        session = null;
      }
    }
    if (!session || (project.telegramId && (!session.topic_id || !session.message_id))) {
      session = await createTelegramSession(
        cleanSessionId,
        website_id,
        project,
      );
    }

    const isText = job.data.type === "text";
    const mediaType = typeof job.data.content?.type === "string" ? job.data.content.type : "";
    const receivedAt = job.data._received_at || job.timestamp || Date.now();
    await db.updateSession(cleanSessionId, { last_customer_at: new Date(receivedAt) });
    const alreadyAnswered = session.last_human_at && new Date(session.last_human_at).getTime() >= receivedAt;
    const action = alreadyAnswered ? "none" : customerAction(project.support, session);
    const canReply = replyGuard(project, session);

    let telegramMessage;
    if (await db.isSessionBlocked(website_id, cleanSessionId)) return createResponse(true, "已屏蔽的会话");
    if (project.telegramId) {
      if (isText) {
        try {
          const flow: string[] = [
            "🧾<b>消息内容</b>：",
            telegram.escapeHTML(emojiConverter(job.data.content)),
          ];
          telegramMessage = await telegram.default.api.sendMessage(
            session.group_id!,
            flow.join("\n"),
            {
              message_thread_id: session.topic_id,
              parse_mode: "HTML",
            },
          );
        } catch (error) { logger.warn("转发客户文本失败", { message: String(error) }); }
      } else if (mediaType.includes("image")) {
        try {
          telegramMessage = await telegram.default.api.sendPhoto(
            session.group_id!,
            job.data.content.url,
            {
              message_thread_id: session.topic_id,
              parse_mode: "HTML",
            },
          );
        } catch {
          telegramMessage = undefined;
        }
      } else if (mediaType.includes("audio")) {
        const converter = async (url: string) => {
          const output = url.split("/").pop()!.split(".")[0] + ".mp3";
          const response = await axios.get(url, { responseType: "stream" });
          return new Promise<string>((resolve, reject) => {
            ffmpeg(response.data)
              .toFormat("mp3")
              .on("error", (err) => {
                reject(err);
              })
              .on("end", () => {
                resolve(output);
              })
              .save(output);
          });
        };
        const file = await converter(job.data.content.url);
        try {
          await telegram.default.api.sendVoice(
            session.group_id!,
            new InputFile(file),
            {
              message_thread_id: session.topic_id,
              parse_mode: "HTML",
              caption: "🧾<b>语音消息</b>",
            },
          );
        } catch {
        } finally {
          await Bun.file(file).delete();
        }
      }
    }

    let content: string | undefined;
    try {
      if (action === "wait") {
        recordCustomerMessage(session, job.data);
        await db.updateSession(cleanSessionId, { thread: session.thread });
        await armTimeout(project, session, job.data, receivedAt);
      } else {
        await crisp.composeMessage(website_id, session_id, true);
        const notice = isSupportOnline(project.support) && session.fallback_active
          ? project.support.timeout.message : project.support.offline.message;
        content = await runAutomaticReply(session, job.data, project, action, canReply, true, notice);
      }
      if (isText && project.telegramId) {
        await notifyTelegram(session, job.data.content, content, telegramMessage);
      }
      await db.updateSession(cleanSessionId, { thread: session.thread });
    } finally {
      await crisp.composeMessage(website_id, session_id, false);
    }
    return createResponse(true, "任务执行完成");
  },
};

async function updateTelegramSession(session: Session, project: any) {
  if (!project.telegramId) return null;

  const flow = await generateTelegramSession(
    session.session_id,
    session.website_id,
  );
  try {
    await telegram.default.api.editMessageText(
      project.telegramId,
      session.message_id!,
      flow.length > 0 ? flow.join("\n") : "无额外信息",
      {
        parse_mode: "HTML",
        reply_markup: telegram.changeAI(
          project.telegramId,
          session.topic_id!,
          project.support.enabled
            ? !!session.fallback_active && ["ai", "rules"].includes(session.fallback_action ?? "")
            : session.enable_reply,
        ),
      },
    );
  } catch (error) {
    if (error instanceof GrammyError) {
      if (error.description === "Bad Request: message to edit not found") {
        return error;
      }
    }
  }
}

const isJSON = (data: string) => {
  try {
    const json = JSON.parse(data);
    return (
      Array.isArray(json) && json.length > 0 && typeof json[0] === "string"
    );
  } catch {
    return false;
  }
};

const getKeyword = (input: string, keywords: any[]) => {
  if (!keywords?.length) return;
  return keywords.find((k) => k && new RegExp(k.keyword).test(input));
};

const formatDate = () => {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return `${date.getUTCFullYear()}-${
    date.getUTCMonth() + 1
  }-${date.getUTCDate()} ${date.getUTCHours()}:${date.getUTCMinutes()}:${date.getUTCSeconds()}`;
};

async function handleTextMessage(
  session: Session,
  body: any,
  project: any,
  options: any[],
  canReply: () => Promise<boolean>,
) {
  let content: string | undefined;

  if (body.option_trigger || project.enableKeyword) {
    const replyOption = body.option_trigger || getKeyword(body.content, project.keyword);
    content = await handleKeywordReply(
      replyOption,
      session,
      body,
      project,
      options,
      canReply,
    );
  }

  if (!content && project.enableAI && session.enable_reply) {
    content = await handleAIReply(session, body, project, canReply);
  }

  return content;
}

async function handleKeywordReply(
  replyOption: any,
  session: Session,
  body: any,
  project: any,
  options: any[],
  canReply: () => Promise<boolean>,
) {
  const { website_id, session_id } = body;
  if (!replyOption) return;
  if (!(await canReply())) return;

  if (replyOption.type === "text") {
    await crisp.sendMessage(
      website_id,
      session_id,
      replyOption.text,
      project.botName,
      project.botIcon,
    );
    return replyOption.text;
  }

  if (replyOption.type === "option") {
    const option = options.find((o) => o.id === replyOption.optionId);
    if (option) {
      await crisp.sendOption(
        website_id,
        session_id,
        option,
        project.botName,
        project.botIcon,
      );
      return option.text;
    }
  }

  if (replyOption.type === "closeAI" && session.enable_reply) {
    const msg = "已关闭智能回复，请等待人工客服接入...";
    await markHumanActivity(body.website_id, session.session_id);
    session.enable_reply = false;
    await crisp.sendMessage(
      website_id,
      session_id,
      msg,
      project.botName,
      project.botIcon,
    );
    return msg;
  }
}
async function searchDocuments(project: string, query: string, matchCount = 3) {
  if (!(await db.hasPayload(project))) return null;

  const vector = await createEmbedding(query);
  if (!vector) return null;

  return await db.matchPayloads(project, vector, matchCount);
}
async function handleAIReply(session: Session, body: any, project: any, canReply: () => Promise<boolean>, record = true) {
  const messages: ChatCompletionMessageParam[] = await buildMessages(
    session,
    body,
    project,
    record,
  );
  const results = await searchDocuments(project.id, body.content);
  if (results && results.length > 0) {
    const docs: ChatCompletionMessageParam = {
      role: "system",
      content: `相关资料：\n${results
        .map((r: any) => r.raw)
        .join("\n----------------\n")}`,
    };
    // 将文档信息插入到最后一条用户消息之前
    if (messages.length > 0) {
      // 找到最后一条消息的位置
      const lastIndex = messages.length - 1;
      // 在最后一条消息之前插入文档信息
      messages.splice(lastIndex, 0, docs);
    }
  }
  const completion = await openai.chat.completions.create({
    messages,
    model: CHAT_MODEL,
  });

  const reply = completion.choices[0]?.message;
  if (!reply?.content) return;

  if (!(await canReply())) return;
  await crisp.sendMessage(
    body.website_id,
    body.session_id,
    reply.content,
    project.botName,
    project.botIcon,
  );
  session.thread.push(reply);

  return reply.content;
}

async function buildMessages(
  session: Session,
  body: any,
  project: any,
  record = true,
): Promise<ChatCompletionMessageParam[]> {
  const messages: ChatCompletionMessageParam[] = [];

  if (isJSON(project.payload)) {
    JSON.parse(project.payload).forEach((p: string) =>
      messages.push({ role: "developer", content: p }),
    );
  } else {
    messages.push({ role: "developer", content: project.payload || "" });
  }

  messages.push({
    role: "developer",
    content: JSON.stringify(
      await crisp.getMetas(body.website_id, body.session_id),
    ),
  });

  session?.thread.forEach((msg: any) => messages.push(msg));

  if (record && body.content && typeof body.content === "string") {
    const msg: ChatCompletionMessageParam = {
      role: "user",
      content: body.content,
    };
    session.thread.push(msg);
    messages.push(msg);
  }

  return messages;
}

async function handleImageMessage(
  session: Session,
  body: any,
  project: any,
  telegramMessage?: Message.TextMessage | Message.PhotoMessage,
  canReply: () => Promise<boolean> = replyGuard(project, session),
  record = true,
) {
  if (!project.enableAI || !project.enableAIPic) return;

  const messages = await buildMessages(session, body, project, false);
  const image: ChatCompletionMessageParam = {
    role: "user",
    content: [{ type: "image_url", image_url: { url: body.content.url } }],
  };
  if (record) { messages.push(image); session.thread.push(image); }

  const completion = await openai.chat.completions.create({
    messages,
    model: CHAT_MODEL,
  });

  if (!completion?.choices) return;

  const reply = completion.choices[0]?.message;
  const replyText = reply?.content ?? "无法识别该图片";
  if (!(await canReply())) return;
  await crisp.sendMessage(
    body.website_id,
    body.session_id,
    replyText,
    project.botName,
    project.botIcon,
  );
  if (reply) session.thread.push(reply);

  if (project.telegramId) {
    if (telegramMessage) {
      try {
        await telegram.default.api.editMessageCaption(
          session.group_id!,
          telegramMessage.message_id,
          {
            caption: `💡<b>智能回复</b>：\n${telegram.escapeHTML(replyText)}`,
            parse_mode: "HTML",
          },
        );
      } catch {}
    } else {
      try {
        await telegram.default.api.sendPhoto(
          session.group_id!,
          body.content.url,
          {
            caption: `💡<b>智能回复</b>：\n${telegram.escapeHTML(replyText)}`,
            message_thread_id: session.topic_id,
            parse_mode: "HTML",
          },
        );
      } catch {}
    }
  }
  return replyText;
}

export function recordCustomerMessage(session: Session, body: any) {
  if (body.type === "text" && typeof body.content === "string") {
    session.thread.push({ role: "user", content: body.content });
  } else if (body.content?.type?.includes("image")) {
    session.thread.push({ role: "user", content: [{ type: "image_url", image_url: { url: body.content.url } }] });
  }
}

/** Shared by regular messages and delayed takeover jobs; no second Telegram forwarding occurs here. */
export async function runAutomaticReply(
  session: Session, body: any, project: any, action: SupportAction | "legacy",
  canReply = replyGuard(project, session), record = true, notice?: string,
): Promise<string | undefined> {
  if (action === "none") { if (record) recordCustomerMessage(session, body); return; }
  if (action === "message") {
    if ((record && !noticeIsDue(session)) || !(await canReply())) {
      if (record) recordCustomerMessage(session, body);
      return;
    }
    const text = notice ?? project.support.offline.message;
    if (!text) return;
    await crisp.sendMessage(body.website_id, body.session_id, text, project.botName, project.botIcon);
    if (record) recordCustomerMessage(session, body);
    session.thread.push({ role: "assistant", content: text });
    await db.updateSession(session.session_id, { last_auto_reply_at: new Date() });
    return text;
  }
  if (body.type === "text") {
    const options = await db.getOption(project.id);
    if (action === "legacy") return handleTextMessage(session, body, project, options, canReply);
    if (action === "rules" && (body.option_trigger || project.enableKeyword)) {
      const matched = body.option_trigger || getKeyword(body.content, project.keyword);
      const text = await handleKeywordReply(matched, session, body, project, options, canReply);
      if (text) {
        if (record) recordCustomerMessage(session, body);
        session.thread.push({ role: "assistant", content: text });
        return text;
      }
      // A closeAI rule invalidates the guard and must never fall through into AI.
      if (!(await canReply())) return;
    }
    if (project.enableAI) return handleAIReply(session, body, project, canReply, record);
    const fallback = notice ?? project.support.offline.message;
    if (action === "rules" && fallback) {
      return runAutomaticReply(session, body, project, "message", canReply, record, fallback);
    }
    if (record) recordCustomerMessage(session, body);
    return;
  }
  if (body.content?.type?.includes("image") && (action !== "legacy" || session.enable_reply)) {
    return handleImageMessage(session, body, project, undefined, canReply, record);
  }
  if (record) recordCustomerMessage(session, body);
}

async function notifyTelegram(
  session: Session,
  userContent: string,
  replyContent: string | undefined,
  telegramMessage?: Message.TextMessage | Message.PhotoMessage,
) {
  if (await db.isSessionBlocked(session.website_id, session.session_id)) return;
  const flow: string[] = ["🧾<b>消息内容</b>：", telegram.escapeHTML(emojiConverter(userContent))];
  if (replyContent) {
    flow.push("", "💡<b>智能回复</b>：", telegram.escapeHTML(replyContent));
  }

  try {
    if (telegramMessage) {
      await telegram.default.api.editMessageText(
        session.group_id!,
        telegramMessage.message_id,
        flow.join("\n"),
        {
          parse_mode: "HTML",
        },
      );
    } else {
      await telegram.default.api.sendMessage(
        session.group_id!,
        flow.join("\n"),
        {
          message_thread_id: session.topic_id,
          parse_mode: "HTML",
        },
      );
    }
  } catch (error) { logger.warn("更新 Telegram 回复失败", { message: String(error) }); }
}
