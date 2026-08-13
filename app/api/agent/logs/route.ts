import { clearRunLogs, getRunLogs } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/agent/logs —— 最近 Agent 运行日志（内存，新在前） */
export async function GET() {
  try {
    return Response.json({ logs: getRunLogs() });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/agent/logs —— 清空日志（body: { action: "clear" }） */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (body?.action !== "clear") {
      return Response.json({ error: "仅支持 action: 'clear'" }, { status: 400 });
    }
    clearRunLogs();
    return Response.json({ ok: true, logs: [] });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
