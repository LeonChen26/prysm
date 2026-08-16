/**
 * 定时任务数据层（自动化）
 * 独立 automations.db（沿用 todo.db / plans.db 独立库惯例）：
 * - automations：任务配置（名称/内容/触发/形态/绑定目录/状态）
 * - automation_runs：执行历史（每次触发生成一个会话，可跳转查看）
 *
 * 触发表示（对齐 Trae Work 定时任务）：
 * - interval：任意分钟间隔（分钟/小时/天）
 * - cron：标准 5 字段 cron 表达式（固定时间：每天/每周/每月 由 UI 生成）
 * schedule_desc 保存人类可读描述用于展示。
 *
 * surface / workdir 创建后不可改（对齐文档：运行模式/环境/输出位置创建后不可改）。
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { basePath } from "./config";
import { nextCronRun } from "./cron";

export type AutomationSurface = "work" | "coding";
export type AutomationStatus = "running" | "done" | "failed" | "skipped";

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  surface: AutomationSurface;
  workdir?: string;
  scheduleType: "interval" | "cron";
  intervalMinutes?: number;
  cronExpr?: string;
  scheduleDesc: string;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: AutomationStatus;
  lastSessionId?: string;
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationRun {
  id: number;
  automationId: string;
  automationName: string;
  sessionId?: string;
  status: AutomationStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export type AutomationInput = Pick<
  Automation,
  "name" | "prompt" | "surface" | "scheduleType" | "intervalMinutes" | "cronExpr" | "scheduleDesc"
> & { workdir?: string };

/** 可修改字段（surface/workdir 创建后不可改） */
export interface AutomationPatch {
  name?: string;
  prompt?: string;
  scheduleType?: "interval" | "cron";
  intervalMinutes?: number;
  cronExpr?: string;
  scheduleDesc?: string;
  enabled?: boolean;
  /** 执行期内部字段（调度器写入） */
  lastStatus?: AutomationStatus;
  lastRunAt?: number;
  runCount?: number;
  nextRunAt?: number;
}

let db: DatabaseSync | undefined;

function getDb(): DatabaseSync {
  if (db) return db;
  const d = new DatabaseSync(basePath("automations.db"));
  d.exec(`
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      surface TEXT NOT NULL DEFAULT 'work',
      workdir TEXT,
      schedule_type TEXT NOT NULL,
      interval_minutes INTEGER,
      cron_expr TEXT,
      schedule_desc TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_status TEXT,
      last_session_id TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_automation_runs
      ON automation_runs(automation_id, id);
  `);
  db = d;
  return d;
}

/** 测试专用：关闭并丢弃连接，下次调用按新 baseDir 重建 */
export function resetAutomationDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* 忽略关闭异常 */
    }
    db = undefined;
  }
}

