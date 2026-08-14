import { addWorkspace, listWorkspaces } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workspaces —— 全部工作区（含授权状态，默认工作区排最前） */
export async function GET() {
  try {
    return Response.json({ workspaces: listWorkspaces() });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/workspaces —— 新增工作区（body: { root, name? }） */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const root = String(body?.root ?? "").trim();
    if (!root) {
      return Response.json({ error: "root 不能为空" }, { status: 400 });
    }
    const name =
      typeof body?.name === "string" && body.name.trim()
        ? body.name.trim()
        : undefined;
    const workspace = addWorkspace(root, name);
    return Response.json({ workspace }, { status: 201 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
