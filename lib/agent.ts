import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, createModels } from "@earendil-works/pi-ai";
import { requestApproval } from "./approval";
import { messageText, transformContext } from "./context";
import { MEMORY_RECALL_K, resetMemoryTracking, retrieveEpisodes } from "./memory";
import { isAutoApproved } from "./policy";
import { getSessionMessages } from "./session";
import { tools } from "./tools";

const PROVIDER_FACTORIES = {
  anthropic: () => import("@earendil-works/pi-ai/providers/anthropic"),
  deepseek: () => import("@earendil-works/pi-ai/providers/deepseek"),
  openai: () => import("@earendil-works/pi-ai/providers/openai"),
  google: () => import("@earendil-works/pi-ai/providers/google"),
} as const;

type ProviderId = keyof typeof PROVIDER_FACTORIES;

const DEFAULT_PROVIDER: ProviderId =
  (process.env.MODEL_PROVIDER as ProviderId) || "anthropic";
const DEFAULT_MODEL = process.env.MODEL_ID || "claude-sonnet-4-5";

export const SYSTEM_PROMPT = `你是 WorkBuddy Agent —— 一个能自主完成任务的通用助手。

你拥有以下能力：
- 通过工具在工作区（agent-workdir 目录）内读取、写入、浏览文件。
- 所有文件操作都被限制在 agent-workdir 内，无法访问工作区以外的路径。
- 具备跨会话的情景记忆：每次对话开始前，系统会把从以往会话中检索到的相关信息以【历史情景】的形式注入给你，这就是你的长期记忆，请直接使用其中的事实（如用户偏好、之前完成的任务、文件内容），不要声称自己"没有记忆"。

工作方式：
1. 理解用户意图后，先规划步骤，再调用工具逐步完成。
2. 对需要多个步骤的复杂任务，先用 todo_create 将任务拆解为清晰的步骤清单；开始执行某一步前用 todo_modify 把它标记为 in_progress，每完成一步标记为 completed；中途如需调整清单，用 todo_modify 追加或修改，不要重复调用 todo_create 覆盖整个清单。
3. 工具调用失败时，分析错误原因，尝试换个参数或换一种方式重试。
4. 任务完成后，用 verify_file 自检关键交付物（确认文件存在、内容符合预期），校验失败时分析原因并修正后重新校验，再向用户总结做了什么、结果如何。
5. 用户意图不明确时，先向用户确认，不要擅自猜测。`;

let models: ReturnType<typeof createModels> | undefined;
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

async function ensureModels(): Promise<ReturnType<typeof createModels>> {
  if (models) return models;
  const factory = PROVIDER_FACTORIES[DEFAULT_PROVIDER];
  if (!factory) {
    throw new Error(
      `不支持的模型提供商: "${DEFAULT_PROVIDER}"。可用: ${Object.keys(PROVIDER_FACTORIES).join(", ")}`,
    );
  }
  const mod = await factory();
  const provider = mod[`${DEFAULT_PROVIDER}Provider`]();
  const m = createModels();
  m.setProvider(provider);
  models = m;
  return m;
}

const KEY_ENV: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
};

/** 需要用户审批的敏感工具 */
const SENSITIVE_TOOLS = new Set(["write_file", "delete_file"]);

/** 对最早的一批消息生成摘要（由同一模型完成，非流式） */
async function summarize(oldMessages: AgentMessage[]): Promise<string> {
  const m = await ensureModels();
  const model = m.getModel(DEFAULT_PROVIDER, DEFAULT_MODEL);
  if (!model) throw new Error("摘要生成失败：模型不可用");
  const transcript = oldMessages
    .map((msg) => `${msg.role}: ${messageText(msg).slice(0, 600)}`)
    .join("\n");
  const reply = await m.completeSimple(model, {
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

/**
 * 构建每次 LLM 调用的上下文：
 * 1. 先做上下文压缩（超限时摘要化旧消息）
 * 2. 用最近的用户消息检索情景记忆，注入相关历史（作为辅助上下文）
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
      recall = retrieveEpisodes(messageText(lastUser), MEMORY_RECALL_K);
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
  return base;
}

/** 从池中取指定会话的 Agent（不存在返回 undefined，不创建） */
export function getAgentForSession(sessionId: string): Agent | undefined {
  return agentPool.get(sessionId);
}

/** 获取指定会话的 Agent（不存在则用历史消息新建，实现会话恢复） */
export async function getAgent(sessionId: string): Promise<Agent> {
  const existing = agentPool.get(sessionId);
  if (existing) return existing;

  const m = await ensureModels();
  const model = m.getModel(DEFAULT_PROVIDER, DEFAULT_MODEL);
  if (!model) {
    throw new Error(
      `模型 "${DEFAULT_MODEL}" 在提供商 "${DEFAULT_PROVIDER}" 中不存在。可用 "MODEL_ID" 环境变量指定。`,
    );
  }
  const auth = await m.checkAuth(DEFAULT_PROVIDER);
  if (!auth) {
    throw new Error(
      `未检测到 ${DEFAULT_PROVIDER} 的 API Key。请在项目根目录的 .env.local 中配置 ${KEY_ENV[DEFAULT_PROVIDER]}=sk-xxx（可参考 .env.example），配置后重启 dev server 生效。`,
    );
  }
  const messages = getSessionMessages(sessionId);
  const a = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools,
      messages,
    },
    streamFn: m.streamSimple.bind(m),
    // 阶段 9：并行工具执行（单条消息含多个工具调用时同时执行；可用 TOOL_EXECUTION=sequential 回退）
    toolExecution:
      process.env.TOOL_EXECUTION === "sequential" ? "sequential" : "parallel",
    // 阶段 2+4：上下文压缩 + 情景记忆检索注入
    transformContext: buildContext,
    // 阶段 3+6：审批流 —— 敏感工具先征求用户确认（命中白名单规则则自动放行）
    beforeToolCall: async ({ toolCall, args }) => {
      if (SENSITIVE_TOOLS.has(toolCall.name) && !isAutoApproved(toolCall.name, args)) {
        const approved = await requestApproval({
          id: toolCall.id,
          toolName: toolCall.name,
          args,
        });
        if (!approved) {
          return { block: true, reason: "用户拒绝了该操作" };
        }
      }
      return undefined;
    },
  });
  agentPool.set(sessionId, a);
  return a;
}

/** 仅用于 dev 热重载时的状态重置 */
export function resetAgent(): void {
  for (const a of agentPool.values()) a.reset();
  agentPool.clear();
  models = undefined;
  resetMemoryTracking();
}

export type UiEvent =
  | { type: "turn_start" }
  | { type: "delta"; delta: string }
  | { type: "tool_start"; id: string; toolName: string; args: unknown }
  | {
      type: "tool_end";
      id: string;
      toolName: string;
      isError: boolean;
      todos?: { id: string; title: string; status: string; detail?: string }[];
    }
  | { type: "turn_end" }
  | { type: "agent_end" };

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
      const ui: UiEvent = {
        type: "tool_end",
        id: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };
      // 透传 todo 工具的任务清单，供前端渲染步骤卡片
      const todos = (event.result as { details?: { todos?: unknown } } | undefined)
        ?.details?.todos;
      if (Array.isArray(todos)) {
        ui.todos = todos as UiEvent["todos"];
      }
      return ui;
    }
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end" };
    case "agent_end":
      return { type: "agent_end" };
    default:
      return null;
  }
}
