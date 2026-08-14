/**
 * Core 工厂（Phase 1a.3，Phase 1b 扩展）
 * 统一参数注入入口：createCore(config) 将 baseDir/env/默认模型等配置写入 config 上下文，
 * 各核心模块经 config.ts 读取，不再直读 process.cwd()/process.env。
 *
 * - Web 路由：createCore({ baseDir: process.cwd(), env: process.env })
 * - Electron 主进程：createCore({ baseDir: app.getPath('userData') })
 * - 现有模块级函数（getAgent/createSession/...）从 PrysmCore 实例暴露，避免全局单例。
 *
 * Phase 1b：listWorkspaces 改由 workspace 表驱动（含默认工作区 + env 一次性导入）；
 *          createSession 支持 surface（work/coding）。
 */

import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import { configure, type ModelRole, type ModelRoute, type PrysmConfig } from "./config";
import { getAgent, mapEvent } from "./agent";
import { subscribeApprovalLifecycle } from "./approval";
import { subscribePlanLifecycle } from "./plan";
import {
  listModelRoutes as listModelRoutesAll,
  setModelRoute as setModelRouteRecord,
} from "./model-router";
import {
  createSession,
  listSessions,
  type SessionInfo,
  type Surface,
} from "./session";
import type { AgentEventBus } from "./events";
import { SimpleEventBus } from "./events";
import {
  addWorkspace as addWorkspaceRecord,
  getDefaultWorkspace,
  grantWorkspaceAccess as grantWorkspaceRecord,
  listWorkspaces as listWorkspaceRecords,
  removeWorkspace as removeWorkspaceRecord,
  revokeWorkspaceAccess as revokeWorkspaceRecord,
} from "./workspace";
import {
  addPolicyRule,
  clearPolicyRules,
  configurePolicy,
  getPolicyApprovalTimeoutMs,
  listPolicyRules,
  removePolicyRule,
  type PolicyKind,
  type PolicyRule,
} from "./policy";
import { configureMcp, getMcpPool, type McpServerStatus } from "./tools/mcp";
import { resolveAgentTools, type ToolFilter } from "./tools/registry";
import {
  buildSkillPrompt,
  disableSkill,
  enableSkill,
  initSkills,
  listSkills,
  reloadSkills,
  type SkillDef,
} from "./skills";

export type { PrysmConfig, Surface, PolicyKind, PolicyRule };

export interface WorkspaceInfo {
  id: string;
  name: string;
  root: string;
  /** 目录授权状态（Phase 2：默认拒绝，default 恒授权） */
  authorized: boolean;
}

export interface PrysmCore {
  getAgent: (sessionId: string) => Promise<Agent>;
  listSessions: () => SessionInfo[];
  createSession: (opts?: { title?: string; surface?: Surface }) => SessionInfo;
  listWorkspaces: () => WorkspaceInfo[];
  resolveWorkspace: (sessionId: string) => WorkspaceInfo;
  eventBus: AgentEventBus;
  // Phase 2：目录授权（默认拒绝）+ 策略管理
  addWorkspace: (root: string, name?: string) => WorkspaceInfo;
  removeWorkspace: (id: string) => void;
  grantWorkspaceAccess: (id: string) => WorkspaceInfo | undefined;
  revokeWorkspaceAccess: (id: string) => WorkspaceInfo | undefined;
  listPolicyRules: () => PolicyRule[];
  addPolicyRule: (kind: PolicyKind, value: string) => PolicyRule;
  removePolicyRule: (id: number) => boolean;
  clearPolicyRules: () => void;
  getPolicyApprovalTimeoutMs: () => number | undefined;
  // Phase 3：MCP 接入（tools+resources+prompts，stdio）
  initMcp: () => Promise<McpServerStatus[]>;
  mcpStatus: () => McpServerStatus[];
  resolveTools: (filter?: ToolFilter) => Promise<AgentTool[]>;
  // Phase 4：Skill 机制（SKILL.md + 注入 + 工具）
  listSkills: () => (SkillDef & { enabled: boolean })[];
  enableSkill: (name: string) => boolean;
  disableSkill: (name: string) => boolean;
  reloadSkills: () => SkillDef[];
  skillPrompt: () => string;
  // Phase 5：多模型路由（role → provider/model；list 含注入/表/默认 合并结果）
  listModelRoutes: () => Record<ModelRole, ModelRoute>;
  setModelRoute: (role: ModelRole, provider: string, model: string) => ModelRoute;
  // 后续扩展：subagentPool 等
}

