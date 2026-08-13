import { clearApprovals, countApprovals, listApprovals, type AuditAction } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_ACTIONS: AuditAction[] = [
  "approved",
  "denied",
  "timeout",
  "denied_auto",
  "auto",
];

/** GET /api/audit?limit=50&tool=run_bash&action=approved&offset=0 —— 审批历史（可筛选/分页） */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    const tool = url.searchParams.get("tool")?.trim() || undefined;
    const action = url.searchParams.get("action")?.trim() as AuditAction | undefined;
    if (action && !VALID_ACTIONS.includes(action)) {
      return Response.json({ error: `action 仅支持: ${VALID_ACTIONS.join(", ")}` }, { status: 400 });
    }
    const filter = { tool, action, offset };
    return Response.json({
      total: countApprovals(filter),
      approvals: listApprovals(limit, filter),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/audit —— 清空审批历史（body: { action: "clear" }） */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (body?.action !== "clear") {
      return Response.json({ error: "仅支持 action: 'clear'" }, { status: 400 });
    }
    const removed = clearApprovals();
    return Response.json({ ok: true, removed, total: 0 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
