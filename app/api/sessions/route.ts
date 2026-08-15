import { createSession, listSessions } from "@/lib/session";
import { addWorkspace, grantWorkspaceAccess } from "@/lib/workspace";
import { setSessionWorkdir } from "@/lib/agent-context";
import path from "node:path";

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

/** POST /api/sessions —— 新建会话（可指定 surface: work/coding 与绑定目录 workdir） */
export async function POST(req: Request) {
  try {
    let title: string | undefined;
    let surface: "work" | "coding" | undefined;
    let workdir: string | undefined;
    try {
      const body = await req.json();
      if (typeof body?.title === "string" && body.title.trim()) {
        title = body.title.trim().slice(0, 40);
      }
      if (body?.surface === "work") surface = "work";
      if (typeof body?.workdir === "string" && body.workdir.trim()) {
        workdir = body.workdir.trim();
      }
    } catch {
      /* 无请求体也可 */
    }

    // 绑定目录：归一化绝对路径，未注册时加入工作区并授权（默认工作区恒可用）
    let workdirResolved: string | undefined;
    if (workdir) {
      workdirResolved = path.resolve(workdir);
      const w = addWorkspace(workdirResolved);
      if (w.authorized !== 1) grantWorkspaceAccess(w.id);
    }

    const session = createSession(title, surface, workdirResolved);
    if (workdirResolved) setSessionWorkdir(session.id, workdirResolved);
    return Response.json({ session }, { status: 201 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
