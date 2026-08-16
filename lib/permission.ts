/**
 * 权限与审批配置（对齐 Trae 权限审批模型）
 *
 * 单一事实来源：<baseDir>/permission/global.json（Trae 为 ~/.trae-cn/permission/global.json）。
 * - 权限模式 activeMode：manual（手动审批）/ auto（自动审批，LLM Guardian 决策）/
 *   full（完全访问，不审批）/ custom（自定义，读 customProfiles.default）
 * - 决策方 reviewer：user（弹卡确认）/ llm（LLM Guardian，拒绝回退用户）/ always_deny（一律拒绝）
 * - 场景开关 sceneRules：commandAstDangerChecker（危险命令 AST 检测）/ deleteToolApproval（删除审批）/
 *   mcpToolApproval（MCP 默认审批）
 * - 命令规则 commandRules：精确 / 前缀（git add *）/ 正则（r/.../）→ allow | ask | deny
 * - MCP 规则 mcpRules：server__tool 精确 > server__* 通配 > 裸 server → allow | ask | deny
 * - 资源授权 resourceAuthorization：filesystem / network（本期仅存配置，network 无代理层暂不生效）
 *
 * 优先级：deny > allow；commandRules > commandAstDangerChecker（命中即按命令规则为准，同 Trae）。
 */

import fs from "node:fs";
import path from "node:path";
import { basePath } from "./config";

export type PermissionMode = "manual" | "auto" | "full" | "custom";
export type Reviewer = "user" | "llm" | "always_deny";
export type ApprovalAction = "allow" | "ask" | "deny";

export interface SceneRules {
  /** 危险命令 AST 检测（rm -rf / 等）；关闭后不再因危险命令升级风险 */
  commandAstDangerChecker: boolean;
  /** 删除文件是否需要审批（false=直接放行） */
  deleteToolApproval: boolean;
  /** 未配置 mcpRules 的 MCP 工具调用是否需要审批 */
  mcpToolApproval: boolean;
}

export interface CommandRuleValue {
  approval: ApprovalAction;
  /** 执行环境（本项目无沙箱，仅存配置语义对齐） */
  execEnv?: "byConfig" | "host" | "sandbox";
}

export interface McpRuleValue {
  approval: ApprovalAction;
}

export interface PermissionProfile {
  displayName?: string;
  approval: {
    reviewer: Reviewer;
    sceneRules: SceneRules;
    commandRules: Record<string, CommandRuleValue>;
    mcpRules: Record<string, McpRuleValue>;
  };
}

export interface ResourceAuthorization {
  /** 工具级资源授权（白名单自动放行 / 黑名单强制拦截，支持 mcp__* / skill__* 通配） */
  tools: { allow: string[]; deny: string[] };
  /** 文件系统路径授权（readWrite=自动放行路径，readOnly=强制拦截路径） */
  filesystem: { readWrite: string[]; readOnly: string[] };
  /** 网络授权（本期仅存配置，无代理层暂不生效） */
  network: { allow: string[]; deny: string[] };
}

export interface PermissionConfig {
  activeMode: PermissionMode;
  customProfiles: Record<string, PermissionProfile>;
  resourceAuthorization: ResourceAuthorization;
  /** 审批超时（毫秒）；缺省回退 120000 */
  approvalTimeoutMs: number;
}

/* ------------------------- 默认值 / 预设 ------------------------- */

const DEFAULT_SCENE_RULES: SceneRules = {
  commandAstDangerChecker: true,
  // Trae 默认 false（删除进回收站可恢复）；本项目 delete_file 为硬删除（fs.unlink），
  // 无回收站兜底，故默认开启删除审批以保留原有安全行为。
  deleteToolApproval: true,
  mcpToolApproval: true,
};

const PRESET_MANUAL: PermissionProfile = {
  displayName: "手动审批",
  approval: {
    reviewer: "user",
    sceneRules: { ...DEFAULT_SCENE_RULES },
    commandRules: {},
    mcpRules: {},
  },
};

