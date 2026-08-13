/**
 * 上下文压缩（context.ts）验证脚本 —— 纯函数断言 + 注入假 summarize，无需 LLM。
 * 覆盖：messageText 提取、estimateTokens 估算、transformContext 触发/保留/降级。
 * 运行：npx tsx test-context.ts
 *
 * 注意：MAX_CONTEXT_TOKENS / KEEP_RECENT_MESSAGES 是模块加载时读 env 的常量，
 * 因此必须先设置 env 再动态 import。
 */
process.env.MAX_CONTEXT_TOKENS = "100";
process.env.KEEP_RECENT_MESSAGES = "2";

const { estimateTokens, transformContext } = await import("./lib/context");
const { messageText } = await import("./lib/messages");

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expectEq(name: string, actual: unknown, want: unknown) {
  if (actual !== want) {
    fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${name} = ${JSON.stringify(actual)}`);
}

console.log("== messageText 提取 ==");
expectEq("字符串 content", messageText({ role: "user", content: "你好", timestamp: 1 } as never), "你好");
expectEq(
  "block 数组（text + toolCall + 未知类型）",
  messageText({
    role: "assistant",
    content: [
      { type: "text", text: "正文" },
      { type: "toolCall", name: "read_file", arguments: { path: "a.txt" } },
      { type: "image", url: "x" },
    ],
    timestamp: 1,
  } as never),
  '正文\nread_file({"path":"a.txt"})',
);
expectEq("无 content 字段（如 bashExecution）", messageText({ role: "bashExecution" } as never), "");
expectEq("content 为 null", messageText({ role: "user", content: null, timestamp: 1 } as never), "");

console.log("\n== estimateTokens 估算 ==");
const pureCjk = "中".repeat(120); // CJK 约 1.2 字符/token → 100
expectEq("纯中文 120 字", estimateTokens({ role: "user", content: pureCjk, timestamp: 1 } as never), 100);
const pureOther = "a".repeat(350); // 其他约 3.5 字符/token → 100
expectEq("纯英文 350 字符", estimateTokens({ role: "user", content: pureOther, timestamp: 1 } as never), 100);
expectEq("空消息", estimateTokens({ role: "user", content: "", timestamp: 1 } as never), 0);

console.log("\n== transformContext ==");
// 构造 5 条消息，每条约 200 token（纯英文 700 字符），总量远超阈值 100
function msg(i: number) {
  return { role: "user" as const, content: `msg${i} ` + "x".repeat(700), timestamp: i };
}
const messages = [msg(1), msg(2), msg(3), msg(4), msg(5)];

// 1) 触发压缩：KEEP_RECENT_MESSAGES=2 → 前 3 条被摘要，后 2 条保留
let summarizedCount = 0;
const compressed = await transformContext(messages, async (old) => {
  summarizedCount = old.length;
  return "这是一段测试摘要";
});
expectEq("触发压缩后 summarize 收到的旧消息数", summarizedCount, 3);
expectEq("压缩后消息条数（1 摘要 + 2 保留）", compressed.length, 3);
expectEq("首条为摘要消息", compressed[0].role, "assistant");
if (!("content" in compressed[0]) || typeof compressed[0].content === "string") {
  fail("摘要消息 content 应为 block 数组");
}
if (!("content" in compressed[0]) || Array.isArray(compressed[0].content)) {
  const text = (compressed[0].content as { type: string; text: string }[])[0]?.text ?? "";
  if (!text.includes("测试摘要")) fail(`摘要内容应包含测试摘要，实际 "${text}"`);
}
expectEq("最近消息保留且顺序不变", (compressed[1] as never as { content: string }).content, msg(4).content);
expectEq("最后一条保留", (compressed[2] as never as { content: string }).content, msg(5).content);

// 2) 未超阈值：原样返回（小消息约 2 tokens < 阈值 100）
const small = [{ role: "user" as const, content: "短消息", timestamp: 1 }];
const unchanged = await transformContext(small, async () => "不应被调用");
expectEq("未超阈值返回原数组", unchanged, small);

// 3) 摘要失败降级：丢弃旧消息，保留最近 N 条
const degraded = await transformContext(messages, async () => {
  throw new Error("模拟摘要失败");
});
expectEq("摘要失败降级保留最近条数", degraded.length, 2);
expectEq("降级后保留最近消息", (degraded[0] as never as { content: string }).content, msg(4).content);

console.log("\n✓ 上下文压缩验证通过");
