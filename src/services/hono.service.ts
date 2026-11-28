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
// 客服接待设置原来是单独的 /support 页面，现在是项目管理页里的「客服接待」标签。
// 旧地址保留为跳转，已有的书签不会失效
hono.get("/support", authMiddleware, (c) => c.redirect("/dashboard"));
hono.get("/support/", authMiddleware, (c) => c.redirect("/dashboard"));

// 后台的补充脚本（「客服接待」标签、退出登录按钮），由下面的 mountWeb 注入到后台页面
const EXTRAS_SCRIPT = path.join(import.meta.dir, "../../web/dashboard-extras.js");
export const EXTRAS_TAG = '<script src="/dashboard-extras.js" defer></script>';
hono.get("/dashboard-extras.js", authMiddleware, async (c) => {
  c.header("Content-Type", "text/javascript; charset=utf-8");
  // 每次都向服务器确认，升级后不会继续用旧脚本
  c.header("Cache-Control", "no-cache");
  return c.body(await Bun.file(EXTRAS_SCRIPT).text());
});

/**
 * 请求的是不是后台的某个页面（前端打包产物里的 index.html），是的话返回文件路径。
 * 只认不带扩展名的路径，并确认解析后的位置仍在 WEB_DIR 里
 */
export const dashboardPageFile = async (pathname: string): Promise<string | null> => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || /\.[^/]*$/.test(decoded)) return null;
  const file = path.resolve(WEB_DIR, "." + path.posix.normalize("/" + decoded), "index.html");
  if (file !== path.join(WEB_DIR, "index.html") && !file.startsWith(WEB_DIR + path.sep)) return null;
  return (await Bun.file(file).exists()) ? file : null;
};

/** 在页面末尾挂上补充脚本。前端重新打包同步过来后不用改任何文件，注入自动生效 */
export const injectExtras = (html: string): string => {
  if (html.includes(EXTRAS_TAG)) return html;
  const index = html.lastIndexOf("</body>");
  return index === -1 ? html + EXTRAS_TAG : html.slice(0, index) + EXTRAS_TAG + html.slice(index);
};

/**
 * 挂载管理页面。放在所有路由之后调用（index.ts 里 /jobs 挂完再调），
 * 这样静态文件兜底不会抢在其他路由前面
 */
export const mountWeb = () => {
  hono.use("*", authMiddleware);
  hono.get("*", async (c, next) => {
    const file = await dashboardPageFile(new URL(c.req.url).pathname);
    if (!file) return next();
    return c.html(injectExtras(await Bun.file(file).text()));
  });
  hono.use("*", serveStatic({ root: WEB_DIR }));
  hono.notFound((c) => c.text("Not Found", 404));
};

export { authMiddleware };
export default hono;
