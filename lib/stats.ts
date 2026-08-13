/**
 * 运行统计聚合
 * 基于运行日志（RunLogEntry[]）计算：成功率、耗时、工具排行、按天分布。
 * 纯函数，无副作用，便于离线单测。
 */

import type { RunLogEntry } from "./agent";

export interface DayStat {
  /** "MM-DD"（本地时区） */
  day: string;
  runs: number;
  okRuns: number;
  failedRuns: number;
  durationMs: number;
}

export interface ToolStat {
  name: string;
  count: number;
}

export interface RunStats {
  totalRuns: number;
  okRuns: number;
  failedRuns: number;
  stoppedRuns: number;
  /** 成功率（0-1，四舍五入到万分位） */
  successRate: number;
  totalDurationMs: number;
  /** 平均耗时（毫秒） */
  avgDurationMs: number;
  /** 工具调用排行（按次数降序） */
  toolRanking: ToolStat[];
  /** 按天分布（最近 days 天，含空天，新在前） */
  byDay: DayStat[];
}

/** 本地时区 "MM-DD" */
function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${m}-${day}`;
}

/** 过去 days 天的日期键（含今天，新在前） */
function recentDayKeys(days: number, now = Date.now()): string[] {
  const keys: string[] = [];
  for (let i = 0; i < days; i++) {
    keys.push(dayKey(now - i * 86_400_000));
  }
  return keys;
}

export function computeStats(logs: RunLogEntry[], days = 7): RunStats {
  let totalRuns = 0;
  let okRuns = 0;
  let failedRuns = 0;
  let stoppedRuns = 0;
  let totalDurationMs = 0;
  const toolCounts = new Map<string, number>();
  const byDayMap = new Map<string, DayStat>();

  for (const log of logs) {
    totalRuns++;
    totalDurationMs += log.durationMs;
    if (log.stopped) {
      stoppedRuns++;
    } else if (log.error) {
      failedRuns++;
    } else {
      okRuns++;
    }
    // 工具调用计数
    if (log.toolCalls) {
      for (const [name, count] of Object.entries(log.toolCalls)) {
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + count);
      }
    }
    // 按天聚合
    const key = dayKey(log.startedAt);
    const d = byDayMap.get(key) ?? {
      day: key,
      runs: 0,
      okRuns: 0,
      failedRuns: 0,
      durationMs: 0,
    };
    d.runs++;
    d.durationMs += log.durationMs;
    if (log.stopped) {
      /* 主动停止不计入成功/失败 */
    } else if (log.error) {
      d.failedRuns++;
    } else {
      d.okRuns++;
    }
    byDayMap.set(key, d);
  }

  const toolRanking = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const byDay = recentDayKeys(days)
    .map((key) => byDayMap.get(key) ?? { day: key, runs: 0, okRuns: 0, failedRuns: 0, durationMs: 0 });

  return {
    totalRuns,
    okRuns,
    failedRuns,
    stoppedRuns,
    successRate:
      totalRuns === 0
        ? 0
        : Math.round((okRuns / Math.max(totalRuns - stoppedRuns, 1)) * 10_000) / 10_000,
    totalDurationMs,
    avgDurationMs: totalRuns === 0 ? 0 : Math.round(totalDurationMs / totalRuns),
    toolRanking,
    byDay,
  };
}
