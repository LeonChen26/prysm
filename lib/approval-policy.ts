/**
 * 审批决策链纯函数（无副作用）—— 与 lib/agent.ts makeBeforeToolCall 决策顺序一致。
 *
 * 决策顺序（对齐 Trae 权限审批模型）：
 *   完全访问 > 规则裁决（commandRules / mcpRules deny|allow|ask）
 *   > 资源授权白/黑名单（deny 优先于 allow，permission.json 文件后端）
 *   > 场景开关（deleteToolApproval / mcpToolApproval）
 *   > reviewer（user / llm / always_deny）
 *
 * ask 表示需要人工 / LLM Guardian 审批（由调用方执行副作用：Guardian 决策、审批卡片、
 * 审计留痕与目录授权）。把决策逻辑抽成纯函数，便于单测覆盖全部分支与优先级。
 */

import type { ApprovalAction, Reviewer, SceneRules } from "./permission";

export interface RuleHit {
  key: string;
  action: ApprovalAction;
}

/** 资源授权黑名单判定结果（lib/policy.ts isDenied，文件后端） */
export interface PolicyDenyResult {
  denied: boolean;
  reason?: string;
}

export interface ApprovalPolicyInput {
  toolName: string;
  args: unknown;
  /** 完全访问模式（跳过一切审批与拦截） */
  fullAccess: boolean;
  /** 是否 MCP 工具（决定 mcpRules 命中与 mcpToolApproval 场景开关） */
  isMcp: boolean;
  /** 规则命中（run_bash → matchCommandRule；MCP → matchMcpRule） */
  ruleHit?: RuleHit;
  /** 资源授权黑名单判定结果（工具/路径） */
  policyDeny: PolicyDenyResult;
  /** 资源授权白名单命中（工具/路径） */
  policyAllow: boolean;
  scene: SceneRules;
  reviewer: Reviewer;
}

export type ApprovalDecision =
  | { action: "allow"; reason: string }
  | { action: "deny"; reason: string }
  | { action: "ask"; reason?: string };

export function decideApproval(input: ApprovalPolicyInput): ApprovalDecision {
  const { toolName, fullAccess, isMcp, ruleHit, policyDeny, policyAllow, scene, reviewer } = input;

  // 1) 完全访问：不审批不拦截
  if (fullAccess) return { action: "allow", reason: "完全访问模式，无需审批" };

  // 2) 规则裁决：deny / allow / ask（ask 不短路，继续走后续判定）
  if (ruleHit) {
    if (ruleHit.action === "deny") {
      return { action: "deny", reason: `命中规则「${ruleHit.key}」被禁止` };
    }
    if (ruleHit.action === "allow") {
      return { action: "allow", reason: `命中规则「${ruleHit.key}」自动放行` };
    }
  }

  // 3) 资源授权黑名单（deny 优先于 allow）
  if (policyDeny.denied) {
    return { action: "deny", reason: policyDeny.reason ?? "该操作被策略禁止" };
  }

  // 4) 资源授权白名单自动放行
  if (policyAllow) return { action: "allow", reason: "命中自动放行规则" };

  // 5) 场景开关：关闭对应场景保护时直接放行
  if (toolName === "delete_file" && !scene.deleteToolApproval) {
    return { action: "allow", reason: "删除审批已关闭（sceneRules.deleteToolApproval=false）" };
  }
  if (isMcp && !scene.mcpToolApproval && !ruleHit) {
    return { action: "allow", reason: "MCP 审批已关闭（sceneRules.mcpToolApproval=false）" };
  }

  // 6) 决策方：always_deny 一律拒绝；user / llm 需要审批
  //    （llm 由调用方执行 LLM Guardian，拒绝回退用户确认，仍为 ask）
  if (reviewer === "always_deny") {
    return { action: "deny", reason: "当前权限策略一律拒绝（reviewer=always_deny）" };
  }
  return { action: "ask" };
}
