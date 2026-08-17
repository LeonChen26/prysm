/**
 * 上下文分析（右侧「上下文」Tab 的数据源）
 * 分类统计当前会话送入 LLM 的上下文构成：system prompt / 记忆注入 / RAG / 用户 / 助手 / 工具结果。
 *
 * 口径说明（关键）：
 * - 历史消息的 token 为「字符估算」（CJK ≈ 1 token/字，ASCII ≈ 4 字符/token），并非真实 tokenizer 输出，
 *   故所有 estimatedTokens 都需在 UI 上标注为估算；
 * - assistant 消息的 usage 字段由 pi-ai 提供，是真实值，单独求和（usageTotals）并优先展示；
 * - 后端不维护 context window 大小（各 provider 不同），故本分析不计算「窗口占用百分比」。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { buildSystemPrompt } from "./agent";
import { buildSkillIndex } from "./skills";
import { buildPreferencePrompt } from "./preference-memory";
import {
  countEpisodes,
  memoryRecallK,
  retrieveEpisodeDetails,
  type MemoryHit,
} from "./memory";
import { retrieveRagText } from "./rag";
import { getSession, getSessionMessages } from "./session";
import { messageText } from "./messages";
import { getAllowedRoots } from "./paths";

export type ContextCategoryKey =
  | "system"
  | "memory"
  | "rag"
  | "user"
  | "assistant"
  | "tool";

export interface ContextCategory {
  key: ContextCategoryKey;
  label: string;
  /** 字符数 */
  chars: number;
  /** 估算 token（字符估算，非真实） */
  estimatedTokens: number;
  /** 条目数（消息条数 / 记忆命中条数） */
  count: number;
}

export interface ContextAnalysis {
  categories: ContextCategory[];
  /** 估算总 token（各部分 estimatedTokens 之和） */
  totalEstimatedTokens: number;
  /** 历史 assistant 消息 usage 求和（真实值，无则为 null） */
  usageTotals: Usage | null;
  /** 最近一条 assistant 消息的 usage（真实值，即最近一轮问答的用量） */
  lastUsage: Usage | null;
  /** 记忆命中明细（可展开查看具体内容） */
  memoryHits: MemoryHit[];
  /** 记忆库总条数 */
  memoryTotal: number;
}

const LABELS: Record<ContextCategoryKey, string> = {
  system: "System 提示词",
  memory: "记忆注入",
  rag: "知识库注入",
  user: "用户输入",
  assistant: "助手输出",
  tool: "工具结果",
};

/** 记忆注入时每条 episode 的截断长度（与 memory.ts 的 MAX_CHARS_PER_EPISODE 一致） */
const MAX_CHARS_PER_EPISODE = 200;

/** 字符级 token 估算：CJK 按 1 字 1 token，其余按 4 字符 1 token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (
    text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []
  ).length;
  const other = text.length - cjk;
  return Math.max(1, Math.ceil(cjk + other / 4));
}

/** 提取 assistant 消息的 usage（非 assistant 或无 usage 返回 null） */
export function usageOf(m: AgentMessage): Usage | null {
  if (m.role !== "assistant") return null;
  const u = (m as { usage?: Usage }).usage;
  return u && typeof u.input === "number" ? u : null;
}

/** 累加 usage（真实值求和） */
export function addUsage(acc: Usage | null, u: Usage): Usage {
  if (!acc) return { ...u, cost: { ...u.cost } };
  return {
    input: acc.input + u.input,
    output: acc.output + u.output,
    cacheRead: acc.cacheRead + u.cacheRead,
    cacheWrite: acc.cacheWrite + u.cacheWrite,
    totalTokens: acc.totalTokens + u.totalTokens,
    cost: {
      input: acc.cost.input + u.cost.input,
      output: acc.cost.output + u.cost.output,
      cacheRead: acc.cost.cacheRead + u.cost.cacheRead,
      cacheWrite: acc.cost.cacheWrite + u.cost.cacheWrite,
      total: acc.cost.total + u.cost.total,
    },
  };
}

