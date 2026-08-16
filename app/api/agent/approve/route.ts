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
    // 严格布尔校验：字符串 "false"/"0"/"yes" 等一律按非法处理，防止拒绝被误判为批准
    if (typeof body?.approve !== "boolean") {
      return Response.json({ error: "approve 必须是布尔值 true/false" }, { status: 400 });
    }
    approve = body.approve;
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
