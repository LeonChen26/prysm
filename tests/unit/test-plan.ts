/**
 * Plan mode（lib/plan.ts）验证脚本。
 * 覆盖：提出计划/阻塞、确认（批准/拒绝）、取消、超时、恢复未决、事件通知、持久化。
 * 运行：npx tsx tests/unit/test-plan.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configure, resetConfig } from "../../lib/config";
import {
  cancelPlan,
  clearPlans,
  decidePlan,
  getPlan,
  listPendingPlans,
  reloadPlans,
  resetPlans,
  proposePlan,
  subscribePlanLifecycle,
  type Plan,
} from "../../lib/plan";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = path.join(os.tmpdir(), "prysm-plan");

function resetAll() {
  resetConfig();
  resetPlans();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* SQLite 句柄占用时跳过（Windows） */
  }
  fs.mkdirSync(dir, { recursive: true });
  configure({ baseDir: dir, env: {} });
}

console.log("== 提出计划：阻塞待确认，事件 proposed ==");
{
  resetAll();
  const events: string[] = [];
  const unsub = subscribePlanLifecycle((e) => events.push(e.type));
  const p = proposePlan({
    sessionId: "plan-s1",
    surface: "coding",
    summary: "添加购物车接口",
    steps: [
      { title: "写接口", tool: "write_file", expected: "route 文件生成" },
      { title: "跑测试", tool: "run_command", expected: "测试通过" },
    ],
  });
  await sleep(20);
  expectEq("发出 proposed 事件", events, ["proposed"]);
  const pending = listPendingPlans("plan-s1");
  expectEq("未决计划 1 条", pending.length, 1);
  expectEq("surface=coding", pending[0].surface, "coding");
  expectEq("步骤含 tool/expected", pending[0].steps[0].tool, "write_file");
  expectEq("步骤状态 pending", pending[0].steps[0].status, "pending");
  // 提交后 promise 未决
  let settled = false;
  p.then(() => (settled = true));
  await sleep(20);
  expectEq("未决定前不 resolve", settled, false);
  unsub();
  resetPlans();
}

console.log("\n== 批准：resolve(true)，事件 decided ==");
{
  resetAll();
  const events: { type: string; approve?: boolean }[] = [];
  const unsub = subscribePlanLifecycle((e) => {
    if (e.type === "decided") events.push({ type: e.type, approve: e.plan.status === "approved" });
    else events.push({ type: e.type });
  });
  const p = proposePlan({
    sessionId: "plan-s2",
    surface: "work",
    summary: "整理周报",
    steps: [{ title: "汇总数据", tool: "mcp__sheets__read", expected: "拿到数据" }],
  });
  const id = (await listPendingPlans("plan-s2"))[0].id;
  expectTrue("decidePlan 成功", decidePlan(id, true));
  const { approved, plan } = await p;
  expectEq("批准后 Promise 为 true", approved, true);
  expectEq("计划状态 approved", plan.status, "approved");
  expectEq("decidedAt 已记录", typeof plan.decidedAt, "number");
  expectEq("事件流", events, [{ type: "proposed" }, { type: "decided", approve: true }]);
  expectEq("未决列表已清空", listPendingPlans("plan-s2"), []);
  expectEq("getPlan 可查", getPlan(id)?.status, "approved");
  unsub();
  resetPlans();
}

console.log("\n== 拒绝：resolve(false) ==");
{
  resetAll();
  const p = proposePlan({
    sessionId: "plan-s3",
    surface: "coding",
    steps: [{ title: "改配置" }],
  });
  const id = (await listPendingPlans("plan-s3"))[0].id;
  decidePlan(id, false);
  const { approved, plan } = await p;
  expectEq("拒绝后 Promise 为 false", approved, false);
  expectEq("计划状态 rejected", plan.status, "rejected");
}

console.log("\n== 取消：resolve(false)，事件 cancelled ==");
{
  resetAll();
  const events: string[] = [];
  const unsub = subscribePlanLifecycle((e) => events.push(e.type));
  const p = proposePlan({
    sessionId: "plan-s4",
    surface: "coding",
    steps: [{ title: "执行迁移" }],
  });
  const id = (await listPendingPlans("plan-s4"))[0].id;
  expectTrue("cancelPlan 成功", cancelPlan(id, "先不开工"));
  const { approved, plan } = await p;
  expectEq("取消后 Promise 为 false", approved, false);
  expectEq("计划状态 cancelled", plan.status, "cancelled");
  expectEq("取消原因保留", plan.reason, "先不开工");
  expectEq("事件流含 cancelled", events, ["proposed", "cancelled"]);
  unsub();
}

console.log("\n== 超时：自动拒绝 ==");
{
  resetAll();
  const p = proposePlan({
    sessionId: "plan-s5",
    surface: "coding",
    steps: [{ title: "慢任务" }],
    timeoutMs: 30,
  });
  const { approved, plan } = await p;
  expectEq("超时后 Promise 为 false", approved, false);
  expectEq("计划状态 rejected", plan.status, "rejected");
  expectTrue("超时原因", (plan.reason ?? "").includes("超时"));
}

console.log("\n== 重复决定 / 空步骤 ==");
{
  resetAll();
  const p = proposePlan({
    sessionId: "plan-s6",
    surface: "coding",
    steps: [{ title: "x" }],
  });
  const id = (await listPendingPlans("plan-s6"))[0].id;
  decidePlan(id, true);
  expectEq("重复 decide 返回 false", decidePlan(id, true), false);
  expectEq("重复 cancel 返回 false", cancelPlan(id), false);
  await p;
}

console.log("\n== 持久化：计划写入 plans.db ==");
{
  resetAll();
  proposePlan({
    sessionId: "plan-s7",
    surface: "work",
    steps: [{ title: "持久化步骤" }],
  });
  const id = (await listPendingPlans("plan-s7"))[0].id;
  await sleep(20);
  // 模拟重启：reloadPlans 清空内存并重新加载数据库，应恢复未决计划
  // （reload 后原 proposePlan 的 Promise resolver 已被重建，不再 await 原 p）
  reloadPlans();
  expectEq("重启后未决计划恢复", listPendingPlans("plan-s7").length, 1);
  expectTrue("重启后仍可 decide", decidePlan(id, true));
  expectEq("重启后 decide 生效", getPlan(id)?.status, "approved");
}

resetAll();
console.log("\n✓ Plan mode 验证通过");
process.exit(0);