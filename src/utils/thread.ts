/**
 * 对话历史的上限。
 *
 * 历史每次都会整段发给模型，不设上限的话费用随对话变长越来越高，
 * 超过模型上下文后这个会话的 AI 回复还会永久失败。这里只保留最近的一段。
 */
export const THREAD_MAX_MESSAGES = 40;
export const THREAD_MAX_CHARS = 24_000;
/** 单条消息的上限，超过就截断（访客可以一次贴很长的文本） */
export const THREAD_MESSAGE_MAX_CHARS = 4_000;
// 图片等非文本内容没法按字数算，按固定值计入
const NON_TEXT_COST = 1_000;

const cost = (message: any) =>
  typeof message?.content === "string" ? message.content.length : NON_TEXT_COST;

export const trimThread = <T = any>(
  thread: T[] | null | undefined,
  maxMessages = THREAD_MAX_MESSAGES,
  maxChars = THREAD_MAX_CHARS,
): T[] => {
  if (!Array.isArray(thread)) return [];
  const kept: T[] = [];
  let total = 0;
  // 从最新的往回取，直到条数或总字数到上限；至少保留最新一条
  for (let i = thread.length - 1; i >= 0 && kept.length < maxMessages; i--) {
    let message: any = thread[i];
    if (!message) continue;
    if (
      typeof message.content === "string" &&
      message.content.length > THREAD_MESSAGE_MAX_CHARS
    ) {
      message = {
        ...message,
        content: message.content.slice(0, THREAD_MESSAGE_MAX_CHARS) + "…",
      };
    }
    total += cost(message);
    if (kept.length > 0 && total > maxChars) break;
    kept.push(message);
  }
  return kept.reverse();
};
