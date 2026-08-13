/**
 * 运行统计聚合单测（离线）
 * 直接构造运行日志调用 computeStats，验证聚合正确性。
 */
import { computeStats } from "../../lib/stats";
import type { RunLogEntry } from "../../lib/agent";

let assertCount = 0;
let failCount = 0;

function assert(cond: boolean, name: string) {
  assertCount++;
  if (!cond) {
    failCount++;
    console.log(`  ✗ ${name}`);
  } else {
    console.log(`  ✓ ${name}`);
  }
}

function entry(partial: Partial<RunLogEntry>): RunLogEntry {
  return {
    id: Math.random(),
    sessionId: "s1",
    title: "t",
    startedAt: Date.now(),
    durationMs: 1000,
    messageCount: 2,
    stopped: false,
    ...partial,
  };
}

console.log("== 运行统计聚合 ==");

// 1) 成功 / 失败 / 停止 判定
const logs = [
  entry({ id: 1, startedAt: Date.now() - 0, durationMs: 1000, stopped: false }), // ok
  entry({ id: 2, startedAt: Date.now() - 86_400_000, durationMs: 2000, error: "boom" }), // failed
  entry({ id: 3, startedAt: Date.now() - 2 * 86_400_000, durationMs: 500, stopped: true }), // stopped
  entry({ id: 4, startedAt: Date.now() - 3 * 86_400_000, durationMs: 3000, stopped: false }), // ok
];
const s = computeStats(logs, 7);
assert(s.totalRuns === 4, `总运行数 = 4`);
assert(s.okRuns === 2, `成功数 = 2`);
assert(s.failedRuns === 1, `失败数 = 1`);
assert(s.stoppedRuns === 1, `停止数 = 1`);
assert(s.successRate === 0.6667, `成功率 = ${s.successRate}（不含停止）`);
assert(s.totalDurationMs === 6500, `总耗时 = 6500ms`);
assert(s.avgDurationMs === 1625, `平均耗时 = 1625ms`);
assert(s.byDay.length === 7, `按天 7 天`);
const today = s.byDay[0];
assert(today.runs === 1 && today.okRuns === 1, `今天 1 次成功`);
assert(s.byDay[1].runs === 1 && s.byDay[1].failedRuns === 1, `昨天 1 次失败`);
assert(s.byDay[2].runs === 1 && s.byDay[2].okRuns === 0, `前天台有停止不计成功`);
assert(s.byDay[6].runs === 0, `7 天前为空天`);

// 2) 工具调用排行
const logs2 = [
  entry({
    id: 5,
    startedAt: Date.now(),
    toolCalls: { write_file: 2, todo_create: 1 },
  }),
  entry({
    id: 6,
    startedAt: Date.now(),
    toolCalls: { write_file: 1, run_bash: 4 },
  }),
  entry({ id: 7, startedAt: Date.now(), toolCalls: undefined }),
];
const s2 = computeStats(logs2, 1);
assert(s2.toolRanking[0]?.name === "run_bash" && s2.toolRanking[0]?.count === 4, `工具排行首位 run_bash=4`);
assert(s2.toolRanking[1]?.name === "write_file" && s2.toolRanking[1]?.count === 3, `工具排行次位 write_file=3`);
assert(s2.toolRanking[2]?.name === "todo_create" && s2.toolRanking[2]?.count === 1, `工具排行 todo_create=1`);
assert(s2.toolRanking.length === 3, `无 toolCalls 的日志不产生排行`);

// 3) 空数据
const s3 = computeStats([], 7);
assert(s3.totalRuns === 0 && s3.successRate === 0 && s3.byDay.length === 7, `空日志安全降级`);

console.log(failCount === 0 ? "\n✓ 运行统计聚合验证通过" : `\n✗ ${failCount} 项断言失败`);
process.exit(failCount === 0 ? 0 : 1);
