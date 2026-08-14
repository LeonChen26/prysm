/**
 * 审批规则化（policy）—— Phase 2 数据源注入
 *
 * 通过策略控制敏感工具（write_file/delete_file/run_bash 等）：
 * - 自动放行（白名单）：命中后无需人工确认；
 * - 强制拦截（黑名单）：命中后直接拒绝，不进入审批（安全兜底）。
 *
 * 数据源优先级（逐类合并，先到先用）：
 *   1. configurePolicy 显式注入（PrysmConfig / 运行时）
 *   2. SQLite policy 表（prysm.db，持久化 + 可视化；首次为空时从 env 一次性导入）
 *   3. env 兼容（APPROVAL_*，仅 SQLite 空表时兜底）
 *
 * 规则格式（与历史 env 一致）：
 * - allow_tools / deny_tools：工具名；支持通配（如 mcp__* / skill__* 批量管控）
 * - allow_paths / deny_paths：路径规则
 *     - 以 / 结尾 → 目录前缀（相对 agent-workdir），如 notes/ 放行 notes/ 下所有文件
 *     - 含 *      → 文件名通配，如 *.md 放行所有 .md 文件
 *     - 其他      → 视为路径前缀
 * - allow_commands / deny_commands：run_bash 命令规则（前缀放行 / 子串拦截）
 *
 * 优先级：deny（黑名单） > allow（白名单）。
 */

import { envValue } from "./config";
import { getPrysmDb } from "./prysm-db";

/** 策略规则的种类（与 policy 表 kind 列对应） */
export type PolicyKind =
  | "allow_tools"
  | "allow_paths"
  | "allow_commands"
  | "deny_tools"
  | "deny_paths"
  | "deny_commands"
  | "approval_timeout_ms";

export interface PolicyRule {
  id: number;
  kind: PolicyKind;
  value: string;
  createdAt: number;
}

/** 可注入的规则输入（字符串数组，与 env 格式一致） */
export interface PolicyInput {
  allowTools?: string[];
  allowPaths?: string[];
  allowCommands?: string[];
  denyTools?: string[];
  denyPaths?: string[];
  denyCommands?: string[];
  approvalTimeoutMs?: number;
}

interface PathRule {
  prefix: string;
  regex?: RegExp;
}

interface Rules {
  allowTools: Set<string>;
  pathRules: PathRule[];
  /** run_bash 命令首行前缀放行规则 */
  allowCommands: string[];
  /** 强制拦截的工具 / 路径 / 命令 */
  denyTools: Set<string>;
  denyPaths: PathRule[];
  denyCommands: string[];
}

let cached: Rules | null = null;
/** configurePolicy 显式注入（非 undefined 字段覆盖其他来源） */
let injected: PolicyInput | undefined;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 解析逗号分隔的简单字符串集合（忽略空项） */
function splitSet(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const t of raw?.split(",") ?? []) {
    const name = t.trim();
    if (name) out.push(name);
  }
  return out;
}

