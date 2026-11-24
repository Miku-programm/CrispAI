import axios from "axios";
import * as db from "@/services/db.service";
import type { Context } from "hono";
import logger from "./logger.service";
import messageSendTask from "@/jobs/messageSend.task";
import messageReceivedTask from "@/jobs/messageReceived.task";
import messageUpdatedTask from "@/jobs/messageUpdated.task";
import { enqueue } from "@/utils/queue";
import { eventJobId } from "@/services/sessionQueue.service";
import { checkAbuse, markHumanActivity } from "@/services/support.service";
import { clip, escapeHTML, safeLink } from "@/utils/html";

const crisp = axios.create({
  baseURL: "https://api.crisp.chat/v1",
  timeout: 15000,
  headers: {
    "X-Crisp-Tier": "plugin",
    "Content-Type": "application/json",
    Authorization:
      "Basic " + btoa(Bun.env.CRISP_ID! + ":" + Bun.env.CRISP_KEY!),
  },
});

crisp.interceptors.response.use(
  (response) => response,
  (error) => {
    const cfg = error.config ?? {};
    const res = error.response;
    logger.error("crisp api failed", {
      method: cfg.method?.toUpperCase(),
      url: cfg.url,
      status: res?.status,
      statusText: res?.statusText,
      data: res?.data,
      code: error.code,
      message: error.message,
    });
    return Promise.reject(error);
  },
);

export const crispEventJobId = (event: string, data: any) =>
  data?.fingerprint === undefined || data?.fingerprint === null
    ? undefined
    : eventJobId("crisp", event, data.website_id, data.session_id,
        data.fingerprint, event === "message:updated" ? data.content : null);

// 保留旧导出以兼容调用方；现在直接持久化，不再用进程内定时缓存。
// 同一会话的后续消息会等第一条建好会话后再执行。
export const bufferMessage = async (data: any) =>
  enqueue(messageSendTask.queue, "messageSend", data, {
    jobId: crispEventJobId("message:send", data),
  });

// Count arrival rate before a slow AI job can build a backlog. Repeated webhook
// deliveries share their fingerprint-derived member in the abuse window.
async function allowCustomerEvent(event: string, data: any): Promise<boolean> {
  const project = await db.getProject(data.website_id);
  if (!project) return false;
  return !(await checkAbuse(
    project, data.session_id.replace(/^session_/, ""), crispEventJobId(event, data),
  ));
}

export const crispWebhook = async (c: Context) => {
  const body = await c.req.json();
  // Preserve first local arrival time through queue backlogs and legacy bridges.
  // This field is assigned after webhook signature validation by the route.
  if (body.data && typeof body.data === "object") body.data._received_at = Date.now();

  switch (body.event) {
    case "message:send":
      if (!(await allowCustomerEvent(body.event, body.data))) {
        return c.json({ ok: true, skipped: true });
      }
      await bufferMessage(body.data);
      break;
    case "message:received":
      const { origin } = body.data;
      if (Bun.env.CRISP_URN && origin === Bun.env.CRISP_URN) {
        return c.json({ ok: true, skipped: true });
      }
      // Immediately invalidate an in-flight AI response before waiting in its
      // conversation lane. The queued task still handles Telegram forwarding.
      if (!body.data.user?.type) {
        await markHumanActivity(
          body.data.website_id,
          body.data.session_id.replace(/^session_/, ""),
          crispEventJobId(body.event, body.data),
        );
      }
      await enqueue(messageReceivedTask.queue, "messageReceived", {
        ...body.data,
        human_activity_recorded: !body.data.user?.type,
      }, {
        jobId: crispEventJobId(body.event, body.data),
      });
      break;
    case "message:updated":
      const { content } = body.data;
      const isPicker = Boolean(content?.id);
      if (!isPicker) {
        return c.json({ ok: true, skipped: true });
      }
      if (!(await allowCustomerEvent(body.event, body.data))) {
        return c.json({ ok: true, skipped: true });
      }
      await enqueue(messageUpdatedTask.queue, "messageUpdated", body.data, {
        jobId: crispEventJobId(body.event, body.data),
      });
      break;
    default:
      logger.warn("Unhandled Crisp event:", body.event);
      break;
  }
  return c.json({ ok: true });
};

/** 访客资料的原始数据（未转义）。给 AI 用的资料从这里取，不要用 getMetas 的 HTML 文本 */
export const getMetaData = async (website_id: string, session_id: string) => {
  const {
    data: { data },
  } = await crisp.get(`/website/${website_id}/conversation/${session_id}/meta`);
  return data ?? {};
};