const PRESET_AUTO: PermissionProfile = {
  displayName: "自动审批",
  approval: {
    reviewer: "llm",
    sceneRules: { ...DEFAULT_SCENE_RULES },
    commandRules: {},
    mcpRules: {},
  },
};

/** full 在决策流中提前短路（完全访问），此处仅占位 */
const PRESET_FULL: PermissionProfile = {
  displayName: "完全访问",
  approval: {
    reviewer: "always_deny",
    sceneRules: { ...DEFAULT_SCENE_RULES },
    commandRules: {},
    mcpRules: {},
  },
};

function defaultProfile(): PermissionProfile {
  return {
    displayName: "自定义",
    approval: {
      reviewer: "user",
      sceneRules: { ...DEFAULT_SCENE_RULES },
      // 默认命令规则：保留历史 seed 的自动放行命令（前缀匹配语义：git push * 命中 git push origin main）
      commandRules: {
        "git push *": { approval: "allow" },
        "npm run *": { approval: "allow" },
      },
      mcpRules: {},
    },
  };
}

function defaultConfig(): PermissionConfig {
  return {
    activeMode: "manual",
    customProfiles: { default: defaultProfile() },
    // 默认资源授权（与历史 policy 表 seed 等价，保证开箱行为平滑）
    resourceAuthorization: {
      tools: { allow: ["append_file"], deny: ["delete_file"] },
      filesystem: { readWrite: ["notes/", "*.md", "sub/dir"], readOnly: [".env", ".git/"] },
      network: { allow: [], deny: [] },
    },
    approvalTimeoutMs: 120000,
  };
}

/* ------------------------- 配置读写 ------------------------- */

let cached: PermissionConfig | null = null;

/** 配置文件路径（<baseDir>/permission/global.json） */
export function permissionFilePath(): string {
  return basePath("permission", "global.json");
}

function normalizeConfig(raw: unknown): PermissionConfig {
  const out = defaultConfig();
  const r = (raw ?? {}) as Record<string, unknown>;
  const mode = r.activeMode;
  if (mode === "manual" || mode === "auto" || mode === "full" || mode === "custom") {
    out.activeMode = mode;
  }
  const timeout = r.approvalTimeoutMs;
  if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) {
    out.approvalTimeoutMs = timeout;
  } else if (typeof timeout === "string" && /^\d+$/.test(timeout.trim())) {
    out.approvalTimeoutMs = Number(timeout.trim());
  }
  const profiles = r.customProfiles as Record<string, unknown> | undefined;
  if (profiles && typeof profiles === "object" && Object.keys(profiles).length > 0) {
    const normalized: Record<string, PermissionProfile> = {};
    for (const [name, p] of Object.entries(profiles)) {
      normalized[name] = normalizeProfile(p as Record<string, unknown>);
    }
    out.customProfiles = normalized;
  }
  const ra = r.resourceAuthorization as Record<string, unknown> | undefined;
  if (ra && typeof ra === "object") {
    const tools = ra.tools as Record<string, unknown> | undefined;
    if (tools && typeof tools === "object") {
      if (Array.isArray(tools.allow)) out.resourceAuthorization.tools.allow = tools.allow.map(String);
      if (Array.isArray(tools.deny)) out.resourceAuthorization.tools.deny = tools.deny.map(String);
    }
    const fs2 = ra.filesystem as Record<string, unknown> | undefined;
    if (fs2 && typeof fs2 === "object") {
      if (Array.isArray(fs2.readWrite)) out.resourceAuthorization.filesystem.readWrite = fs2.readWrite.map(String);
      if (Array.isArray(fs2.readOnly)) out.resourceAuthorization.filesystem.readOnly = fs2.readOnly.map(String);
    }
    const nw = ra.network as Record<string, unknown> | undefined;
    if (nw && typeof nw === "object") {
      if (Array.isArray(nw.allow)) out.resourceAuthorization.network.allow = nw.allow.map(String);
      if (Array.isArray(nw.deny)) out.resourceAuthorization.network.deny = nw.deny.map(String);
    }
  }
  return out;
}

