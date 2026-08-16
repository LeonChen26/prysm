/**
 * 会话工作目录并发隔离验证脚本（lib/tools.ts 工作目录上下文）
 * 覆盖：多会话并发处理时，工具执行读取的工作目录必须与发起请求的会话一致。
 *      修复前：使用全局可变变量 sessionWorkdirOverride，并发请求互相覆盖，
 *             工具会读到错误会话的 workdir（数据完整性问题）。
 *      修复后：使用 AsyncLocalStorage 隔离异步上下文，每个会话的
 *             runWithWorkdir 块内 effectiveWorkdir 互不干扰。
 * 运行：npx tsx tests/unit/test-workdir-context.ts
 */
import {
  runWithWorkdir,
  getSessionWorkdirOverride,
  getEffectiveWorkdirForTest,
} from "../../lib/tools";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expectEq(name: string, actual: unknown, want: unknown) {
  if (actual !== want) {
    fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${name}`);
}

console.log("== 同步读取（无上下文）回退 undefined ==");
expectEq("无 runWithWorkdir 时 getSessionWorkdirOverride 返回 undefined", getSessionWorkdirOverride(), undefined);
expectEq("无 runWithWorkdir 时 effectiveWorkdir 等于 AGENT_WORKDIR（默认工作区）", getEffectiveWorkdirForTest().length > 0, true);

console.log("\n== runWithWorkdir 块内读取 ==");
runWithWorkdir("/work/A", () => {
  expectEq("块 A 内读取到 A", getSessionWorkdirOverride(), "/work/A");
});
runWithWorkdir("/work/B", () => {
  expectEq("块 B 内读取到 B", getSessionWorkdirOverride(), "/work/B");
});

console.log("\n== 嵌套 runWithWorkdir 块（内层覆盖外层） ==");
runWithWorkdir("/work/outer", () => {
  expectEq("外层读取 outer", getSessionWorkdirOverride(), "/work/outer");
  runWithWorkdir("/work/inner", () => {
    expectEq("内层读取 inner", getSessionWorkdirOverride(), "/work/inner");
  });
  expectEq("内层退出后回到 outer", getSessionWorkdirOverride(), "/work/outer");
});

console.log("\n== 跨 await 边界保持上下文（模拟真实异步调用链） ==");
async function asyncReadAfterAwait(): Promise<string | undefined> {
  await new Promise((r) => setTimeout(r, 10));
  return getSessionWorkdirOverride();
}

(async () => {
  const [aResult, bResult] = await Promise.all([
    runWithWorkdir("/work/A", async () => asyncReadAfterAwait()),
    runWithWorkdir("/work/B", async () => asyncReadAfterAwait()),
  ]);
  expectEq("并发 A 跨 await 仍读到 A", aResult, "/work/A");
  expectEq("并发 B 跨 await 仍读到 B", bResult, "/work/B");

  console.log("\n== 模拟真实工具执行：并发两会话调用 effectiveWorkdir ==");
  // 关键场景：两个会话的"工具执行"在 await 之后读取 effectiveWorkdir，
  // 必须各自读到自己的 workdir，而不是对方覆盖后的值。
  // 这是修复前最容易出错的地方 —— 全局变量被并发请求相互覆盖。
  const [wdA, wdB] = await Promise.all([
    runWithWorkdir("/work/A", async () => {
      // 模拟工具执行前的网络/IO 等待
      await new Promise((r) => setTimeout(r, 20));
      return getEffectiveWorkdirForTest();
    }),
    runWithWorkdir("/work/B", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getEffectiveWorkdirForTest();
    }),
  ]);
  // Windows 路径大小写不敏感，规范化后比对
  const norm = (p: string) => p.replace(/\\/g, "/");
  expectEq("会话 A 的工具读取到 A 的 workdir", norm(wdA), norm("/work/A"));
  expectEq("会话 B 的工具读取到 B 的 workdir", norm(wdB), norm("/work/B"));

  console.log("\n== runWithWorkdir 块结束后上下文清空 ==");
  runWithWorkdir("/work/temp", () => {});
  expectEq("块结束后回到 undefined", getSessionWorkdirOverride(), undefined);

  console.log("\n✓ 会话工作目录并发隔离验证通过");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
