import { modifyTodos, removeTodos, reorderTodos } from "@/lib/todo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 前端直接操作 todo 清单（拖拽排序 / 删除单项 / 追加步骤）。
 * 由用户交互触发，不经过 agent；agent 下一次 tool_end 会透传最新清单保持同步。
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const action = body?.action;
    if (action === "reorder" && Array.isArray(body.ids)) {
      return Response.json({ ok: true, ...reorderTodos(body.ids.map(String)) });
    }
    if (action === "remove" && Array.isArray(body.ids)) {
      return Response.json({ ok: true, ...removeTodos(body.ids.map(String)) });
    }
    if (action === "append" && Array.isArray(body.items)) {
      return Response.json({
        ok: true,
        ...modifyTodos(undefined, body.items),
      });
    }
    return Response.json({ error: "不支持的 action" }, { status: 400 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
