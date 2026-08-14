import path from "node:path";

/**
 * 运行时配置上下文（Phase 1a.3）
 * 统一注入路径基准与配置数据，替代各模块直接读取 process.cwd() / process.env。
 * - Web：createCore 启动时 configure({ baseDir: process.cwd(), env: process.env })
 * - Electron：createCore 启动时 configure({ baseDir: app.getPath('userData') })
 * - 未 configure 时（单测直接 import 模块）回退到 process.cwd()/process.env，行为不变。
 */

export interface PrysmConfig {
  /** 路径基准：Web=process.cwd()，Electron=app.getPath('userData') */
  baseDir: string;
  /** 环境变量（兼容期；Phase 2 起逐步迁入 SQLite） */
  env?: NodeJS.ProcessEnv;
  /** 默认模型 provider（优先于 env MODEL_PROVIDER） */
  defaultProvider?: string;
  /** 默认模型 ID（优先于 env MODEL_ID） */
  defaultModel?: string;
  /** 审批超时（毫秒，优先于 env APPROVAL_TIMEOUT_MS） */
  approvalTimeoutMs?: number;
  /** 多工作区根（Phase 1b 起优先 workspace 表；兼容 env AGENT_ALLOWED_PATHS） */
  allowedRoots?: string[];
  /** skill 扫描目录（Phase 4 使用） */
  skillsDir?: string;
  /** mcp.json 路径（Phase 3 使用） */
  mcpConfigPath?: string;
  /** 模型路由注入（Phase 5：按 role 指定 provider/model，优先级高于 model_route 表） */
  modelRoutes?: Partial<Record<ModelRole, ModelRoute>>;
  /** 审批策略注入（Phase 2：非空字段覆盖 SQLite/env，供 Electron/Web 定制） */
  policy?: import("./policy").PolicyInput;
}

/** 模型路由角色与目标（见 model-router.ts） */
export type ModelRole = "orchestrator" | "subagent" | "summarize" | "title";
export interface ModelRoute {
  provider: string;
  model: string;
}

let current: PrysmConfig | undefined;

export function configure(config: PrysmConfig): void {
  current = config;
}

export function getConfig(): PrysmConfig {
  if (!current) {
    current = { baseDir: process.cwd(), env: process.env };
  }
  return current;
}

/** 仅用于测试：清除注入配置，回到默认 env/cwd 行为 */
export function resetConfig(): void {
  current = undefined;
}

/** 读取环境变量（优先注入的 env，否则 process.env） */
export function envValue(name: string): string | undefined {
  const cfg = getConfig();
  return cfg.env?.[name] ?? process.env[name];
}

/** 拼接 baseDir 下的相对路径 */
export function basePath(...segments: string[]): string {
  return path.resolve(getConfig().baseDir, ...segments);
}

/** 默认模型提供商：优先注入值，其次 env MODEL_PROVIDER，最后兜底 */
export function getDefaultProvider(fallback = "anthropic"): string {
  const cfg = getConfig();
  return cfg.defaultProvider ?? envValue("MODEL_PROVIDER") ?? fallback;
}

/** 默认模型 ID：优先注入值，其次 env MODEL_ID，最后兜底 */
export function getDefaultModel(fallback = "claude-sonnet-4-5"): string {
  const cfg = getConfig();
  return cfg.defaultModel ?? envValue("MODEL_ID") ?? fallback;
}

/** 审批超时：优先注入值，其次 env APPROVAL_TIMEOUT_MS，最后兜底（毫秒） */
export function getApprovalTimeoutMs(fallback = 120000): number {
  const cfg = getConfig();
  return cfg.approvalTimeoutMs ?? Number(envValue("APPROVAL_TIMEOUT_MS") ?? fallback);
}
