import { getAgentForSession, markStopped } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/agent/stop —— 中断指定会话当前正在执行的 run */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const sessionId = String(body?.sessionId ?? "").trim();
    if (!sessionId) {
      return Response.json({ error: "sessionId 不能为空" }, { status: 400 });
    }
    const agent = getAgentForSession(sessionId);
    if (!agent || !agent.state.isStreaming) {
      return Response.json({ ok: true, stopped: false });
    }
    agent.abort();
    markStopped(sessionId);
    return Response.json({ ok: true, stopped: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
