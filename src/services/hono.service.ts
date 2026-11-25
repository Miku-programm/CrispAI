import path from "path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { webhookCallback as telegramWebhook } from "grammy";

import { loggerMiddleware } from "@/middlewares/logger.middleware";
import { crispMiddleware } from "@/middlewares/crisp.middleware";
import { authMiddleware } from "@/middlewares/auth.middleware";
import bot, { WEBHOOK_SECRET } from "@/services/telegram.service";
import { crispWebhook } from "@/services/crisp.service";
import * as storage from "@/services/storage.service";
import logger from "@/services/logger.service";
import api from "@/api";
import { hasSession, safeNext } from "@/services/session.service";
import mcp from "@/mcp";

// 管理页面的静态文件。前端源码不在这个仓库里，打包后的产物同步到 public/ 并随仓库提交
const WEB_DIR = Bun.env.WEB_DIR
  ? path.resolve(Bun.env.WEB_DIR)
  : path.join(import.meta.dir, "../../public");

const hono = new Hono();
hono.use("*", loggerMiddleware);

hono.onError((error, c) => {
  // basicAuth 等中间件用 HTTPException 表达 401，要原样返回（带 WWW-Authenticate 头浏览器才会弹登录框）
  if (error instanceof HTTPException) return error.getResponse();

  logger.error("请求处理异常", {
    url: c.req.url,
    message: error.message,
    stack: error.stack,
  });
  return c.json({ message: "服务器开小差了，请稍后再试" }, 500);
});

// ---- 公开路由：各自带校验，不走 Basic 认证 ----
hono.get("/health", (c) => c.text("ok"));
hono.post(
  "/telegram",
  telegramWebhook(bot, "hono", { secretToken: WEBHOOK_SECRET }),
);
hono.post("/crisp", crispMiddleware, crispWebhook);
// Telegram 客服发的图片，Crisp 要从公网拉取
hono.get(`${storage.UPLOAD_ROUTE}/:name`, async (c) => {
  const file = await storage.getFile(c.req.param("name"));
  if (!file) return c.notFound();
  return new Response(file, {
    headers: { "Cache-Control": "public, max-age=31536000, immutable" },
  });
});
// 访客网站引用的欢迎语脚本
hono.get("/intro.js", serveStatic({ root: WEB_DIR }));

// 登录页。自身和它用到的图标不需要认证；已登录时直接去目标页面
const LOGIN_PAGE = path.join(import.meta.dir, "../../web/login.html");
hono.get("/login", async (c) => {
  if (hasSession(c)) return c.redirect(safeNext(c.req.query("next")));
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "same-origin");
  return c.html(await Bun.file(LOGIN_PAGE).text());
});
// 退出登录的确认页。GET 本身不改变登录状态（否则任何网站放一个指向这里的链接就能把你登出），
// 真正的退出由页面上的按钮向 /api/v1/logout 发 POST 完成
const LOGOUT_PAGE = path.join(import.meta.dir, "../../web/logout.html");
hono.get("/logout", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
  return c.html(await Bun.file(LOGOUT_PAGE).text());
});
hono.get("/favicon.ico", serveStatic({ root: WEB_DIR }));
hono.get("/logo-simple.png", serveStatic({ root: WEB_DIR }));

// 给外部 AI 助手用的 MCP 接口，自带 Bearer 令牌认证，见 mcp/index.ts
hono.route("/mcp", mcp);

// /api/v1 里除 intro 外都需要认证，见 api/index.ts
hono.route("/api/v1", api);
hono.get("/support", authMiddleware, async (c) =>
  c.html(await Bun.file(path.join(import.meta.dir, "../../web/support.html")).text()),
);
hono.get("/support/", authMiddleware, (c) => c.redirect("/support"));

/**
 * 挂载管理页面。放在所有路由之后调用（index.ts 里 /jobs 挂完再调），
 * 这样静态文件兜底不会抢在其他路由前面
 */
export const mountWeb = () => {
  hono.use("*", authMiddleware);
  hono.use("*", serveStatic({ root: WEB_DIR }));
  hono.notFound((c) => c.text("Not Found", 404));
};

export { authMiddleware };
export default hono;
