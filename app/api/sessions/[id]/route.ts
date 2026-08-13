import { contentText } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getAgent } from "@/lib/agent";
import {
  deleteSession,
  getSession,
  pinSession,
  renameSession,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toUiMessage(m: AgentMessage) {
  if (m.role === "user") {
    return { role: "user" as const, text: contentText(m.content) };
  }
  if (m.role === "assistant") {
    return { role: "assistant" as const, text: contentText(m.content) };
  }
  return null;
}

/** GET /api/sessions/:id —— 指定会话的消息历史 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: "会话不存在" }, { status: 404 });
    }
    const agent = await getAgent(id);
    const messages = agent.state.messages
      .map(toUiMessage)
      .filter((m): m is NonNullable<typeof m> => m !== null);
    return Response.json({ session, messages });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** PATCH /api/sessions/:id —— 重命名或置顶会话 */
export async function PATCH(
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
    if (body && typeof body.pinned === "boolean") {
      pinSession(id, body.pinned);
      return Response.json({
        ok: true,
        session: { ...session, pinned: body.pinned ? 1 : 0 },
      });
    }
    const title = String(body?.title ?? "").trim();
    if (!title) {
      return Response.json({ error: "title 不能为空" }, { status: 400 });
    }
    renameSession(id, title);
    return Response.json({
      ok: true,
      session: { ...session, title },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** DELETE /api/sessions/:id —— 删除会话及消息 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: "会话不存在" }, { status: 404 });
    }
    deleteSession(id);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