function parsePathRules(raw: string | undefined): PathRule[] {
  const rules: PathRule[] = [];
  for (const item of splitSet(raw)) {
    const rule = item.replace(/^\.?\//, "");
    if (!rule) continue;
    if (rule.includes("*")) {
      // 通配规则只匹配文件名（最后一段）
      const re = new RegExp("^" + rule.split("*").map(escapeRegex).join(".*") + "$");
      rules.push({ prefix: rule, regex: re });
    } else {
      // 目录/路径前缀：去掉结尾斜杠，按路径段匹配，避免 sub/dir 误匹配 sub/dirx
      rules.push({ prefix: rule.replace(/\/+$/, "") });
    }
  }
  return rules;
}

/* ------------------------- SQLite policy 表 ------------------------- */

/** 首次播种：policy 表为空时从 env APPROVAL_* 一次性导入（之后 env 只读兼容） */
function seedPolicy(): void {
  const d = getPrysmDb();
  const row = d.prepare("SELECT COUNT(*) AS c FROM policy").get() as { c: number };
  if (row.c > 0) return;
  const now = Date.now();
  const insert = d.prepare(
    "INSERT INTO policy (kind, value, created_at) VALUES (?, ?, ?)",
  );
  const envMap: { kind: PolicyKind; raw: string | undefined }[] = [
    { kind: "allow_tools", raw: envValue("APPROVAL_ALLOW_TOOLS") },
    { kind: "allow_paths", raw: envValue("APPROVAL_ALLOW_PATHS") },
    { kind: "allow_commands", raw: envValue("APPROVAL_ALLOW_COMMANDS") },
    { kind: "deny_tools", raw: envValue("APPROVAL_DENY_TOOLS") },
    { kind: "deny_paths", raw: envValue("APPROVAL_DENY_PATHS") },
    { kind: "deny_commands", raw: envValue("APPROVAL_DENY_COMMANDS") },
  ];
  for (const { kind, raw } of envMap) {
    for (const value of splitSet(raw)) {
      insert.run(kind, value, now);
    }
  }
  const timeout = envValue("APPROVAL_TIMEOUT_MS");
  if (timeout && /^\d+$/.test(timeout.trim())) {
    insert.run("approval_timeout_ms", timeout.trim(), now);
  }
}

/** 从 policy 表组装规则（未配置的类为空） */
function rulesFromDb(): Partial<Rules> {
  const d = getPrysmDb();
  seedPolicy();
  const rows = d
    .prepare("SELECT kind, value FROM policy")
    .all() as { kind: string; value: string }[];
  const map: Record<string, string[]> = {};
  for (const row of rows) {
    (map[row.kind] ??= []).push(row.value);
  }
  return {
    allowTools: new Set(map.allow_tools ?? []),
    pathRules: parsePathRules((map.allow_paths ?? []).join(",")),
    allowCommands: map.allow_commands ?? [],
    denyTools: new Set(map.deny_tools ?? []),
    denyPaths: parsePathRules((map.deny_paths ?? []).join(",")),
    denyCommands: map.deny_commands ?? [],
  };
}

/** env 兼容回退（SQLite 表为空时兜底） */
function rulesFromEnv(): Rules {
  return {
    allowTools: new Set(splitSet(envValue("APPROVAL_ALLOW_TOOLS"))),
    pathRules: parsePathRules(envValue("APPROVAL_ALLOW_PATHS")),
    allowCommands: splitSet(envValue("APPROVAL_ALLOW_COMMANDS")),
    denyTools: new Set(splitSet(envValue("APPROVAL_DENY_TOOLS"))),
    denyPaths: parsePathRules(envValue("APPROVAL_DENY_PATHS")),
    denyCommands: splitSet(envValue("APPROVAL_DENY_COMMANDS")),
  };
}

/** 逐字段取第一个有内容的来源（优先级从高到低；高优先级来源接管该字段） */
function mergeRules(...parts: Partial<Rules>[]): Rules {
  const empty: Rules = {
    allowTools: new Set(),
    pathRules: [],
    allowCommands: [],
    denyTools: new Set(),
    denyPaths: [],
    denyCommands: [],
  };
  const hasContent = (v: unknown): boolean => {
    if (v === undefined) return false;
    if (v instanceof Set) return v.size > 0;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  };
  const pick = <K extends keyof Rules>(key: K): Rules[K] => {
    for (const p of parts) {
      if (hasContent(p[key])) return p[key] as Rules[K];
    }
    return empty[key];
  };
  return {
    allowTools: pick("allowTools"),
    pathRules: pick("pathRules"),
    allowCommands: pick("allowCommands"),
    denyTools: pick("denyTools"),
    denyPaths: pick("denyPaths"),
    denyCommands: pick("denyCommands"),
  };
}

function getRules(): Rules {
  if (cached) return cached;
  const fromInput: Partial<Rules> = injected
    ? {
        allowTools: injected.allowTools ? new Set(injected.allowTools) : undefined,
        pathRules: injected.allowPaths ? parsePathRules(injected.allowPaths.join(",")) : undefined,
        allowCommands: injected.allowCommands,
        denyTools: injected.denyTools ? new Set(injected.denyTools) : undefined,
        denyPaths: injected.denyPaths ? parsePathRules(injected.denyPaths.join(",")) : undefined,
        denyCommands: injected.denyCommands,
      }
    : {};
  cached = mergeRules(fromInput, rulesFromDb(), rulesFromEnv());
  return cached;
}

/** 从工具参数中提取相对路径（write_file/delete_file 用 path，move/copy 用目标 to） */
function extractRelPath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.path === "string") return a.path;
  if (typeof a.to === "string") return a.to;
  return null;
}

/** 从工具参数中提取命令（run_bash 用 command） */
function extractCommand(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const c = (args as Record<string, unknown>).command;
  return typeof c === "string" ? c.trim() : null;
}

