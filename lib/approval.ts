/**
 * 工具审批流（阶段 3）
 * beforeToolCall 检测到敏感工具时，创建待审批请求并阻塞等待。
 * 前端通过 SSE 收到 approval_required 事件，调用 approve 端点后放行/拦截。
 * 每次审批决定（同意 / 拒绝 / 超时）都会写入审计历史（audit.db）。
 */

import { logApproval } from "./audit";

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: unknown;
}

type ApproveResolver = (approve: boolean) => void;

interface PendingEntry {
  req: ApprovalRequest;
  resolver: ApproveResolver;
}

const pending = new Map<string, PendingEntry>();
const listeners = new Set<(req: ApprovalRequest) => void>();

export const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS ?? 120000);

/** 注册审批事件订阅（SSE 推送用），返回取消函数 */
export function subscribeApprovals(listener: (req: ApprovalRequest) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 发起一次审批请求，阻塞直到用户确认或超时（超时视为拒绝） */
export function requestApproval(req: ApprovalRequest, timeoutMs = APPROVAL_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(req.id);
      logApproval(req.toolName, req.args, "timeout");
      resolve(false);
    }, timeoutMs);
    pending.set(req.id, {
      req,
      resolver: (approve) => {
        clearTimeout(timer);
        resolve(approve);
      },
    });
    listeners.forEach((l) => l(req));
  });
}

/** 用户对某个审批请求作出决定。返回 false 表示该请求已不存在/超时 */
export function resolveApproval(id: string, approve: boolean): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  logApproval(entry.req.toolName, entry.req.args, approve ? "approved" : "denied");
  entry.resolver(approve);
  return true;
}
