import { getMcpPool } from "@/lib/tools/mcp";
import { resetToolRegistry, resolveAgentTools } from "@/lib/tools/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 新增/删除后刷新工具注册表，返回最新状态与工具集 */
async function snapshot(pool: ReturnType<typeof getMcpPool>) {
  const servers = await pool.ensureInit();
  const tools = (await resolveAgentTools()).map((t) => t.name);
  return { servers, tools };
}

/**
 * GET /api/mcp —— MCP 连接状态与工具清单（前端面板可视化用）
 * 返回：{ servers: McpServerStatus[], tools: string[] }
 */
export async function GET() {
  try {
    const pool = getMcpPool();
    return Response.json(await snapshot(pool));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/mcp —— 新增 stdio MCP 服务器（body: { name, command, args? }）
 * 写回 mcp.json 并连接；成功后刷新工具注册表（下次工具解析含新服务器工具）。
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const name = String(body?.name ?? "").trim();
    const command = String(body?.command ?? "").trim();
    if (!MCP_NAME_RE.test(name)) {
      return Response.json(
        { error: "服务器名非法：仅允许字母/数字/下划线/连字符" },
        { status: 400 },
      );
    }
    if (!command) {
      return Response.json({ error: "command 不能为空（如 npx / uvx）" }, { status: 400 });
    }
    const args = Array.isArray(body?.args) ? body.args.map(String) : undefined;
    const pool = getMcpPool();
    await pool.addServer(name, { command, args });
    resetToolRegistry();
    return Response.json({ ok: true, ...(await snapshot(pool)) });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 409 },
    );
  }
}

/** DELETE /api/mcp?name=xxx —— 删除并断开某 stdio 服务器（同时从 mcp.json 移除） */
export async function DELETE(req: Request) {
  try {
    const name = new URL(req.url).searchParams.get("name") ?? "";
    if (!name) {
      return Response.json({ error: "name 参数缺失" }, { status: 400 });
    }
    const pool = getMcpPool();
    const removed = await pool.removeServer(name);
    if (!removed) {
      return Response.json({ error: `MCP server "${name}" 未配置` }, { status: 404 });
    }
    resetToolRegistry();
    return Response.json({ ok: true, ...(await snapshot(pool)) });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
