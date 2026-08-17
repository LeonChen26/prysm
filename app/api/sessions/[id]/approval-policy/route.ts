import {
  getSession,
  getSessionApprovalPolicy,
  setSessionApprovalPolicy,
} from "@/lib/session";
import { getApprovalPolicy } from "@/lib/permission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/sessions/:id/approval-policy —— 当前会话策略（覆盖值 + 全局生效值） */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: "会话不存在" }, { status: 404 });
    }
    const override = getSessionApprovalPolicy(id) ?? null;
    const global = getApprovalPolicy();
    return Response.json({ sessionId: id, override, global });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** PUT /api/sessions/:id/approval-policy —— 设置会话级审批策略（ask/never/follow） */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: "会话不存在" }, { status: 404 });
    }
    const body = await req.json().catch(() => null);
    const policy = body?.policy;
    if (policy !== "ask" && policy !== "never" && policy !== "follow") {
      return Response.json(
        { error: 'policy 必须是 "ask" | "never" | "follow"' },
        { status: 400 },
      );
    }
    const normalized = policy === "follow" ? null : policy;
    setSessionApprovalPolicy(id, normalized);
    return Response.json({
      ok: true,
      sessionId: id,
      override: normalized,
      global: getApprovalPolicy(),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
