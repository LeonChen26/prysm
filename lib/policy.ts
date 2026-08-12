/**
 * 审批规则化（policy）
 *
 * 通过环境变量配置"自动放行"规则，命中后敏感工具（write_file/delete_file 等）
 * 无需人工确认；未命中的操作仍走人工审批（安全兜底）。
 *
 * 配置项（均在 .env.local 中，逗号分隔）：
 * - APPROVAL_ALLOW_TOOLS=append_file,create_dir       完全免审批的工具名
 * - APPROVAL_ALLOW_PATHS=notes/,docs/,*.md,*.txt      路径规则：
 *     - 以 / 结尾 → 目录前缀（相对 agent-workdir），如 notes/ 放行 notes/ 下所有文件
 *     - 含 *      → 文件名通配，如 *.md 放行所有 .md 文件
 *     - 其他      → 视为路径前缀
 *
 * 注意：规则为惰性解析（首次调用时读取 env），便于测试中先设置 env 再断言。
 */

interface PathRule {
  prefix: string;
  regex?: RegExp;
}

let cached: { allowTools: Set<string>; pathRules: PathRule[] } | null = null;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parse(): { allowTools: Set<string>; pathRules: PathRule[] } {
  const allowTools = new Set<string>();
  for (const t of process.env.APPROVAL_ALLOW_TOOLS?.split(",") ?? []) {
    const name = t.trim();
    if (name) allowTools.add(name);
  }

  const pathRules: PathRule[] = [];
  for (const raw of process.env.APPROVAL_ALLOW_PATHS?.split(",") ?? []) {
    const rule = raw.trim().replace(/^\.?\//, "");
    if (!rule) continue;
    if (rule.includes("*")) {
      // 通配规则只匹配文件名（最后一段）
      const re = new RegExp(
        "^" + rule.split("*").map(escapeRegex).join(".*") + "$",
      );
      pathRules.push({ prefix: rule, regex: re });
    } else {
      // 目录/路径前缀：去掉结尾斜杠，按路径段匹配，避免 sub/dir 误匹配 sub/dirx
      pathRules.push({ prefix: rule.replace(/\/+$/, "") });
    }
  }
  return { allowTools, pathRules };
}

function getRules(): { allowTools: Set<string>; pathRules: PathRule[] } {
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

/**
 * 判断某次敏感工具调用是否应自动放行。
 * 优先工具白名单，其次路径规则；未命中返回 false（走人工审批）。
 */
export function isAutoApproved(toolName: string, args: unknown): boolean {
  const { allowTools, pathRules } = getRules();
  if (allowTools.has(toolName)) return true;

  const rel = extractRelPath(args);
  if (!rel) return false;
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");

  for (const rule of pathRules) {
    if (rule.regex) {
      const fileName = norm.split("/").pop() ?? norm;
      if (rule.regex.test(fileName)) return true;
    } else if (norm === rule.prefix || norm.startsWith(rule.prefix + "/")) {
      return true;
    }
  }
  return false;
}
