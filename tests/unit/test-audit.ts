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

  if (total < 4) fail(`应有至少 4 条历史，实际 ${total}`);
  if (!acts.includes("write_file:approved")) fail("缺少 approved 记录");
  if (!acts.includes("delete_file:denied")) fail("缺少 denied 记录");
  if (!acts.includes("run_bash:timeout")) fail("缺少 timeout 记录");
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

  const removed = clearApprovals();
  console.log("清空:", removed, "| 剩余:", countApprovals());
  if (countApprovals() !== 0) fail("清空后应为 0");

  console.log("\n✓ 审批历史审计验证通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
