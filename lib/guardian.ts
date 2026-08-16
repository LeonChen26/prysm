/**
 * LLM Guardian —— 自动审批（auto 模式）的决策方
 *
 * 复用主模型通道（resolveModel("orchestrator") + completeSimple），对敏感工具调用返回
 * { allow, reason }。Trae 行为：LLM Guardian 拒绝后回退用户确认；模型不可用/解析失败时
 * 静默回退用户审批（调用方处理），不阻塞工具执行。
 *
 * 与 lib/judge.ts（事后评分）不同：guardian 在工具执行前同步决策，成本受控（短提示词）。
 */

import { contentText } from "@earendil-works/pi-ai";
import { resolveModel } from "./model-router";
import type { RiskLevel } from "./risk";

export interface GuardianInput {
  toolName: string;
  args: unknown;
  risk?: RiskLevel;
  riskReason?: string;
  /** 命中的规则 key（commandRules / mcpRules），提示决策方已有显式配置 */
  ruleKey?: string;
  /** 目标相对路径（文件类工具） */
  path?: string;
}

export interface GuardianDecision {
  allow: boolean;
  reason?: string;
}

const SYSTEM_PROMPT = `你是权限审批官（LLM Guardian）。系统将提交一个智能体想要执行的操作，请判断是否允许执行。
输出严格 JSON：{"allow":true或false,"reason":"简短中文理由（60字内）"}
判断原则：危险命令（递归删除、管道执行远程脚本、格式化磁盘、提权等）一律拒绝；删除重要/不可恢复文件需谨慎；常规读写、构建、测试、git 提交等日常操作允许。`;

/** 参数摘要：截断为短文本，控制成本与提示词长度 */
function summarizeArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > 800 ? s.slice(0, 800) + "…" : s;
  } catch {
    return String(args ?? {});
  }
}

/** 解析 Guardian 返回文本，期望包含 JSON：{"allow":bool,"reason":"..."}；无法解析返回 null */
export function parseGuardianOutput(text: string): GuardianDecision | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { allow?: unknown; reason?: unknown };
    if (typeof parsed.allow !== "boolean") return null;
    return {
      allow: parsed.allow,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 对一次敏感工具调用做 LLM 审批决策。
 * 返回 undefined 表示无法决策（模型不可用 / 解析失败），调用方应回退用户审批。
 */
export async function guardianAssess(
  input: GuardianInput,
): Promise<GuardianDecision | undefined> {
  let models: Awaited<ReturnType<typeof resolveModel>>["models"];
  let model: Awaited<ReturnType<typeof resolveModel>>["model"];
  try {
    const r = await resolveModel("orchestrator");
    models = r.models;
    model = r.model;
    if (!model) {
      console.warn("[guardian] 主模型不可用，回退用户审批");
      return undefined;
    }
  } catch (err) {
    console.warn("[guardian] 模型解析失败，回退用户审批:", err);
    return undefined;
  }

  const lines = [
    `工具：${input.toolName}`,
    `参数：${summarizeArgs(input.args)}`,
    input.path ? `路径：${input.path}` : undefined,
    input.risk ? `风险等级：${input.risk}` : undefined,
    input.riskReason ? `风险原因：${input.riskReason}` : undefined,
    input.ruleKey ? `命中规则：${input.ruleKey}` : undefined,
  ].filter((l): l is string => !!l);
  const transcript = lines.join("\n");

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
    console.warn("[guardian] 决策调用失败，回退用户审批:", err);
    return undefined;
  }

  const text = contentText(reply.content);
  const parsed = parseGuardianOutput(text);
  if (!parsed) {
    console.warn("[guardian] 输出未包含可解析 JSON，回退用户审批:", text.slice(0, 120));
    return undefined;
  }
  console.log(
    `[guardian] ${input.toolName} → ${parsed.allow ? "放行" : "拒绝"} ${parsed.reason ?? ""}`,
  );
  return parsed;
}
