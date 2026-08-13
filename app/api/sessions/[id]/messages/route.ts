import { getAgentForSession } from "@/lib/agent";
import {
  deleteSessionMessage,
  getSession,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/sessions/:id/messages —— 删除会话中的单条消息（body: { index }） */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: "会话不存在" }, { status: 404 });
    }
    const body = await req.json().catch(() => null);
    const index = Number(body?.index);
    if (!Number.isInteger(index) || index < 0) {
      return Response.json({ error: "index 必须是非负整数" }, { status: 400 });
    }
    const messages = deleteSessionMessage(id, index);
    // 同步内存中的 Agent 实例状态，避免下次生成时历史不一致
    const agent = getAgentForSession(id);
    if (agent) agent.state.messages = messages;
    return Response.json({ ok: true, count: messages.length });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
