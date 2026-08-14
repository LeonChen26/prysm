/**
 * 子 agent 编排（lib/subagent.ts）验证脚本。
 * 覆盖：派生/记录、父会话隔离、并发上限、超时、失败、取消。
 * 不触发真实模型调用（runner 由测试注入模拟）。
 * 运行：npx tsx tests/unit/test-subagent.ts
 */
import {
  abortSubagent,
  getSubagent,
  keyOf,
  listSubagents,
  resetSubagentPool,
  spawnSubagent,
  type SubagentSpec,
} from "../../lib/subagent";

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

function expectTrue(name: string, actual: unknown) {
  if (!actual) fail(`${name}: 期望为真，实际 ${JSON.stringify(actual)}`);
  console.log(`  ✓ ${name}`);
}

const spec = (over: Partial<SubagentSpec> = {}): SubagentSpec => ({
  parentSessionId: "parent-1",
  task: "调查某模块的接口",
  capability: "readonly",
  surface: "work",
  ...over,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("== 派生与记录：done 状态、key/id 生成 ==");
{
  resetSubagentPool();
  const rec = await spawnSubagent(spec(), async (s) => {
    expectTrue("runner 收到填充的 key", !!s.key);
    expectTrue("runner 收到填充的 subagentId", !!s.subagentId);
    return "调查完成：接口在 lib/model-router.ts";
  });
  expectTrue("key 为 parentSessionId:subagentId", rec.key === keyOf("parent-1", rec.subagentId));
  expectEq("状态 done", rec.status, "done");
  expectEq("摘要保留", rec.summary, "调查完成：接口在 lib/model-router.ts");
  expectEq("getSubagent 命中", getSubagent(rec.key)?.status, "done");
}

console.log("\n== 父会话隔离：listSubagents 按 parentSessionId 过滤 ==");
{
  resetSubagentPool();
  await spawnSubagent(spec({ parentSessionId: "p-a" }), async () => "a");
  await spawnSubagent(spec({ parentSessionId: "p-a" }), async () => "a2");
  await spawnSubagent(spec({ parentSessionId: "p-b" }), async () => "b");
  expectEq("p-a 有 2 条", listSubagents("p-a").length, 2);
  expectEq("p-b 有 1 条", listSubagents("p-b").length, 1);
  expectEq("全部 3 条", listSubagents().length, 3);
}

console.log("\n== 并发上限：超限返回 error 且不阻塞 ==");
{
  resetSubagentPool();
  const gate = (() => {
    let open = false;
    return {
      open: () => (open = true),
      enter: async () => {
        while (!open) await sleep(1);
      },
      isOpen: () => open,
    };
  })();
  // 占用 3 个槽位（MAX_CONCURRENCY=3），全部挂起
  const inFlight = Array.from({ length: 3 }, () =>
    spawnSubagent(spec(), async () => {
      await gate.enter();
      return "ok";
    }),
  );
  await sleep(50); // 确保 3 个已进入 running 并占用槽位
  const overflow = await spawnSubagent(spec({ task: "overflow" }), async () => "never");
  expectEq("超限返回 error", overflow.status, "error");
  expectTrue("超限错误提示并发上限", (overflow.error ?? "").includes("并发数已达上限"));
  expectEq("溢出未计入池", getSubagent(overflow.key), undefined);
  // 释放槽位后新任务可运行
  gate.open();
  const results = await Promise.all(inFlight);
  expectEq("三任务均 done", results.map((r) => r.status), ["done", "done", "done"]);
}

console.log("\n== 超时：标记 timed_out ==");
{
  resetSubagentPool();
  const rec = await spawnSubagent(
    spec({ timeoutMs: 30 }),
    async () => {
      await sleep(200);
      return "太慢";
    },
  );
  expectEq("状态 timed_out", rec.status, "timed_out");
  expectTrue("超时摘要", (rec.summary ?? "").includes("超时"));
}

console.log("\n== 失败：记录 error ==");
{
  resetSubagentPool();
  const rec = await spawnSubagent(
    spec(),
    async () => {
      throw new Error("模型不可用");
    },
  );
  expectEq("状态 error", rec.status, "error");
  expectEq("错误信息保留", rec.error, "模型不可用");
}

console.log("\n== 取消：abort 后保持 cancelled 不被覆盖 ==");
{
  resetSubagentPool();
  const gate = (() => {
    let open = false;
    return {
      open: () => (open = true),
      enter: async () => {
        while (!open) await sleep(1);
      },
    };
  })();
  const done = spawnSubagent(spec(), async () => {
    await gate.enter();
    return "完成";
  });
  await sleep(50);
  const running = listSubagents("parent-1").find((r) => r.status === "running");
  expectTrue("有 running 子 agent", running);
  expectTrue("abort 成功", abortSubagent(running!.key));
  expectEq("abort 后状态 cancelled", running!.status, "cancelled");
  expectTrue("重复 abort 幂等返回 false", abortSubagent(running!.key) === false);
  gate.open();
  await done;
  expectEq("runner 返回后仍保持 cancelled", running!.status, "cancelled");
}

resetSubagentPool();
console.log("\n✓ 子 agent 编排验证通过");
process.exit(0);