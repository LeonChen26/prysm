/**
 * 上下文分析（lib/context-analysis.ts）验证脚本 —— 纯函数断言。
 * 覆盖：estimateTokens（字符级 token 估算）、usageOf（提取 usage）、addUsage（累加 usage）。
 * 运行：npx tsx tests/unit/test-context-analysis.ts
 */
const { estimateTokens, usageOf, addUsage } = await import(
  "../../lib/context-analysis"
);

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expectEq(name: string, actual: unknown, want: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${name}`);
}

function expectTrue(name: string, cond: boolean) {
  if (!cond) fail(name);
  console.log(`  ✓ ${name}`);
}

function expectClose(name: string, actual: number, want: number, eps = 1e-9) {
  if (Math.abs(actual - want) > eps) {
    fail(`${name}: 期望 ${want}，实际 ${actual}`);
  }
  console.log(`  ✓ ${name}`);
}

console.log("== estimateTokens 估算 ==");
{
  expectEq("空字符串 → 0", estimateTokens(""), 0);
  expectEq("CJK: 你好世界 → 4", estimateTokens("你好世界"), 4);
  expectEq("ASCII: hello → 2 (ceil(5/4))", estimateTokens("hello"), 2);
  expectEq("混合: 你好hello → ceil(2+5/4)=4", estimateTokens("你好hello"), 4);
  expectEq("非空文本最小 1 token", estimateTokens("a"), 1);
  expectEq("纯标点 CJK", estimateTokens("，。！？"), 4);
  expectEq("长 ASCII 文本", estimateTokens("a".repeat(400)), 100);
  expectEq("长 CJK 文本", estimateTokens("中".repeat(100)), 100);
}

console.log("\n== addUsage 累加 ==");
{
  const u = {
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 5,
    totalTokens: 150,
    cost: { input: 0.25, output: 0.5, cacheRead: 0.01, cacheWrite: 0.005, total: 0.765 },
  };

  expectEq("null + usage = usage 副本", addUsage(null, u), u);
  expectTrue("null + usage 返回独立副本", addUsage(null, u) !== u);

  const u2 = {
    input: 200,
    output: 80,
    cacheRead: 20,
    cacheWrite: 10,
    totalTokens: 280,
    cost: { input: 0.5, output: 0.25, cacheRead: 0.02, cacheWrite: 0.01, total: 0.78 },
  };

  const summed = addUsage(u, u2);
  expectEq("input 求和", summed.input, 300);
  expectEq("output 求和", summed.output, 130);
  expectEq("cacheRead 求和", summed.cacheRead, 30);
  expectEq("cacheWrite 求和", summed.cacheWrite, 15);
  expectEq("totalTokens 求和", summed.totalTokens, 430);
  expectClose("cost.input 求和", summed.cost.input, 0.75);
  expectClose("cost.output 求和", summed.cost.output, 0.75);
  expectClose("cost.cacheRead 求和", summed.cost.cacheRead, 0.03);
  expectClose("cost.cacheWrite 求和", summed.cost.cacheWrite, 0.015);
  expectClose("cost.total 求和", summed.cost.total, 1.545);
}

console.log("\n== usageOf 提取 ==");
{
  const usage = {
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 5,
    totalTokens: 150,
    cost: { input: 0.25, output: 0.5, cacheRead: 0.01, cacheWrite: 0.005, total: 0.765 },
  };

  expectEq(
    "非 assistant 消息 → null",
    usageOf({ role: "user", content: "hi", timestamp: 1 } as never),
    null,
  );
  expectEq(
    "assistant 无 usage → null",
    usageOf({ role: "assistant", content: "ok", timestamp: 1 } as never),
    null,
  );
  expectEq(
    "assistant 有 usage → 返回 usage",
    usageOf({ role: "assistant", content: "ok", timestamp: 1, usage } as never),
    usage,
  );
  expectEq(
    "toolResult 消息 → null",
    usageOf({ role: "toolResult", content: "result", timestamp: 1 } as never),
    null,
  );
  expectEq(
    "assistant usage 缺失 input 字段 → null",
    usageOf({
      role: "assistant",
      content: "ok",
      timestamp: 1,
      usage: { output: 50 } as never,
    } as never),
    null,
  );
}

console.log("\n✓ 上下文分析验证通过");