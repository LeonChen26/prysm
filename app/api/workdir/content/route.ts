import { readWorkdirFile } from "@/lib/workdir";
import { resolveInWorkdir } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workdir/content?path=xxx&root=xxx —— 预览工作区内文本文件内容（root 指定工作区根） */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rel = (url.searchParams.get("path") ?? "").trim();
    if (!rel) {
      return Response.json({ error: "path 不能为空" }, { status: 400 });
    }
    const root = (url.searchParams.get("root") ?? "").trim() || undefined;
    // Phase 2 预检：未授权/越界目录返回 403 与授权提示，走授权流而非 500
    const check = resolveInWorkdir(rel, root);
    if (!check.ok) {
      if (check.reason === "unauthorized") {
        return Response.json(
          {
            error: "目录未授权",
            needsAuthorization: true,
            root: check.root,
            workspaceId: check.workspaceId,
          },
          { status: 403 },
        );
      }
      return Response.json({ error: "路径越界" }, { status: 403 });
    }
    const data = await readWorkdirFile(rel, root);
    return Response.json({ ok: true, ...data });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
