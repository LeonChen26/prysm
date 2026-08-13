import { createWorkdirEntry, listWorkdir, writeWorkdirFile } from "@/lib/workdir";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workdir?path=xxx —— 列出工作区目录条目 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rel = (url.searchParams.get("path") ?? "").trim();
    const data = await listWorkdir(rel);
    return Response.json(data);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/workdir —— 新建文件/目录（JSON）或上传文件（multipart） */
export async function POST(req: Request) {
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      const dir = (form.get("dir") ?? "").toString().trim();
      if (!(file instanceof File)) {
        return Response.json({ error: "缺少 file 字段" }, { status: 400 });
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const name = file.name.replace(/[\\/]/g, "");
      const rel = [dir, name].filter(Boolean).join("/");
      const bytes = await writeWorkdirFile(rel, buf);
      return Response.json({ ok: true, path: rel, bytes });
    }
    const body = await req.json().catch(() => null);
    const path = String(body?.path ?? "").trim();
    if (!path) {
      return Response.json({ error: "path 不能为空" }, { status: 400 });
    }
    const type = body?.type === "dir" ? "dir" : "file";
    await createWorkdirEntry(path, type, String(body?.content ?? ""));
    return Response.json({ ok: true, path, type });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
