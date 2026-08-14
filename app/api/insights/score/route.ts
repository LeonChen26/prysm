import { addScore } from "@/lib/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/insights/score —— 提交人工评分（body: { sessionId, label: 'good'|'bad', comment? }） */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const sessionId = body?.sessionId;
    const label = body?.label;
    if (typeof sessionId !== "string" || !sessionId) {
      return Response.json({ error: "sessionId 必填" }, { status: 400 });
    }
    if (label !== "good" && label !== "bad") {
      return Response.json({ error: "label 须为 good 或 bad" }, { status: 400 });
    }
    const score = addScore({
      sessionId,
      kind: "human",
      label,
      comment: typeof body?.comment === "string" ? body.comment : undefined,
    });
    return Response.json({ ok: true, score });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
