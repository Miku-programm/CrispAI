import { expect, test } from "bun:test";
import { handleBody, handleMessage, ToolError, type Tool } from "../src/mcp/protocol";

const info = { name: "crispai", version: "1.0.0", instructions: "be careful" };
const tools: Tool[] = [
  { name: "echo", title: "Echo", description: "d", inputSchema: { type: "object" },
    annotations: { readOnlyHint: true }, handler: async (args) => ({ got: args }) },
  { name: "bad_input", title: "", description: "", inputSchema: { type: "object" }, annotations: {},
    handler: async () => { throw new ToolError("参数不正确"); } },
  { name: "crash", title: "", description: "", inputSchema: { type: "object" }, annotations: {},
    handler: async () => { throw new Error("postgres://user:secret@db/x connection refused"); } },
];
const call = (message: unknown, onError?: any) => handleMessage(message, tools, info, onError) as Promise<any>;

test("initialize echoes a supported version and falls back for unknown ones", async () => {
  const known = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  expect(known.result.protocolVersion).toBe("2025-03-26");
  expect(known.result.capabilities).toEqual({ tools: { listChanged: false } });
  expect(known.result.instructions).toBe("be careful");
  const future = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } });
  expect(future.result.protocolVersion).toBe("2025-06-18");
});

test("tools/list never exposes handlers", async () => {
  const listed = await call({ jsonrpc: "2.0", id: "a", method: "tools/list" });
  expect(listed.id).toBe("a");
  expect(listed.result.tools.map((t: any) => t.name)).toEqual(["echo", "bad_input", "crash"]);
  expect(listed.result.tools.every((t: any) => !("handler" in t))).toBe(true);
});

test("tools/call returns data, caller errors verbatim and hides internal errors", async () => {
  const ok = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } });
  expect(JSON.parse(ok.result.content[0].text)).toEqual({ got: { a: 1 } });
  expect(ok.result.isError).toBeUndefined();
  const bad = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bad_input" } });
  expect(bad.result).toEqual({ isError: true, content: [{ type: "text", text: "参数不正确" }] });
  const logged: string[] = [];
  const crash = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "crash" } },
    (tool: string) => logged.push(tool));
  expect(crash.result.isError).toBe(true);
  expect(crash.result.content[0].text).not.toContain("secret");
  expect(logged).toEqual(["crash"]);
  const unknown = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } });
  expect(unknown.error.code).toBe(-32602);
});

test("notifications get no reply; malformed and unknown requests get JSON-RPC errors", async () => {
  expect(await call({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
  expect(await call({ jsonrpc: "2.0", id: 9, result: {} })).toBeUndefined();
  expect((await call({ jsonrpc: "2.0", id: 6, method: "resources/list" })).error.code).toBe(-32601);
  expect((await call({ id: 7, method: "ping" })).error.code).toBe(-32600);
  expect((await call("nonsense")).error.code).toBe(-32600);
  expect((await call({ jsonrpc: "2.0", id: 8, method: "ping" })).result).toEqual({});
});

test("batches answer requests only and reject empty or oversized batches", async () => {
  const batch = await handleBody([
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ], tools, info) as any[];
  expect(batch.map((r) => r.id)).toEqual([1, 2]);
  expect(await handleBody([{ jsonrpc: "2.0", method: "notifications/x" }], tools, info)).toBeUndefined();
  expect((await handleBody([], tools, info) as any).error.code).toBe(-32600);
  expect((await handleBody(Array(21).fill({ jsonrpc: "2.0", id: 1, method: "ping" }), tools, info) as any).error.code).toBe(-32600);
});
