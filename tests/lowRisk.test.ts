import { expect, test } from "bun:test";
import { mkdtemp, writeFile, utimes, readdir, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { isValidKeyword, KEYWORD_INPUT_MAX, matchKeyword } from "../src/utils/keyword";
import { deleteFilesOlderThan, uploadRetentionDays } from "../src/services/storage.service";

test("a broken keyword rule is skipped instead of failing every message", () => {
  const rules = [{ keyword: "(unclosed", type: "text" }, { keyword: "退款|refund", type: "text" }];
  expect(matchKeyword("我要退款", rules)).toBe(rules[1]);
  expect(matchKeyword("hello", rules)).toBeUndefined();
  expect(matchKeyword("x", [null as any, { type: "text" } as any])).toBeUndefined();
  expect(matchKeyword({ url: "x" }, rules)).toBeUndefined();
  expect(matchKeyword("x", undefined)).toBeUndefined();
  expect(isValidKeyword("a+")).toBe(true);
  expect(isValidKeyword("(a")).toBe(false);
  expect(isValidKeyword(5)).toBe(false);
});

test("only the head of a long message is matched, bounding regex cost", () => {
  const rules = [{ keyword: "needle" }];
  expect(matchKeyword("needle" + "a".repeat(50_000), rules)).toBe(rules[0]);
  expect(matchKeyword("a".repeat(KEYWORD_INPUT_MAX) + "needle", rules)).toBeUndefined();
  const started = performance.now();
  matchKeyword("a".repeat(5_000_000) + "!", [{ keyword: "^(a|aa)+$" }]);
  expect(performance.now() - started).toBeLessThan(5_000);
});

test("upload cleanup removes only old regular files in the upload directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "crispai-upload-"));
  try {
    const day = 24 * 3600 * 1000, now = Date.now();
    const old = new Date(now - 200 * day), recent = new Date(now - 10 * day);
    await writeFile(path.join(dir, "old.jpg"), "x"); await utimes(path.join(dir, "old.jpg"), old, old);
    await writeFile(path.join(dir, "new.jpg"), "x"); await utimes(path.join(dir, "new.jpg"), recent, recent);
    await mkdir(path.join(dir, "sub")); await writeFile(path.join(dir, "sub", "old.jpg"), "x");
    await utimes(path.join(dir, "sub", "old.jpg"), old, old); await utimes(path.join(dir, "sub"), old, old);
    expect(await deleteFilesOlderThan(180 * day, dir, now)).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(["new.jpg", "sub"]);
    expect(await readdir(path.join(dir, "sub"))).toEqual(["old.jpg"]);
    expect(await deleteFilesOlderThan(day, path.join(dir, "missing"), now)).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("upload cleanup is opt-in: nothing is deleted unless a retention is configured", () => {
  expect(uploadRetentionDays(undefined)).toBe(0);
  expect(uploadRetentionDays("")).toBe(0);
  expect(uploadRetentionDays("0")).toBe(0);
  expect(uploadRetentionDays("30")).toBe(30);
  expect(uploadRetentionDays("-3")).toBe(0);
  expect(uploadRetentionDays("abc")).toBe(0);
});