/** 分析指定会话的上下文构成（纯同步，供 GET /api/context/[sessionId] 调用） */
export function analyzeContext(sessionId: string): ContextAnalysis {
  const surface = getSession(sessionId)?.surface ?? "coding";
  const messages = getSessionMessages(sessionId);

  const acc: Record<
    ContextCategoryKey,
    { chars: number; estimatedTokens: number; count: number }
  > = {
    system: { chars: 0, estimatedTokens: 0, count: 0 },
    memory: { chars: 0, estimatedTokens: 0, count: 0 },
    rag: { chars: 0, estimatedTokens: 0, count: 0 },
    user: { chars: 0, estimatedTokens: 0, count: 0 },
    assistant: { chars: 0, estimatedTokens: 0, count: 0 },
    tool: { chars: 0, estimatedTokens: 0, count: 0 },
  };

  let usageTotals: Usage | null = null;
  let lastUsage: Usage | null = null;

  // 1. system prompt（估算）：与 getAgent 的装配方式一致
  const basePrompt = buildSystemPrompt(getAllowedRoots(), surface);
  const skillIndex = buildSkillIndex();
  const prefMemory = buildPreferencePrompt(getSession(sessionId)?.workdir);
  const systemText = [basePrompt, skillIndex, prefMemory].filter(Boolean).join("\n\n");
  acc.system.chars = systemText.length;
  acc.system.estimatedTokens = estimateTokens(systemText);
  acc.system.count = 1;

  // 2. 历史消息分类（sessions.db 只存干净 user/assistant/toolResult，无注入消息）
  for (const m of messages) {
    let key: ContextCategoryKey;
    if (m.role === "user") key = "user";
    else if (m.role === "assistant") key = "assistant";
    else key = "tool"; // toolResult 及其他自定义消息（bashExecution 等无 content）
    const text = messageText(m).trim();
    if (text) {
      acc[key].chars += text.length;
      acc[key].estimatedTokens += estimateTokens(text);
    }
    acc[key].count += 1;
    if (key === "assistant") {
      const u = usageOf(m);
      if (u) {
        usageTotals = addUsage(usageTotals, u);
        lastUsage = u;
      }
    }
  }

  // 3. 记忆注入（以最近一条用户消息为查询，与 buildContext 一致）
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  let memoryHits: MemoryHit[] = [];
  if (lastUser) {
    try {
      memoryHits = retrieveEpisodeDetails(messageText(lastUser), memoryRecallK());
    } catch (err) {
      console.error("[context] 记忆检索失败:", err);
    }
  }
  const memoryText = memoryHits
    .map((h) => `[${h.role}] ${h.content.slice(0, MAX_CHARS_PER_EPISODE)}`)
    .join("\n");
  acc.memory.chars = memoryText.length;
  acc.memory.estimatedTokens = estimateTokens(memoryText);
  acc.memory.count = memoryHits.length;

  // 4. 知识库注入（RAG，与 buildContext 一致）
  let ragText = "";
  if (lastUser) {
    try {
      ragText = retrieveRagText(messageText(lastUser));
    } catch (err) {
      console.error("[context] RAG 检索失败:", err);
    }
  }
  acc.rag.chars = ragText.length;
  acc.rag.estimatedTokens = estimateTokens(ragText);
  acc.rag.count = ragText ? 1 : 0;

  const categories: ContextCategory[] = (
    Object.keys(acc) as ContextCategoryKey[]
  ).map((key) => ({ key, label: LABELS[key], ...acc[key] }));

  const totalEstimatedTokens = categories.reduce(
    (s, c) => s + c.estimatedTokens,
    0,
  );

  return {
    categories,
    totalEstimatedTokens,
    usageTotals,
    lastUsage,
    memoryHits,
    memoryTotal: countEpisodes(),
  };
}
