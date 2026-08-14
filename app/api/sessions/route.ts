import { createSession, listSessions } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/sessions —— 会话列表（按最近更新排序） */
export async function GET() {
  try {
    return Response.json({ sessions: listSessions() });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/sessions —— 新建会话（可指定 surface: work/coding） */
export async function POST(req: Request) {
  try {
    let title: string | undefined;
    let surface: "work" | "coding" | undefined;
    try {
      const body = await req.json();
      if (typeof body?.title === "string" && body.title.trim()) {
        title = body.title.trim().slice(0, 40);
      }
      if (body?.surface === "work") surface = "work";
    } catch {
      /* 无请求体也可 */
    }
    const session = createSession(title, surface);
    return Response.json({ session }, { status: 201 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
