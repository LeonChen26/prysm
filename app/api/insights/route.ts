import { getInsightsOverview } from "@/lib/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/insights —— 观测+评估聚合：运行记录（含评分）+ 汇总统计 */
export async function GET() {
  try {
    return Response.json(getInsightsOverview());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
