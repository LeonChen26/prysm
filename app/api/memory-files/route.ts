import {
  globalMemoryPath,
  projectMemoryPath,
  readPreferenceMemory,
  writeMemoryFile,
  memoryFileFor,
  type MemoryScope,
} from "@/lib/preference-memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/memory-files?workdir=xxx —— 偏好记忆内容（全局 + 当前工作区项目），设置面板用 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const workdir = (url.searchParams.get("workdir") ?? "").trim() || undefined;
    return Response.json({
      global: {
        content: readPreferenceMemory("global"),
        file: globalMemoryPath(),
      },
      project: {
        content: readPreferenceMemory("project", workdir),
        file: projectMemoryPath(workdir),
      },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/memory-files —— 保存/清空偏好记忆（body: { action, scope, content?, workdir? }） */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const action = String(body?.action ?? "");
    const scope: MemoryScope = body?.scope === "global" ? "global" : "project";
    const workdir =
      typeof body?.workdir === "string" && body.workdir.trim()
        ? body.workdir.trim()
        : undefined;
    if (action === "save") {
      const content = String(body?.content ?? "");
      writeMemoryFile(memoryFileFor(scope, workdir), content);
      return Response.json({
        ok: true,
        scope,
        file: memoryFileFor(scope, workdir),
        chars: content.length,
      });
    }
    if (action === "reset") {
      // 重置为默认工作区的项目记忆示例内容（对齐文档：文件不存在时为空）
      writeMemoryFile(memoryFileFor(scope, workdir), "");
      return Response.json({ ok: true, scope });
    }
    return Response.json(
      { error: "action 仅支持 save / reset" },
      { status: 400 },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
