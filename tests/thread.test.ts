import { expect, test } from "bun:test";
import { THREAD_MESSAGE_MAX_CHARS, trimThread } from "../src/utils/thread";

const message = (n: number, size = 10) => ({ role: "user", content: `${n}:`.padEnd(size, "x") });

test("keeps the newest messages in order up to the count limit", () => {
  const thread = Array.from({ length: 100 }, (_, i) => message(i));
  const kept = trimThread(thread, 5, 10_000);
  expect(kept.map((m) => m.content.split(":")[0])).toEqual(["95", "96", "97", "98", "99"]);
});

test("stops at the character budget but always keeps the latest message", () => {
  const thread = [message(0, 400), message(1, 400), message(2, 400)];
  expect(trimThread(thread, 40, 900).length).toBe(2);
  expect(trimThread(thread, 40, 10).length).toBe(1);
  expect(trimThread(thread, 40, 10)[0]!.content.startsWith("2:")).toBe(true);
});

test("clips one oversized message without mutating the stored object", () => {
  const huge = { role: "user", content: "a".repeat(THREAD_MESSAGE_MAX_CHARS * 3) };
  const [kept] = trimThread([huge]);
  expect(kept!.content.length).toBe(THREAD_MESSAGE_MAX_CHARS + 1);
  expect(huge.content.length).toBe(THREAD_MESSAGE_MAX_CHARS * 3);
});

test("handles images, holes and missing history", () => {
  const image = { role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] };
  expect(trimThread([null, image, message(1)] as any[]).length).toBe(2);
  expect(trimThread(undefined)).toEqual([]);
  expect(trimThread(null)).toEqual([]);
});