function normPath(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

function matchesPath(pathRules: PathRule[], rel: string): boolean {
  const norm = normPath(rel);
  for (const rule of pathRules) {
    if (rule.regex) {
      const fileName = norm.split("/").pop() ?? norm;
      if (rule.regex.test(fileName)) return true;
    } else if (
      norm === rule.prefix ||
      norm.startsWith(rule.prefix + "/") ||
      // 隐藏文件前缀宽松匹配：.env 规则同时命中 .env.local（安全方向宁可多拦）
      (rule.prefix.startsWith(".") && norm.startsWith(rule.prefix + "."))
    ) {
      return true;
    }
  }
  return false;
}

/** 工具名匹配：支持精确名与通配（mcp__* / skill__* 等批量管控） */
function matchesToolName(rules: Set<string>, name: string): boolean {
  for (const rule of rules) {
    if (rule === name) return true;
    if (rule.includes("*")) {
      const re = new RegExp("^" + rule.split("*").map(escapeRegex).join(".*") + "$");
      if (re.test(name)) return true;
    }
  }
  return false;
}

/**
 * 检测命令中是否含复合/多语句语法（换行、命令链、子 shell 等）。
 * 这类命令的副作用无法通过"首行前缀"完整覆盖，为安全起见一律不自动放行，走人工审批。
 */
const COMPOUND_CMD_RE = /[\n\r;|&]|\$\(|\`/;

/** run_bash 命令是否命中放行前缀（单条简单命令，按整词边界匹配）。
 *  安全兜底：若命令含复合语法（换行/分号/管道/&&/||/子shell），则不自动放行，避免前缀匹配绕过。
 */
function matchesAllowCommand(allowCommands: string[], command: string): boolean {
  if (COMPOUND_CMD_RE.test(command)) return false;
  const line = command.trim();
  if (!line) return false;
  return allowCommands.some((rule) => {
    if (!rule) return false;
    return (
      line === rule ||
      line.startsWith(rule + " ") ||
      line.startsWith(rule + "\t")
    );
  });
}

/** 命令是否命中拦截子串 */
function matchesDenyCommand(denyCommands: string[], command: string): boolean {
  return denyCommands.some((rule) => rule && command.includes(rule));
}

export interface DenyResult {
  denied: boolean;
  reason?: string;
}

/**
 * 判断某次敏感工具调用是否被策略强制拦截（黑名单）。
 * 命中返回 true（不进入审批，直接拒绝）。
 */
export function isDenied(toolName: string, args: unknown): DenyResult {
  const rules = getRules();
  if (matchesToolName(rules.denyTools, toolName)) {
    return { denied: true, reason: `工具 ${toolName} 被策略禁止` };
  }
  const rel = extractRelPath(args);
  if (rel && matchesPath(rules.denyPaths, rel)) {
    return { denied: true, reason: `路径 "${rel}" 被策略禁止` };
  }
  const cmd = extractCommand(args);
  if (cmd && matchesDenyCommand(rules.denyCommands, cmd)) {
    return { denied: true, reason: "命令命中禁止规则" };
  }
  return { denied: false };
}

/**
 * 判断某次敏感工具调用是否应自动放行（白名单）。
 * 优先工具白名单（支持通配），其次路径规则与命令前缀；未命中返回 false（走人工审批）。
 */
export function isAutoApproved(toolName: string, args: unknown): boolean {
  const rules = getRules();
  if (matchesToolName(rules.allowTools, toolName)) return true;

  const rel = extractRelPath(args);
  if (rel && matchesPath(rules.pathRules, rel)) return true;

  const cmd = extractCommand(args);
  if (cmd && matchesAllowCommand(rules.allowCommands, cmd)) return true;

  return false;
}

/* ------------------------- 数据源注入 / reload ------------------------- */

/**
 * 显式注入策略（非 undefined 字段覆盖 SQLite/env）。
 * 供 createCore(PrysmConfig) / Electron 壳调用；调用后清除缓存强制重载。
 */
export function configurePolicy(input?: PolicyInput): void {
  injected = input;
  cached = null;
}

/** 从数据源重新加载（SQLite 策略变更后调用），清除缓存 */
export function reloadPolicy(): void {
  cached = null;
}

/** 仅用于测试：清除注入与缓存，回退 env 行为 */
export function resetPolicy(): void {
  injected = undefined;
  cached = null;
}

/* ------------------------- policy 表 CRUD（可视化/管理） ------------------------- */

export function listPolicyRules(): PolicyRule[] {
  const d = getPrysmDb();
  seedPolicy();
  const rows = d
    .prepare("SELECT id, kind, value, created_at AS createdAt FROM policy ORDER BY id ASC")
    .all() as unknown as PolicyRule[];
  return rows;
}

export function addPolicyRule(kind: PolicyKind, value: string): PolicyRule {
  const v = value.trim();
  if (!v) throw new Error("规则值不能为空");
  const d = getPrysmDb();
  const now = Date.now();
  const r = d
    .prepare("INSERT INTO policy (kind, value, created_at) VALUES (?, ?, ?)")
    .run(kind, v, now);
  reloadPolicy();
  return { id: Number(r.lastInsertRowid), kind, value: v, createdAt: now };
}

export function removePolicyRule(id: number): boolean {
  const d = getPrysmDb();
  const r = d.prepare("DELETE FROM policy WHERE id = ?").run(id);
  reloadPolicy();
  return Number(r.changes) > 0;
}

/** 清空全部策略（含超时配置） */
export function clearPolicyRules(): void {
  getPrysmDb().prepare("DELETE FROM policy").run();
  reloadPolicy();
}

/** 策略表中的审批超时（毫秒）；未配置返回 undefined（回退 config/env 默认） */
export function getPolicyApprovalTimeoutMs(): number | undefined {
  const d = getPrysmDb();
  seedPolicy();
  const row = d
    .prepare("SELECT value FROM policy WHERE kind = 'approval_timeout_ms' ORDER BY id ASC LIMIT 1")
    .get() as { value: string } | undefined;
  if (!row) return undefined;
  const n = Number(row.value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
