/**
 * 执行策略解析层（权限审批优化 Phase 0）
 * 统一"文件操作 + 会话根 + 完全访问模式"的判定入口，让路径判定（paths.ts）、
 * 审批（approval.ts）基于同一个 per-call 策略对象，解开路径解析与授权判定耦合。
 *
 * 依赖方向：本模块只依赖 permission / config，不依赖 tools / paths（避免循环依赖）；
 * root 由调用方（tools.ts 的 effectiveWorkdir）从 workdirStorage 上下文注入。
 */

import { isFullAccessMode } from "./permission";

/** 文件操作语义：read=只读（读放开后任意本地路径，见 resolveInWorkspace） */
export type FileOp = "read" | "write";

/** 一次工具调用的执行策略（每次执行前解析一次，纯同步无副作用） */
export interface ExecutionPolicy {
  /** 会话根：由调用方从 workdirStorage 上下文注入（effectiveWorkdir） */
  root: string;
  /** 完全访问模式（permission activeMode=full）：跳过一切路径与审批拦截 */
  fullAccess: boolean;
}

/**
 * 解析一次执行策略。
 * @param root 会话根（调用方注入，勿用 agent-context 的 getSessionWorkdir——那仅 agent 初始化用）
 */
export function resolveExecutionPolicy(root: string): ExecutionPolicy {
  return { root, fullAccess: isFullAccessMode() };
}
