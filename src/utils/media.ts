import net from "node:net";

/**
 * 访客消息里的文件地址是访客可控的（Crisp 网页 SDK 可以发任意 url 的文件/语音消息），
 * 服务器主动下载之前必须校验，否则就是 SSRF。
 *
 * 默认只允许 Crisp 自己的存储域名；自建代理等特殊情况可用 MEDIA_ALLOWED_HOSTS 覆盖
 * （逗号分隔；以 "." 开头表示匹配该域名及其所有子域名）。
 */
const DEFAULT_ALLOWED_HOSTS = [".crisp.chat"];

export const allowedMediaHosts = (raw = Bun.env.MEDIA_ALLOWED_HOSTS): string[] => {
  const list = (raw ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_ALLOWED_HOSTS;
};

export const isAllowedMediaUrl = (
  url: unknown,
  hosts: string[] = allowedMediaHosts(),
): boolean => {
  if (typeof url !== "string" || url.length > 2000) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== "443") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  // IP 字面量（含 [::1]、十进制/十六进制写法被 URL 规范化后的结果）一律拒绝
  if (net.isIP(host.replace(/^\[|\]$/g, "")) !== 0) return false;
  return hosts.some((allowed) =>
    allowed.startsWith(".")
      ? host === allowed.slice(1) || host.endsWith(allowed)
      : host === allowed,
  );
};

/** 语音文件下载上限：超过就不转码，只把地址转给客服 */
export const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
/** 下载的总时限（含慢速响应），到点直接中断 */
export const MEDIA_DOWNLOAD_TIMEOUT = 30_000;
/** ffmpeg 转码时限，到点杀掉进程 */
export const MEDIA_TRANSCODE_TIMEOUT = 60_000;
