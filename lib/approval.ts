/**
 * 工具审批流（阶段 3）
 * beforeToolCall 检测到敏感工具时，创建待审批请求并阻塞等待。
 * 前端通过 SSE 收到 approval_required 事件，调用 approve 端点后放行/拦截。
 *
 * 事件机制（subscribeApprovalLifecycle）：
 * - required  新审批请求（含风险等级/过期时间，前端展示倒计时）
 * - resolved  用户已决定（同意/拒绝）
 * - expired   超时（自动视为拒绝）
 * - notice    策略直接拦截等非审批类通知（denied_auto）
 * 每次审批决定（同意 / 拒绝 / 超时）都会写入审计历史（audit.db）。
 */

import { logApproval } from "./audit";
import type { RiskLevel } from "./risk";
import { getApprovalPolicy, getFileApprovalTimeoutMs } from "./permission";
import { getSessionApprovalPolicy } from "./session";

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: unknown;
  /** 发起会话（多会话并发时按会话隔离推送） */
  sessionId?: string;
  /** 风险评估结果 */
  risk?: RiskLevel;
  riskReason?: string;
}

export interface ApprovalState extends ApprovalRequest {
  status: "pending" | "approved" | "denied" | "timeout";
  createdAt: number;
  expiresAt: number;
}

export type ApprovalLifecycleEvent =
  | { type: "required"; state: ApprovalState }
  | { type: "resolved"; state: ApprovalState }
  | { type: "expired"; state: ApprovalState }
  | {
      type: "notice";
      id?: string;
      toolName: string;
      args: unknown;
      action: "denied_auto";
      reason: string;
      sessionId?: string;
    };

type ApproveResolver = (approve: boolean) => void;

interface PendingEntry {
  req: ApprovalRequest;
  resolver: ApproveResolver;
  createdAt: number;
  expiresAt: number;
  /** 超时定时器：resolveApproval 时需 clearTimeout，避免批准后仍触发 timeout 审计/过期事件 */
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();
const listeners = new Set<(req: ApprovalRequest) => void>();
const lifecycleListeners = new Set<(e: ApprovalLifecycleEvent) => void>();

/** 注册"新审批请求"订阅（兼容旧用法），返回取消函数 */
export function subscribeApprovals(listener: (req: ApprovalRequest) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 注册审批生命周期订阅（required / resolved / expired / notice），返回取消函数 */
export function subscribeApprovalLifecycle(
  listener: (e: ApprovalLifecycleEvent) => void,
): () => void {
  lifecycleListeners.add(listener);
  return () => lifecycleListeners.delete(listener);
}

function notifyLifecycle(e: ApprovalLifecycleEvent): void {
  lifecycleListeners.forEach((l) => l(e));
  if (e.type === "required") {
    listeners.forEach((l) => l(e.state));
  }
}

/**
 * 发起一次审批请求，阻塞直到用户确认或超时（超时视为拒绝）。
 * 返回 Promise<boolean>：true=同意放行，false=拒绝/超时。
 * 超时优先级：参数 > permission.json（approvalTimeoutMs，缺省 120s）。
 */
export function requestApproval(
  req: ApprovalRequest,
  timeoutMs?: number,
): Promise<boolean> {
  // 审批策略门（Phase 2.1 + per-session）：never 模式确定性拒绝 —— 不创建请求、不弹卡片，
  // 立即以失败 resolve，审计 outcome 标注 denied(auto)，并推 notice 事件。
  // 优先级：会话级覆盖（session.approvalPolicy）> env PRYSM_APPROVAL_POLICY > permission.json approvalPolicy。
  const sessionPolicy = req.sessionId
    ? getSessionApprovalPolicy(req.sessionId)
    : undefined;
  const effectivePolicy = sessionPolicy ?? getApprovalPolicy();
  if (effectivePolicy === "never") {
    const reason = sessionPolicy
      ? "会话审批策略为 never，操作被确定性拒绝"
      : "审批策略为 never（PRYSM_APPROVAL_POLICY=never / approvalPolicy=never），操作被确定性拒绝";
    logApproval(req.toolName, req.args, "denied_auto", {
      sessionId: req.sessionId,
      risk: req.risk,
      reason,
    });
    notifyApprovalNotice(req.id, req.toolName, req.args, reason, req.sessionId);
    return Promise.resolve(false);
  }
  // 审计配对（Phase 2）：发起即记录 asked，与后续 decided（approved/denied/timeout）成对
  logApproval(req.toolName, req.args, "asked", {
    sessionId: req.sessionId,
    risk: req.risk,
    reason: req.riskReason,
  });
  return new Promise((resolve) => {
    const effectiveTimeout = timeoutMs ?? getFileApprovalTimeoutMs();
    const createdAt = Date.now();
    const expiresAt = createdAt + effectiveTimeout;
    const state: ApprovalState = {
      ...req,
      status: "pending",
      createdAt,
      expiresAt,
    };
    const timer = setTimeout(() => {
      // entry 已被 resolveApproval 移除（用户已决定）或同 id 已被新请求覆盖时，跳过过期处理
      if (pending.get(req.id)?.timer !== timer) return;
      pending.delete(req.id);
      logApproval(req.toolName, req.args, "timeout", {
        sessionId: req.sessionId,
        risk: req.risk,
      });
      state.status = "timeout";
      notifyLifecycle({ type: "expired", state });
      resolve(false);
    }, effectiveTimeout);
    pending.set(req.id, { req, resolver: resolve, createdAt, expiresAt, timer });
    notifyLifecycle({ type: "required", state });
  });
}

/** 用户对某个审批请求作出决定。返回 false 表示该请求已不存在/超时 */
export function resolveApproval(id: string, approve: boolean): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  clearTimeout(entry.timer); // 取消超时定时器，防止已决后再写 timeout 审计/推 expired
  const state: ApprovalState = {
    ...entry.req,
    status: approve ? "approved" : "denied",
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
  };
  logApproval(entry.req.toolName, entry.req.args, approve ? "approved" : "denied", {
    sessionId: entry.req.sessionId,
    risk: entry.req.risk,
  });
  notifyLifecycle({ type: "resolved", state });
  entry.resolver(approve);
  return true;
}

/** 当前未决的审批请求快照（供前端刷新页面后恢复卡片） */
export function listPendingApprovals(): ApprovalState[] {
  const out: ApprovalState[] = [];
  for (const { req, createdAt, expiresAt } of pending.values()) {
    out.push({
      ...req,
      status: "pending",
      createdAt,
      expiresAt,
    });
  }
  return out;
}

/** 推送非审批类策略通知（如 denied_auto 直接拦截） */
export function notifyApprovalNotice(
  id: string,
  toolName: string,
  args: unknown,
  reason: string,
  sessionId?: string,
): void {
  notifyLifecycle({
    type: "notice",
    id,
    toolName,
    args,
    action: "denied_auto",
    reason,
    sessionId,
  });
}
