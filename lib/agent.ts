import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type Usage } from "@earendil-works/pi-ai";
import { notifyApprovalNotice, requestApproval } from "./approval";
import { logApproval } from "./audit";
import { messageText } from "./messages";
import { transformContext } from "./context";
import { memoryRecallK, resetMemoryTracking, retrieveEpisodes } from "./memory";
import { retrieveRagText } from "./rag";
import { isAutoApproved, isDenied } from "./policy";
import { assessRisk, toolSource } from "./risk";
import { getSession, getSessionMessages } from "./session";
import { resolveAgentTools } from "./tools/registry";
import { setSpawnSubagentImpl } from "./tools";
import type { SubagentSpec } from "./subagent";
import { isSensitiveMcpTool } from "./tools/mcp";
import { buildSkillPrompt } from "./skills";
import { resolveModel, resetModelRouter } from "./model-router";
import { TOOL_META } from "./tool-meta";
import { envValue } from "./config";
import { clearRuns, getRuns, recordRun } from "./insights";
import { getAllowedRoots, resolveInWorkdir } from "./paths";
import { grantWorkspaceAccess } from "./workspace";

const KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
};

/**
 * 基础系统提示词（Phase 1b 动态化；Phase 7 按会话形态 work/coding 分化）
 * 多工作区下工作区根不再固定，按会话可访问的工作区根动态注入；
 * surface 决定角色定位：work 偏办公自动化，coding 偏编码工程（风格参考 pi-coding-agent：
 * 专家定位一句话 + 显式"可用工具"清单 + 精炼工作准则）。
 */
export function buildSystemPrompt(
  workspaceRoots: string[],
  surface?: "work" | "coding",
): string {
  const rootsText =
    workspaceRoots.length > 0 ? workspaceRoots.join("\n") : "（未配置）";
  // 按形态取内置工具清单：通用工具（未标 surface）+ 该形态专属工具
  const effSurface = surface ?? "coding";
  const toolsText = Object.entries(TOOL_META)
    .filter(([, m]) => !m.surface || m.surface === effSurface)
    .map(
      ([name, m]) =>
        `- ${name}: ${m.label}${m.sensitive ? "（敏感，操作需审批）" : ""}`,
    )
    .join("\n");
  const persona =
    surface === "work"
      ? `你是 Prysm 的 Work（办公自动化）助手，专注处理办公类任务：文档撰写与整理、资料检索与调研、数据整理与报告、邮件与纪要等事务性工作。
定位：以可交付的成果为导向 —— 报告、清单、表格、成文文档；动手前先明确目标与交付物形态。
原则：需要最新外部信息的任务，优先使用联网检索（web_search / fetch_url）并标注来源。`
      : surface === "coding"
        ? `你是 Prysm 的 Coding（编码）助手，一名专家级编码助理，工作在 Prysm 编码 harness 中。
定位：代码编写与重构、调试与排错、命令执行、环境配置、项目结构与构建理解。
原则：用工具自证结论 —— 能执行就先执行验证、能校验就先校验再汇报；涉及文件时清晰标注路径。`
        : `你是 Prysm —— 一个能自主完成任务的通用助手。`;
  return `${persona}

可用工具（当前形态，除内置工具外你还可使用已启用的 Skill 与已连接的 MCP server 提供的自定义工具）：
${toolsText}

你拥有以下能力：
- 通过工具在以下可访问的工作区根目录内读取、写入、浏览文件：
${rootsText}
- 所有文件操作都被限制在这些根目录内，无法访问根目录以外的路径。
- 具备跨会话的情景记忆：每次对话开始前，系统会把从以往会话中检索到的相关信息以【历史情景】的形式注入给你，这就是你的长期记忆，请直接使用其中的事实（如用户偏好、之前完成的任务、文件内容），不要声称自己"没有记忆"。
- 可通过 web_search 搜索互联网、用 fetch_url 抓取网页全文，获取实时信息（时事、文档、价格、版本号等）。涉及需要最新数据的问题，先搜索再回答，并标注信息来源。

工作准则：
1. 保持简洁，聚焦结论；涉及文件时清晰标注路径。
2. 理解用户意图后，先规划步骤，再调用工具逐步完成；复杂任务先用 plan_propose 产出结构化计划并等待用户确认，确认后再执行；简单任务可跳过。
3. 对已进入执行的任务，先用 todo_create 将任务拆解为清晰的步骤清单；开始执行某一步前用 todo_modify 把它标记为 in_progress，每完成一步标记为 completed；中途如需调整清单，用 todo_modify 追加或修改，不要重复调用 todo_create 覆盖整个清单。
4. 工具调用失败时，分析错误原因，尝试换个参数或换一种方式重试。
5. 任务完成后，用 verify_file 自检关键交付物（确认文件存在、内容符合预期），校验失败时分析原因并修正后重新校验，再向用户总结做了什么、结果如何。
6. 用户意图不明确时，先向用户确认，不要擅自猜测。
7. 需要向用户展示中间推理过程（如分步推导、方案权衡）时，用 \`\`\`thinking 语言标签的代码块包裹该部分内容，前端会将其折叠显示；最终结论写在思考块之外。`;
}

