import { expect, test } from "bun:test";
import { clip, escapeHTML, safeLink, unescapeHTML } from "../src/utils/html";

test("escapeHTML neutralises tags, entities and attribute quotes", () => {
  expect(escapeHTML(`Tom <3 & "x"`)).toBe("Tom &lt;3 &amp; &quot;x&quot;");
  expect(escapeHTML(`<a href="https://evil.example">点我</a>`)).not.toContain("<a");
  expect(escapeHTML(null)).toBe("");
  expect(escapeHTML(42)).toBe("42");
});

test("unescapeHTML round-trips escaped text for plain-text topic names", () => {
  const raw = `A&B <c> "d" &lt;`;
  expect(unescapeHTML(escapeHTML(raw))).toBe(raw);
});

test("clip limits by code point and never splits an emoji", () => {
  expect(clip("abcdef", 3)).toBe("abc…");
  expect(clip("abc", 3)).toBe("abc");
  expect(clip("😀😀😀", 2)).toBe("😀😀…");
});

test("safeLink only links http(s) URLs and escapes the href", () => {
  expect(safeLink("https://a.example/?x=1&y=2")).toBe(
    `<a href="https://a.example/?x=1&amp;y=2">https://a.example/?x=1&amp;y=2</a>`,
  );
  expect(safeLink(`https://a.example/"><b>x`)).not.toContain(`"><b>`);
  expect(safeLink("javascript:alert(1)")).toBe("javascript:alert(1)");
  expect(safeLink("tg://resolve?domain=x")).not.toContain("<a");
  expect(safeLink("not a url <b>")).toBe("not a url &lt;b&gt;");
});
