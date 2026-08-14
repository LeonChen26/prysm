import { createWorkdirEntry, listWorkdir, writeWorkdirFile } from "@/lib/workdir";
import { resolveInWorkdir, type ResolveResult } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Phase 2 预检：未授权/越界返回 403 + 授权提示（走授权流而非 500） */
function authorizationError(res: Extract<ResolveResult, { ok: false }>) {
  if (res.reason === "unauthorized") {
    return Response.json(
      {
        error: "目录未授权",
        needsAuthorization: true,
        root: res.root,
        workspaceId: res.workspaceId,
      },
      { status: 403 },
    );
  }
  return Response.json({ error: "路径越界" }, { status: 403 });
}

/** GET /api/workdir?path=xxx&root=xxx —— 列出工作区目录条目（root 指定工作区根，缺省默认工作区） */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rel = (url.searchParams.get("path") ?? "").trim();
    const root = (url.searchParams.get("root") ?? "").trim() || undefined;
    const check = resolveInWorkdir(rel, root);
    if (!check.ok) return authorizationError(check);
    const data = await listWorkdir(rel, root);
    return Response.json(data);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/workdir —— 新建文件/目录（JSON）或上传文件（multipart）；root 指定工作区根 */
export async function POST(req: Request) {
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      const dir = (form.get("dir") ?? "").toString().trim();
      const root = (form.get("root") ?? "").toString().trim() || undefined;
      if (!(file instanceof File)) {
        return Response.json({ error: "缺少 file 字段" }, { status: 400 });
      }
      const check = resolveInWorkdir(dir, root);
      if (!check.ok) return authorizationError(check);
      const buf = Buffer.from(await file.arrayBuffer());
      const name = file.name.replace(/[\\/]/g, "");
      const rel = [dir, name].filter(Boolean).join("/");
      const bytes = await writeWorkdirFile(rel, buf, root);
      return Response.json({ ok: true, path: rel, bytes });
    }
    const body = await req.json().catch(() => null);
    const path = String(body?.path ?? "").trim();
    if (!path) {
      return Response.json({ error: "path 不能为空" }, { status: 400 });
    }
    const type = body?.type === "dir" ? "dir" : "file";
    const root = String(body?.root ?? "").trim() || undefined;
    const check = resolveInWorkdir(path, root);
    if (!check.ok) return authorizationError(check);
    await createWorkdirEntry(path, type, String(body?.content ?? ""), root);
    return Response.json({ ok: true, path, type });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
