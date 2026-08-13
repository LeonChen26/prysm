import { clearApprovals, countApprovals, listApprovals } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/audit?limit=50 —— 最近审批决定历史 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    return Response.json({
      total: countApprovals(),
      approvals: listApprovals(limit),
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
