/**
 * 工具调用风险评估
 *
 * 为待审批的敏感操作计算风险等级（low / medium / high / critical），
 * 供审批卡片展示、审计记录与危险命令识别使用。
 * - 基础等级由工具类型决定；
 * - run_bash 按危险命令规则升级（critical > high > medium）；
 * - 文件类工具命中受保护路径（.env / .git / node_modules / 锁文件等）时升级。
 *
 * 纯函数、无 node 依赖：服务端 agent.ts 与前端审批卡片共用。
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";

/** 工具来源（Phase 2 起影响默认风险等级）：core=内置 / mcp / skill / subagent */
export type ToolSource = "core" | "mcp" | "skill" | "subagent";

/** 从工具名推断来源（Phase 2/3）：mcp__* → mcp，skill__* → skill，其余 core */
export function toolSource(toolName: string): ToolSource {
  if (toolName.startsWith("mcp__")) return "mcp";
  if (toolName.startsWith("skill__")) return "skill";
  return "core";
}

export const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export interface RiskAssessment {
  level: RiskLevel;
  /** 命中原因（用于展示与审计） */
  reason?: string;
  /** run_bash 命中的危险命令片段（前端可高亮） */
  matched?: string;
}

/** 工具基础风险等级（未做内容分析时的默认值） */
const TOOL_BASE_RISK: Record<string, RiskLevel> = {
  write_file: "low",
  append_file: "low",
  create_dir: "low",
  copy_file: "low",
  move_file: "medium",
  delete_file: "high",
  run_bash: "medium",
};

/** 未在基础表时按来源给的默认等级（Phase 2；外部来源默认 medium，核心未知工具默认 low） */
const SOURCE_BASE_RISK: Record<ToolSource, RiskLevel> = {
  core: "low",
  mcp: "medium",
  skill: "medium",
  subagent: "medium",
};

/** 基础风险：优先工具表，其次按来源给默认 */
function baseRisk(toolName: string, source?: ToolSource): RiskLevel {
  return (
    TOOL_BASE_RISK[toolName] ??
    (source ? SOURCE_BASE_RISK[source] : "low")
  );
}

