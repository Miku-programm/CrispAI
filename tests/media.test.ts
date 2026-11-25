import { expect, test } from "bun:test";
import { allowedMediaHosts, isAllowedMediaUrl } from "../src/utils/media";

const hosts = [".crisp.chat"];

test("accepts Crisp storage over https", () => {
  expect(isAllowedMediaUrl("https://storage.crisp.chat/users/upload/a/b.webm", hosts)).toBe(true);
  expect(isAllowedMediaUrl("https://crisp.chat/x.mp3", hosts)).toBe(true);
});

test("rejects internal, look-alike and non-https targets", () => {
  for (const url of [
    "http://storage.crisp.chat/a.mp3",
    "https://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1/a.mp3",
    "https://[::1]/a.mp3",
    "https://2130706433/a.mp3",
    "https://redis:6379/",
    "https://evilcrisp.chat/a.mp3",
    "https://storage.crisp.chat.evil.example/a.mp3",
    "https://user:pw@storage.crisp.chat/a.mp3",
    "https://storage.crisp.chat:8443/a.mp3",
    "file:///etc/passwd",
    "not a url",
  ]) {
    expect(isAllowedMediaUrl(url, hosts)).toBe(false);
  }
  expect(isAllowedMediaUrl(undefined, hosts)).toBe(false);
  expect(isAllowedMediaUrl({ url: "https://storage.crisp.chat/a" }, hosts)).toBe(false);
});

test("MEDIA_ALLOWED_HOSTS overrides the default list", () => {
  expect(allowedMediaHosts(undefined)).toEqual([".crisp.chat"]);
  expect(allowedMediaHosts(" Files.Example.com , .cdn.example ")).toEqual([
    "files.example.com", ".cdn.example",
  ]);
  expect(isAllowedMediaUrl("https://files.example.com/a.mp3", ["files.example.com"])).toBe(true);
  expect(isAllowedMediaUrl("https://x.files.example.com/a.mp3", ["files.example.com"])).toBe(false);
});
