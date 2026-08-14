import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  CallToolResult,
  ListToolsResult,
  ReadResourceResult,
  GetPromptResult,
  Resource,
  Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import fs from "node:fs";
import { basePath } from "../config";
import type { ToolProvider } from "./registry";

/**
 * MCP 客户端池与工具 provider（Phase 3，stdio 先行）
 * 接入 MCP 三类能力：
 * - tools     —— 映射为 AgentTool（mcp__<server>__<tool>），经 registry 进入 Agent 工具集
 * - resources —— McpClientPool.readResource / listResources 暴露，供 API / 上下文注入
 * - prompts   —— McpClientPool.getPrompt / listPrompts 暴露
 *
 * 降级策略：server 崩溃 / 连接超时 → 该 server 标记 error，其工具从工具集剔除，
 * 调用返回明确错误提示而非整体卡死；下次 load/call 时尝试自动重连。
 *
 * 注意：本模块只依赖 pi-agent-core / Node 内置 / MCP SDK，不依赖 Next.js。
 */

// ---------------------------------------------------------------- 配置

/** stdio 本地子进程 server（Phase 3 主推） */
export interface McpStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** 远程 server（streamable HTTP / SSE，Phase 3 后补） */
export interface McpRemoteServer {
  url: string;
  transport?: "http" | "sse";
  headers?: Record<string, string>;
}

export type McpServerOptions = McpStdioServer | McpRemoteServer;

export interface McpConfigFile {
  servers?: Record<string, McpServerOptions>;
}

function isStdio(o: McpServerOptions): o is McpStdioServer {
  return typeof (o as McpStdioServer).command === "string";
}

/**
 * 读取 mcp.json（默认 <baseDir>/mcp.json），解析出 servers 映射。
 * 文件缺失 / 非法时返回空对象（不抛错，按「无 MCP 配置」处理）。
 */
export function loadMcpConfig(mcpConfigPath?: string): Record<string, McpServerOptions> {
  let raw: string;
  try {
    raw = fs.readFileSync(mcpConfigPath ?? basePath("mcp.json"), "utf-8");
  } catch {
    return {};
  }
  try {
    const cfg = JSON.parse(raw) as McpConfigFile;
    return (cfg.servers ?? {}) as Record<string, McpServerOptions>;
  } catch (err) {
    console.error(`[mcp] mcp.json 解析失败: ${(err as Error).message}`);
    return {};
  }
}

// ------------------------------------------------------- JSON Schema → typebox

/**
 * JSON Schema → typebox TSchema（供 AgentTool.parameters 使用）。
 * 支持常见类型 / enum / anyOf / oneOf / 嵌套 object；无法映射时兜底 Type.Unsafe（原样透传）。
 */
export function jsonSchemaToTypebox(schema: Record<string, unknown> | undefined): TSchema {
  if (!schema || typeof schema !== "object") return Type.Unsafe({ type: "object" });
  const s = schema as Record<string, any>;
  if (Array.isArray(s.enum)) {
    const literals = s.enum.map((v: unknown) => Type.Literal(v as string | number | boolean));
    return literals.length === 1 ? literals[0] : Type.Union(literals);
  }
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const parts = (s.anyOf ?? s.oneOf).map((sub: Record<string, unknown>) =>
      jsonSchemaToTypebox(sub),
    );
    return parts.length === 1 ? parts[0] : Type.Union(parts);
  }
  const desc = typeof s.description === "string" ? { description: s.description } : {};
  switch (s.type) {
    case "string":
      return Type.String(desc);
    case "number":
      return Type.Number(desc);
    case "integer":
      return Type.Integer(desc);
    case "boolean":
      return Type.Boolean(desc);
    case "null":
      return Type.Null();
    case "array":
      return Type.Array(jsonSchemaToTypebox(s.items ?? {}));
    case "object": {
      const props = (s.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = new Set<string>((s.required ?? []) as string[]);
      const fields: Record<string, TSchema> = {};
      for (const [key, sub] of Object.entries(props)) {
        const inner = jsonSchemaToTypebox(sub);
        fields[key] = required.has(key) ? inner : Type.Optional(inner);
      }
      return Type.Object(fields);
    }
    default:
      return Type.Unsafe(schema);
  }
}

