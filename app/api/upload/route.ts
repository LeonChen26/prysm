import { saveImage } from "@/lib/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/upload —— 上传图片（body: { data: base64, mimeType?: string }），落盘到工作区根 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.data !== "string" || !body.data.trim()) {
      return Response.json({ error: "缺少 data（base64 图片内容）" }, { status: 400 });
    }
    const mimeType = typeof body.mimeType === "string" ? body.mimeType : undefined;
    const saved = await saveImage(body.data, mimeType);
    return Response.json({ ok: true, ...saved });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 400 });
  }
}