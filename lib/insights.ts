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

/** 优化建议（优化环节：由评估数据聚合出的待优化项） */
export interface OptimizationSuggestion {
  type: "llm_judge" | "run_error" | "run_stopped" | "no_tools";
  /** 关联次数 */
  count: number;
  /** 低分评语（仅 llm_judge 类型，取最低分一条） */
  comment?: string;
}

/** AI 评分趋势点（按运行时间升序，供趋势可视化） */
export interface JudgeTrendPoint {
  score: number;
  /** 对应运行开始时间（毫秒） */
  at: number;
}

/** 按模型聚合的评估统计（评估 + 分析：哪类模型表现更好、问题更少） */
export interface ModelStat {
  model: string;
  /** 该模型运行次数 */
  runs: number;
  /** 有 LLM-Judge 评分的运行数 */
  judgeCount: number;
  /** LLM-Judge 平均分（0-10，一位小数；无评分时为 null） */
  avgJudgeScore: number | null;
  /** 低分（<7）次数 */
  lowScoreCount: number;
  /** 规则问题次数（run_error/run_stopped/no_tools） */
  ruleIssues: number;
  /** 总 token 用量 */
  totalTokens: number;
}

/** 观测 + 评估聚合：运行记录（附带各自评分）+ 汇总统计 + 优化建议 + 评分趋势 + 模型表现 */
export function getInsightsOverview(runLimit = 100): {
  runs: (RunLogEntry & { scores: Score[] })[];
  summary: InsightsSummary;
  suggestions: OptimizationSuggestion[];
  judgeTrend: JudgeTrendPoint[];
  modelStats: ModelStat[];
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

  // 优化建议：低分（<7）AI 评语 + 规则问题聚合
  const lowJudgeCount = count(
    "SELECT COUNT(*) AS c FROM scores WHERE kind = 'rule' AND label = 'llm_judge' AND score IS NOT NULL AND score < 7",
  );
  const lowJudgeRow = d
    .prepare(
      "SELECT comment FROM scores WHERE kind = 'rule' AND label = 'llm_judge' AND score IS NOT NULL AND score < 7 ORDER BY score ASC LIMIT 1",
    )
    .get() as { comment: string | null } | undefined;
  const suggestions: OptimizationSuggestion[] = [];
  if (lowJudgeCount > 0) {
    suggestions.push({
      type: "llm_judge",
      count: lowJudgeCount,
      comment: lowJudgeRow?.comment ?? undefined,
    });
  }
  for (const [type, c] of [
    ["run_error", runError],
    ["run_stopped", runStopped],
    ["no_tools", noTools],
  ] as const) {
    if (c > 0) suggestions.push({ type, count: c });
  }

  // AI 评分趋势：按运行时间升序（关联 turns.started_at），供迷你折线可视化
  const judgeTrend: JudgeTrendPoint[] = (
    d
      .prepare(
        `SELECT s.score AS score, t.started_at AS at
         FROM scores s
         LEFT JOIN turns t ON t.id = s.run_id
         WHERE s.kind = 'rule' AND s.label = 'llm_judge' AND s.score IS NOT NULL
         ORDER BY t.started_at ASC, s.id ASC`,
      )
      .all() as { score: number; at: number }[]
  ).map((r) => ({ score: Number(r.score), at: Number(r.at) }));

  // 模型表现：按 turns.model 聚合（分别子查询聚合评分与规则问题，避免双 JOIN 笛卡尔积放大计数）
  const modelStats: ModelStat[] = (
    d
      .prepare(
        `SELECT t.model AS model,
                COUNT(*) AS runs,
                COALESCE(SUM(j.judge_count), 0) AS judge_count,
                AVG(j.avg_score) AS avg_score,
                COALESCE(SUM(j.low_count), 0) AS low_count,
                COALESCE(SUM(ru.rule_issues), 0) AS rule_issues,
                COALESCE(SUM(t.tokens_total), 0) AS total_tokens
         FROM turns t
         LEFT JOIN (
           SELECT run_id, COUNT(*) AS judge_count, AVG(score) AS avg_score,
                  SUM(CASE WHEN score < 7 THEN 1 ELSE 0 END) AS low_count
           FROM scores WHERE kind = 'rule' AND label = 'llm_judge' AND score IS NOT NULL
           GROUP BY run_id
         ) j ON j.run_id = t.id
         LEFT JOIN (
           SELECT run_id, COUNT(*) AS rule_issues
           FROM scores WHERE kind = 'rule' AND label IN ('run_error', 'run_stopped', 'no_tools')
           GROUP BY run_id
         ) ru ON ru.run_id = t.id
         WHERE t.model IS NOT NULL AND t.model != ''
         GROUP BY t.model
         ORDER BY runs DESC`,
      )
      .all() as {
      model: string;
      runs: number;
      judge_count: number;
      avg_score: number | null;
      low_count: number;
      rule_issues: number;
      total_tokens: number;
    }[]
  ).map((r) => ({
    model: r.model,
    runs: Number(r.runs),
    judgeCount: Number(r.judge_count),
    avgJudgeScore:
      r.avg_score == null
        ? null
        : Math.round(Number(r.avg_score) * 10) / 10,
    lowScoreCount: Number(r.low_count),
    ruleIssues: Number(r.rule_issues),
    totalTokens: Number(r.total_tokens),
  }));

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
    suggestions,
    judgeTrend,
    modelStats,
  };
}
