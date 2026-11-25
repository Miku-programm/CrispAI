/**
 * MCP（Model Context Protocol）的最小服务端实现：Streamable HTTP、无状态、只提供 tools。
 *
 * 每个 POST 带一条（或一批）JSON-RPC 消息，直接用 JSON 应答，不开 SSE 长连接、不保存会话，
 * 所以多副本部署和重启都不影响客户端。协议细节见 https://modelcontextprotocol.io
 */
export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const DEFAULT_VERSION = "2025-06-18";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  handler: (args: unknown) => Promise<unknown>;
};

export type ServerInfo = { name: string; version: string; instructions: string };

/** 工具里抛这个错表示“调用方的问题”，原文会返回给助手；其他异常只返回笼统提示 */
export class ToolError extends Error {}

const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0" as const, id: id ?? null, error: { code, message },
});
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });

const isObject = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** 处理一条消息。通知（没有 id）返回 undefined，不需要应答 */
export async function handleMessage(
  message: unknown,
  tools: Tool[],
  info: ServerInfo,
  onError: (tool: string, error: unknown) => void = () => {},
): Promise<Record<string, unknown> | undefined> {
  if (!isObject(message) || message.jsonrpc !== "2.0") {
    return rpcError(null, -32600, "Invalid Request");
  }
  const { id, method, params } = message;
  // 客户端发来的应答（result/error）和通知都不需要回
  if (typeof method !== "string") return id === undefined || "result" in message || "error" in message
    ? undefined : rpcError(id, -32600, "Invalid Request");
  if (id === undefined || id === null) return undefined;

  switch (method) {
    case "initialize": {
      const requested = isObject(params) ? params.protocolVersion : undefined;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : DEFAULT_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version },
        instructions: info.instructions,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: tools.map(({ handler: _handler, ...tool }) => tool),
      });
    case "tools/call": {
      const name = isObject(params) ? params.name : undefined;
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      try {
        const data = await tool.handler(isObject(params) ? params.arguments ?? {} : {});
        const result: ToolResult = {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
        return rpcResult(id, result);
      } catch (error) {
        if (!(error instanceof ToolError)) onError(tool.name, error);
        // 工具执行失败按协议放在结果里（isError），这样助手能看到原因并自行调整
        const result: ToolResult = {
          isError: true,
          content: [{
            type: "text",
            text: error instanceof ToolError ? error.message : "服务器内部错误，请稍后再试",
          }],
        };
        return rpcResult(id, result);
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** 处理一次 POST 的请求体（单条或批量）。返回 undefined 表示只有通知，应答 202 */
export async function handleBody(
  body: unknown,
  tools: Tool[],
  info: ServerInfo,
  onError?: (tool: string, error: unknown) => void,
) {
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > 20) return rpcError(null, -32600, "Invalid Request");
    const responses = [];
    for (const message of body) {
      const response = await handleMessage(message, tools, info, onError);
      if (response) responses.push(response);
    }
    return responses.length > 0 ? responses : undefined;
  }
  return handleMessage(body, tools, info, onError);
}
