import { createCore } from "@/lib/core";
import { parseCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 统一入口：注入 baseDir/env（createCore 内部会启动定时任务调度器，幂等） */
const core = createCore({ baseDir: process.cwd(), env: process.env });

/**
 * GET /api/automations —— 定时任务列表 + 执行历史（自动化面板）
 * 返回：{ automations: Automation[], runs: AutomationRun[] }
 */
export async function GET() {
  try {
    return Response.json({
      automations: core.listAutomations(),
      runs: core.listAutomationRuns(50),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** 校验触发字段：interval_minutes 与 cron_expr 二选一；cron 校验合法性。返回规范化 schedule。 */
function resolveSchedule(body: Record<string, unknown>): {
  scheduleType: "interval" | "cron";
  intervalMinutes?: number;
  cronExpr?: string;
  scheduleDesc: string;
} {
  const hasInterval =
    typeof body.interval_minutes === "number" &&
    Number.isInteger(body.interval_minutes) &&
    body.interval_minutes > 0;
  const hasCron = typeof body.cron_expr === "string" && body.cron_expr.trim().length > 0;
  if (!hasInterval && !hasCron) {
    throw new Error("触发方式缺失：请提供 interval_minutes（间隔分钟）或 cron_expr（5 字段 cron）之一");
  }
  if (hasCron) {
    try {
      parseCron(body.cron_expr as string);
    } catch (err) {
      throw new Error(`cron 表达式非法：${(err as Error).message}`);
    }
  }
  const scheduleDesc = String(body.schedule_desc ?? "").trim();
  if (!scheduleDesc) throw new Error("schedule_desc（触发描述）不能为空");
  return {
    scheduleType: hasInterval ? "interval" : "cron",
    intervalMinutes: hasInterval ? (body.interval_minutes as number) : undefined,
    cronExpr: hasCron ? (body.cron_expr as string).trim() : undefined,
    scheduleDesc,
  };
}

/** POST /api/automations —— action 分发：create / update / toggle / delete / run */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const action = String(body?.action ?? "");
    if (action === "create") {
      const name = String(body?.name ?? "").trim();
      const prompt = String(body?.prompt ?? "").trim();
      if (!name) return Response.json({ error: "任务名称不能为空" }, { status: 400 });
      if (!prompt) return Response.json({ error: "任务内容（prompt）不能为空" }, { status: 400 });
      const schedule = resolveSchedule(body as Record<string, unknown>);
      const surface = body?.surface === "coding" ? "coding" : "work";
      const workdir =
        typeof body?.workdir === "string" && body.workdir.trim()
          ? body.workdir.trim()
          : undefined;
      const automation = core.createAutomation({
        name,
        prompt,
        surface,
        workdir,
        ...schedule,
      });
      return Response.json({ ok: true, automation, automations: core.listAutomations() });
    }
    if (action === "update") {
      const id = String(body?.id ?? "");
      if (!id) return Response.json({ error: "id 缺失" }, { status: 400 });
      const patch: Record<string, unknown> = {};
      if (typeof body?.name === "string" && body.name.trim()) patch.name = body.name.trim();
      if (typeof body?.prompt === "string") patch.prompt = body.prompt;
      if (body?.schedule_type !== undefined) {
        const schedule = resolveSchedule(body);
        Object.assign(patch, schedule);
      }
      if (Object.keys(patch).length === 0) {
        return Response.json({ error: "无可更新字段" }, { status: 400 });
      }
      const updated = core.updateAutomation(id, patch);
      if (!updated) return Response.json({ error: `定时任务 "${id}" 不存在` }, { status: 404 });
      return Response.json({ ok: true, automation: updated, automations: core.listAutomations() });
    }
    if (action === "toggle") {
      const id = String(body?.id ?? "");
      const enabled = body?.enabled === true;
      const updated = core.toggleAutomation(id, enabled);
      if (!updated) return Response.json({ error: `定时任务 "${id}" 不存在` }, { status: 404 });
      return Response.json({ ok: true, automation: updated, automations: core.listAutomations() });
    }
    if (action === "delete") {
      const id = String(body?.id ?? "");
      const removed = core.deleteAutomation(id);
      if (!removed) return Response.json({ error: `定时任务 "${id}" 不存在` }, { status: 404 });
      return Response.json({ ok: true, automations: core.listAutomations(), runs: core.listAutomationRuns(50) });
    }
    if (action === "run") {
      const id = String(body?.id ?? "");
      if (!id) return Response.json({ error: "id 缺失" }, { status: 400 });
      const result = await core.runAutomationNow(id);
      return Response.json({
        ok: true,
        ...result,
        automations: core.listAutomations(),
        runs: core.listAutomationRuns(50),
      });
    }
    return Response.json(
      { error: "action 仅支持 create / update / toggle / delete / run" },
      { status: 400 },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
