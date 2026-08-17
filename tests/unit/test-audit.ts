/**
 * 审批历史审计验证脚本 —— 无需真实 LLM。
 * 验证：
 * 1. 同意 / 拒绝 / 超时三种决定都写入审计历史
 * 2. 历史查询（新在前）与清空
 */

import { requestApproval, resolveApproval } from "../../lib/approval";
import { clearApprovals, countApprovals, listApprovals, redactArgs } from "../../lib/audit";

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

async function main() {
  clearApprovals();
  console.log("== 审批历史审计 ==");

  // 同意
  const p1 = requestApproval(
    { id: "a1", toolName: "write_file", args: { path: "x.txt" } },
    5000,
  );
  resolveApproval("a1", true);
  const r1 = await p1;
  console.log("同意路径结果:", r1);

  // 拒绝
  const p2 = requestApproval(
    { id: "a2", toolName: "delete_file", args: { path: "x.txt" } },
    5000,
  );
  resolveApproval("a2", false);
  const r2 = await p2;
  console.log("拒绝路径结果:", r2);

  // 超时（50ms 自动拒绝）
  const p3 = requestApproval(
    { id: "a3", toolName: "run_bash", args: { command: "ls" } },
    50,
  );
  const r3 = await p3;
  console.log("超时路径结果:", r3);

  // 带会话关联与风险的审批记录
  const p4 = requestApproval(
    { id: "a4", toolName: "write_file", args: { path: "x.txt" }, sessionId: "s1", risk: "high" },
    5000,
  );
  resolveApproval("a4", false);
  const r4 = await p4;
  console.log("带会话审批结果:", r4);

  const list = listApprovals(10);
  const total = countApprovals();
  const acts = list.map((a) => `${a.toolName}:${a.action}`);
  console.log("历史:", acts.join(", "));

  // 审批策略门（Phase 2）：asked 审计配对 —— 每次 requestApproval 先写 asked 再写 decided
  if (total < 8) fail(`应有至少 8 条历史（4 组 asked→decided 配对），实际 ${total}`);
  if (!acts.includes("write_file:approved")) fail("缺少 approved 记录");
  if (!acts.includes("delete_file:denied")) fail("缺少 denied 记录");
  if (!acts.includes("run_bash:timeout")) fail("缺少 timeout 记录");
  if (!acts.includes("write_file:asked")) fail("缺少 asked 记录（审批发起审计配对）");
  // 会话关联与风险等级被记录（可回溯）
  const w4 = list.find((a) => a.id > 0 && a.sessionId === "s1");
  if (!w4) fail("应记录 sessionId");
  console.log(`  ✓ 会话关联: ${w4.sessionId} / 风险: ${w4.risk}`);
  if (w4.risk !== "high") fail("risk 应记录为 high");
  // 参数被记录（可回溯）
  const first = list[0];
  if (typeof first.args !== "string") fail("args 应为字符串");

  console.log("\n== 敏感信息脱敏 ==");
  const red = redactArgs({
    token: "sk-abcdefghijklmnop",
    apiKey: "my-secret-key",
    command: "echo sk-live-1234567890 > /tmp/x",
    path: "x.txt",
    nested: { password: "p@ss" },
  });
  console.log("脱敏结果:", red);
  if (red.includes("sk-abcdefghijklmnop")) fail("token 值未脱敏");
  if (red.includes("my-secret-key")) fail("apiKey 值未脱敏");
  if (red.includes("sk-live-1234567890")) fail("命令内嵌密钥串未脱敏");
  if (red.includes("p@ss")) fail("嵌套 password 未脱敏");
  if (!red.includes("[redacted]")) fail("应包含 [redacted] 占位");

  console.log("\n== 审计筛选：按 tool 名称 ==");
  // 先构造已知数据（清空后写入）
  clearApprovals();
  const pA1 = requestApproval({ id: "fA1", toolName: "write_file", args: { path: "a.txt" } }, 5000);
  resolveApproval("fA1", true);
  await pA1;
  const pA2 = requestApproval({ id: "fA2", toolName: "write_file", args: { path: "b.txt" } }, 5000);
  resolveApproval("fA2", false);
  await pA2;
  const pA3 = requestApproval({ id: "fA3", toolName: "run_bash", args: { command: "ls" } }, 5000);
  resolveApproval("fA3", true);
  await pA3;
  const onlyWrite = listApprovals(10, { tool: "write_file" });
  const allTools = listApprovals(10);
  console.log(`  全量 ${allTools.length} 条，其中 write_file ${onlyWrite.length} 条`);
  // Phase 2：每次 requestApproval 产生 asked + decided 两条，write_file 两次调用 → 4 条
  if (onlyWrite.length !== 4) fail(`按 tool 筛选 write_file 应得 4 条（2 组 asked→decided），实际 ${onlyWrite.length}`);
  if (!onlyWrite.every((r) => r.toolName === "write_file")) fail("write_file 筛选结果不纯");
  expectEq("按 tool 计数 countApprovals", countApprovals({ tool: "write_file" }), 4);
  expectEq("按 tool=run_bash 计数", countApprovals({ tool: "run_bash" }), 2);
  expectEq("全量计数（无筛选）", countApprovals(), 6);

  console.log("\n== 审计筛选：按 action 动作 ==");
  const deniedOnly = listApprovals(10, { action: "denied" });
  const approvedOnly = listApprovals(10, { action: "approved" });
  expectEq("按 action=denied 条数", deniedOnly.length, 1);
  expectEq("按 action=approved 条数", approvedOnly.length, 2);
  expectEq("按 action=timeout 条数（当前记录无）", countApprovals({ action: "timeout" }), 0);

  console.log("\n== 审计筛选：tool + action 联合 ==");
  const writeApproved = listApprovals(10, { tool: "write_file", action: "approved" });
  expectEq("write_file + approved 联合筛选条数", writeApproved.length, 1);
  expectEq("联合计数", countApprovals({ tool: "write_file", action: "approved" }), 1);

  console.log("\n== 审计分页：limit 与 offset ==");
  const allAsc = listApprovals(10).reverse(); // 老在前
  // 写入顺序：fA1(asked→approved) → fA2(asked→denied) → fA3(asked→approved)
  // listApprovals 新在前：fA3 approved, fA3 asked, fA2 denied, fA2 asked, fA1 approved, fA1 asked
  const page1 = listApprovals(2, {}); // 前 2 条（最新两条）
  const page2 = listApprovals(2, { offset: 2 }); // 跳过 2 取后面
  expectEq("page1 size=limit=2", page1.length, 2);
  expectEq("page1[0] 最新 = fA3 approved", page1[0].toolName + ":" + page1[0].action, "run_bash:approved");
  expectEq("page1[1] = fA3 asked（配对的发起记录）", page1[1].toolName + ":" + page1[1].action, "run_bash:asked");
  expectEq("page2 size=2（offset=2 后剩 4 条取 2）", page2.length, 2);
  expectEq("page2[0] = fA2 denied", page2[0].toolName + ":" + page2[0].action, "write_file:denied");
  expectEq("page2[1] = fA2 asked", page2[1].toolName + ":" + page2[1].action, "write_file:asked");
  expectEq("offset 超出返回空数组", listApprovals(10, { offset: 999 }).length, 0);

  const removed = clearApprovals();
  console.log("清空:", removed, "| 剩余:", countApprovals());
  if (countApprovals() !== 0) fail("清空后应为 0");

  console.log("\n✓ 审批历史审计验证通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
