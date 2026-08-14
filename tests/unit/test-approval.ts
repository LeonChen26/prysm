/**
 * 工具审批流（approval.ts）验证脚本 —— 纯内存断言，无需 LLM。
 * 覆盖：同意/拒绝/未知 id、超时视为拒绝、事件订阅与取消。
 * 运行：npx tsx test-approval.ts
 */
import {
  listPendingApprovals,
  notifyApprovalNotice,
  requestApproval,
  resolveApproval,
  subscribeApprovalLifecycle,
  subscribeApprovals,
} from "../../lib/approval";

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

  console.log("\n== 生命周期事件（required/resolved/expired + 会话关联） ==");
  const events: string[] = [];
  const unsubLife = subscribeApprovalLifecycle((e) => {
    if (e.type === "required") events.push(`required:${e.state.id}:${e.state.sessionId}`);
    if (e.type === "resolved") events.push(`resolved:${e.state.id}`);
    if (e.type === "expired") events.push(`expired:${e.state.id}`);
  });
  const pc1 = requestApproval(
    { id: "c1", toolName: "write_file", args: { path: "x.txt" }, sessionId: "s1" },
    200,
  );
  resolveApproval("c1", true);
  await pc1;
  requestApproval(
    { id: "c2", toolName: "run_bash", args: { command: "ls" }, sessionId: "s2" },
    30,
  );
  await sleep(80);
  expectEq(
    "事件顺序（含会话 id）",
    events.join("|"),
    "required:c1:s1|resolved:c1|required:c2:s2|expired:c2",
  );
  unsubLife();

  console.log("\n== pending 快照（刷新页面恢复审批） ==");
  const pd = requestApproval({ id: "d1", toolName: "write_file", args: { path: "x" } }, 5000);
  const pend = listPendingApprovals();
  const d1 = pend.find((x) => x.id === "d1");
  if (!d1) fail("pending 应包含 d1");
  expectEq("pending 状态为 pending", d1.status, "pending");
  expectEq("pending 带过期时间", typeof d1.expiresAt, "number");
  resolveApproval("d1", true);
  await pd;
  expectEq(
    "决定后 pending 清空",
    listPendingApprovals().some((x) => x.id === "d1"),
    false,
  );

  console.log("\n== policy_notice 事件（denied_auto 策略拦截直接通知） ==");
  const noticeEvents: string[] = [];
  const unsubNotice = subscribeApprovalLifecycle((e) => {
    if (e.type === "notice") {
      noticeEvents.push(`${e.id ?? ""}:${e.toolName}:${e.action}:${e.reason}:${e.sessionId ?? ""}`);
    }
  });
  notifyApprovalNotice("p1", "run_bash", { command: "rm -rf /" }, "命令命中禁止规则", "s5");
  notifyApprovalNotice("p2", "write_file", { path: ".env" }, "路径被策略禁止");
  unsubNotice();
  expectEq(
    "notice 事件顺序与字段（含会话 id）",
    noticeEvents.join("|"),
    "p1:run_bash:denied_auto:命令命中禁止规则:s5|p2:write_file:denied_auto:路径被策略禁止:",
  );

  console.log("\n== risk/riskReason 字段透传进生命周期事件 ==");
  const riskEvents: string[] = [];
  const unsubRisk = subscribeApprovalLifecycle((e) => {
    if (e.type === "required") {
      riskEvents.push(`${e.state.id}:risk=${e.state.risk ?? "none"}:reason=${e.state.riskReason ?? "none"}`);
    }
    if (e.type === "resolved") {
      riskEvents.push(`resolved:${e.state.id}:risk=${e.state.risk ?? "none"}`);
    }
  });
  const pr = requestApproval(
    { id: "r1", toolName: "delete_file", args: { path: ".env" }, risk: "high", riskReason: "命中受保护路径（环境变量文件）" },
    5000,
  );
  resolveApproval("r1", true);
  await pr;
  unsubRisk();
  expectEq(
    "risk 与 riskReason 随 required/resolved 事件透传",
    riskEvents.join("|"),
    "r1:risk=high:reason=命中受保护路径（环境变量文件）|resolved:r1:risk=high",
  );

  console.log("\n✓ 工具审批流验证通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
