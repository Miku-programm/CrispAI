/**
 * 关键词匹配。关键词是后台填的正则，输入是访客消息。
 *
 * - 坏正则只跳过这一条规则，不能让该项目所有消息的处理都失败
 * - 只拿消息的前一段去匹配：正则写得不好时，超长输入会让匹配耗时暴涨（ReDoS），
 *   而关键词规则本来也只关心短消息
 */
export const KEYWORD_INPUT_MAX = 2_000;

export const isValidKeyword = (pattern: unknown): pattern is string => {
  if (typeof pattern !== "string") return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

export const matchKeyword = <T extends { keyword?: unknown }>(
  input: unknown,
  keywords: T[] | null | undefined,
): T | undefined => {
  if (typeof input !== "string" || !Array.isArray(keywords)) return;
  const text = input.slice(0, KEYWORD_INPUT_MAX);
  return keywords.find((rule) => {
    if (!rule || !isValidKeyword(rule.keyword)) return false;
    return new RegExp(rule.keyword).test(text);
  });
};
