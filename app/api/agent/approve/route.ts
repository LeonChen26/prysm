import { resolveApproval } from "@/lib/approval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/agent/approve —— 用户对审批请求作出决定 { id, approve } */
export async function POST(req: Request) {
  let id: string;
  let approve: boolean;
  try {
    const body = await req.json();
    id = String(body?.id ?? "");
    approve = Boolean(body?.approve);
  } catch {
    return Response.json({ error: "请求体必须是 JSON: { id, approve }" }, { status: 400 });
  }
  if (!id) {
    return Response.json({ error: "id 不能为空" }, { status: 400 });
  }
  const ok = resolveApproval(id, approve);
  if (!ok) {
    return Response.json({ error: "审批请求不存在或已超时" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
