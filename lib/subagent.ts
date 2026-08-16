/**
 * 子 agent 编排（Phase 5）
 * 任务级并行与隔离：主 agent 通过 spawn_subagent 派生，prysm 层维护子 agent 池。
 * - 池键控：`${parentSessionId}:${subagentId}`，与主会话池隔离。
 * - 类型：只读研究型（capability=readonly）/ 读写执行型（capability=readwrite）。
 * - 并发/资源控制：并发上限、超时、取消。
 * - 降级：超时 → 标记 timed_out 并返回部分结果；失败 → 记录 error。
 *
 * 本模块只依赖 Node 内置，不依赖 pi-agent-core；真正的执行逻辑（构造子 Agent、
 * 调用模型）由调用方注入 runner（agent.ts 的 runSubagentCore），保持可测试。
 */
import { randomUUID } from "node:crypto";

export type SubagentCapability = "readonly" | "readwrite";
export type SubagentSurface = "work" | "coding";

export interface SubagentSpec {
  /** 父会话 id */
  parentSessionId: string;
  /** 交给子 agent 的任务描述 */
  task: string;
  capability: SubagentCapability;
  surface?: SubagentSurface;
  /** 超时（毫秒），默认 120s */
  timeoutMs?: number;
  /** 由 spawnSubagent 填充：子 agent 唯一 key `${parentSessionId}:${subagentId}` */
  key?: string;
  /** 由 spawnSubagent 填充：子 agent id */
  subagentId?: string;
}

/** 执行器：真正运行子 agent 并返回摘要（由 agent.ts 注入） */
export type SubagentRunner = (spec: SubagentSpec) => Promise<string>;

export type SubagentStatus =
  | "running"
  | "done"
  | "error"
  | "timed_out"
  | "cancelled";

export interface SubagentRecord {
  key: string;
  parentSessionId: string;
  subagentId: string;
  capability: SubagentCapability;
  surface?: SubagentSurface;
  startedAt: number;
  status: SubagentStatus;
  summary?: string;
  error?: string;
}

const pool = new Map<string, SubagentRecord>();
let running = 0;
let aborted = new Set<string>(); // 已通过 abortSubagent 释放过槽位的 key，防止 finally 双重释放
const MAX_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 120_000;

/** 子 agent key：`${parentSessionId}:${subagentId}`（与主会话池隔离） */
export function keyOf(parentSessionId: string, subagentId: string): string {
  return `${parentSessionId}:${subagentId}`;
}

/** 查询子 agent 记录（可按父会话过滤） */
export function listSubagents(parentSessionId?: string): SubagentRecord[] {
  const all = [...pool.values()];
  return parentSessionId
    ? all.filter((s) => s.parentSessionId === parentSessionId)
    : all;
}

export function getSubagent(key: string): SubagentRecord | undefined {
  return pool.get(key);
}

/** 取消正在运行的子 agent（幂等） */
export function abortSubagent(key: string): boolean {
  const r = pool.get(key);
  if (!r || r.status !== "running") return false;
  r.status = "cancelled";
  r.summary = "(已取消)";
  // 标记该 key 已释放槽位；runner finally 的 releaseSlot 会跳过，防止双重释放并发计数
  aborted.add(key);
  running = Math.max(0, running - 1);
  return true;
}

/** 仅用于测试/dev：清空池与并发计数 */
export function resetSubagentPool(): void {
  pool.clear();
  running = 0;
  aborted.clear();
}

/** 申请并发槽位（超限返回 false） */
function acquireSlot(): boolean {
  if (running >= MAX_CONCURRENCY) return false;
  running++;
  return true;
}

function releaseSlot(): void {
  running = Math.max(0, running - 1);
}

/**
 * 派生并运行一个子 agent。
 * @param spec 任务描述与类型
 * @param runner 真正的执行器（agent.ts 注入）；超时/并发/取消由本函数统一包装
 * @returns 子 agent 记录（status 反映最终结果）
 */
export async function spawnSubagent(
  spec: SubagentSpec,
  runner: SubagentRunner,
): Promise<SubagentRecord> {
  if (!acquireSlot()) {
    return {
      key: "",
      parentSessionId: spec.parentSessionId,
      subagentId: "",
      capability: spec.capability,
      surface: spec.surface,
      startedAt: Date.now(),
      status: "error",
      error: `子 agent 并发数已达上限（${MAX_CONCURRENCY}），请稍后重试`,
    };
  }

  const subagentId = randomUUID().slice(0, 8);
  const key = keyOf(spec.parentSessionId, subagentId);
  const rec: SubagentRecord = {
    key,
    parentSessionId: spec.parentSessionId,
    subagentId,
    capability: spec.capability,
    surface: spec.surface,
    startedAt: Date.now(),
    status: "running",
  };
  pool.set(key, rec);

  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fullSpec: SubagentSpec = { ...spec, key, subagentId };
  try {
    const summary = await withTimeout(runner(fullSpec), timeoutMs);
    // 若已被取消，保持 cancelled，不覆盖
    if (rec.status !== "cancelled") {
      rec.status = "done";
      rec.summary = summary;
    }
  } catch (err) {
    if (rec.status !== "cancelled") {
      const timedOut = (err as { timedOut?: boolean })?.timedOut === true;
      if (timedOut) {
        rec.status = "timed_out";
        rec.summary = "(子 agent 超时)";
        rec.error = `超过 ${timeoutMs}ms 未完成`;
      } else {
        rec.status = "error";
        rec.error = err instanceof Error ? err.message : String(err);
        rec.summary = `(子 agent 失败: ${rec.error})`;
      }
    }
  } finally {
    // abortSubagent 已提前释放过槽位时跳过，避免并发计数被双重递减
    if (!aborted.delete(key)) releaseSlot();
  }
  return rec;
}

/** 带超时的 Promise 包装：超时抛 timedOut 标记错误 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const e = new Error("children agent timeout") as Error & {
        timedOut?: boolean;
      };
      e.timedOut = true;
      reject(e);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}