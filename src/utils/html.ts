/**
 * Telegram HTML 消息用的转义工具。
 *
 * 访客昵称、邮箱、页面地址、附加数据都是访客可控的，拼进 parse_mode: "HTML" 的消息前
 * 必须转义：否则一个 "<" 就会让 Telegram 拒收整条消息，合法标签还能伪造链接。
 */
export const escapeHTML = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const unescapeHTML = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");

/** 先截断再转义，保证不会把一个 HTML 实体从中间切断。 */
export const clip = (value: unknown, max: number): string => {
  const text = String(value ?? "");
  // 按码点截断，避免切开 emoji 的代理对
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") + "…" : text;
};

/**
 * 生成 Telegram 链接。只有 http/https 地址才做成可点击链接，
 * 其他（javascript:、tg: 等）一律按纯文本显示。
 */
export const safeLink = (url: unknown, max = 300): string => {
  const text = String(url ?? "");
  const label = escapeHTML(clip(text, max));
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return label;
    // href 超长时 Telegram 会拒收，超长地址只显示不做链接
    if (text.length > 2000) return label;
    return `<a href="${escapeHTML(text)}">${label}</a>`;
  } catch {
    return label;
  }
};