function normalizeProfile(p: Record<string, unknown> | undefined): PermissionProfile {
  const out = defaultProfile();
  if (!p || typeof p !== "object") return out;
  if (typeof p.displayName === "string" && p.displayName) out.displayName = p.displayName;
  const approval = p.approval as Record<string, unknown> | undefined;
  if (approval && typeof approval === "object") {
    const reviewer = approval.reviewer;
    if (reviewer === "user" || reviewer === "llm" || reviewer === "always_deny") {
      out.approval.reviewer = reviewer;
    }
    const sr = approval.sceneRules as Record<string, unknown> | undefined;
    if (sr && typeof sr === "object") {
      if (typeof sr.commandAstDangerChecker === "boolean") out.approval.sceneRules.commandAstDangerChecker = sr.commandAstDangerChecker;
      if (typeof sr.deleteToolApproval === "boolean") out.approval.sceneRules.deleteToolApproval = sr.deleteToolApproval;
      if (typeof sr.mcpToolApproval === "boolean") out.approval.sceneRules.mcpToolApproval = sr.mcpToolApproval;
    }
    const cr = approval.commandRules as Record<string, unknown> | undefined;
    if (cr && typeof cr === "object") {
      const normalized: Record<string, CommandRuleValue> = {};
      for (const [k, v] of Object.entries(cr)) {
        const val = v as Record<string, unknown>;
        if (val && typeof val === "object" && isApprovalAction(val.approval)) {
          const entry: CommandRuleValue = { approval: val.approval as ApprovalAction };
          if (val.execEnv === "byConfig" || val.execEnv === "host" || val.execEnv === "sandbox") {
            entry.execEnv = val.execEnv;
          }
          normalized[k] = entry;
        }
      }
      out.approval.commandRules = normalized;
    }
    const mr = approval.mcpRules as Record<string, unknown> | undefined;
    if (mr && typeof mr === "object") {
      const normalized: Record<string, McpRuleValue> = {};
      for (const [k, v] of Object.entries(mr)) {
        const val = v as Record<string, unknown>;
        if (val && typeof val === "object" && isApprovalAction(val.approval)) {
          normalized[k] = { approval: val.approval as ApprovalAction };
        }
      }
      out.approval.mcpRules = normalized;
    }
  }
  return out;
}

function isApprovalAction(v: unknown): v is ApprovalAction {
  return v === "allow" || v === "ask" || v === "deny";
}

/** 读取权限配置（文件损坏/缺失时回退默认值，不抛错） */
export function getPermission(): PermissionConfig {
  if (cached) return cached;
  const file = permissionFilePath();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      cached = normalizeConfig(raw);
      return cached;
    }
  } catch (err) {
    console.error("[permission] 读取配置失败，使用默认值:", err);
  }
  cached = defaultConfig();
  return cached;
}

/** 写回配置并清除缓存 */
export function savePermission(cfg: PermissionConfig): void {
  const file = permissionFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf8");
  cached = cfg;
}

/** 确保配置文件存在（缺省时落盘默认配置），返回文件路径。供设置面板"打开配置"等入口使用 */
export function ensurePermissionFile(): string {
  const file = permissionFilePath();
  if (!fs.existsSync(file)) {
    savePermission(getPermission());
  }
  return file;
}

/** 清除缓存（外部改动文件后调用） */
export function reloadPermission(): void {
  cached = null;
}

/** 设置权限模式并持久化 */
export function setActiveMode(mode: PermissionMode): void {
  const cfg = getPermission();
  if (cfg.activeMode !== mode) {
    cfg.activeMode = mode;
    savePermission(cfg);
  }
}

/** 当前生效的权限配置（custom 模式读 customProfiles.default） */
export function getActiveProfile(): PermissionProfile {
  const perm = getPermission();
  if (perm.activeMode === "manual") return PRESET_MANUAL;
  if (perm.activeMode === "auto") return PRESET_AUTO;
  if (perm.activeMode === "full") return PRESET_FULL;
  return perm.customProfiles.default ?? PRESET_MANUAL;
}

