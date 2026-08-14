import { getMcpPool } from "@/lib/tools/mcp";
import { resolveAgentTools } from "@/lib/tools/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/mcp —— MCP 连接状态与工具清单（前端面板可视化用）
 * 返回：{ servers: McpServerStatus[], tools: string[] }
 */
export async function GET() {
  try {
    const pool = getMcpPool();
    const servers = await pool.ensureInit();
    const tools = (await resolveAgentTools()).map((t) => t.name);
    return Response.json({ servers, tools });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