/** @deprecated Phase 1b：改用 buildSystemPrompt(workspaceRoots) 动态生成；保留供测试与历史导入 */
export const SYSTEM_PROMPT = buildSystemPrompt(getAllowedRoots());

/** 按会话缓存 Agent 实例：切换会话即切换实例，历史消息在构造时恢复 */
const agentPool = new Map<string, Agent>();
/** 记录被用户主动停止的会话（run 结束后由路由消费） */
const stoppedSessions = new Set<string>();

export function markStopped(sessionId: string): void {
  stoppedSessions.add(sessionId);
}

/** 消费"是否被停止"标记并返回结果 */
export function consumeStopped(sessionId: string): boolean {
  return stoppedSessions.delete(sessionId);
}

/** 需要用户审批的敏感工具（从 TOOL_META.sensitive 派生，避免与工具元数据漂移） */
const SENSITIVE_TOOLS = new Set(
  Object.entries(TOOL_META)
    .filter(([, meta]) => meta.sensitive)
    .map(([name]) => name),
);

/**
 * 敏感工具审批通过后调用：若目标路径位于未授权工作区，则顺带授权（记住授权）。
 * 目录授权默认拒绝（Phase 2）：用户批准一次对该目录的敏感操作，即视为同意后续访问。
 */
function ensureDirAuthorized(args: unknown): void {
  if (!args || typeof args !== "object") return;
  const a = args as Record<string, unknown>;
  const rel =
    typeof a.path === "string" ? a.path : typeof a.to === "string" ? a.to : null;
  if (!rel) return;
  const r = resolveInWorkdir(rel);
  if (!r.ok && r.reason === "unauthorized" && r.workspaceId) {
    grantWorkspaceAccess(r.workspaceId);
    console.log(`[auth] 已授权工作区 ${r.workspaceId}（根: ${r.root}）`);
  }
}

/** 对最早的一批消息生成摘要（由同一模型完成，非流式） */
async function summarize(oldMessages: AgentMessage[]): Promise<string> {
  const { models, model, provider } = await resolveModel("summarize");
  if (!model) throw new Error("摘要生成失败：模型不可用");
  const transcript = oldMessages
    .map((msg) => `${msg.role}: ${messageText(msg).slice(0, 600)}`)
    .join("\n");
  const reply = await models.completeSimple(model, {
    systemPrompt:
      "你是对话摘要器。把用户提供的对话记录压缩成简洁的中文摘要，保留：用户偏好、关键决策、未完成任务、已交付的成果。控制在 300 字以内，不要遗漏关键信息。",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: transcript }],
        timestamp: Date.now(),
      },
    ],
  });
  return contentText(reply.content);
}

