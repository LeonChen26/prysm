/**
 * 对话面板共享类型、常量与纯函数（无 React 依赖，可被任何客户端模块引用）
 */

export interface UiMessage {
  role: "user" | "assistant";
  text: string;
  /** 消息时间戳（毫秒），用于展示发送时间 */
  timestamp?: number;
  /** 多模态（Phase 6）：消息内的图片块（base64） */
  images?: { type: "image"; data: string; mimeType: string }[];
}

/** 工具审批结果（沉淀到工具卡片，供对话流追溯） */
export interface ToolApproval {
  action: "approved" | "denied" | "timeout" | "denied_auto" | "auto";
  reason?: string;
}

export const APPROVAL_ACTION_LABELS: Record<ToolApproval["action"], string> = {
  approved: "已通过审批",
  denied: "已拒绝",
  timeout: "已超时",
  denied_auto: "已拦截",
  auto: "自动放行",
};

export interface ToolCard {
  id: string;
  toolName: string;
  args: unknown;
  status: "running" | "done" | "error";
  result?: string;
  /** 工具开始时间戳（用于计算耗时） */
  startedAt?: number;
  /** 工具执行耗时（毫秒） */
  elapsedMs?: number;
  /** 该工具调用经过的审批结果（敏感工具） */
  approval?: ToolApproval;
}

const TOOLCARDS_KEY_PREFIX = "prysm.toolcards.";
const TOOLCARDS_MAX_PER_SESSION = 50;

/** 按会话读取已完成的工具卡片（localStorage 持久化，供切会话/刷新后回顾） */
export function loadToolCards(sessionId: string | null): ToolCard[] {
  if (!sessionId) return [];
  try {
    const raw = localStorage.getItem(TOOLCARDS_KEY_PREFIX + sessionId);
    if (!raw) return [];
    const arr = JSON.parse(raw) as ToolCard[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 保存会话的工具卡片（仅存非 running 的已完成卡片，限制条数防止撑爆 localStorage） */
export function saveToolCards(sessionId: string | null, cards: ToolCard[]): void {
  if (!sessionId) return;
  try {
    const settled = cards.filter((c) => c.status !== "running");
    const kept = settled.slice(-TOOLCARDS_MAX_PER_SESSION);
    localStorage.setItem(TOOLCARDS_KEY_PREFIX + sessionId, JSON.stringify(kept));
  } catch {
    /* 存储满/不可用时静默降级为不持久化 */
  }
}

/** 删除会话的工具卡片记录（删除会话时调用） */
export function clearToolCards(sessionId: string): void {
  try {
    localStorage.removeItem(TOOLCARDS_KEY_PREFIX + sessionId);
  } catch {
    /* ignore */
  }
}

/** 工具卡片状态文案：有审批结果优先展示审批结果，否则才是执行完成/失败 */
export function toolCardStateText(card: ToolCard): string {
  if (card.status === "running") return "运行中";
  if (card.approval) return APPROVAL_ACTION_LABELS[card.approval.action];
  const base = card.status === "done" ? "完成" : "失败";
  return card.elapsedMs != null
    ? `${base} · ${formatDuration(card.elapsedMs)}`
    : base;
}

/** 工具卡片状态颜色 class（审批结果用语义色，默认灰） */
export function toolCardStateClass(card: ToolCard): string {
  const ap = card.approval;
  if (ap) {
    switch (ap.action) {
      case "denied":
      case "denied_auto":
        return "card-state-danger";
      case "timeout":
        return "card-state-warning";
      case "approved":
        return "card-state-success";
      case "auto":
        return "card-state-brand";
    }
  }
  if (card.status === "error") return "card-state-danger";
  return "";
}

export interface TodoItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  detail?: string;
}

export interface ApprovalCard {
  id: string;
  toolName: string;
  args: unknown;
  /** 风险评估等级（low/medium/high/critical） */
  risk?: string;
  /** 风险命中原因 */
  riskReason?: string;
  /** 请求创建时间（毫秒） */
  createdAt?: number;
  /** 过期时间（毫秒），用于前端倒计时 */
  expiresAt?: number;
  /** 本地标记：正在提交决定（按钮 loading 态） */
  deciding?: boolean;
}

export const RISK_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
};

/** Plan mode 步骤（Phase 7） */
export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  tool?: string;
  expected?: string;
  status?: "pending" | "in_progress" | "done" | "skipped";
}

