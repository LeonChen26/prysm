import { setWorkspaceAuthorized } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/workspaces/:id/authorize —— 授权/撤销某工作区（body: { authorized: boolean }） */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    if (typeof body?.authorized !== "boolean") {
      return Response.json({ error: "authorized 必须为布尔值" }, { status: 400 });
    }
    const workspace = setWorkspaceAuthorized(id, body.authorized);
    if (!workspace) {
      return Response.json({ error: "工作区不存在" }, { status: 404 });
    }
    return Response.json({ workspace });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
