import {
  indexWorkspaces,
  ragEnabled,
  ragStats,
  searchDocs,
} from "@/lib/rag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/rag?q=关键词&limit=20 —— 知识库检索；无 q 时返回索引概览 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (!q) {
      return Response.json({ enabled: ragEnabled(), stats: ragStats() });
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);
    return Response.json({ enabled: ragEnabled(), hits: searchDocs(q, limit) });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/rag —— 重建/增量索引全部已授权工作区（body: { action: "index" }） */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (body?.action !== "index") {
      return Response.json({ error: "仅支持 action: 'index'" }, { status: 400 });
    }
    const stats = await indexWorkspaces();
    return Response.json({ ok: true, stats, total: ragStats().total });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}