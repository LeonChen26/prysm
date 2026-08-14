/**
 * 测试用 MCP mock server（stdio 传输）。
 * 供 tests/unit/test-mcp.ts 驱动真实的 McpClientPool 连接与工具调用。
 * 暴露：
 * - 工具 hello（readOnlyHint）、delete_all（destructiveHint）、echo（无标注）
 * - 资源 mock://doc
 * - prompt greet
 * 运行：node tests/fixtures/mcp-mock-server.mjs
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "prysm-mock-server", version: "1.0.0" },
  {
    capabilities: { tools: {}, resources: {}, prompts: {} },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "hello",
      title: "打招呼",
      description: "返回一句问候",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "称呼" } },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "delete_all",
      title: "清空数据",
      description: "破坏性操作：清空全部数据",
      inputSchema: { type: "object", properties: {} },
      annotations: { destructiveHint: true },
    },
    {
      name: "echo",
      title: "回显",
      description: "无标注工具：按输入原样返回",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "hello") {
    const who = args?.name ?? "world";
    return { content: [{ type: "text", text: `hello, ${who}` }] };
  }
  if (name === "delete_all") {
    return { content: [{ type: "text", text: "all deleted" }] };
  }
  if (name === "echo") {
    return { content: [{ type: "text", text: String(args?.text ?? "") }] };
  }
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: "mock://doc", name: "样例文档", mimeType: "text/plain" },
  ],
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{ name: "greet", description: "问候模板" }],
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (req.params.name === "greet") {
    return {
      messages: [
        { role: "user", content: { type: "text", text: "请问候用户" } },
      ],
    };
  }
  throw new Error(`unknown prompt: ${req.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
