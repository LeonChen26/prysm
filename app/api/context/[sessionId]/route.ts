import { analyzeContext } from "@/lib/context-analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/context/:sessionId —— 会话上下文构成分析（估算构成 + 真实 usage） */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await params;
    return Response.json(analyzeContext(sessionId));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
