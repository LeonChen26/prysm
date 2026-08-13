import { exportBackup, importBackup } from "@/lib/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/backup —— 导出全部数据（会话+消息+记忆+任务计划）为 JSON */
export async function GET() {
  try {
    const backup = exportBackup();
    return Response.json(backup);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/backup —— 导入备份并清空重建，返回各类数据条数 */
export async function POST(req: Request) {
  try {
    const data = await req.json().catch(() => null);
    if (!data) {
      return Response.json({ error: "请求体必须是备份 JSON" }, { status: 400 });
    }
    const stats = importBackup(data);
    return Response.json({ ok: true, ...stats });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