/** 为会话生成精炼标题（默认命名且对话多轮时调用），失败时返回空串 */
export async function generateTitle(
  messages: AgentMessage[],
): Promise<string> {
  const first = messages.find((mm) => mm.role === "user");
  if (!first) return "";
  const { models, model } = await resolveModel("title");
  if (!model) return "";
  const reply = await models.completeSimple(model, {
    systemPrompt:
      "你是会话标题生成器。根据对话内容生成一个 12 字以内的中文标题，只输出标题本身，不要引号、不要标点、不要多余解释。",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: messageText(first).slice(0, 200) }],
        timestamp: Date.now(),
      },
    ],
  });
  return contentText(reply.content).trim().replace(/["""'']/g, "").slice(0, 20);
}

/** 运行日志条目（持久化到 insights.db 的 turns 表） */
export interface RunLogEntry {
  id: number;
  sessionId: string;
  title: string;
  startedAt: number;
  durationMs: number;
  messageCount: number;
  stopped: boolean;
  error?: string;
  /** 本轮各工具调用次数（供运行统计） */
  toolCalls?: Record<string, number>;
  /** 本轮 token 用量（真实值，turn_end 事件累加） */
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    totalTokens: number;
    cost: number;
  };
}

/** 记录一次 Agent 运行（持久化到 insights.db，替代内存数组），返回落库记录（含 id，供关联评分） */
export function logRun(
  entry: Omit<RunLogEntry, "id"> & { userText?: string; model?: string },
): RunLogEntry {
  return recordRun(entry);
}

/** 最近运行日志（新在前，从 insights.db 读） */
export function getRunLogs(): RunLogEntry[] {
  return getRuns();
}

/** 清空运行日志 */
export function clearRunLogs(): void {
  clearRuns();
}

/**
 * 构建每次 LLM 调用的上下文：
 * 1. 先做上下文压缩（超限时摘要化旧消息）
 * 2. 用最近的用户消息检索情景记忆，注入相关历史（作为辅助上下文）
 * 3. 用同一查询检索知识库（RAG），注入相关文档片段（Phase 6）
 *    注入顺序：压缩 → 记忆 → RAG，三者各有预算。
 */
async function buildContext(
  messages: AgentMessage[],
): Promise<AgentMessage[]> {
  const base = await transformContext(messages, summarize);

  // 检索情景记忆：以最近一条用户消息为查询
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  let recall = "";
  if (lastUser) {
    try {
      recall = retrieveEpisodes(messageText(lastUser), memoryRecallK());
    } catch (err) {
      console.error("[memory] 检索失败:", err);
    }
  }
  if (recall) {
    base.unshift({
      role: "user",
      content: [
        {
          type: "text",
          text: `【历史情景】以下是从以往会话中检索到的相关信息，可能与当前任务相关，请参考：\n${recall}`,
        },
      ],
      timestamp: Date.now(),
    });
    console.log(`[memory] 注入情景记忆 ${recall.length} 字符`);
  } else {
    console.log("[memory] 本次检索无命中，未注入");
  }

  // 知识库检索（RAG）：以同一用户查询检索项目文档，注入相关片段
  if (lastUser) {
    try {
      const rag = retrieveRagText(messageText(lastUser));
      if (rag) {
        base.unshift({
          role: "user",
          content: [
            {
              type: "text",
              text: `【知识库】以下是从项目文档检索到的相关内容，可能与当前任务相关，请参考：\n${rag}`,
            },
          ],
          timestamp: Date.now(),
        });
        console.log(`[rag] 注入知识库片段 ${rag.length} 字符`);
      }
    } catch (err) {
      console.error("[rag] 检索失败:", err);
    }
  }
  return base;
}

/** 从池中取指定会话的 Agent（不存在返回 undefined，不创建） */
export function getAgentForSession(sessionId: string): Agent | undefined {
  return agentPool.get(sessionId);
}

/**
 * 构建敏感工具审批 handler（主 agent 与子 agent 共用）。
 * 黑名单命中直接拦截；白名单命中自动放行（落审计）；否则征求用户确认。
 * @param sessionId 审批/审计关联的会话标识（子 agent 传其子 agent key，带标识回传）
 */
function makeBeforeToolCall(
  sessionId: string,
): NonNullable<import("@earendil-works/pi-agent-core").AgentOptions["beforeToolCall"]> {
  return async ({ toolCall, args }) => {
    // 敏感判定：内置工具看 TOOL_META.sensitive，MCP 工具按服务端标注（destructive/readOnly）判定
    if (!SENSITIVE_TOOLS.has(toolCall.name) && !isSensitiveMcpTool(toolCall.name)) {
      return undefined;
    }

    // 1) 强制拦截（deny 优先于 allow）
    const deny = isDenied(toolCall.name, args);
    if (deny.denied) {
      const reason = deny.reason ?? "该操作被策略禁止";
      logApproval(toolCall.name, args, "denied_auto", { sessionId, reason });
      notifyApprovalNotice(toolCall.id, toolCall.name, args, reason, sessionId);
      return { block: true, reason };
    }

    // 2) 白名单自动放行（落审计，不打扰用户）
    if (isAutoApproved(toolCall.name, args)) {
      logApproval(toolCall.name, args, "auto", {
        sessionId,
        reason: "命中自动放行规则",
      });
      return undefined;
    }

    // 3) 人工审批（带风险等级与会话关联；外部来源按来源默认等级评估）
    const risk = assessRisk(toolCall.name, args, toolSource(toolCall.name));
    const approved = await requestApproval({
      id: toolCall.id,
      toolName: toolCall.name,
      args,
      sessionId,
      risk: risk.level,
      riskReason: risk.reason,
    });
    if (!approved) {
      return { block: true, reason: "用户拒绝了该操作" };
    }
    // Phase 2：审批通过即视为对目标目录授权（默认拒绝策略下的"记住授权"）
    ensureDirAuthorized(args);
    return undefined;
  };
}

/** 获取指定会话的 Agent（不存在则用历史消息新建，实现会话恢复） */
export async function getAgent(sessionId: string): Promise<Agent> {
  const existing = agentPool.get(sessionId);
  if (existing) return existing;

  const { models, model, provider, modelId } = await resolveModel("orchestrator");
  if (!model) {
    throw new Error(
      `模型 "${modelId}" 在提供商 "${provider}" 中不存在。可用 "MODEL_ID" 环境变量指定。`,
    );
  }
  const auth = await models.checkAuth(provider);
  if (!auth) {
    throw new Error(
      `未检测到 ${provider} 的 API Key。请在项目根目录的 .env.local 中配置 ${KEY_ENV[provider] ?? provider + "_API_KEY"}=sk-xxx（可参考 .env.example），配置后重启 dev server 生效。`,
    );
  }
  const messages = getSessionMessages(sessionId);
  // Phase 7：会话形态驱动提示词角色定位与工具集筛选
  const surface = getSession(sessionId)?.surface ?? "coding";
  const basePrompt = buildSystemPrompt(getAllowedRoots(), surface);
  // Phase 4：已启用技能的正文拼入系统提示词
  const skillPrompt = buildSkillPrompt();
  const systemPrompt = skillPrompt ? `${basePrompt}\n\n${skillPrompt}` : basePrompt;
  const a = new Agent({
    initialState: {
      systemPrompt,
      model,
      // Phase 3+7：工具集动态解析 —— 内置工具 + 已连接的 MCP server 工具，按会话形态筛选
      tools: await resolveAgentTools({ surface }),
      messages,
    },
    streamFn: models.streamSimple.bind(models),
    // 阶段 9：并行工具执行（单条消息含多个工具调用时同时执行；可用 TOOL_EXECUTION=sequential 回退）
    toolExecution:
      envValue("TOOL_EXECUTION") === "sequential" ? "sequential" : "parallel",
    // 阶段 2+4：上下文压缩 + 情景记忆检索注入
    transformContext: buildContext,
    // 阶段 3+6：审批流 —— 敏感工具先评估风险与策略（黑/白名单/人工审批）
    beforeToolCall: makeBeforeToolCall(sessionId),
  });
  agentPool.set(sessionId, a);
  return a;
}

/** 仅用于 dev 热重载时的状态重置 */
export function resetAgent(): void {
  for (const a of agentPool.values()) a.reset();
  agentPool.clear();
  resetModelRouter();
  resetMemoryTracking();
}

/**
 * 子 agent 执行器（Phase 5）：构造独立 Agent 运行子任务，返回摘要。
 * 上下文隔离：独立 state.messages，不污染主会话；审批走同一 risk/policy/approval/audit，
 * 审批/审计 sessionId 用子 agent key（带父上下文标识回传）。
 * 通过 setSpawnSubagentImpl 注入 spawn_subagent 工具（打破 tools↔agent 循环依赖）。
 */
export async function runSubagentCore(spec: SubagentSpec): Promise<string> {
  const { models, model } = await resolveModel("subagent");
  if (!model) throw new Error("子 agent 模型不可用");
  const key = spec.key ?? spec.parentSessionId;
  const roots = getAllowedRoots();
  const rootsText = roots.length > 0 ? roots.join("\n") : "（未配置）";
  const capDesc =
    spec.capability === "readwrite"
      ? "读写（可修改文件）"
      : "只读（不可修改文件，仅可读文件/搜索/查询）";
  const systemPrompt = `你是 Prysm 派生的子 agent，负责在隔离上下文中完成一项子任务。
当前模式：${capDesc}
可访问工作区根：
${rootsText}
请专注完成任务。完成后，用简洁的中文摘要汇报关键结论与具体产出（引用文件路径/数据），不要输出过程性细节。`;

  const a = new Agent({
    initialState: {
      systemPrompt,
      model,
      // 工具集按 capability 筛选：只读子 agent 仅读书写工具以外的只读/无标记工具
      tools: await resolveAgentTools({ capability: spec.capability }),
      messages: [],
    },
    streamFn: models.streamSimple.bind(models),
    toolExecution:
      envValue("TOOL_EXECUTION") === "sequential" ? "sequential" : "parallel",
    // 审批带子 agent key 标识回传父会话
    beforeToolCall: makeBeforeToolCall(key),
  });

  await a.prompt({
    role: "user",
    content: [{ type: "text", text: `请完成以下任务：\n${spec.task}` }],
    timestamp: Date.now(),
  });

  const last = [...a.state.messages].reverse().find((m) => m.role === "assistant");
  if (!last) throw new Error("子 agent 未产生任何输出");
  return messageText(last).trim();
}

// 注入 spawn_subagent 工具的延迟执行器（模块加载时建立，避免循环依赖）
setSpawnSubagentImpl(runSubagentCore);

export type UiEvent =
  | { type: "turn_start"; sessionId?: string }
  | { type: "delta"; delta: string; sessionId?: string }
  | {
      type: "tool_start";
      id: string;
      toolName: string;
      args: unknown;
      sessionId?: string;
    }
  | {
      type: "tool_end";
      id: string;
      toolName: string;
      isError: boolean;
      /** 工具返回的文本内容（截断到 2000 字符），供前端展开查看 */
      result?: string;
      todos?: { id: string; title: string; status: string; detail?: string }[];
      sessionId?: string;
    }
  | { type: "turn_end"; usage?: Usage; sessionId?: string }
  | { type: "agent_end"; sessionId?: string };

export function mapEvent(event: AgentEvent): UiEvent | null {
  switch (event.type) {
    case "message_update": {
      const e = event.assistantMessageEvent;
      if (e.type === "text_delta") return { type: "delta", delta: e.delta };
      return null;
    }
    case "tool_execution_start":
      return {
        type: "tool_start",
        id: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_end": {
      const ui: Extract<UiEvent, { type: "tool_end" }> = {
        type: "tool_end",
        id: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };
      // 透传工具返回的文本内容（前端卡片可展开查看）
      const raw = event.result as
        | { content?: { type?: string; text?: string }[] }
        | undefined;
      const texts = (raw?.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string);
      if (texts.length > 0) {
        ui.result = texts.join("\n").slice(0, 2000);
      }
      // 透传 todo 工具的任务清单，供前端渲染步骤卡片
      const todos = (event.result as { details?: { todos?: unknown } } | undefined)
        ?.details?.todos;
      if (Array.isArray(todos)) {
        ui.todos = todos as Extract<UiEvent, { type: "tool_end" }>["todos"];
      }
      return ui;
    }
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end": {
      const msg = event.message as { usage?: Usage };
      return { type: "turn_end", usage: msg?.usage };
    }
    case "agent_end":
      return { type: "agent_end" };
    default:
      return null;
  }
}
