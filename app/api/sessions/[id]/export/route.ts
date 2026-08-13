import { contentText } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSession, getSessionMessages } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 提取消息为 { role, text } 对话记录（跳过工具调用等内部消息） */
function toDialogue(m: AgentMessage): { role: string; text: string } | null {
  if (m.role === "user" || m.role === "assistant") {
    return { role: m.role, text: contentText(m.content) };
  }
  return null;
}

/** GET /api/sessions/:id/export?format=md|json —— 导出会话对话 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: "会话不存在" }, { status: 404 });
    }
    const url = new URL(req.url);
    const format = url.searchParams.get("format") ?? "md";

    const lines = getSessionMessages(id)
      .map(toDialogue)
      .filter((d): d is NonNullable<typeof d> => d !== null);

    if (format === "json") {
      const data = {
        session: { id: session.id, title: session.title, createdAt: session.createdAt },
        exportedAt: new Date().toISOString(),
        messages: lines,
      };
      return new Response(JSON.stringify(data, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(session.title)}.json`,
        },
      });
    }

    const md = `# ${session.title}\n\n${lines
      .map((d) => (d.role === "user" ? `## 用户\n\n${d.text}\n` : `## 助手\n\n${d.text}\n`))
      .join("\n")}`;
    return new Response(md, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(session.title)}.md`,
      },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
