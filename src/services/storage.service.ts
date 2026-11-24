import path from "path";
import { mkdir, readdir, stat, unlink } from "fs/promises";

/**
 * 本地文件存储
 *
 * 说明：Telegram 客服发来的图片/贴纸存到 `UPLOAD_DIR`，由 Hono 挂在 `/upload/*` 对外提供，
 * 再把公网地址发给 Crisp。Crisp 要从公网拉图，所以：
 * - `/upload/*` 不能放在 Basic 认证后面
 * - 必须配置 `PUBLIC_URL`（对外访问的 https 地址，结尾不带斜杠）
 */
export const UPLOAD_DIR = path.resolve(Bun.env.UPLOAD_DIR ?? "./data/upload");
export const UPLOAD_ROUTE = "/upload";

const publicUrl = () => (Bun.env.PUBLIC_URL ?? "").replace(/\/+$/, "");

// 文件名只保留安全字符，防止路径穿越。Telegram 的 file_id 本身就是 base64url
const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_");

/**
 * 保存文件并返回公网地址
 */
export const saveFile = async (name: string, data: Uint8Array) => {
  await mkdir(UPLOAD_DIR, { recursive: true });
  const fileName = safeName(name);
  await Bun.write(path.join(UPLOAD_DIR, fileName), data);
  return `${publicUrl()}${UPLOAD_ROUTE}/${fileName}`;
};

/**
 * 按文件名取文件，不存在返回 `null`
 */
export const getFile = async (name: string) => {
  const file = Bun.file(path.join(UPLOAD_DIR, safeName(name)));
  return (await file.exists()) ? file : null;
};

/**
 * 上传文件保留天数。默认 0 = 永不清理：这些图片的地址永久留在 Crisp 的聊天记录里，
 * 删掉后历史消息里的图就打不开了，所以必须由部署者自己决定是否开启
 */
export const uploadRetentionDays = (raw = Bun.env.UPLOAD_RETENTION_DAYS) => {
  if (raw === undefined || raw === "") return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 0;
};

/**
 * 删除上传目录里超过指定时长没改动过的文件，返回删除数量。
 * 只处理目录下的普通文件，不进子目录、不跟随符号链接
 */
export const deleteFilesOlderThan = async (
  maxAgeMs: number,
  dir = UPLOAD_DIR,
  now = Date.now(),
) => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || now - info.mtimeMs <= maxAgeMs) continue;
      await unlink(file);
      deleted++;
    } catch {}
  }
  return deleted;
};
