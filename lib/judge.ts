/**
 * LLM-as-Judge 自动评分（观测评估闭环的「评估」自动化环节）
 *
 * 默认关闭（PRYSM_LLM_JUDGE=1 开启）：每次 run 落库后异步调用一次主模型，
 * 根据「用户请求 + 工具调用 + token 用量 + Agent 回复」对本次问答质量打分（0-10 + 理由），
 * 结果写入 insights.db 的 scores 表（kind=rule, label=llm_judge），供评估面板展示。
 *
 * 设计约束：
 * - 完全可开关，默认 off，避免产生隐性成本；
 * - 失败静默降级（模型不可用 / 解析失败 → 仅打日志，不落库污染数据）；
 * - 不新增 ModelRole，直接复用 orchestrator 主模型。
 */
import { contentText } from "@earendil-works/pi-ai";
import { resolveModel } from "./model-router";
import { addScore } from "./insights";
import { envValue } from "./config";
import type { RunLogEntry } from "./agent";

/** 是否启用 LLM-as-Judge（PRYSM_LLM_JUDGE=1/true/yes） */
export function judgeEnabled(): boolean {
  const v = envValue("PRYSM_LLM_JUDGE");
  return v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";
}

/** 供评估的上下文（仅文本，尽量短以控制成本） */
export interface JudgeContext {
  userText?: string;
  replyText?: string;
}

const SYSTEM_PROMPT = `你是任务执行质量评估员。根据用户的请求、Agent 的执行过程与回复，评估本次问答的质量。
输出严格 JSON：{"score":0到10的整数,"reason":"简短中文理由（60字内）"}
评分维度：是否准确回应请求、工具使用是否恰当、回复是否完整清晰、是否存在明显错误。`;

/** 解析 LLM 返回的评分文本，期望包含 JSON：{"score":0-10,"reason":"..."}；无法解析返回 null */
export function parseJudgeOutput(
  text: string,
): { score?: number; reason?: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { score?: unknown; reason?: unknown };
    const out: { score?: number; reason?: string } = {};
    if (typeof parsed.score === "number") {
      out.score = Math.max(0, Math.min(10, Math.round(parsed.score)));
    }
    if (typeof parsed.reason === "string") out.reason = parsed.reason.slice(0, 200);
    return out;
  } catch {
    return null;
  }
}

/** 对一次运行打分并落库（fire-and-forget，调用方负责 catch） */
export async function judgeRun(
  run: RunLogEntry,
  ctx: JudgeContext = {},
): Promise<void> {
  if (!judgeEnabled()) return;
  const { models, model } = await resolveModel("orchestrator");
  if (!model) {
    console.warn("[judge] 主模型不可用，跳过自动评分");
    return;
  }

  const transcript = [
    `用户请求：${(ctx.userText ?? "").slice(0, 2000) || "（空）"}`,
    `调用工具：${run.toolCalls
      ? Object.entries(run.toolCalls)
          .map(([n, c]) => `${n}×${c}`)
          .join(", ")
      : "（无工具调用）"}`,
    `token 用量：${run.usage?.totalTokens ?? 0}`,
    `Agent 回复：${(ctx.replyText ?? "").slice(0, 4000) || "（空）"}`,
  ].join("\n");

  let reply;
  try {
    reply = await models.completeSimple(model, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: transcript }],
          timestamp: Date.now(),
        },
      ],
    });
  } catch (err) {
    console.warn("[judge] 评分调用失败（已跳过）:", err);
    return;
  }

  const text = contentText(reply.content);
  const parsed = parseJudgeOutput(text);
  if (!parsed) {
    console.warn("[judge] 输出未包含可解析 JSON，跳过:", text.slice(0, 120));
    return;
  }
  const { score, reason } = parsed;

  addScore({
    sessionId: run.sessionId,
    kind: "rule",
    label: "llm_judge",
    score,
    comment: reason,
    runId: run.id,
  });
  console.log(`[judge] run=${run.id} score=${score ?? "?"} reason=${reason ?? ""}`);
}