/**
 * 访客资料，格式化成 Telegram HTML。
 * 所有字段都是访客可控的，逐个转义并限长：没转义时昵称里一个 "<" 就会让 Telegram 拒收整条消息
 */
export const getMetas = async (website_id: string, session_id: string) => {
  const data = await getMetaData(website_id, session_id);
  const text = (value: unknown, max: number) => escapeHTML(clip(value, max));
  const flow = [];
  if (data.nickname)
    flow.push(`👤<b>用户</b>：<code>${text(data.nickname, 100)}</code>`);
  if (data.email)
    flow.push(`📧<b>邮箱</b>：<code>${text(data.email, 200)}</code>`);
  if (data.device) {
    if (data.device.geolocation && data.device.geolocation.country) {
      flow.push("");
      flow.push(
        `📍<b>地理位置</b>：${text(data.device.geolocation.country, 60)} ${text(
          data.device.geolocation.city ?? "",
          60,
        )}`,
      );
    }
    const system = data.device.system;
    if (system && system.os && system.os.name) {
      flow.push("");
      flow.push(`🖥<b>操作系统</b>：${text(system.os.name, 60)}`);
    }
    if (system && system.browser && system.browser.name) {
      flow.push("");
      flow.push(`🌐<b>浏览器</b>：${text(system.browser.name, 60)}`);
    }
    if (data.data && Object.keys(data.data).length > 0) {
      flow.push("");
      flow.push("📄<b>附加信息</b>：");
      flow.push("<pre>" + text(JSON.stringify(data.data), 800) + "</pre>");
    }
  }
  return flow;
};
// Telegram 单条消息上限 4096 字符，访问历史只取最近几条并限制每条长度
const MAX_PAGES = 8;
export const listPages = async (website_id: string, session_id: string) => {
  try {
    const {
      data: { data },
    } = await crisp.get(
      `/website/${website_id}/conversation/${session_id}/pages/1`
    );
    const flow = [];
    const pages = Array.isArray(data) ? data.slice(0, MAX_PAGES) : [];
    if (pages.length > 0) {
      flow.push("");
      flow.push("📄<b>访问历史</b>：");
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        flow.push(
          `${i === 0 ? "<blockquote expandable>" : ""}${safeLink(
            page.page_url,
            120,
          )}`
        );
        if (page.page_referrer) {
          flow.push(`来源：${safeLink(page.page_referrer, 120)}`);
        }
        if (i === pages.length - 1) flow.push("</blockquote>");
      }
    }
    return flow;
  } catch (error) {
    return [];
  }
};

export const composeMessage = async (
  website_id: string,
  session_id: string,
  action: boolean
) => {
  try {
    await crisp.patch(
      `/website/${website_id}/conversation/${session_id}/compose`,
      {
        type: action ? "start" : "stop",
        from: "operator",
      }
    );
  } catch {
    return false;
  }
  return true;
};
export const sendMessage = async (
  website_id: string,
  session_id: string,
  message: string,
  botName: string,
  botURL: string
) => {
  try {
    await crisp.post(
      `/website/${website_id}/conversation/${session_id}/message`,
      {
        type: "text",
        content: message,
        from: "operator",
        origin: Bun.env.CRISP_URN ?? "chat",
        user: {
          type: "website",
          nickname: botName ?? "智能客服",
          avatar: botURL ?? "https://img.icons8.com/officel/80/bot.png",
        },
      }
    );
    return true;
  } catch (error) {
    throw error;
  }
};
export const sendOption = async (
  website_id: string,
  session_id: string,
  option: any,
  botName: string,
  botURL: string
) => {
  try {
    await crisp.post(
      `/website/${website_id}/conversation/${session_id}/message`,
      {
        type: "picker",
        content: {
          id: option.id,
          text: option.text,
          choices: option.options.map((choice: any) => {
            return {
              value: choice.id,
              label: choice.label,
              selected: false,
            };
          }),
        },
        from: "operator",
        origin: Bun.env.CRISP_URN ?? "chat",
        user: {
          type: "website",
          nickname: botName ?? "智能客服",
          avatar: botURL ?? "https://img.icons8.com/officel/80/bot.png",
        },
      }
    );
    return true;
  } catch (error) {
    throw error;
  }
};

export const checkSession = async (website_id: string, session_id: string) => {
  try {
    await crisp.head(`/website/${website_id}/conversation/${session_id}`);
    return true;
  } catch (error) {
    return false;
  }
};
export const getMessages = async (website_id: string, session_id: string) => {
  try {
    const result = await checkSession(website_id, session_id);
    if (!result) return [];
    const {
      data: { data },
    } = await crisp.get(
      `/website/${website_id}/conversation/${session_id}/messages`
    );
    return data;
  } catch (error) {
    throw error;
  }
};
