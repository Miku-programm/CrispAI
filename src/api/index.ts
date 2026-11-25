import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";

import z from "zod";
import { authMiddleware, clientKey, limiterFor } from "@/middlewares/auth.middleware";
import {
  checkCredentials,
  endSession,
  isSameSiteRequest,
  startSession,
} from "@/services/session.service";
import introTask from "@/jobs/intro.task";
import { enqueue } from "@/utils/queue";
import { validate } from "@/api/validator";
import * as project from "@/api/project.controller";
import * as option from "@/api/option.controller";
import * as payload from "@/api/payload.controller";
import * as transfer from "@/api/transfer.controller";
import supportApi from "@/api/support.controller";
import * as db from "@/services/db.service";
import { connection } from "@/services/redis.service";
import {
  allowIntro,
  INTRO_BODY_LIMIT,
  INTRO_JOB_OPTIONS,
  introSchema,
} from "@/services/introGuard.service";

/**
 * 管理后台接口（/api/v1）
 *
 * 除 intro 外全部需要 Basic 认证。写接口沿用原来的路由名，前端改动最小；
 * 读接口是新增的，替代原来浏览器直连数据库的查询。
 */
const api = new Hono();

// intro 由访客网站上的 intro.js 跨域调用，公开且不需要认证
const introCors = cors({
  origin: "*",
  allowMethods: ["POST", "OPTIONS"],
  allowHeaders: ["Content-Type"],
});
api.use("/intro", introCors);
api.post(
  "/intro",
  bodyLimit({
    maxSize: INTRO_BODY_LIMIT,
    onError: (c) => c.json({ message: "请求体过大" }, 413),
  }),
  validate("json", introSchema),
  async (c) => {
    // 只取校验过的两个字段入队，请求里多带的任何内容都不会进 Redis
    const data = introSchema.parse(await c.req.json());
    // 不认识的站点、被限流或短时间内重复的请求都直接丢弃，统一返回成功，不向调用方暴露原因
    if (
      (await db.getProject(data.website_id)) &&
      (await allowIntro(connection, data))
    ) {
      await enqueue(introTask.queue, "intro", data, INTRO_JOB_OPTIONS);
    }
    return c.json({ message: "成功" });
  },
);

// 登录 / 退出：登录页调用，自身不需要已登录
api.post(
  "/login",
  bodyLimit({ maxSize: 2 * 1024, onError: (c) => c.json({ message: "请求体过大" }, 413) }),
  validate("json", z.object({ username: z.string().max(200), password: z.string().max(500) })),
  async (c) => {
    if (!Bun.env.ADMIN_PASSWORD) {
      return c.json({ message: "未配置 ADMIN_PASSWORD，管理后台已禁用" }, 503);
    }
    if (!isSameSiteRequest(c)) return c.json({ message: "请求来源不被允许" }, 403);
    // 和 Basic 认证共用同一套失败次数限制
    const key = clientKey(c);
    const limiter = limiterFor(key);
    const wait = limiter.retryAfter(key);
    if (wait > 0) {
      c.header("Retry-After", String(Math.ceil(wait / 1000)));
      return c.json({ message: "登录失败次数过多，请稍后再试", code: "too_many_attempts" }, 429);
    }
    const { username, password } = await c.req.json();
    if (!checkCredentials(username, password)) {
      limiter.fail(key);
      return c.json({ message: "账号或密码不正确", code: "invalid_credentials" }, 401);
    }
    limiter.succeed(key);
    return c.json({ message: "登录成功", secure: startSession(c) });
  },
);
api.post("/logout", (c) => {
  // 只接受本站页面发起的退出，别的网站不能替你退出登录
  if (!isSameSiteRequest(c)) return c.json({ message: "请求来源不被允许" }, 403);
  endSession(c);
  return c.json({ message: "已退出登录" });
});

api.use("*", authMiddleware);
api.route("/support", supportApi);

// project
api.get("/projects", project.listController);
api.get("/project", project.getSchema, project.getController);
api.post("/createProject", project.createSchema, project.createController);
api.post("/deleteProject", project.deleteSchema, project.deleteController);
api.post(
  "/saveProjectGeneral",
  project.saveGeneralSchema,
  project.saveGeneralController,
);
api.post("/saveProjectAI", project.saveAISchema, project.saveAIController);
api.post(
  "/saveProjectKeyword",
  project.saveKeywordSchema,
  project.saveKeywordController,
);
// option
api.get("/options", option.listSchema, option.listController);
api.post("/saveProjectOption", option.saveSchema, option.saveController);
api.post("/deleteProjectOption", option.deleteSchema, option.deleteController);
// payload
api.get("/payloads", payload.listSchema, payload.listController);
api.post("/saveProjectPayload", payload.saveSchema, payload.saveController);
api.post(
  "/deleteProjectPayload",
  payload.deleteSchema,
  payload.deleteController,
);
// 导入导出
api.get("/exportProject", transfer.exportSchema, transfer.exportController);
api.post("/importProject", transfer.importSchema, transfer.importController);

api.all("*", (c) => c.json({ message: "接口不存在" }, 404));

export default api;
