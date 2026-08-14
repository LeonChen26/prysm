/**
 * 观测数据（观测-评估-优化闭环的「观测 + 评估」层）
 * - turns 表：持久化每次 Agent 运行（替代原先内存 runLogs，重启即失）。
 * - scores 表：人工评分（👍/👎/评语）+ 规则评估（落库时零成本计算）。
 * 与 sessions.db / agent-memory.db 同构：Node 内置 SQLite，零额外依赖。
 */
import { DatabaseSync } from "node:sqlite";
import { basePath } from "./config";
import type { RunLogEntry } from "./agent";

let db: DatabaseSync | undefined;

function getDb(): DatabaseSync {
  if (db) return db;
  const d = new DatabaseSync(basePath("insights.db"));
  d.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      stopped INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      tool_calls TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cache_read INTEGER,
      tokens_total INTEGER,
      cost_total REAL,
      model TEXT,
      user_text TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turns_started ON turns(started_at);

    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      score REAL,
      comment TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scores_session ON scores(session_id);
  `);
  db = d;
  return d;
}

/** 评分条目（人工 / 规则） */
export interface Score {
  id: number;
  runId: number | null;
  sessionId: string;
  kind: "human" | "rule";
  label: string;
  score?: number;
  comment?: string;
  createdAt: number;
}

/** 写入一条评分（默认关联该会话最近一次 run；runId 可显式指定） */
export function addScore(input: {
  sessionId: string;
  kind: "human" | "rule";
  label: string;
  score?: number;
  comment?: string;
  runId?: number;
}): Score {
  const d = getDb();
  const runId =
    input.runId ??
    (d
      .prepare(
        "SELECT id FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(input.sessionId) as { id: number } | undefined)?.id ??
    null;
  const r = d
    .prepare(
      `INSERT INTO scores (run_id, session_id, kind, label, score, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      input.sessionId,
      input.kind,
      input.label,
      input.score ?? null,
      input.comment ?? null,
      Date.now(),
    );
  return {
    id: Number(r.lastInsertRowid),
    runId,
    sessionId: input.sessionId,
    kind: input.kind,
    label: input.label,
    score: input.score,
    comment: input.comment,
    createdAt: Date.now(),
  };
}

function rowToEntry(row: Record<string, unknown>): RunLogEntry {
  const hasUsage = row.tokens_in != null;
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    title: String(row.title),
    startedAt: Number(row.started_at),
    durationMs: Number(row.duration_ms),
    messageCount: Number(row.message_count),
    stopped: Number(row.stopped) === 1,
    error: row.error ? String(row.error) : undefined,
    toolCalls: row.tool_calls
      ? (JSON.parse(String(row.tool_calls)) as Record<string, number>)
      : undefined,
    usage: hasUsage
      ? {
          input: Number(row.tokens_in),
          output: Number(row.tokens_out ?? 0),
          cacheRead: Number(row.cache_read ?? 0),
          totalTokens: Number(row.tokens_total ?? 0),
          cost: Number(row.cost_total ?? 0),
        }
      : undefined,
  };
}

