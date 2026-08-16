/**
 * Plan mode（阶段 7）
 * 执行前规划 + 人工确认。区别于 todo（执行中拆解）与审批流（工具调用时逐次确认）：
 * - 数据模型复用 todo（步骤）；步骤额外携带「涉及工具 tool」「预期 expected」。
 * - 主 agent 通过 plan_propose 产出结构化计划并阻塞等待，用户 confirm/拒绝后才继续。
 * - 独立于 beforeToolCall：不混用审批钩子，两条链路各自独立。
 * - 事件机制（subscribePlanLifecycle）：proposed / decided / cancelled。
 * 持久化到 plans.db，重启后可恢复未决计划。
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { basePath, envValue } from "./config";
import type { Surface } from "./session";

export type PlanStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  /** 涉及工具（提示用，如 web_search / write_file / mcp__xxx__tool） */
  tool?: string;
  /** 预期结果 */
  expected?: string;
  /** 执行状态（UI 阶段 7 展示） */
  status: "pending" | "in_progress" | "done" | "skipped";
}

export interface Plan {
  id: string;
  sessionId: string;
  surface: Surface;
  summary?: string;
  steps: PlanStep[];
  status: PlanStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  reason?: string;
}

export type PlanLifecycleEvent =
  | { type: "proposed"; plan: Plan }
  | { type: "decided"; plan: Plan }
  | { type: "cancelled"; plan: Plan };

type PlanResolver = (approved: boolean) => void;

interface PendingEntry {
  plan: Plan;
  resolver: PlanResolver;
}

const pending = new Map<string, PendingEntry>();
const lifecycleListeners = new Set<(e: PlanLifecycleEvent) => void>();
let db: DatabaseSync | undefined;
let loaded = false;

