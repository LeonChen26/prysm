/**
 * 消息纯文本提取（messages.ts）验证脚本 —— 纯函数断言，无需 LLM。
 * 覆盖：字符串 content、text 块、toolCall 块、无 content 的消息、混合内容、空内容。
 * 运行：npx tsx tests/unit/test-messages.ts
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { messageText } from "../../lib/messages";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expect(name: string, actual: string, want: string) {
  if (actual !== want) {
    fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${name}`);
}

console.log("== 字符串 content ==");
expect(
  "普通字符串",
  messageText({ role: "assistant", content: "Hello World" } as AgentMessage),
  "Hello World",
);
expect(
  "空字符串",
  messageText({ role: "assistant", content: "" } as AgentMessage),
  "",
);
expect(
  "含换行与特殊字符",
  messageText({ role: "user", content: "line1\nline2\t#tag" } as AgentMessage),
  "line1\nline2\t#tag",
);

console.log("\n== content 为数组：text 块 ==");
expect(
  "单个 text 块",
  messageText({
    role: "assistant",
    content: [{ type: "text", text: "单块文本" }],
  } as AgentMessage),
  "单块文本",
);
expect(
  "多个 text 块用换行拼接",
  messageText({
    role: "assistant",
    content: [
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" },
    ],
  } as AgentMessage),
  "第一段\n第二段",
);
expect(
  "text 块含空串被 filter(Boolean) 过滤",
  messageText({
    role: "assistant",
    content: [
      { type: "text", text: "有内容" },
      { type: "text", text: "" },
      { type: "text", text: "尾段" },
    ],
  } as AgentMessage),
  "有内容\n尾段",
);

console.log("\n== content 为数组：toolCall 块 ==");
expect(
  "toolCall 格式化为 name(argsJSON)",
  messageText({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "tc1",
        name: "write_file",
        arguments: { path: "a.txt", content: "x" },
      },
    ],
  } as AgentMessage),
  'write_file({"path":"a.txt","content":"x"})',
);
expect(
  "toolCall arguments 为空对象",
  messageText({
    role: "assistant",
    content: [
      { type: "toolCall", id: "tc2", name: "list_dir", arguments: {} },
    ],
  } as AgentMessage),
  "list_dir({})",
);

console.log("\n== 混合 text 与 toolCall ==");
expect(
  "text + toolCall 混合按序拼接",
  messageText({
    role: "assistant",
    content: [
      { type: "text", text: "我将写入文件：" },
      {
        type: "toolCall",
        id: "tc3",
        name: "write_file",
        arguments: { path: "x.md" },
      },
      { type: "text", text: "完成。" },
    ],
  } as AgentMessage),
  '我将写入文件：\nwrite_file({"path":"x.md"})\n完成。',
);

console.log("\n== 无 content 的消息类型（bashExecution 等） ==");
expect(
  "完全无 content 字段 → 空串",
  messageText({ role: "tool", type: "bashExecution", command: "ls" } as unknown as AgentMessage),
  "",
);
expect(
  "content 为 null → 空串",
  messageText({ role: "assistant", content: null } as unknown as AgentMessage),
  "",
);
expect(
  "content 为 undefined → 空串",
  messageText({ role: "assistant", content: undefined } as unknown as AgentMessage),
  "",
);

console.log("\n== 未知块类型返回空串 ==");
expect(
  "未知类型块不贡献文本",
  messageText({
    role: "assistant",
    content: [
      { type: "image", url: "x.png" } as unknown as AgentMessage["content"] extends Array<infer U> ? U : never,
      { type: "text", text: "可见文本" },
      { type: "weirdBlock", data: 1 } as unknown as AgentMessage["content"] extends Array<infer U> ? U : never,
    ],
  } as AgentMessage),
  "可见文本",
);

console.log("\n✓ 消息纯文本提取验证通过");
