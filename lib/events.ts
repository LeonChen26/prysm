import type { UiEvent } from "./agent";
import type { RiskLevel } from "./risk";

/**
 * 统一事件总线（Phase 1a.2）
 * 把两套独立事件通道（agent 的 UiEvent 与审批的 ApprovalLifecycleEvent）
 * 统一为单一 BusEvent 流，供壳侧（SSE / IPC）适配。
 *
 * 事件命名沿袭现有前端 SSE 契约（components/chat-types.ts），
 * Phase 1a.2 只做通道统一，不改变前端收到的事件字段。
 */

/**
 * 审批事件（核心层直接 emit）。
 * 所有事件为纯 JSON 可序列化对象（无函数引用/循环结构），可在 Electron IPC 间传递。
 * `sessionId` 供壳侧（SSE/IPC）按会话隔离推送。
 */
export type ApprovalEvent =
  | {
      type: "approval_required";
      id: string;
      toolName: string;
      args: unknown;
      risk?: RiskLevel;
      riskReason?: string;
      expiresAt: number;
      sessionId?: string;
    }
  | {
      type: "approval_resolved";
      id: string;
      approve: boolean;
      sessionId?: string;
    }
  | { type: "approval_expired"; id: string; sessionId?: string }
  | {
      type: "policy_notice";
      id?: string;
      toolName: string;
      args: unknown;
      action: string;
      reason: string;
      sessionId?: string;
    };

/** Plan mode 事件（核心层直接 emit，独立于审批流） */
export type PlanEvent =
  | {
      type: "plan_proposed";
      id: string;
      sessionId: string;
      surface: string;
      summary?: string;
      steps: { id: string; title: string; detail?: string; tool?: string; expected?: string }[];
      expiresAt: number;
    }
  | {
      type: "plan_decided";
      id: string;
      approve: boolean;
      reason?: string;
      sessionId?: string;
    }
  | {
      type: "plan_cancelled";
      id: string;
      reason?: string;
      sessionId?: string;
    };

/** 统一事件流：agent 事件 + 审批事件 + plan 事件 */
export type BusEvent = UiEvent | ApprovalEvent | PlanEvent;

export interface AgentEventBus {
  emit(event: BusEvent): void;
  subscribe(listener: (event: BusEvent) => void): () => void;
}

/** 进程内事件总线实现（Web 与 Electron 主进程均可直接用） */
export class SimpleEventBus implements AgentEventBus {
  private listeners = new Set<(event: BusEvent) => void>();

  emit(event: BusEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: BusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
