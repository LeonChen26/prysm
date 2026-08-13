import { getRunLogs } from "@/lib/agent";
import { computeStats } from "@/lib/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/stats —— 运行统计概览（基于运行日志聚合） */
export async function GET() {
  try {
    return Response.json({ stats: computeStats(getRunLogs()) });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