// -------------------------------------------------------------- 结果映射

/** 将 MCP CallToolResult 映射为 pi-agent-core 的 AgentToolResult content */
export function mcpResultToAgentContent(res: CallToolResult): {
  content: (TextContent | ImageContent)[];
  isError: boolean;
} {
  const content: (TextContent | ImageContent)[] = [];
  for (const item of res.content ?? []) {
    if (item.type === "text") {
      content.push({ type: "text", text: item.text });
    } else if (item.type === "image") {
      content.push({ type: "image", data: item.data, mimeType: item.mimeType });
    } else {
      content.push({ type: "text", text: JSON.stringify(item) });
    }
  }
  if (res.structuredContent !== undefined) {
    content.push({ type: "text", text: JSON.stringify(res.structuredContent) });
  }
  return { content, isError: res.isError === true };
}

// -------------------------------------------------------------- 客户端池

export type McpServerStatusKind = "connected" | "connecting" | "error" | "disabled";

export interface McpServerStatus {
  name: string;
  status: McpServerStatusKind;
  /** error/disabled 时的原因说明 */
  error?: string;
  tools: number;
  resources: number;
  prompts: number;
  transport: "stdio" | "http" | "sse";
  command?: string;
  url?: string;
}

export interface McpToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** 服务端标注：只读 / 破坏性（影响 sensitive 判定） */
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

interface McpServerHandle {
  name: string;
  options: McpServerOptions;
  client: Client | null;
  status: McpServerStatusKind;
  error?: string;
  tools: McpToolDef[];
  resources: Resource[];
  prompts: Prompt[];
}

const CONNECT_TIMEOUT_MS = 15_000;

export class McpClientPool {
  private handles = new Map<string, McpServerHandle>();
  private initialized = false;

  constructor(private configPath?: string) {}

