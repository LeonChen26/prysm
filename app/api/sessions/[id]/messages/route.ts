import { getAgentForSession } from "@/lib/agent";
import {
  deleteSessionMessages,
  getSession,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/sessions/:id/messages —— 删除会话消息（body: { index } 或 { indices: [] }） */
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
    let indices: number[];
    if (Array.isArray(body?.indices)) {
      indices = body.indices.map(Number);
    } else {
      const index = Number(body?.index);
      indices = [index];
    }
    if (indices.length === 0 || indices.some((i) => !Number.isInteger(i) || i < 0)) {
      return Response.json(
        { error: "index / indices 必须是 0 或以上的整数" },
        { status: 400 },
      );
    }
    const messages = deleteSessionMessages(id, indices);
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
