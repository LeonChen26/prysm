import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * 把 AgentMessage 的 content 提取为纯文本（供摘要/记忆检索/搜索等复用）。
 * toolCall 块格式化为调用描述，bashExecution 等无 content 的消息返回空串。
 */
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