  private async createClient(name: string, options: McpServerOptions): Promise<Client> {
    const client = new Client({ name: `prysm-${name}`, version: "0.1.0" });
    if (isStdio(options)) {
      const transport = new StdioClientTransport({
        command: options.command,
        args: options.args,
        env: options.env,
        cwd: options.cwd,
        stderr: "pipe",
      });
      // 捕获子进程 stderr 供排障
      transport.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8").trim();
        if (text) console.error(`[mcp:${name}] ${text}`);
      });
      // 传输关闭/报错 → 标记 error（供下次调用自动重连）
      transport.onclose = () => this.markError(name, "连接已关闭");
      transport.onerror = (err) => this.markError(name, err.message);
      await client.connect(transport);
    } else {
      const url = (options as McpRemoteServer).url;
      throw new Error(`远程 MCP server "${name}"（${url}）暂未支持：Phase 3 仅支持 stdio，streamable HTTP/SSE 后补`);
    }
    return client;
  }

  private markError(name: string, message: string): void {
    const h = this.handles.get(name);
    if (h && h.status !== "disabled") {
      h.status = "error";
      h.error = message;
      console.error(`[mcp] server "${name}" 不可用: ${message}`);
    }
  }

  private async buildHandle(name: string, options: McpServerOptions): Promise<McpServerHandle> {
    const h: McpServerHandle = {
      name,
      options,
      client: null,
      status: "connecting",
      tools: [],
      resources: [],
      prompts: [],
    };
    this.handles.set(name, h);
    try {
      const client = await this.createClient(name, options);
      // connect 是异步的：用 ping 等待初始化完成（带超时）
      await withTimeout(client.ping(), CONNECT_TIMEOUT_MS, `连接超时（${CONNECT_TIMEOUT_MS / 1000}s）`);
      h.client = client;
      const [toolsR, resourcesR, promptsR] = await Promise.allSettled([
        client.listTools(),
        client.listResources(),
        client.listPrompts(),
      ]);
      if (toolsR.status === "fulfilled") {
        h.tools = toToolDefs((toolsR.value as ListToolsResult).tools);
      }
      if (resourcesR.status === "fulfilled") {
        h.resources = (resourcesR.value as ListResourcesResultLike).resources ?? [];
      }
      if (promptsR.status === "fulfilled") {
        h.prompts = (promptsR.value as ListPromptsResultLike).prompts ?? [];
      }
      h.status = "connected";
    } catch (err) {
      h.status = "error";
      h.error = err instanceof Error ? err.message : String(err);
      console.error(`[mcp] server "${name}" 连接失败: ${h.error}`);
    }
    return h;
  }

  /** 幂等初始化：连接全部已配置 server（并发），返回状态快照 */
  async init(): Promise<McpServerStatus[]> {
    if (this.initialized) return this.status();
    this.initialized = true;
    const servers = loadMcpConfig(this.configPath);
    await Promise.all(
      Object.entries(servers).map(async ([name, options]) => {
        await this.buildHandle(name, options);
      }),
    );
    return this.status();
  }

  /** 状态快照（含未连接阶段的初始化；幂等） */
  async ensureInit(): Promise<McpServerStatus[]> {
    return this.init();
  }

  status(): McpServerStatus[] {
    return [...this.handles.values()].map((h) => {
      const isRemote = !isStdio(h.options);
      return {
        name: h.name,
        status: h.status,
        error: h.error,
        tools: h.tools.length,
        resources: h.resources.length,
        prompts: h.prompts.length,
        transport: isRemote
          ? ((h.options as McpRemoteServer).transport ?? "http")
          : "stdio",
        command: isStdio(h.options) ? h.options.command : undefined,
        url: isRemote ? (h.options as McpRemoteServer).url : undefined,
      };
    });
  }

  /** 连接状态标记为 error 的 server 按需重连（下次访问时自动触发） */
  private async ensureConnected(name: string): Promise<McpServerHandle> {
    await this.init();
    let h = this.handles.get(name);
    if (!h) throw new Error(`MCP server "${name}" 未配置`);
    if (h.status === "error") {
      // 自动重连：重建句柄
      this.handles.delete(name);
      h = await this.buildHandle(name, h.options);
    }
    if (h.status !== "connected") {
      throw new Error(`MCP server "${name}" 不可用: ${h.error ?? "未知错误"}`);
    }
    return h;
  }

  getHandle(name: string): McpServerHandle | undefined {
    return this.handles.get(name);
  }

  connectedServers(): string[] {
    return [...this.handles.values()]
      .filter((h) => h.status === "connected")
      .map((h) => h.name);
  }

  /** 某 server 的工具定义（用于 provider.load；未连接/失败返回空数组） */
  async toolsOf(server: string): Promise<McpToolDef[]> {
    await this.init();
    const h = this.handles.get(server);
    if (!h || h.status !== "connected") return [];
    return h.tools;
  }

  /** 调用某 server 的某个工具（含按需重连） */
  async callTool(
    server: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const h = await this.ensureConnected(server);
    if (!h.client) throw new Error(`MCP server "${server}" 无可用连接`);
    const res = await h.client.callTool({ name: toolName, arguments: args });
    return res as CallToolResult;
  }

  /** 读取某 server 的资源 */
  async readResource(server: string, uri: string): Promise<ReadResourceResult> {
    const h = await this.ensureConnected(server);
    if (!h.client) throw new Error(`MCP server "${server}" 无可用连接`);
    return h.client.readResource({ uri });
  }

  /** 列出某 server 的资源 */
  async listResources(server: string): Promise<Resource[]> {
    await this.init();
    return this.handles.get(server)?.resources ?? [];
  }

  /** 获取某 server 的 prompt（消息模板） */
  async getPrompt(
    server: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<GetPromptResult> {
    const h = await this.ensureConnected(server);
    if (!h.client) throw new Error(`MCP server "${server}" 无可用连接`);
    return h.client.getPrompt({ name, arguments: args });
  }

  /** 列出某 server 的 prompts */
  async listPrompts(server: string): Promise<Prompt[]> {
    await this.init();
    return this.handles.get(server)?.prompts ?? [];
  }

  /** 关闭全部连接（应用退出/重载时调用） */
  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.handles.values()].map(async (h) => {
        try {
          await h.client?.close();
        } catch {
          /* 忽略关闭错误 */
        }
        h.status = "error";
        h.error = "已关闭";
      }),
    );
    this.handles.clear();
    this.initialized = false;
  }
}

