import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import z from "zod";
import * as db from "@/services/db.service";
import { isSupportOnline } from "@/services/support.policy";
import { supportConflictMessage, supportSchema } from "@/types/support";

const projectQuery = z.object({ project_id: z.string().uuid() });
const sessionBody = projectQuery.extend({
  session_id: z.string().trim().min(1, "请填写会话 ID").max(256)
    .regex(/^\S+$/, "会话 ID 不能包含空格")
    .refine((value) => value !== "session_", "请填写完整会话 ID"),
});
const saveBody = projectQuery.extend({ support: supportSchema });
const blockBody = sessionBody.extend({ reason: z.string().trim().max(500).default("") });

const checked = <T extends z.ZodTypeAny, Target extends "json" | "query">(target: Target, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json({
        message: result.error.issues.map((issue) => issue.message).join("；"),
      }, 400);
    }
  });

/** 挂载在已认证的 /api/v1/support；不要单独挂到公开路由。 */
const supportApi = new Hono();

supportApi.get("/", checked("query", projectQuery), async (c) => {
  const project = await db.getProjectById(c.req.query("project_id")!);
  if (!project) return c.json({ message: "项目不存在" }, 404);
  return c.json({
    data: {
      project_id: project.id,
      name: project.name,
      website_id: project.websiteId,
      enableAI: project.enableAI,
      enableKeyword: project.enableKeyword,
      currentOnline: isSupportOnline(project.support),
      support: project.support,
    },
  });
});

supportApi.post(
  "/",
  checked("json", saveBody),
  async (c) => {
    const { project_id, support } = saveBody.parse(await c.req.json());
    const project = await db.getProjectById(project_id);
    if (!project) return c.json({ message: "项目不存在" }, 404);
    const conflict = supportConflictMessage(support, !!project.enableAI);
    if (conflict) return c.json({ message: conflict }, 400);
    const saved = await db.saveProjectSupport(project_id, support);
    if (!saved) return c.json({ message: "项目不存在" }, 404);
    return c.json({
      message: "客服设置已保存，旧的等待任务已取消",
      data: saved.support,
      currentOnline: isSupportOnline(saved.support),
    });
  },
);

supportApi.get("/blocked", checked("query", projectQuery), async (c) => {
  const project = await db.getProjectById(c.req.query("project_id")!);
  if (!project) return c.json({ message: "项目不存在" }, 404);
  const data = project.websiteId ? await db.listBlockedSessions(project.websiteId) : [];
  return c.json({ data });
});

supportApi.post(
  "/block",
  checked("json", blockBody),
  async (c) => {
    const { project_id, session_id, reason } = blockBody.parse(await c.req.json());
    const project = await db.getProjectById(project_id);
    if (!project) return c.json({ message: "项目不存在" }, 404);
    if (!project.websiteId) return c.json({ message: "请先设置项目 Website ID" }, 400);
    const data = await db.blockSession(project.websiteId, session_id, reason, "manual");
    return c.json({ message: "已屏蔽此会话，后续访客消息不再转发至 Telegram", data });
  },
);

supportApi.post("/unblock", checked("json", sessionBody), async (c) => {
  const { project_id, session_id } = sessionBody.parse(await c.req.json());
  const project = await db.getProjectById(project_id);
  if (!project) return c.json({ message: "项目不存在" }, 404);
  if (!project.websiteId) return c.json({ message: "请先设置项目 Website ID" }, 400);
  const { unblockCustomer } = await import("@/services/support.service");
  await unblockCustomer(project.websiteId, session_id);
  return c.json({ message: "已解除屏蔽；后续新消息恢复接收" });
});

export default supportApi;
