import { listPendingApprovals } from "@/lib/approval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/agent/pending —— 当前未决的审批请求（前端刷新页面后恢复审批卡片） */
export async function GET() {
  const approvals = listPendingApprovals();
  const now = Date.now();
  return Response.json({
    now,
    approvals: approvals.filter((a) => a.expiresAt > now),
  });
}
