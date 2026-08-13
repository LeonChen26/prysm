/**
 * 对话面板共享类型、常量与纯函数（无 React 依赖，可被任何客户端模块引用）
 */

export interface UiMessage {
  role: "user" | "assistant";
  text: string;
  /** 消息时间戳（毫秒），用于展示发送时间 */
  timestamp?: number;
}

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
