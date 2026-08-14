/**
 * Skill 工具 provider（Phase 4）
 * 按 enabled 技能声明的 tools 名单，从内置工具与 MCP 工具集中筛选并暴露同名工具。
 * 语义：启用某技能 → 其声明所需/可选用的工具进入 Agent 工具集（供 Phase 5 按技能强制注入）。
 * 不新增工具实现；skill 专属工具（skill__<name>__<tool>）预留后续版本。
 *
 * 注意：本模块依赖 registry/builtin/mcp 形成的工具集，且 registry 的初始化
 * （initToolRegistry）会注册本 provider —— 通过延迟构造避免循环依赖。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolProvider } from "./registry";
import { tools as builtinTools } from "../tools";
import { mcpToolProviders } from "./mcp";
import { enabledSkillTools } from "../skills";

/**
 * 构造 Skill 工具 provider：load() 时返回 enabled 技能声明的工具实现
 * （同名暴露，实现取自内置工具与已连接 MCP server 的工具集）。
 */
export async function skillToolProvider(): Promise<ToolProvider> {
  return {
    id: "skill",
    async load(): Promise<AgentTool[]> {
      // 每次 load 重新计算，保证启用/禁用即时生效（不缓存快照）
      const required = enabledSkillTools();
      if (required.length === 0) return [];
      const byName = new Map<string, AgentTool>();
      for (const t of builtinTools) byName.set(t.name, t);
      for (const p of await mcpToolProviders()) {
        for (const t of await p.load()) byName.set(t.name, t);
      }
      return required
        .map((n) => byName.get(n))
        .filter((t): t is AgentTool => Boolean(t));
    },
  };
}
