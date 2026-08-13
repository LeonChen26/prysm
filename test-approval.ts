/**
 * 工具审批流（approval.ts）验证脚本 —— 纯内存断言，无需 LLM。
 * 覆盖：同意/拒绝/未知 id、超时视为拒绝、事件订阅与取消。
 * 运行：npx tsx test-approval.ts
 */
import {
  requestApproval,
  resolveApproval,
  subscribeApprovals,
} from "./lib/approval";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("== 用户同意 ==");
  const p1 = requestApproval({ id: "a1", toolName: "write_file", args: { path: "x.txt" } });
  expectEq("resolveApproval 返回 true（请求存在）", resolveApproval("a1", true), true);
  expectEq("审批结果为同意", await p1, true);
  expectEq("重复 resolve 返回 false（已消费）", resolveApproval("a1", true), false);

  console.log("\n== 用户拒绝 ==");
  const p2 = requestApproval({ id: "a2", toolName: "delete_file", args: { path: "y.txt" } });
  resolveApproval("a2", false);
  expectEq("审批结果为拒绝", await p2, false);

  console.log("\n== 未知 id ==");
  expectEq("不存在的审批返回 false", resolveApproval("nope", true), false);

  console.log("\n== 超时前同意有效 ==");
  const p3 = requestApproval({ id: "a3", toolName: "write_file", args: {} }, 50);
  expectEq("超时前 resolve 返回 true", resolveApproval("a3", true), true);
  expectEq("审批结果为同意", await p3, true);

  console.log("\n== 超时自动拒绝（不 resolve） ==");
  const start = Date.now();
  const p4 = requestApproval({ id: "a4", toolName: "write_file", args: {} }, 60);
  const result4 = await p4;
  expectEq("超时结果 false", result4, false);
  if (Date.now() - start < 50) fail("超时应在等待后返回");
  expectEq("超时后 resolve 返回 false（已清理）", resolveApproval("a4", true), false);

  console.log("\n== 事件订阅与取消 ==");
  const received: string[] = [];
  const unsubscribe = subscribeApprovals((req) => received.push(req.id));
  requestApproval({ id: "b1", toolName: "append_file", args: {} });
  requestApproval({ id: "b2", toolName: "create_dir", args: {} });
  resolveApproval("b1", true);
  resolveApproval("b2", true);
  expectEq("订阅收到 2 个请求", received.join(","), "b1,b2");
  unsubscribe();
  requestApproval({ id: "b3", toolName: "write_file", args: {} });
  resolveApproval("b3", true);
  expectEq("取消订阅后不再收到", received.join(","), "b1,b2");

  console.log("\n✓ 工具审批流验证通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