/** 持久化一次 Agent 运行（返回带自增 id 的完整条目），并自动跑规则评估 */
export function recordRun(
  entry: Omit<RunLogEntry, "id"> & { userText?: string; model?: string },
): RunLogEntry {
  const d = getDb();
  const r = d
    .prepare(
      `INSERT INTO turns
       (session_id, title, started_at, duration_ms, message_count, stopped, error,
        tool_calls, tokens_in, tokens_out, cache_read, tokens_total, cost_total, model, user_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.sessionId,
      entry.title,
      entry.startedAt,
      entry.durationMs,
      entry.messageCount,
      entry.stopped ? 1 : 0,
      entry.error ?? null,
      entry.toolCalls ? JSON.stringify(entry.toolCalls) : null,
      entry.usage?.input ?? null,
      entry.usage?.output ?? null,
      entry.usage?.cacheRead ?? null,
      entry.usage?.totalTokens ?? null,
      entry.usage?.cost ?? null,
      entry.model ?? null,
      entry.userText ?? null,
      Date.now(),
    );
  const runId = Number(r.lastInsertRowid);

  // 规则评估（零成本，落库时自动跑，供后续筛选坏案例）
  if (entry.error) {
    addScore({ sessionId: entry.sessionId, runId, kind: "rule", label: "run_error", comment: entry.error });
  } else if (entry.stopped) {
    addScore({ sessionId: entry.sessionId, runId, kind: "rule", label: "run_stopped" });
  } else if (!entry.toolCalls || Object.keys(entry.toolCalls).length === 0) {
    addScore({ sessionId: entry.sessionId, runId, kind: "rule", label: "no_tools" });
  }

  return { id: runId, ...entry };
}

/** 最近运行记录（新在前） */
export function getRuns(limit = 50): RunLogEntry[] {
  const rows = getDb()
    .prepare("SELECT * FROM turns ORDER BY id DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

/** 清空运行记录（连同评分） */
export function clearRuns(): void {
  const d = getDb();
  d.exec("DELETE FROM turns");
  d.exec("DELETE FROM scores");
}

function rowToScore(row: Record<string, unknown>): Score {
  return {
    id: Number(row.id),
    runId: row.run_id == null ? null : Number(row.run_id),
    sessionId: String(row.session_id),
    kind: row.kind as "human" | "rule",
    label: String(row.label),
    score: row.score == null ? undefined : Number(row.score),
    comment: row.comment ? String(row.comment) : undefined,
    createdAt: Number(row.created_at),
  };
}

/** 最近评分记录（新在前） */
export function listScores(limit = 500): Score[] {
  const rows = getDb()
    .prepare("SELECT * FROM scores ORDER BY id DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToScore);
}

/** 评估汇总（基于 turns/scores 全库计数） */
export interface InsightsSummary {
  totalRuns: number;
  good: number;
  bad: number;
  ruleIssues: number;
  runError: number;
  runStopped: number;
  noTools: number;
  /** LLM-Judge 评分条数 */
  judgeCount: number;
  /** LLM-Judge 平均分（0-10，一位小数；无评分时为 null） */
  avgJudgeScore: number | null;
}

/** 观测 + 评估聚合：运行记录（附带各自评分）+ 汇总统计 */
export function getInsightsOverview(runLimit = 100): {
  runs: (RunLogEntry & { scores: Score[] })[];
  summary: InsightsSummary;
} {
  const d = getDb();
  const count = (sql: string): number => {
    const row = d.prepare(sql).get() as { c: number } | undefined;
    return Number(row?.c ?? 0);
  };

  const totalRuns = count("SELECT COUNT(*) AS c FROM turns");
  const good = count(
    "SELECT COUNT(*) AS c FROM scores WHERE kind = 'human' AND label = 'good'",
  );
  const bad = count(
    "SELECT COUNT(*) AS c FROM scores WHERE kind = 'human' AND label = 'bad'",
  );
  const runError = count(
    "SELECT COUNT(*) AS c FROM scores WHERE kind = 'rule' AND label = 'run_error'",
  );
  const runStopped = count(
    "SELECT COUNT(*) AS c FROM scores WHERE kind = 'rule' AND label = 'run_stopped'",
  );
  const noTools = count(
    "SELECT COUNT(*) AS c FROM scores WHERE kind = 'rule' AND label = 'no_tools'",
  );
  const judgeScores = (
    d
      .prepare(
        "SELECT score FROM scores WHERE kind = 'rule' AND label = 'llm_judge' AND score IS NOT NULL",
      )
      .all() as Record<string, unknown>[]
  ).map((r) => Number(r.score));

  const scores = listScores();
  const byRun = new Map<number, Score[]>();
  for (const s of scores) {
    if (s.runId == null) continue;
    const arr = byRun.get(s.runId) ?? [];
    arr.push(s);
    byRun.set(s.runId, arr);
  }

  const runs = getRuns(runLimit).map((r) => ({
    ...r,
    scores: byRun.get(r.id) ?? [],
  }));

  return {
    runs,
    summary: {
      totalRuns,
      good,
      bad,
      ruleIssues: runError + runStopped + noTools,
      runError,
      runStopped,
      noTools,
      judgeCount: judgeScores.length,
      avgJudgeScore:
        judgeScores.length === 0
          ? null
          : Math.round(
              (judgeScores.reduce((s, v) => s + v, 0) / judgeScores.length) * 10,
            ) / 10,
    },
  };
}