function rowToAutomation(row: Record<string, unknown>): Automation {
  return {
    id: String(row.id),
    name: String(row.name),
    prompt: String(row.prompt),
    surface: row.surface === "work" ? "work" : "coding",
    workdir:
      typeof row.workdir === "string" && row.workdir ? row.workdir : undefined,
    scheduleType: row.schedule_type === "interval" ? "interval" : "cron",
    intervalMinutes:
      typeof row.interval_minutes === "number" ? Number(row.interval_minutes) : undefined,
    cronExpr: typeof row.cron_expr === "string" ? row.cron_expr : undefined,
    scheduleDesc: String(row.schedule_desc),
    enabled: Number(row.enabled ?? 0) === 1,
    nextRunAt: typeof row.next_run_at === "number" ? Number(row.next_run_at) : undefined,
    lastRunAt: typeof row.last_run_at === "number" ? Number(row.last_run_at) : undefined,
    lastStatus: (() => {
      const s = String(row.last_status);
      return s === "running" || s === "done" || s === "failed" || s === "skipped"
        ? s
        : undefined;
    })(),
    lastSessionId:
      typeof row.last_session_id === "string" ? row.last_session_id : undefined,
    runCount: Number(row.run_count ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** 全部任务（新在前） */
export function listAutomations(): Automation[] {
  const d = getDb();
  const rows = d
    .prepare("SELECT * FROM automations ORDER BY created_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToAutomation);
}

export function getAutomation(id: string): Automation | undefined {
  const d = getDb();
  const row = d.prepare("SELECT * FROM automations WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToAutomation(row) : undefined;
}

/** 计算下次触发时间（interval 顺延；cron 取下一个匹配点）。cron 非法会抛错。 */
export function computeNextRunAt(
  a: Pick<Automation, "scheduleType" | "intervalMinutes" | "cronExpr">,
  from: number = Date.now(),
): number {
  if (a.scheduleType === "interval") {
    const m = a.intervalMinutes;
    if (!m || m < 1) throw new Error("interval_minutes 必须为正整数（分钟）");
    return from + m * 60_000;
  }
  const expr = a.cronExpr;
  if (!expr) throw new Error("cron_expr 缺失");
  return nextCronRun(expr, from);
}

/** 新建任务；next_run_at 自动按当前时间计算 */
export function createAutomation(input: AutomationInput): Automation {
  const d = getDb();
  const id = randomUUID();
  const now = Date.now();
  const nextRunAt = computeNextRunAt(input);
  d.prepare(
    `INSERT INTO automations
      (id, name, prompt, surface, workdir, schedule_type, interval_minutes, cron_expr,
       schedule_desc, enabled, next_run_at, run_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)`,
  ).run(
    id,
    input.name.trim(),
    input.prompt,
    input.surface,
    input.workdir ?? null,
    input.scheduleType,
    input.scheduleType === "interval" ? input.intervalMinutes ?? null : null,
    input.scheduleType === "cron" ? input.cronExpr ?? null : null,
    input.scheduleDesc,
    nextRunAt,
    now,
    now,
  );
  return getAutomation(id)!;
}

/** 更新任务（仅允许 patch 中的字段；surface/workdir 不可改） */
export function updateAutomation(id: string, patch: AutomationPatch): Automation | undefined {
  const d = getDb();
  const existing = getAutomation(id);
  if (!existing) return undefined;
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null | undefined) => {
    if (v === undefined) return;
    fields.push(`${col} = ?`);
    values.push(v);
  };
  set("name", patch.name?.trim());
  set("prompt", patch.prompt);
  set("schedule_type", patch.scheduleType);
  if (patch.scheduleType === "interval") {
    set("interval_minutes", patch.intervalMinutes ?? null);
    set("cron_expr", null);
  } else if (patch.scheduleType === "cron") {
    set("cron_expr", patch.cronExpr ?? null);
    set("interval_minutes", null);
  }
  set("schedule_desc", patch.scheduleDesc);
  set("enabled", patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0);
  // 执行期内部字段
  set("last_status", patch.lastStatus);
  set("last_run_at", patch.lastRunAt);
  set("run_count", patch.runCount);
  // next_run_at：优先显式指定；否则触发方式变更时重算
  const scheduleChanged =
    patch.scheduleType !== undefined ||
    patch.intervalMinutes !== undefined ||
    patch.cronExpr !== undefined;
  if (patch.nextRunAt !== undefined) {
    fields.push("next_run_at = ?");
    values.push(patch.nextRunAt);
  } else if (scheduleChanged) {
    const nextRunAt = computeNextRunAt({
      scheduleType: patch.scheduleType ?? existing.scheduleType,
      intervalMinutes: patch.intervalMinutes ?? existing.intervalMinutes,
      cronExpr: patch.cronExpr ?? existing.cronExpr,
    });
    fields.push("next_run_at = ?");
    values.push(nextRunAt);
  }
  if (fields.length === 0) return existing;
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  d.prepare(`UPDATE automations SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getAutomation(id);
}

/** 启用/停用；停用时保留 next_run_at（重新启用按原计划触发） */
export function setAutomationEnabled(id: string, enabled: boolean): Automation | undefined {
  const d = getDb();
  const existing = getAutomation(id);
  if (!existing) return undefined;
  d.prepare("UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?").run(
    enabled ? 1 : 0,
    Date.now(),
    id,
  );
  return getAutomation(id);
}

/** 删除任务并级联删除其执行历史 */
export function deleteAutomation(id: string): boolean {
  const d = getDb();
  if (!getAutomation(id)) return false;
  d.prepare("DELETE FROM automation_runs WHERE automation_id = ?").run(id);
  d.prepare("DELETE FROM automations WHERE id = ?").run(id);
  return true;
}

// ---------------------------------------------------------------- 执行历史

export function listAutomationRuns(limit = 50): AutomationRun[] {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT r.id, r.automation_id, r.session_id, r.status, r.started_at, r.finished_at, r.error,
              a.name AS automation_name
         FROM automation_runs r
         LEFT JOIN automations a ON a.id = r.automation_id
        ORDER BY r.id DESC
        LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: Number(row.id),
    automationId: String(row.automation_id),
    automationName: String(row.automation_name ?? "(已删除任务)"),
    sessionId: typeof row.session_id === "string" ? row.session_id : undefined,
    status: String(row.status) as AutomationStatus,
    startedAt: Number(row.started_at),
    finishedAt:
      typeof row.finished_at === "number" ? Number(row.finished_at) : undefined,
    error: typeof row.error === "string" ? row.error : undefined,
  }));
}

export function recordRun(
  automationId: string,
  sessionId: string | undefined,
  status: AutomationStatus,
  startedAt: number,
  finishedAt?: number,
  error?: string,
): void {
  const d = getDb();
  d.prepare(
    "INSERT INTO automation_runs (automation_id, session_id, status, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(automationId, sessionId ?? null, status, startedAt, finishedAt ?? null, error ?? null);
}

/** 全部启用的任务 */
export function listEnabledAutomations(): Automation[] {
  return listAutomations().filter((a) => a.enabled);
}

/** 当前到期（next_run_at <= now）的启用任务 */
export function listDueAutomations(now: number = Date.now()): Automation[] {
  return listEnabledAutomations().filter(
    (a) => a.nextRunAt !== undefined && a.nextRunAt <= now,
  );
}

/** 备份导出：任务配置（不含执行历史） */
export function dumpAutomations(): Automation[] {
  return listAutomations();
}

/** 备份恢复：清空后导入（幂等：跳过同名 id 或重建？采用追加导入，id 冲突覆盖） */
export function restoreAutomations(list: Automation[]): number {
  const d = getDb();
  let count = 0;
  const upsert = d.prepare(
    `INSERT INTO automations
      (id, name, prompt, surface, workdir, schedule_type, interval_minutes, cron_expr,
       schedule_desc, enabled, next_run_at, last_run_at, last_status, last_session_id,
       run_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, prompt=excluded.prompt, schedule_type=excluded.schedule_type,
       interval_minutes=excluded.interval_minutes, cron_expr=excluded.cron_expr,
       schedule_desc=excluded.schedule_desc, enabled=excluded.enabled,
       next_run_at=excluded.next_run_at, updated_at=excluded.updated_at`,
  );
  for (const a of list) {
    try {
      upsert.run(
        a.id,
        a.name,
        a.prompt,
        a.surface,
        a.workdir ?? null,
        a.scheduleType,
        a.scheduleType === "interval" ? a.intervalMinutes ?? null : null,
        a.scheduleType === "cron" ? a.cronExpr ?? null : null,
        a.scheduleDesc,
        a.enabled ? 1 : 0,
        a.nextRunAt ?? null,
        a.lastRunAt ?? null,
        a.lastStatus ?? null,
        a.lastSessionId ?? null,
        a.runCount ?? 0,
        a.createdAt ?? Date.now(),
        a.updatedAt ?? Date.now(),
      );
      count++;
    } catch (err) {
      console.error(`[automation] 恢复任务 ${a.id} 失败: ${(err as Error).message}`);
    }
  }
  return count;
}
