/**
 * 定时任务（自动化）验证脚本 —— cron 解析 + next_run 计算 + CRUD + 调度 due 逻辑 + 备份。
 * 运行：npx tsx tests/unit/test-automation.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configure, resetConfig } from "../../lib/config";
import {
  computeNextRunAt,
  createAutomation,
  deleteAutomation,
  dumpAutomations,
  getAutomation,
  listAutomationRuns,
  listAutomations,
  listDueAutomations,
  recordRun,
  resetAutomationDb,
  restoreAutomations,
  setAutomationEnabled,
  updateAutomation,
} from "../../lib/automation";
import { nextCronRun, parseCron } from "../../lib/cron";
import { tickAutomations, stopScheduler } from "../../lib/scheduler";
import { exportBackup, importBackup } from "../../lib/backup";
import { resetPrysmDb } from "../../lib/prysm-db";

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

function expectThrow(name: string, fn: () => unknown) {
  try {
    fn();
    fail(`${name}: 期望抛错但未抛`);
  } catch {
    console.log(`  ✓ ${name}`);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-auto-"));
configure({ baseDir: tmpDir, env: {} });
resetAutomationDb();
resetPrysmDb();

// ---------------------------------------------------------------- cron 解析

console.log("== parseCron：5 字段解析与合法性 ==");
{
  const p = parseCron("0 9 * * 1");
  expectEq("分钟字段", [...p.minute.values], [0]);
  expectEq("小时字段", [...p.hour.values], [9]);
  expectEq("日字段通配", p.day.wildcard, true);
  expectEq("周字段", [...p.dow.values], [1]);
  expectThrow("字段数不足抛错", () => parseCron("0 9 * *"));
  expectThrow("分钟越界抛错", () => parseCron("60 9 * * *"));
  expectThrow("非法值抛错", () => parseCron("a b c d e"));
  const sun0 = parseCron("0 9 * * 0");
  const sun7 = parseCron("0 9 * * 7");
  expectEq("周 0 归一化为周日", [...sun0.dow.values], [0]);
  expectEq("周 7 归一化为周日", [...sun7.dow.values], [0]);
}

console.log("\n== nextCronRun：下一个匹配时间 ==");
{
  const from = new Date(2026, 0, 1, 8, 30).getTime(); // 2026-01-01 08:30（周四）
  const daily = new Date(nextCronRun("0 9 * * *", from));
  expectEq("每天9点 → 当天 09:00", daily.getHours() + ":" + daily.getMinutes(), "9:0");
  expectEq("当天日期", `${daily.getFullYear()}-${daily.getMonth() + 1}-${daily.getDate()}`, "2026-1-1");

  const past = new Date(nextCronRun("30 8 * * *", from)); // 08:30 已过 → 次日
  expectEq("已过时刻 → 次日", `${past.getFullYear()}-${past.getMonth() + 1}-${past.getDate()}`, "2026-1-2");

  const weekly = new Date(nextCronRun("0 9 * * 1", from)); // 下一个周一
  expectEq("每周一 → 落在周一", weekly.getDay(), 1);
  expectEq("每周一日期", `${weekly.getMonth() + 1}-${weekly.getDate()}`, "1-5");

  const monthly = new Date(nextCronRun("0 9 1 * *", from));
  expectEq("每月1号 → 当月 1 号", `${monthly.getMonth() + 1}-${monthly.getDate()}`, "1-1");

  const eom = new Date(nextCronRun("0 0 31 * *", new Date(2026, 0, 31, 12).getTime()));
  expectEq("月末31日 → 跳过2月到3月31", `${eom.getMonth() + 1}-${eom.getDate()}`, "3-31");

  const ny = new Date(nextCronRun("0 0 1 1 *", new Date(2026, 0, 1, 0, 0).getTime()));
  expectEq("1月1日 → 次年", ny.getFullYear(), 2027);

  const sun = nextCronRun("0 9 * * 0", from);
  const sun7 = nextCronRun("0 9 * * 7", from);
  expectEq("周0与周7 结果一致", sun, sun7);
}

// ---------------------------------------------------------------- next_run 计算

console.log("\n== computeNextRunAt：interval 与 cron ==");
{
  const from = Date.now();
  const iv = computeNextRunAt({ scheduleType: "interval", intervalMinutes: 30 }, from);
  expectEq("interval 顺延 30 分钟", iv, from + 30 * 60_000);
  const cr = computeNextRunAt({ scheduleType: "cron", cronExpr: "0 9 * * *" }, from);
  expectEq("cron 取下一个匹配（> from）", cr > from, true);
  expectThrow("interval 缺分钟数抛错", () =>
    computeNextRunAt({ scheduleType: "interval" } as never, from),
  );
  expectThrow("cron 缺表达式抛错", () =>
    computeNextRunAt({ scheduleType: "cron" } as never, from),
  );
}

// ---------------------------------------------------------------- CRUD

console.log("\n== createAutomation / 持久化 ==");
const a1 = createAutomation({
  name: "每日行情摘要",
  prompt: "检索今日行情并输出摘要",
  surface: "work",
  scheduleType: "interval",
  intervalMinutes: 60,
  scheduleDesc: "每 60 分钟",
});
expectEq("默认启用", a1.enabled, true);
expectEq("next_run 在未来", a1.nextRunAt! > Date.now(), true);
expectEq("scheduleType", a1.scheduleType, "interval");

const a2 = createAutomation({
  name: "每周代码检查",
  prompt: "对项目做一次代码健康检查",
  surface: "coding",
  scheduleType: "cron",
  cronExpr: "0 9 * * 1",
  scheduleDesc: "每周一 09:00",
  workdir: "E:\\proj",
});
expectEq("cron 任务持久化", a2.cronExpr, "0 9 * * 1");
expectEq("workdir 保存", a2.workdir, "E:\\proj");
expectEq("列表含 2 个", listAutomations().length, 2);

console.log("\n== updateAutomation / toggle / delete ==");
{
  const upd = updateAutomation(a1.id, { name: "行情速递" });
  expectEq("改名生效", upd?.name, "行情速递");
  const oldNext = a1.nextRunAt!;
  const updCron = updateAutomation(a1.id, {
    scheduleType: "cron",
    cronExpr: "0 9 * * *",
    scheduleDesc: "每天 09:00",
  });
  expectEq("改触发方式 → 重算 next_run", updCron?.nextRunAt !== oldNext, true);
  expectEq("cron_expr 已写入", updCron?.cronExpr, "0 9 * * *");

  const off = setAutomationEnabled(a2.id, false);
  expectEq("停用生效", off?.enabled, false);
  expectEq("停用后不出现在启用列表", listDueAutomations(Date.now()).some((x) => x.id === a2.id), false);

  recordRun(a1.id, "sess-1", "done", Date.now(), Date.now());
  expectEq("执行历史 1 条", listAutomationRuns().length, 1);
  expectEq("删除任务级联历史", deleteAutomation(a1.id), true);
  expectEq("任务已删", getAutomation(a1.id), undefined);
  expectEq("历史已清", listAutomationRuns().some((r) => r.automationId === a1.id), false);
}

// ---------------------------------------------------------------- 调度 due

console.log("\n== listDueAutomations / tick skipped 防重叠 ==");
{
  const a = createAutomation({
    name: "due 任务",
    prompt: "触发测试",
    surface: "work",
    scheduleType: "interval",
    intervalMinutes: 30,
    scheduleDesc: "每 30 分钟",
  });
  // 把 next_run_at 拨到过去，且 last_status=running（模拟上一轮未结束）
  updateAutomation(a.id, { nextRunAt: Date.now() - 1000, lastStatus: "running" });
  expectEq("到期筛选命中", listDueAutomations(Date.now()).some((x) => x.id === a.id), true);
  const before = listAutomationRuns().length;
  await tickAutomations(Date.now());
  const after = listAutomationRuns().length;
  expectEq("running 任务本轮跳过并记录 skipped", after, before + 1);
  const last = listAutomationRuns()[0];
  expectEq("跳过记录状态", last.status, "skipped");
  expectEq("跳过记录归属", last.automationId, a.id);
}

// ---------------------------------------------------------------- 备份

console.log("\n== 备份恢复：automations 纳入 ==");
{
  const b = exportBackup();
  expectEq("导出含 automations", Array.isArray(b.automations), true);
  const beforeCount = listAutomations().length;
  const restored = importBackup(b);
  expectEq("恢复统计含 automations", restored.automations >= beforeCount - 1, true);
  // 再次导出应一致（幂等 upsert）
  const b2 = exportBackup();
  expectEq("恢复后导出数量一致", b2.automations!.length, b.automations!.length);
}

console.log("\n✓ 定时任务验证通过");
stopScheduler();
resetAutomationDb();
resetPrysmDb();
resetConfig();
process.exit(0);
