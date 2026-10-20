import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { ChatMemberAdministrator } from "grammy/types";
import telegramCallbackTask from "@/jobs/telegramCallback.task";
import telegramReplyTask from "@/jobs/telegramReply.task";
import logger from "@/services/logger.service";
import { enqueue } from "@/utils/queue";
import * as db from "@/services/db.service";
import { eventJobId, sessionQueueKey } from "@/services/sessionQueue.service";
import { markHumanActivity, unblockCustomer } from "@/services/support.service";
import { isSupportOnline } from "@/services/support.policy";
import { supportConflictMessage } from "@/types/support";

const TOKEN = Bun.env.TELEGRAM_TOKEN || "";
const bot = new Bot(TOKEN);
bot.api.config.use(autoRetry());

// 记录错误并继续抛出，入队失败必须让 Webhook 返回非成功状态，允许 Telegram 重投。
bot.catch((err) => {
  const error = err.error;
  logger.error("Telegram 更新处理失败", {
    updateId: err.ctx?.update?.update_id,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  throw error;
});

bot.command("start", (ctx) => ctx.reply("请输入 /ping 获取群组 ID"));
bot.command("ping", async (ctx) => {
  try {
    const isTopicGroup = ctx.chat.is_forum || ctx.message?.chat.is_forum;
    if (!isTopicGroup) {
      await ctx.reply("该群不是话题群");
      return;
    }

    const admins = await ctx.api.getChatAdministrators(ctx.chat.id);
    const me = admins.find(
      (admin) => admin.user.id === ctx.me.id
    ) as ChatMemberAdministrator;
    if (!me || !me.can_manage_topics) {
      await ctx.reply("请将管理话题权限赋予我");
      return;
    }
    await ctx.reply(`群组 ID: \`${ctx.chat.id}\`\n请复制到网页内保存`, {
      parse_mode: "MarkdownV2",
    });
  } catch (e) {
    logger.error("处理 /ping 命令失败:", e);
  }
});
bot.on("callback_query:data", async (ctx) => {
  const match = /^(open|close|block|unblock)_(-?\d+)_(\d+)$/.exec(ctx.callbackQuery.data);
  if (!match || !ctx.callbackQuery.message) {
    await ctx.answerCallbackQuery({ text: "无效的操作" });
    return;
  }
  const groupId = Number(match[2]), topicId = Number(match[3]);
  const session = await db.getSessionByTopic(groupId, topicId);
  if (!session || ctx.callbackQuery.message.chat.id !== groupId
    || ctx.callbackQuery.message.message_id !== session.message_id) {
    await ctx.answerCallbackQuery({ text: "会话不存在或按钮已过期" });
    return;
  }
  // Apply control immediately, so a completion already running in the lane cannot send after takeover.
  await applySessionControl(session, match[1]!);
  await enqueue(telegramCallbackTask.queue, "telegramCallback", {
    website_id: session.website_id, session_id: session.session_id,
  }, { jobId: eventJobId("telegram-control", ctx.update.update_id) });
  try {
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.warn("应答 callback query 失败", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
for (const command of ["online", "offline", "auto", "status"] as const) {
  bot.command(command, async (ctx) => {
    const projects = (await db.listProjects()).filter(p => p.telegramId === ctx.chat.id);
    const wanted = ctx.match.trim();
    const chosen = wanted ? projects.filter(p => p.id === wanted) : projects;
    if (!chosen.length) return ctx.reply("此群尚未绑定该项目，请在管理后台配置 Telegram 群组 ID。");
    if (command === "status") {
      return ctx.reply(chosen.map(p => `${p.name} (${p.id})\n策略：${p.support.enabled ? "已启用" : "旧版自动回复"}；当前${isSupportOnline(p.support) ? "在线" : "离线"}；${p.support.availabilityMode === "schedule" ? "按营业时间" : "手动模式"}`).join("\n\n"));
    }
    if (chosen.length !== 1) return ctx.reply(`此群绑定了多个项目，请使用 /${command} 项目ID：\n${chosen.map(p => `${p.name}: ${p.id}`).join("\n")}`);
    const project = chosen[0]!;
    const config = { ...project.support, enabled: true,
      availabilityMode: command === "auto" ? "schedule" as const : "manual" as const,
      online: command === "auto" ? project.support.online : command === "online" };
    const conflict = supportConflictMessage(config, project.enableAI);
    if (conflict) return ctx.reply(conflict);
    await db.saveProjectSupport(project.id, config);
    return ctx.reply(`${project.name}：已切换为${command === "auto" ? "营业时间自动模式" : command === "online" ? "手动在线" : "手动离线"}。`);
  });
}

for (const command of ["block", "unblock"] as const) {
  bot.command(command, async ctx => {
    if (!ctx.message?.message_thread_id) return ctx.reply("请在客户对应的话题内使用此命令。");
    const session = await db.getSessionByTopic(ctx.chat.id, ctx.message.message_thread_id);
    if (!session) return ctx.reply("未找到此话题对应的客户会话。");
    await applySessionControl(session, command);
    await refreshSessionControls(session);
    return ctx.reply(command === "block" ? "已屏蔽此会话，不再转发或自动回复。" : "已解除屏蔽，新消息将恢复处理。", {
      message_thread_id: session.topic_id,
    });
  });
}

bot.on(["msg:text", "msg:photo", "msg:sticker"], async ctx => {
  if (!ctx.message?.is_topic_message || !ctx.message.message_thread_id) return;
  const session = await db.getSessionByTopic(ctx.chat.id, ctx.message.message_thread_id);
  if (!session || await db.isSessionBlocked(session.website_id, session.session_id)) return;
  await markHumanActivity(session.website_id, session.session_id, eventJobId("telegram-human", ctx.update.update_id));
  await enqueue(telegramReplyTask.queue, "telegramReply", { ...ctx.message, human_activity_recorded: true }, {
    sessionKey: sessionQueueKey(session.website_id, session.session_id),
    jobId: eventJobId("telegram-reply", ctx.update.update_id),
  });
});

export const changeAI = (groupId: number, topicId: number, bool: boolean, blocked = false) => {
  const text = bool ? "暂时关闭 AI 回复" : "开启 AI 回复";
  const callback_data = bool
    ? `close_${groupId}_${topicId}`
    : `open_${groupId}_${topicId}`;
  return {
    inline_keyboard: [
      ...(blocked ? [] : [[{ text, callback_data }]]),
      [{ text: blocked ? "解除屏蔽" : "屏蔽此客户", callback_data: `${blocked ? "unblock" : "block"}_${groupId}_${topicId}` }],
    ],
  };
};

export const escapeHTML = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function applySessionControl(session: Session, action: string) {
  if (action === "block") return db.blockSession(session.website_id, session.session_id, "客服手动屏蔽", "manual");
  if (action === "unblock") return unblockCustomer(session.website_id, session.session_id);
  if (action === "close") return markHumanActivity(session.website_id, session.session_id);
  if (action === "open") {
    const project = await db.getProject(session.website_id);
    if (!project?.enableAI || await db.isSessionBlocked(session.website_id, session.session_id)) return;
    return db.updateSessionIfVersion(session.session_id, session.control_version ?? 0, {
      enable_reply: true, enable_time: new Date(), control_version: (session.control_version ?? 0) + 1,
      pending_token: null, pending_since: null, pending_message: null, deadline_at: null,
      fallback_active: true, fallback_action: "ai",
    });
  }
}

export async function refreshSessionControls(session: Session) {
  const current = await db.getSession(session.session_id);
  if (!current?.group_id || !current.message_id || !current.topic_id) return;
  const blocked = await db.isSessionBlocked(current.website_id, current.session_id);
  const project = await db.getProject(current.website_id);
  const automatic = project?.support.enabled
    ? !!current.fallback_active && ["ai", "rules"].includes(current.fallback_action ?? "")
    : current.enable_reply;
  try {
    await bot.api.editMessageReplyMarkup(current.group_id, current.message_id, {
      reply_markup: changeAI(current.group_id, current.topic_id, automatic, blocked),
    });
  } catch (error) { logger.warn("更新会话按钮失败", { message: String(error) }); }
}

export async function notifyBlocked(websiteId: string, sessionId: string) {
  const session = await db.getSession(sessionId);
  if (!session?.group_id || !session.topic_id) return;
  await refreshSessionControls(session);
  try {
    await bot.api.sendMessage(session.group_id, "🛑 此会话触发刷屏规则，已停止转发和自动回复。可点击「解除屏蔽」恢复。", {
      message_thread_id: session.topic_id,
    });
  } catch (error) { logger.warn("发送屏蔽提示失败", { websiteId, message: String(error) }); }
}

// 注册 Webhook 失败后的重试间隔
const WEBHOOK_RETRY_DELAY = 30_000;
// 单次注册请求的最长等待时间（含 auto-retry 内部的重试等待）
const WEBHOOK_TIMEOUT = 20_000;

/**
 * 注册 Telegram Webhook，在后台不断重试直到成功。
 * 之前是在启动时同步调用、失败即 process.exit(1)，Telegram 一抖动就进入崩溃重启循环；
 * 现在失败只记录日志并稍后重试，不阻塞 HTTP 服务启动，也不会退出进程。
 */
// Webhook 校验用的 secret：Telegram 每次回调都会带在 X-Telegram-Bot-Api-Secret-Token 头里，
// 没有它任何人都能向 /telegram 伪造消息。没单独配置时由 bot token 派生，不需要额外的环境变量
export const WEBHOOK_SECRET =
  Bun.env.TELEGRAM_SECRET ||
  new Bun.CryptoHasher("sha256")
    .update("crispai-webhook:" + (Bun.env.TELEGRAM_TOKEN ?? ""))
    .digest("hex");

export const setupWebhook = async () => {
  // 默认用 PUBLIC_URL 拼，反向代理路径特殊时可以用 TELEGRAM_ENDPOINT 单独指定
  const publicUrl = (Bun.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
  const endpoint =
    Bun.env.TELEGRAM_ENDPOINT || (publicUrl ? `${publicUrl}/telegram` : "");
  if (!endpoint) {
    logger.error("未配置 PUBLIC_URL，跳过 Telegram Webhook 注册");
    return;
  }

  for (let attempt = 1; ; attempt++) {
    try {
      await bot.api.setWebhook(
        endpoint,
        { drop_pending_updates: false, secret_token: WEBHOOK_SECRET },
        // grammY 的类型声明用的是 abort-controller 包里的 AbortSignal，
        // 与运行时的标准 AbortSignal 只是类型不兼容，实际可以直接使用
        AbortSignal.timeout(WEBHOOK_TIMEOUT) as any
      );
      logger.info("Telegram Webhook 设置成功");
      return;
    } catch (error) {
      logger.error(
        `设置 Telegram Webhook 失败（第 ${attempt} 次），${
          WEBHOOK_RETRY_DELAY / 1000
        } 秒后重试:`,
        error
      );
      await Bun.sleep(WEBHOOK_RETRY_DELAY);
    }
  }
};

export default bot;
