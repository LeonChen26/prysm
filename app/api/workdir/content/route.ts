import { readWorkdirFile } from "@/lib/workdir";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workdir/content?path=xxx —— 预览工作区内文本文件内容 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rel = (url.searchParams.get("path") ?? "").trim();
    if (!rel) {
      return Response.json({ error: "path 不能为空" }, { status: 400 });
    }
    const data = await readWorkdirFile(rel);
    return Response.json({ ok: true, ...data });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
