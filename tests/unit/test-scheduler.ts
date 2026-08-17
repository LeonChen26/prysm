/**
 * lib/scheduler.ts 单元测试 —— 生命周期管理、错误处理、并发防护。
 * 运行：npx tsx tests/unit/test-scheduler.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configure, resetConfig } from "../../lib/config";
import { resetAutomationDb, createAutomation, updateAutomation, listAutomationRuns } from "../../lib/automation";
import { resetPrysmDb } from "../../lib/prysm-db";
import { startScheduler, stopScheduler, tickAutomations, runAutomationNow, bindAutomationEventBus } from "../../lib/scheduler";
import { SimpleEventBus } from "../../lib/events";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expectEq(name: string, actual: unknown, want: unknown) {
  const ok =
    typeof actual === "object" && typeof want === "object"
      ? JSON.stringify(actual) === JSON.stringify(want)
      : actual === want;
  if (!ok) {
    fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${name}`);
}

function expectThrow(name: string, fn: () => unknown, wantMsg?: string) {
  try {
    fn();
    fail(`${name}: 期望抛错但未抛`);
  } catch (e) {
    if (wantMsg) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes(wantMsg)) {
        fail(`${name}: 异常消息 "${msg}" 不包含 "${wantMsg}"`);
      }
    }
  }
  console.log(`  ✓ ${name}`);
}

async function expectReject(name: string, promise: Promise<unknown>, wantMsg?: string) {
  try {
    await promise;
    fail(`${name}: 期望 reject 但未 reject`);
  } catch (e) {
    if (wantMsg) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes(wantMsg)) {
        fail(`${name}: 异常消息 "${msg}" 不包含 "${wantMsg}"`);
      }
    }
  }
  console.log(`  ✓ ${name}`);
}

// —— 初始化 ——
const base = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-scheduler-"));
configure({ baseDir: base, env: {} });

function cleanupAutomationDb() {
  resetAutomationDb();
  const dbPath = path.join(base, "automations.db");
  try { fs.unlinkSync(dbPath); } catch { /* 忽略 */ }
}

cleanupAutomationDb();
resetPrysmDb();

// 确保调度器处于干净状态（可能有其他测试遗留的 timer）
stopScheduler();

// —— 1. startScheduler / stopScheduler 生命周期 ——
console.log("== startScheduler / stopScheduler 生命周期 ==");
{
  stopScheduler();

  startScheduler();
  console.log("  ✓ startScheduler() 首次调用不抛错");

  // 幂等：第二次调用不应创建新 timer
  startScheduler();
  console.log("  ✓ startScheduler() 幂等（第二次调用不抛错）");

  stopScheduler();
  console.log("  ✓ stopScheduler() 清理 timer 不抛错");

  // stop 后再次 start 应正常工作
  startScheduler();
  console.log("  ✓ stop 后 startScheduler() 可重新启动");

  stopScheduler();
}

// —— 2. tickAutomations：无任务时返回 0 ——
console.log("\n== tickAutomations：空列表 ==");
{
  cleanupAutomationDb();
  const count = await tickAutomations(Date.now());
  expectEq("无任务时返回 0", count, 0);
}

// —— 3. runAutomationNow：不存在的任务抛错 ——
console.log("\n== runAutomationNow：不存在的任务 ==");
{
  await expectReject(
    "不存在的 automationId 抛错",
    runAutomationNow("non-existent-id-12345"),
    "定时任务",
  );
}

// —— 4. runAutomationNow：并发防护（上一轮仍 running 时跳过） ——
console.log("\n== runAutomationNow：并发防护 ==");
{
  const a = createAutomation({
    name: "并发测试任务",
    prompt: "测试并发防护",
    surface: "work",
    scheduleType: "interval",
    intervalMinutes: 30,
    scheduleDesc: "每 30 分钟",
  });

  // 模拟上一轮仍在运行
  updateAutomation(a.id, { lastStatus: "running" });

  const beforeRuns = listAutomationRuns().length;
  const result = await runAutomationNow(a.id);
  const afterRuns = listAutomationRuns().length;

  expectEq("running 状态下返回 skipped", result.status, "skipped");
  expectEq("skipped 记录已写入 automation_runs", afterRuns, beforeRuns + 1);

  const run = listAutomationRuns()[0];
  expectEq("跳过记录的状态为 skipped", run.status, "skipped");
  expectEq("跳过记录归属正确", run.automationId, a.id);

  // 清理
  cleanupAutomationDb();
}