interface ListResourcesResultLike {
  resources?: Resource[];
}
interface ListPromptsResultLike {
  prompts?: Prompt[];
}

function toToolDefs(tools: ListToolsResult["tools"]): McpToolDef[] {
  return tools.map((t) => ({
    name: t.name,
    title: t.title ?? t.name,
    description: t.description,
    inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
    readOnlyHint: t.annotations?.readOnlyHint,
    destructiveHint: t.annotations?.destructiveHint,
  }));
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// -------------------------------------------------------------- 工具 provider

/**
 * 单个 MCP server 的工具 provider。
 * 工具命名：mcp__<server>__<tool>；execute 转发 callTool，并把结果 content 映射回 AgentToolResult。
 */
export class McpToolProvider implements ToolProvider {
  readonly id: string;

  constructor(
    private pool: McpClientPool,
    private server: string,
  ) {
    this.id = `mcp:${this.server}`;
  }

  async load(): Promise<AgentTool[]> {
    const defs = await this.pool.toolsOf(this.server);
    if (defs.length === 0) return [];
    const server = this.server;
    return defs.map((t) => {
      const name = `mcp__${server}__${t.name}`;
      return {
        name,
        label: t.title ?? t.name,
        description: t.description ?? `MCP 工具 ${server}::${t.name}`,
        parameters: jsonSchemaToTypebox(t.inputSchema),
        execute: async (_toolCallId, params) => {
          const res = await this.pool.callTool(server, t.name, params as Record<string, unknown>);
          const { content, isError } = mcpResultToAgentContent(res);
          if (isError) {
            const text = content
              .map((c) => (c.type === "text" ? c.text : ""))
              .filter(Boolean)
              .join("\n");
            throw new Error(text || `MCP 工具 ${name} 执行失败`);
          }
          return { content, details: { server, tool: t.name } };
        },
      } satisfies AgentTool;
    });
  }
}

// ------------------------------------------------------------ 模块级单例

let mcpPool: McpClientPool | undefined;

/** 注入 MCP 配置路径（createCore 时调用；缺省 <baseDir>/mcp.json） */
export function configureMcp(mcpConfigPath?: string): McpClientPool {
  mcpPool = new McpClientPool(mcpConfigPath);
  return mcpPool;
}

/** 获取全局池（未配置时惰性创建，读取 <baseDir>/mcp.json） */
export function getMcpPool(): McpClientPool {
  if (!mcpPool) mcpPool = new McpClientPool();
  return mcpPool;
}

/** 供测试：重建池 */
export function resetMcpPool(): void {
  mcpPool = undefined;
}

/** 全部已连接 server 的工具 provider 列表（供 registry 注册；内部先完成初始化） */
export async function mcpToolProviders(): Promise<McpToolProvider[]> {
  const pool = getMcpPool();
  await pool.init();
  return pool.connectedServers().map((s) => new McpToolProvider(pool, s));
}

/**
 * 敏感判定（Phase 3）：MCP 工具按服务端标注与默认策略决定是否走审批流。
 * - destructiveHint=true  → 敏感（破坏性操作）
 * - readOnlyHint=true     → 非敏感（只读）
 * - 两者均未标注          → 默认敏感（外部工具不可信，风险按 medium 兜底）
 * 非 MCP 工具名返回 false（由内置 TOOL_META.sensitive 判定）。
 */
export function isSensitiveMcpTool(toolName: string): boolean {
  const m = /^mcp__(.+)__(.+)$/.exec(toolName);
  if (!m) return false;
  const server = m[1];
  const tool = m[2];
  const def = getMcpPool()
    .getHandle(server)
    ?.tools.find((t) => t.name === tool);
  // 工具不可见（server 未连接等）→ 保守按敏感处理
  if (!def) return true;
  if (def.destructiveHint) return true;
  if (def.readOnlyHint) return false;
  return true;
}