export function createCore(config: PrysmConfig): PrysmCore {
  // 注入运行时配置：路径基准 + 环境变量 + 默认模型/审批超时等
  configure(config);
  // Phase 2：策略数据源注入（非空字段覆盖 SQLite/env；undefined 则走 SQLite/env 兼容）
  configurePolicy(config.policy);
  // Phase 3：MCP 池配置注入（显式指定 mcp.json 时使用；否则惰性读取 <baseDir>/mcp.json）
  if (config.mcpConfigPath) configureMcp(config.mcpConfigPath);

  const eventBus = new SimpleEventBus();
  // Phase 7.5：核心层直接 emit AgentEventBus —— 审批/计划生命周期事件注入共享 bus（带 sessionId 供壳侧按会话隔离）。
  // 事件均为纯 JSON 可序列化对象，SSE / Electron IPC 可直接透传。
  subscribeApprovalLifecycle((e) => {
    if (e.type === "required") {
      eventBus.emit({
        type: "approval_required",
        id: e.state.id,
        toolName: e.state.toolName,
        args: e.state.args,
        risk: e.state.risk,
        riskReason: e.state.riskReason,
        expiresAt: e.state.expiresAt,
        sessionId: e.state.sessionId,
      });
    } else if (e.type === "resolved" || e.type === "expired") {
      eventBus.emit({
        type: e.type === "resolved" ? "approval_resolved" : "approval_expired",
        id: e.state.id,
        approve: e.type === "resolved" && e.state.status === "approved",
        sessionId: e.state.sessionId,
      });
    } else if (e.type === "notice") {
      eventBus.emit({
        type: "policy_notice",
        id: e.id,
        toolName: e.toolName,
        args: e.args,
        action: e.action,
        reason: e.reason,
        sessionId: e.sessionId,
      });
    }
  });
  subscribePlanLifecycle((e) => {
    if (e.type === "proposed") {
      eventBus.emit({
        type: "plan_proposed",
        id: e.plan.id,
        sessionId: e.plan.sessionId,
        surface: e.plan.surface,
        summary: e.plan.summary,
        steps: e.plan.steps,
        expiresAt: e.plan.expiresAt,
      });
    } else if (e.type === "decided") {
      eventBus.emit({
        type: "plan_decided",
        id: e.plan.id,
        approve: e.plan.status === "approved",
        reason: e.plan.reason,
        sessionId: e.plan.sessionId,
      });
    } else if (e.type === "cancelled") {
      eventBus.emit({
        type: "plan_cancelled",
        id: e.plan.id,
        reason: e.plan.reason,
        sessionId: e.plan.sessionId,
      });
    }
  });

  const toInfo = (w: {
    id: string;
    name: string;
    root: string;
    authorized: number | boolean;
  }): WorkspaceInfo => ({
    id: w.id,
    name: w.name,
    root: w.root,
    authorized: w.authorized === 1 || w.authorized === true,
  });

  return {
    // Phase 7.5：核心层直接 emit —— agent 事件经 mapEvent 注入共享 bus（带 sessionId 供壳侧按会话隔离）。
    getAgent: async (sessionId) => {
      const a = await getAgent(sessionId);
      a.subscribe((evt) => {
        const ui = mapEvent(evt);
        if (!ui) return;
        eventBus.emit({ ...ui, sessionId });
      });
      return a;
    },
    listSessions,
    // Phase 1b：创建会话时确定 surface（work/coding）
    createSession: (opts) => createSession(opts?.title, opts?.surface),
    // Phase 1b：workspace 表驱动（含默认工作区 + env 一次性导入 + 后续 UI 管理）
    listWorkspaces: (): WorkspaceInfo[] =>
      listWorkspaceRecords().map((w) => toInfo(w)),
    // Phase 1b：会话尚未绑定具体工作区，统一落到默认工作区（Phase 1b+ 增加会话工作区归属后按归属解析）
    resolveWorkspace: (): WorkspaceInfo => {
      const w = getDefaultWorkspace();
      return { id: w.id, name: w.name, root: w.root, authorized: true };
    },
    eventBus,
    // Phase 2：目录授权（默认拒绝）+ 策略管理
    addWorkspace: (root, name) => toInfo(addWorkspaceRecord(root, name)),
    removeWorkspace: (id) => removeWorkspaceRecord(id),
    grantWorkspaceAccess: (id) => {
      const w = grantWorkspaceRecord(id);
      return w ? toInfo(w) : undefined;
    },
    revokeWorkspaceAccess: (id) => {
      const w = revokeWorkspaceRecord(id);
      return w ? toInfo(w) : undefined;
    },
    listPolicyRules: () => listPolicyRules(),
    addPolicyRule: (kind, value) => addPolicyRule(kind, value),
    removePolicyRule: (id) => removePolicyRule(id),
    clearPolicyRules: () => clearPolicyRules(),
    getPolicyApprovalTimeoutMs: () => getPolicyApprovalTimeoutMs(),
    // Phase 3：MCP 池状态 / 工具集解析
    initMcp: () => getMcpPool().ensureInit(),
    mcpStatus: () => getMcpPool().status(),
    resolveTools: (filter) => resolveAgentTools(filter),
    // Phase 4：Skill 生命周期与注入
    listSkills: () => listSkills(),
    enableSkill: (name) => enableSkill(name),
    disableSkill: (name) => disableSkill(name),
    reloadSkills: () => reloadSkills(),
    skillPrompt: () => buildSkillPrompt(),
    // Phase 5：模型路由（读/写 model_route 表，list 含注入>表>默认）
    listModelRoutes: () => listModelRoutesAll(),
    setModelRoute: (role, provider, model) => setModelRouteRecord(role, provider, model),
  };
}
