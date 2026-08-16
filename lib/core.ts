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
import { configureMcp, getMcpPool, type McpServerStatus } from "./tools/mcp";
import { resolveAgentTools, type ToolFilter } from "./tools/registry";
import {
  buildSkillIndex,
  disableSkill,
  enableSkill,
  initSkills,
  listSkills,
  reloadSkills,
  type SkillDef,
} from "./skills";
import {
  createAutomation as createAutomationRecord,
  deleteAutomation as deleteAutomationRecord,
  listAutomationRuns,
  listAutomations,
  setAutomationEnabled,
  updateAutomation as updateAutomationRecord,
  type Automation,
  type AutomationInput,
  type AutomationPatch,
  type AutomationRun,
} from "./automation";
import {
  bindAutomationEventBus,
  runAutomationNow,
  startScheduler,
} from "./scheduler";

export type { PrysmConfig, Surface };

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
  // Phase 3：MCP 接入（tools+resources+prompts，stdio）
  initMcp: () => Promise<McpServerStatus[]>;
  mcpStatus: () => McpServerStatus[];
  resolveTools: (filter?: ToolFilter) => Promise<AgentTool[]>;
  // Phase 4.1：Skill 机制（SKILL.md + 名称描述索引 + use_skill 按需加载）
  listSkills: () => (SkillDef & { enabled: boolean })[];
  enableSkill: (name: string) => boolean;
  disableSkill: (name: string) => boolean;
  reloadSkills: () => SkillDef[];
  skillIndex: () => string;
  // Phase 5：多模型路由（role → provider/model；list 含注入/表/默认 合并结果）
  listModelRoutes: () => Record<ModelRole, ModelRoute>;
  setModelRoute: (role: ModelRole, provider: string, model: string) => ModelRoute;
  // 定时任务（自动化）：配置管理 + 执行
  listAutomations: () => Automation[];
  createAutomation: (input: AutomationInput) => Automation;
  updateAutomation: (id: string, patch: AutomationPatch) => Automation | undefined;
  deleteAutomation: (id: string) => boolean;
  toggleAutomation: (id: string, enabled: boolean) => Automation | undefined;
  listAutomationRuns: (limit?: number) => AutomationRun[];
  runAutomationNow: (
    id: string,
  ) => Promise<{ status: string; sessionId?: string; error?: string }>;
  // 后续扩展：subagentPool 等
}

export function createCore(config: PrysmConfig): PrysmCore {
  // 注入运行时配置：路径基准 + 环境变量 + 默认模型等
  configure(config);
  // Phase 3：MCP 池配置注入（显式指定 mcp.json 时使用；否则惰性读取 <baseDir>/mcp.json）
  if (config.mcpConfigPath) configureMcp(config.mcpConfigPath);

  const eventBus = new SimpleEventBus();
  // 已接入 bus 的 agent 实例集合（WeakSet 不阻止实例回收）：保证每个 agent 只注册一次监听器
  const subscribedAgents = new WeakSet<Agent>();
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

  // 定时任务调度器：绑定事件总线（automation_run 事件推送）并启动（幂等，防热重载重复）。
  // 测试/特殊环境可通过 config.disableScheduler 关闭自动启动。
  bindAutomationEventBus(eventBus);
  if (!config.disableScheduler) startScheduler();

  return {
    // Phase 7.5：核心层直接 emit —— agent 事件经 mapEvent 注入共享 bus（带 sessionId 供壳侧按会话隔离）。
    // 注意：agent 实例按 sessionId 缓存复用，必须确保每个 agent 只注册一次监听器，
    // 否则多次调用 getAgent（每次 POST/GET）会让同一 delta 事件被重复 emit 到 bus，
    // 前端流式文本随之被重复拼接（如 "edit_file" → "editeditedit_file_file_file"）。
    getAgent: async (sessionId) => {
      const a = await getAgent(sessionId);
      if (!subscribedAgents.has(a)) {
        subscribedAgents.add(a);
        a.subscribe((evt) => {
          const ui = mapEvent(evt);
          if (!ui) return;
          eventBus.emit({ ...ui, sessionId });
        });
      }
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
    // Phase 2：目录授权（默认拒绝）
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
    // Phase 3：MCP 池状态 / 工具集解析
    initMcp: () => getMcpPool().ensureInit(),
    mcpStatus: () => getMcpPool().status(),
    resolveTools: (filter) => resolveAgentTools(filter),
    // Phase 4：Skill 生命周期与注入
    listSkills: () => listSkills(),
    enableSkill: (name) => enableSkill(name),
    disableSkill: (name) => disableSkill(name),
    reloadSkills: () => reloadSkills(),
    skillIndex: () => buildSkillIndex(),
    // Phase 5：模型路由（读/写 model_route 表，list 含注入>表>默认）
    listModelRoutes: () => listModelRoutesAll(),
    setModelRoute: (role, provider, model) => setModelRouteRecord(role, provider, model),
    // 定时任务（自动化）：配置管理 + 执行
    listAutomations: () => listAutomations(),
    createAutomation: (input) => createAutomationRecord(input),
    updateAutomation: (id, patch) => updateAutomationRecord(id, patch),
    deleteAutomation: (id) => deleteAutomationRecord(id),
    toggleAutomation: (id, enabled) => setAutomationEnabled(id, enabled),
    listAutomationRuns: (limit) => listAutomationRuns(limit),
    runAutomationNow: (id) => runAutomationNow(id),
  };
}
