/**
 * 定时任务调度器（自动化执行）
 * - startScheduler()：模块级单例，每 30s 扫描一次到期任务（幂等，防 Web dev 热重载重复启动）
 * - tickAutomations()：到期任务逐个执行；上一轮仍 running 的任务标记 skipped（防同任务重叠）
 * - runAutomationNow()：单任务立即执行 —— 复用 Agent 链路（getAgent + prompt + 会话持久化 + logRun），
 *   每次执行新建独立会话（title=任务名），执行结果可跳转查看；进度经 eventBus 发 automation_run 事件
 * - stopScheduler()：清定时器（测试/热重载用）
 */

import { createSession, saveSessionMessages, touchSession } from "./session";
import { getAgent, logRun } from "./agent";
import { addWorkspace, grantWorkspaceAccess } from "./workspace";
import { setSessionWorkdir } from "./agent-context";
import { runWithToolCtx, runWithWorkdir } from "./tools";
import type { AgentEventBus } from "./events";
import {
  computeNextRunAt,
  getAutomation,
  listDueAutomations,
  recordRun,
  updateAutomation,
  type AutomationStatus,
} from "./automation";

const TICK_MS = 30_000;

let timer: NodeJS.Timeout | undefined;
let started = false;

/** 事件总线（由 createCore 注入；未注入时静默跳过事件推送） */
let eventBus: AgentEventBus | undefined;
export function bindAutomationEventBus(bus: AgentEventBus | undefined): void {
  eventBus = bus;
}

/**
 * 跨模块实例共享调度器定时器引用（挂在 globalThis 上）。
 * 修复：dev 热重载重新求值本模块时，旧实例的 interval 无人 clear，
 * 若新实例再 setInterval 会造成双 tick；借助全局引用让新实例直接复用旧 timer。
 */
const GLOBAL_KEY = "__prysm_scheduler_timer__";
type GlobalTimer = { ref: ReturnType<typeof setInterval> | undefined };
function globalTimer(): GlobalTimer {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { ref: undefined };
  return g[GLOBAL_KEY] as GlobalTimer;
}

/** 启动调度器（幂等；跨 HMR 复用已有 interval） */
export function startScheduler(): void {
  if (started) return;
  const shared = globalTimer();
  if (shared.ref !== undefined) {
    // 旧模块实例遗留的 interval 仍存活 → 直接复用，不重复创建
    timer = shared.ref;
    started = true;
    return;
  }
  started = true;
  timer = setInterval(() => {
    void tickAutomations().catch((err) => {
      console.error("[automation] 调度 tick 失败:", err);
    });
  }, TICK_MS);
  timer.unref?.();
  shared.ref = timer;
}

/** 停止调度器（测试/热重载） */
export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  globalTimer().ref = undefined;
  started = false;
}

/**
 * 立即执行一个定时任务（手动"立即运行"与调度 tick 共用）。
 * 返回执行结果；不抛错（失败记录为 failed，不阻塞其他任务）。
 */
export async function runAutomationNow(
  automationId: string,
): Promise<{ status: AutomationStatus; sessionId?: string; error?: string }> {
  const a = getAutomation(automationId);
  if (!a) throw new Error(`定时任务 "${automationId}" 不存在`);
  // 防重叠：上一轮仍在运行（调度 tick 或手动触发）时直接拒绝，避免同一任务并发执行
  const fresh = getAutomation(automationId);
  if (fresh?.lastStatus === "running") {
    recordRun(automationId, undefined, "skipped", Date.now(), Date.now(), "任务执行中，手动触发被跳过");
    return { status: "skipped" };
  }
  const startedAt = Date.now();
  updateAutomation(a.id, { lastStatus: "running", lastRunAt: startedAt });
  let sessionId: string | undefined;
  let status: AutomationStatus = "done";
  let error: string | undefined;
  try {
    // 每次执行新建独立会话（title=任务名），与用户手动会话互不冲突（agent 按会话隔离 + isStreaming 互斥）
    const session = createSession(a.name, a.surface, a.workdir);
    sessionId = session.id;
    if (a.workdir) {
      const w = addWorkspace(a.workdir);
      if (w && w.authorized !== 1) grantWorkspaceAccess(w.id);
      setSessionWorkdir(sessionId, a.workdir);
    }
    // 注入本轮上下文（对齐 app/api/agent/route.ts：plan_propose 归属 / 工作区根 / 记忆工作区）
    try {
      const agent = await getAgent(sessionId);
      // 在「工具会话上下文 + 任务绑定工作目录」下执行 prompt + 工具调用链；
      // AsyncLocalStorage 保证并发执行的多任务各自读到自己的 sessionId/workdir。
      await runWithToolCtx(
        { sessionId, surface: a.surface, workdir: a.workdir },
        async () => {
          await runWithWorkdir(a.workdir, async () => {
            await agent.prompt(a.prompt);
            await agent.waitForIdle();
          });
        },
      );
      // 持久化会话消息（全量替换）
      saveSessionMessages(sessionId, agent.state.messages);
    } finally {
      touchSession(sessionId);
      // 运行日志（insights.db，供观测统计）
      logRun({
        sessionId,
        title: a.name,
        startedAt,
        durationMs: Date.now() - startedAt,
        messageCount: 0,
        stopped: false,
        error,
      });
    }
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? err.message : String(err);
    console.error(`[automation] 任务 "${a.name}" 执行失败: ${error}`);
  } finally {
    // 无论成败都推进 next_run_at（失败不阻塞后续计划触发）
    let nextRunAt: number | undefined;
    try {
      nextRunAt = computeNextRunAt(a);
    } catch (e) {
      console.error(`[automation] 计算下次触发失败: ${(e as Error).message}`);
    }
    updateAutomation(a.id, {
      lastStatus: status,
      lastRunAt: startedAt,
      runCount: (a.runCount ?? 0) + 1,
      nextRunAt,
    });
    recordRun(automationId, sessionId, status, startedAt, Date.now(), error);
    eventBus?.emit({
      type: "automation_run",
      automationId: a.id,
      name: a.name,
      sessionId,
      status,
      error,
    });
  }
  return { status, sessionId, error };
}

/**
 * 调度 tick：找出到期任务并逐个执行。
 * 上一轮 last_status === "running" 的任务本轮跳过并记录 skipped（防同任务重叠执行）。
 * 返回本轮到期任务数。
 */
export async function tickAutomations(now: number = Date.now()): Promise<number> {
  const due = listDueAutomations(now);
  for (const a of due) {
    const fresh = getAutomation(a.id);
    if (!fresh || !fresh.enabled) continue;
    if (fresh.lastStatus === "running") {
      recordRun(a.id, undefined, "skipped", now, now, "上一轮执行未结束，本轮跳过");
      continue;
    }
    try {
      await runAutomationNow(a.id);
    } catch (err) {
      console.error(`[automation] 任务 "${a.name}" 触发失败: ${(err as Error).message}`);
    }
  }
  return due.length;
}