/** run_bash 危险命令规则：按数组顺序匹配，越靠前越危险 */
const COMMAND_RULES: { level: RiskLevel; re: RegExp; label: string }[] = [
  { level: "critical", re: /rm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/|~(?:\/|$))/, label: "递归删除根目录/家目录" },
  { level: "critical", re: /(?:curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/, label: "管道执行远程脚本" },
  { level: "critical", re: /\bmkfs(?:\.[a-z0-9]+)?\b/, label: "格式化磁盘" },
  { level: "critical", re: /\bdd\b[^|;&\n]*\bof=\/dev\/(?:sd|nvme|vd)/, label: "直接写磁盘设备" },
  { level: "critical", re: /chmod\s+-[a-z]*R[a-z]*\s+777\s+\//, label: "递归授权整个根目录" },
  { level: "critical", re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, label: "fork 炸弹" },
  { level: "high", re: /rm\s+-[a-z]*r[a-z]*f?/, label: "递归强制删除" },
  { level: "high", re: /\bsudo\b/, label: "sudo 提权执行" },
  { level: "high", re: /\bgit\s+push\b[^|;&\n]*(?:--force|-f)\b/, label: "强制推送" },
  { level: "high", re: /chmod\s+777/, label: "开放全部权限" },
  { level: "high", re: /\b(?:shutdown|reboot|halt|poweroff)\b/, label: "关机/重启" },
  { level: "high", re: /\b(?:kill|pkill|killall)\b\s+-9/, label: "强制终止进程" },
  { level: "medium", re: /\bgit\s+push\b/, label: "推送代码" },
  { level: "medium", re: /\b(?:kill|pkill|killall)\b/, label: "终止进程" },
  { level: "medium", re: /\b(?:docker|podman)\s+(?:rm|rmi|stop|kill)\b/, label: "容器删除/停止" },
  { level: "medium", re: /\bnpm\s+uninstall\b|\b(?:npm|yarn|pnpm)\s+(?:i|install)\s+-g\b/, label: "卸载或全局安装包" },
  { level: "medium", re: /\bnpm\s+(?:install|i)\s+--(?:force|no-save|legacy-peer-deps)\b/, label: "强制安装依赖" },
];

/** 受保护路径：写/删命中则升级为 high */
const PROTECTED_PATH_RES: { re: RegExp; label: string }[] = [
  { re: /(^|\/)\.env($|\.)/, label: "环境变量文件" },
  { re: /(^|\/)\.git\//, label: "Git 目录" },
  { re: /(^|\/)node_modules\//, label: "依赖目录" },
  { re: /(^|\/)\.ssh\//, label: "SSH 密钥" },
  { re: /(^|\/)\.aws\//, label: "云凭证" },
  { re: /(package-lock|pnpm-lock|yarn)\.(json|yaml)$/, label: "依赖锁文件" },
  { re: /\.(db|sqlite|sqlite3)$/, label: "数据库文件" },
  // 凭据类文件与私钥（读放开兜底：这些文件常含明文 token / 私钥，只读也不应放行）
  { re: /(^|\/)\.(npmrc|yarnrc|pypirc|netrc|git-credentials|gitconfig|hgrc)$/, label: "凭据文件" },
  { re: /(^|\/)\.(bash_history|zsh_history|fish_history|psql_history|mysql_history)$/, label: "命令历史" },
  { re: /(^|\/)\.kube\//, label: "Kubernetes 配置" },
  { re: /(^|\/)\.docker\//, label: "Docker 凭据" },
  { re: /\.(pem|key|p12|pfx|ppk)$/, label: "私钥文件" },
];

function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[b] > RISK_ORDER[a] ? b : a;
}

/**
 * 受保护路径判定（读放开兜底：只读工具命中则路径层直接拒绝）。
 * 与 assessRisk 的写/删风险升级共用同一套规则，避免两处维护。
 * @param p 绝对路径（已 realpath 规范化）
 */
export function isProtectedPath(p: string): { hit: boolean; label?: string } {
  const norm = p.replace(/\\/g, "/");
  for (const rule of PROTECTED_PATH_RES) {
    if (rule.re.test(norm)) return { hit: true, label: rule.label };
  }
  return { hit: false };
}

/** 从工具参数中提取相对路径（与 policy.ts 一致的规则） */
function extractRelPath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.path === "string") return a.path;
  if (typeof a.to === "string") return a.to;
  return null;
}

function getArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

/**
 * 评估一次敏感工具调用的风险。
 * 返回等级与首个命中原因；未命中任何规则时仅返回基础等级。
 * @param source 工具来源（Phase 2）：core/mcp/skill/subagent，影响未登记工具的默认等级
 * @param opts.astDangerChecker 危险命令 AST 检测开关（sceneRules.commandAstDangerChecker）；
 *   false 时不按危险命令规则升级风险
 */
export function assessRisk(
  toolName: string,
  args: unknown,
  source?: ToolSource,
  opts?: { astDangerChecker?: boolean },
): RiskAssessment {
  let level = baseRisk(toolName, source);
  let reason: string | undefined;
  let matched: string | undefined;

  if (toolName === "run_bash") {
    const command = getArgs(args).command;
    if (typeof command === "string") {
      const astEnabled = opts?.astDangerChecker !== false;
      if (astEnabled) {
        for (const rule of COMMAND_RULES) {
          if (!rule.re.test(command)) continue;
          const hit = rule.re.exec(command);
          const m = hit ? hit[0] : undefined;
          if (RISK_ORDER[rule.level] > RISK_ORDER[level]) {
            level = rule.level;
            reason = rule.label;
            matched = m;
          }
        }
      }
    }
    return { level, reason, matched };
  }

  // 文件类工具：命中受保护路径升级为 high（临界点 critical 保持）
  if (level !== "critical") {
    const rel = extractRelPath(args);
    if (rel) {
      const norm = rel.replace(/\\/g, "/");
      for (const p of PROTECTED_PATH_RES) {
        if (p.re.test(norm)) {
          const next = maxLevel(level, "high");
          if (next !== level || !reason) {
            reason = `命中受保护路径（${p.label}）`;
          }
          level = next;
          break;
        }
      }
    }
  }
  return { level, reason, matched };
}
