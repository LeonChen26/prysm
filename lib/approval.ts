/**
 * 工具审批流（阶段 3）
 * beforeToolCall 检测到敏感工具时，创建待审批请求并阻塞等待。
 * 前端通过 SSE 收到 approval_required 事件，调用 approve 端点后放行/拦截。
 */

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: unknown;
}

type ApproveResolver = (approve: boolean) => void;

const pending = new Map<string, ApproveResolver>();
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
      resolve(false);
    }, timeoutMs);
    pending.set(req.id, (approve) => {
      clearTimeout(timer);
      resolve(approve);
    });
    listeners.forEach((l) => l(req));
  });
}

/** 用户对某个审批请求作出决定。返回 false 表示该请求已不存在/超时 */
export function resolveApproval(id: string, approve: boolean): boolean {
  const resolver = pending.get(id);
  if (!resolver) return false;
  pending.delete(id);
  resolver(approve);
  return true;
}