function getDb(): DatabaseSync {
  if (db) return db;
  const d = new DatabaseSync(basePath("plans.db"));
  d.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      summary TEXT,
      steps TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_at INTEGER,
      reason TEXT
    );
  `);
  db = d;
  return d;
}

/**
 * 惰性加载：确保 DB 在配置注入（configure）之后才打开。
 * 之前为模块加载时立即 loadPlans()，在 Electron 形态下早于 configure()，
 * 导致 plans.db 落在 process.cwd() 而非 PRYSM_BASE_DIR(userData)。
 */
function ensureLoaded(): void {
  if (loaded) return;
  loadPlans();
  loaded = true;
}

/** 进程启动时恢复未决计划（decided 历史仅保留最近 top-K，避免膨胀） */
function loadPlans(): void {
  try {
    const rows = getDb()
      .prepare("SELECT * FROM plans ORDER BY created_at DESC LIMIT 200")
      .all() as {
      id: string;
      session_id: string;
      surface: string;
      summary: string | null;
      steps: string;
      status: string;
      created_at: number;
      expires_at: number;
      decided_at: number | null;
      reason: string | null;
    }[];
    for (const r of rows) {
      if (r.status !== "pending") continue; // 只恢复未决
      const p: Plan = {
        id: r.id,
        sessionId: r.session_id,
        surface: r.surface as Surface,
        summary: r.summary ?? undefined,
        steps: JSON.parse(r.steps),
        status: "pending",
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        decidedAt: r.decided_at ?? undefined,
        reason: r.reason ?? undefined,
      };
      // 已过期且未决 → 自动视为拒绝
      if (Date.now() >= p.expiresAt) {
        p.status = "rejected";
        p.reason = p.reason ?? "计划确认超时";
        persistPlan(p);
        continue;
      }
      pending.set(p.id, { plan: p, resolver: () => false });
    }
  } catch {
    /* 数据库损坏则忽略 */
  }
}

function persistPlan(p: Plan): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO plans
       (id, session_id, surface, summary, steps, status, created_at, expires_at, decided_at, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.id,
      p.sessionId,
      p.surface,
      p.summary ?? null,
      JSON.stringify(p.steps),
      p.status,
      p.createdAt,
      p.expiresAt,
      p.decidedAt ?? null,
      p.reason ?? null,
    );
}

function notify(e: PlanLifecycleEvent): void {
  lifecycleListeners.forEach((l) => l(e));
}

/** 注册计划生命周期订阅（proposed / decided / cancelled），返回取消函数 */
export function subscribePlanLifecycle(
  listener: (e: PlanLifecycleEvent) => void,
): () => void {
  lifecycleListeners.add(listener);
  return () => lifecycleListeners.delete(listener);
}

/** 计划确认超时（毫秒），优先级：参数 > env PLAN_TIMEOUT_MS > 默认 5min */
export function getPlanTimeoutMs(): number {
  return Number(envValue("PLAN_TIMEOUT_MS") ?? 5 * 60 * 1000);
}

export interface ProposePlanInput {
  sessionId: string;
  surface: Surface;
  summary?: string;
  steps: { title: string; detail?: string; tool?: string; expected?: string }[];
  timeoutMs?: number;
}

/**
 * 提出计划并阻塞等待用户确认。
 * 返回 Promise<{ approved: boolean; plan: Plan }>；超时视为拒绝。
 */
export function proposePlan(input: ProposePlanInput): Promise<{ approved: boolean; plan: Plan }> {
  ensureLoaded();
  return new Promise((resolve) => {
    const createdAt = Date.now();
    const effectiveTimeout = input.timeoutMs ?? getPlanTimeoutMs();
    const plan: Plan = {
      id: randomUUID().slice(0, 8),
      sessionId: input.sessionId,
      surface: input.surface,
      summary: input.summary,
      steps: input.steps.map((s, i) => ({
        id: `step-${i + 1}`,
        title: s.title,
        detail: s.detail,
        tool: s.tool,
        expected: s.expected,
        status: "pending",
      })),
      status: "pending",
      createdAt,
      expiresAt: createdAt + effectiveTimeout,
    };
    const timer = setTimeout(() => {
      if (!pending.has(plan.id)) return;
      pending.delete(plan.id);
      plan.status = "rejected";
      plan.reason = "计划确认超时";
      plan.decidedAt = Date.now();
      persistPlan(plan);
      notify({ type: "decided", plan });
      resolve({ approved: false, plan });
    }, effectiveTimeout);
    pending.set(plan.id, {
      plan,
      resolver: (approved) => {
        clearTimeout(timer);
        resolve({ approved, plan });
      },
    });
    persistPlan(plan);
    notify({ type: "proposed", plan });
  });
}

/** 用户对计划作出决定（同意/拒绝）。返回 false 表示该计划已不存在/超时 */
export function decidePlan(id: string, approve: boolean): boolean {
  ensureLoaded();
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  entry.plan.status = approve ? "approved" : "rejected";
  entry.plan.decidedAt = Date.now();
  entry.plan.reason = approve ? undefined : "用户拒绝该计划";
  persistPlan(entry.plan);
  notify({ type: "decided", plan: entry.plan });
  entry.resolver(approve);
  return true;
}

/** 取消未决计划 */
export function cancelPlan(id: string, reason = "用户取消"): boolean {
  ensureLoaded();
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  entry.plan.status = "cancelled";
  entry.plan.decidedAt = Date.now();
  entry.plan.reason = reason;
  persistPlan(entry.plan);
  notify({ type: "cancelled", plan: entry.plan });
  entry.resolver(false);
  return true;
}

/** 未决计划快照（按会话过滤可选） */
export function listPendingPlans(sessionId?: string): Plan[] {
  ensureLoaded();
  const out: Plan[] = [];
  for (const { plan } of pending.values()) {
    if (sessionId && plan.sessionId !== sessionId) continue;
    out.push(clonePlan(plan));
  }
  return out;
}

/** 查询单个计划（含已决历史） */
export function getPlan(id: string): Plan | null {
  ensureLoaded();
  const p = pending.get(id)?.plan;
  if (p) return clonePlan(p);
  const r = getDb().prepare("SELECT * FROM plans WHERE id = ?").get(id) as
    | {
        id: string;
        session_id: string;
        surface: string;
        summary: string | null;
        steps: string;
        status: string;
        created_at: number;
        expires_at: number;
        decided_at: number | null;
        reason: string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    sessionId: r.session_id,
    surface: r.surface as Surface,
    summary: r.summary ?? undefined,
    steps: JSON.parse(r.steps),
    status: r.status as PlanStatus,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedAt: r.decided_at ?? undefined,
    reason: r.reason ?? undefined,
  };
}

function clonePlan(p: Plan): Plan {
  return JSON.parse(JSON.stringify(p));
}

/** 清空未决与历史（测试用） */
export function clearPlans(): void {
  ensureLoaded();
  pending.clear();
  const d = getDb();
  d.exec("DELETE FROM plans");
}

/** 关闭并重置连接（测试用） */
export function resetPlans(): void {
  pending.clear();
  loaded = false;
  try {
    db?.close();
  } catch {
    /* 未打开 */
  }
  db = undefined;
}

/** 模拟进程重启：清空内存状态后从数据库重新加载（测试/热恢复用） */
export function reloadPlans(): void {
  pending.clear();
  loaded = false;
  try {
    db?.close();
  } catch {
    /* 未打开 */
  }
  db = undefined;
  ensureLoaded();
}