/** Plan mode 待确认卡片（Phase 7） */
export interface PlanCard {
  id: string;
  surface?: string;
  summary?: string;
  steps: PlanStep[];
  createdAt?: number;
  expiresAt?: number;
  deciding?: boolean;
  /** 已由后端决定：approve 结果（已批准/已拒绝） */
  decided?: boolean;
  /** 已由后端取消 */
  cancelled?: boolean;
}

/** 审批参数按工具格式化展示（run_bash 显示命令，文件类显示路径/内容预览） */
export function formatApprovalArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  switch (toolName) {
    case "run_bash":
      return typeof a.command === "string" ? a.command : JSON.stringify(args);
    case "write_file":
    case "append_file": {
      const lines: string[] = [];
      if (typeof a.path === "string") lines.push(`路径: ${a.path}`);
      if (typeof a.content === "string") {
        const lineCount = a.content.split("\n").length;
        const preview = a.content.slice(0, 200);
        lines.push(
          `内容(${lineCount} 行):\n${preview}${a.content.length > 200 ? "\n…" : ""}`,
        );
      }
      return lines.join("\n");
    }
    case "delete_file":
      return typeof a.path === "string" ? `路径: ${a.path}` : JSON.stringify(args);
    case "move_file":
    case "copy_file":
      return [a.from, a.to]
        .filter((v): v is string => typeof v === "string")
        .map((v) => `路径: ${v}`)
        .join("\n");
    default:
      return JSON.stringify(args, null, 2);
  }
}

export interface SessionInfo {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned?: number;
  /** 会话形态（work/coding），Phase 1b 起由后端返回 */
  surface?: "work" | "coding";
}

export interface SseEvent {
  type:
    | "session"
    | "turn_start"
    | "delta"
    | "tool_start"
    | "tool_end"
    | "turn_end"
    | "agent_end"
    | "approval_required"
    | "approval_resolved"
    | "approval_expired"
    | "policy_notice"
    | "plan_proposed"
    | "plan_decided"
    | "plan_cancelled"
    | "stopped"
    | "error"
    | "done";
  delta?: string;
  id?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  result?: string;
  todos?: TodoItem[];
  sessionId?: string;
  title?: string;
  message?: string;
  /** 审批：风险等级 / 命中原因 / 过期时间 / 决定结果 */
  risk?: string;
  riskReason?: string;
  expiresAt?: number;
  approve?: boolean;
  /** 策略拦截通知 */
  action?: string;
  reason?: string;
  /** Plan mode：计划标题 / 步骤 / 形态 */
  surface?: string;
  summary?: string;
  steps?: { id: string; title: string; detail?: string; tool?: string; expected?: string }[];
}

export interface RunStats {
  totalRuns: number;
  okRuns: number;
  failedRuns: number;
  stoppedRuns: number;
  successRate: number;
  totalDurationMs: number;
  avgDurationMs: number;
  toolRanking: { name: string; count: number }[];
  byDay: {
    day: string;
    runs: number;
    okRuns: number;
    failedRuns: number;
    durationMs: number;
  }[];
}

export const TODO_STATUS_LABELS: Record<TodoItem["status"], string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "完成",
  cancelled: "已取消",
};

export const GROUP_ORDER = ["今天", "昨天", "7天内", "更早"];

/** 会话分组：今天 / 昨天 / 7天内 / 更早 */
export function formatGroupLabel(ts: number): string {
  const now = new Date();
  const startToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  if (ts >= startToday) return "今天";
  if (ts >= startToday - 86400_000) return "昨天";
  if (ts >= startToday - 7 * 86400_000) return "7天内";
  return "更早";
}

/** 会话相对时间：刚刚 / x分钟前 / x小时前 / x天前 / 日期 */
export function formatRelTime(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 工具耗时：<1s 显示毫秒，否则保留一位小数秒 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 消息发送时间：HH:mm（跨天补日期） */
export function formatMsgTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 解析 SSE 流，逐事件回调（无法解析的负载静默跳过） */
export async function readSSE(
  response: Response,
  onEvent: (ev: SseEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      try {
        onEvent(JSON.parse(payload) as SseEvent);
      } catch {
        /* 忽略无法解析的事件 */
      }
    }
  }
}
