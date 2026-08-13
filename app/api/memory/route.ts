import {
  clearEpisodes,
  countEpisodes,
  deleteEpisode,
  listEpisodes,
} from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/memory?limit=50&offset=0 —— 情景记忆列表（最新在前） */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    return Response.json({
      total: countEpisodes(),
      episodes: listEpisodes(limit, offset),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** DELETE /api/memory?id=123 —— 删除单条记忆 */
export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return Response.json({ error: "id 必须是正整数" }, { status: 400 });
    }
    const removed = deleteEpisode(id);
    return Response.json({ ok: removed, total: countEpisodes() });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/memory —— 清空全部记忆（body: { action: "clear" }） */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (body?.action !== "clear") {
      return Response.json({ error: "仅支持 action: 'clear'" }, { status: 400 });
    }
    const removed = clearEpisodes();
    return Response.json({ ok: true, removed, total: 0 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
