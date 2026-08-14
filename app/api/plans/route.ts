import {
  cancelPlan,
  decidePlan,
  getPlan,
  listPendingPlans,
} from "@/lib/plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/plans?sessionId=xxx&id=yyy —— 未决计划列表；指定 id 返回单个计划 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    const id = url.searchParams.get("id") ?? undefined;
    if (id) {
      const plan = getPlan(id);
      return Response.json(plan ? { plan } : { plan: null });
    }
    return Response.json({ plans: listPendingPlans(sessionId) });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/plans —— body: { id, action: "approve" | "reject" | "cancel", reason? } */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.id !== "string" || !body.id) {
      return Response.json({ error: "缺少 id" }, { status: 400 });
    }
    const action = body.action;
    if (action === "approve" || action === "reject") {
      const ok = decidePlan(body.id, action === "approve");
      if (!ok) return Response.json({ error: "计划不存在或已超时" }, { status: 404 });
      return Response.json({ ok: true, plan: getPlan(body.id) });
    }
    if (action === "cancel") {
      const ok = cancelPlan(body.id, typeof body.reason === "string" ? body.reason : undefined);
      if (!ok) return Response.json({ error: "计划不存在或已处理" }, { status: 404 });
      return Response.json({ ok: true, plan: getPlan(body.id) });
    }
    return Response.json(
      { error: "action 必须是 approve / reject / cancel" },
      { status: 400 },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}