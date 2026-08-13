import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * 上下文压缩（阶段 2）
 * 在每次 LLM 调用前执行：当累计 token 超过阈值时，
 * 把最早的一批消息交给 LLM 生成摘要，替换为一条摘要消息。
 */

export const MAX_CONTEXT_TOKENS = Number(process.env.MAX_CONTEXT_TOKENS ?? 50000);
export const KEEP_RECENT_MESSAGES = Number(process.env.KEEP_RECENT_MESSAGES ?? 8);

/** 把 AgentMessage 的 content 提取为纯文本（用于估算与摘要） */
export function messageText(m: AgentMessage): string {
  // AgentMessage 联合包含 bashExecution 等无 content 的消息类型
  if (!("content" in m) || m.content == null) return "";
  const content = m.content;
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "toolCall") return `${b.name}(${JSON.stringify(b.arguments)})`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** 粗略 token 估算：CJK 约 1.2 字符/token，其他约 3.5 字符/token */
export function estimateTokens(m: AgentMessage): number {
  const s = messageText(m);
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk / 1.2 + other / 3.5);
}

export async function transformContext(
  messages: AgentMessage[],
  summarize: (oldMessages: AgentMessage[]) => Promise<string>,
): Promise<AgentMessage[]> {
  const total = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  if (total <= MAX_CONTEXT_TOKENS) return messages;

  const keep = Math.min(KEEP_RECENT_MESSAGES, messages.length - 1);
  const old = messages.slice(0, messages.length - keep);
  const recent = messages.slice(messages.length - keep);

  try {
    const summary = await summarize(old);
    // 手动构造消息缺少 AssistantMessage 的若干运行时字段，这里只保留对话所需结构
    const summaryMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `【对话摘要】以下是更早对话的压缩摘要，供后续参考：\n${summary}`,
        },
      ],
      timestamp: Date.now(),
    } as AgentMessage;
    return [summaryMessage, ...recent];
  } catch (err) {
    // 摘要失败时退化为直接丢弃旧消息，保证对话可继续
    console.error("[context] 摘要生成失败，直接丢弃旧消息:", err);
    return recent;
  }
}
