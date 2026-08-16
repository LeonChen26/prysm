import { getAgentForSession } from "@/lib/agent";
import { clearSessionMessages, getSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/sessions/:id/clear —— 清空会话消息（保留会话） */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: "会话不存在" }, { status: 404 });
    }
    clearSessionMessages(id);
    // 同步内存中的 Agent 实例状态，避免清空后新消息仍把旧历史注入模型上下文
    const agent = getAgentForSession(id);
    if (agent) agent.state.messages = [];
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