// —— 5. tickAutomations：到期但处于 running 的任务被跳过 ——
console.log("\n== tickAutomations：running 任务跳过 ==");
{
  const a = createAutomation({
    name: "tick-skip 任务",
    prompt: "测试 tick 跳过",
    surface: "work",
    scheduleType: "interval",
    intervalMinutes: 30,
    scheduleDesc: "每 30 分钟",
  });

  // 拨到过去 + 标记 running
  updateAutomation(a.id, {
    nextRunAt: Date.now() - 1000,
    lastStatus: "running",
  });

  const before = listAutomationRuns().length;
  const dueCount = await tickAutomations(Date.now());
  const after = listAutomationRuns().length;

  expectEq("到期任务数为 1", dueCount, 1);
  expectEq("running 任务被跳过并记录", after, before + 1);

  const last = listAutomationRuns()[0];
  expectEq("跳过记录状态为 skipped", last.status, "skipped");

  cleanupAutomationDb();
}

// —— 6. bindAutomationEventBus：事件注入与触发 ——
console.log("\n== bindAutomationEventBus ==");
{
  const bus = new SimpleEventBus();
  const received: Array<{ type: string; automationId: string; status: string }> = [];

  bus.subscribe((evt) => {
    if (evt.type === "automation_run") {
      received.push({
        type: evt.type,
        automationId: evt.automationId,
        status: evt.status,
      });
    }
  });

  bindAutomationEventBus(bus);

  const a = createAutomation({
    name: "event-bus 测试",
    prompt: "测试事件总线",
    surface: "work",
    scheduleType: "interval",
    intervalMinutes: 30,
    scheduleDesc: "每 30 分钟",
  });

  // 不标记为 running，走完整流程 → getAgent 会失败 → catch→finally 触发事件
  await runAutomationNow(a.id);

  expectEq("收到 automation_run 事件", received.length, 1);
  expectEq("事件类型正确", received[0].type, "automation_run");
  expectEq("事件 automationId 正确", received[0].automationId, a.id);
  // getAgent 失败 → status 为 failed
  expectEq("事件状态为 failed", received[0].status, "failed");

  cleanupAutomationDb();
}

// —— 7. tickAutomations：无启用任务时返回 0 ——
console.log("\n== tickAutomations：无启用任务 ==");
{
  cleanupAutomationDb();

  // 创建一个任务但设为停用
  const a = createAutomation({
    name: "停用任务",
    prompt: "不应触发",
    surface: "work",
    scheduleType: "interval",
    intervalMinutes: 1,
    scheduleDesc: "每 1 分钟",
  });
  updateAutomation(a.id, { enabled: false, nextRunAt: Date.now() - 1000 });

  const count = await tickAutomations(Date.now());
  expectEq("仅停用任务时返回 0", count, 0);

  cleanupAutomationDb();
}

// —— 8. 全局 timer 引用：stopScheduler 后全局引用被清除 ——
console.log("\n== 全局 timer 引用管理 ==");
{
  stopScheduler();

  const g = globalThis as Record<string, unknown>;
  const key = "__prysm_scheduler_timer__";

  startScheduler();
  if (!g[key]) fail("启动后全局引用应存在");
  console.log("  ✓ startScheduler 后全局引用存在");

  stopScheduler();
  if (g[key]) {
    const ref = (g[key] as { ref: unknown }).ref;
    if (ref !== undefined) fail("stopScheduler 后全局 timer 引用应为 undefined");
  }
  console.log("  ✓ stopScheduler 后全局 timer 引用已清除");
}

// —— 9. 多次 start/stop 循环 ——
console.log("\n== 多次 start/stop 循环 ==");
{
  for (let i = 0; i < 3; i++) {
    startScheduler();
    stopScheduler();
  }
  startScheduler();
  startScheduler();
  stopScheduler();
  console.log("  ✓ 多次 start/stop 循环正常");
}

// —— 清理 ——
stopScheduler();
cleanupAutomationDb();
resetPrysmDb();
resetConfig();
try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log("\n✓ scheduler 模块全部测试通过");