/** 当前决策方 */
export function getReviewer(): Reviewer {
  return getActiveProfile().approval.reviewer;
}

/** 当前场景开关 */
export function getSceneRules(): SceneRules {
  return getActiveProfile().approval.sceneRules;
}

/** 是否完全访问模式（跳过一切审批） */
export function isFullAccessMode(): boolean {
  return getPermission().activeMode === "full";
}

/**
 * 全局资源授权（所有模式生效）。
 * 规则统一存放在 customProfiles.default / resourceAuthorization，activeMode 只决定
 * 未命中规则时的默认审批方式（reviewer）。
 */
export function getResourceAuthorization(): ResourceAuthorization {
  return getPermission().resourceAuthorization;
}

/** 审批超时（毫秒），缺省 120000 */
export function getFileApprovalTimeoutMs(): number {
  return getPermission().approvalTimeoutMs;
}

/* ------------------------- 规则匹配 ------------------------- */

type ParsedKey =
  | { type: "exact" }
  | { type: "regex"; re: RegExp }
  | { type: "prefix"; prefix: string };

function parseKey(key: string): ParsedKey {
  const trimmed = key.trim();
  if (trimmed.startsWith("r/") && trimmed.endsWith("/") && trimmed.length > 3) {
    try {
      return { type: "regex", re: new RegExp(trimmed.slice(2, -1)) };
    } catch {
      /* 正则非法 → 退化为精确匹配 */
    }
  }
  if (trimmed.endsWith("*")) {
    const prefix = trimmed.slice(0, -1);
    if (prefix) return { type: "prefix", prefix: prefix.endsWith(" ") ? prefix : prefix + " " };
  }
  return { type: "exact" };
}

/**
 * 命令规则匹配（run_bash 命令）：精确 > 正则 > 前缀。
 * 命中返回 { key, action }；未命中返回 undefined（回退 AST 危险检测 + 人工/Guardian 审批）。
 */
export function matchCommandRule(
  command: string,
): { key: string; action: ApprovalAction } | undefined {
  const rules = getPermission().customProfiles.default?.approval.commandRules ?? {};
  const keys = Object.keys(rules);
  if (keys.length === 0 || !command) return undefined;
  const cmd = command.trim();
  const parsed = new Map(keys.map((k) => [k, parseKey(k)]));
  for (const k of keys) {
    const p = parsed.get(k)!;
    if (p.type === "exact" && cmd === k.trim()) return { key: k, action: rules[k].approval };
  }
  for (const k of keys) {
    const p = parsed.get(k)!;
    if (p.type === "regex" && p.re.test(cmd)) return { key: k, action: rules[k].approval };
  }
  for (const k of keys) {
    const p = parsed.get(k)!;
    if (p.type === "prefix" && cmd.startsWith(p.prefix)) return { key: k, action: rules[k].approval };
  }
  return undefined;
}

/**
 * MCP 工具规则匹配：mcp__server__tool → server__tool（精确）> server__*（通配）> server（裸）。
 * 命中返回 { key, action }；未命中返回 undefined（回退 sceneRules.mcpToolApproval 判定）。
 */
export function matchMcpRule(
  toolName: string,
): { key: string; action: ApprovalAction } | undefined {
  const rules = getPermission().customProfiles.default?.approval.mcpRules ?? {};
  const keys = Object.keys(rules);
  if (keys.length === 0) return undefined;
  let logical = toolName;
  const m = /^mcp__(.+)$/.exec(toolName);
  if (m) logical = m[1];
  if (rules[logical]) return { key: logical, action: rules[logical].approval };
  const idx = logical.indexOf("__");
  const server = idx >= 0 ? logical.slice(0, idx) : logical;
  const wild = server + "__*";
  if (rules[wild]) return { key: wild, action: rules[wild].approval };
  if (rules[server]) return { key: server, action: rules[server].approval };
  return undefined;
}
