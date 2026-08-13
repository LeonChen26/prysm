/**
 * 审批规则化（policy）
 *
 * 通过环境变量配置审批策略，控制敏感工具（write_file/delete_file/run_bash 等）：
 * - 自动放行（白名单）：命中后无需人工确认；
 * - 强制拦截（黑名单）：命中后直接拒绝，不进入审批（安全兜底）。
 *
 * 配置项（均在 .env.local 中，逗号分隔）：
 * - APPROVAL_ALLOW_TOOLS=append_file,create_dir       完全免审批的工具名
 * - APPROVAL_ALLOW_PATHS=notes/,docs/,*.md,*.txt      路径放行规则：
 *     - 以 / 结尾 → 目录前缀（相对 agent-workdir），如 notes/ 放行 notes/ 下所有文件
 *     - 含 *      → 文件名通配，如 *.md 放行所有 .md 文件
 *     - 其他      → 视为路径前缀
 * - APPROVAL_ALLOW_COMMANDS=git push,npm run,ls       命令放行规则（run_bash）：
 *     按命令首行前缀匹配，如 `git push` 放行 `git push origin main`
 * - APPROVAL_DENY_TOOLS=delete_file                   强制拦截的工具名（永不放行，直接拒绝）
 * - APPROVAL_DENY_PATHS=.env,.git/                    路径拦截规则（语法同 ALLOW_PATHS）
 * - APPROVAL_DENY_COMMANDS=rm -rf /,| sh              命令拦截规则（run_bash，子串匹配）：
 *     命令文本中包含任一规则即直接拒绝，如 `| sh` 拦截一切管道到 sh 的执行
 *
 * 优先级：deny（黑名单） > allow（白名单）。
 *
 * 注意：规则为惰性解析（首次调用时读取 env），便于测试中先设置 env 再断言。
 */

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

function parse(): Rules {
  return {
    allowTools: new Set(splitSet(process.env.APPROVAL_ALLOW_TOOLS)),
    pathRules: parsePathRules(process.env.APPROVAL_ALLOW_PATHS),
    allowCommands: splitSet(process.env.APPROVAL_ALLOW_COMMANDS),
    denyTools: new Set(splitSet(process.env.APPROVAL_DENY_TOOLS)),
    denyPaths: parsePathRules(process.env.APPROVAL_DENY_PATHS),
    denyCommands: splitSet(process.env.APPROVAL_DENY_COMMANDS),
  };
}

function getRules(): Rules {
  if (!cached) cached = parse();
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

/** run_bash 命令是否命中放行前缀（取首行，按整词边界匹配） */
function matchesAllowCommand(allowCommands: string[], command: string): boolean {
  const firstLine = command.split("\n")[0].trim();
  if (!firstLine) return false;
  return allowCommands.some((rule) => {
    if (!rule) return false;
    return (
      firstLine === rule ||
      firstLine.startsWith(rule + " ") ||
      firstLine.startsWith(rule + "\t")
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
  if (rules.denyTools.has(toolName)) {
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
 * 优先工具白名单，其次路径规则与命令前缀；未命中返回 false（走人工审批）。
 */
export function isAutoApproved(toolName: string, args: unknown): boolean {
  const rules = getRules();
  if (rules.allowTools.has(toolName)) return true;

  const rel = extractRelPath(args);
  if (rel && matchesPath(rules.pathRules, rel)) return true;

  const cmd = extractCommand(args);
  if (cmd && matchesAllowCommand(rules.allowCommands, cmd)) return true;

  return false;
}
