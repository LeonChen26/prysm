import type { AgentTool } from "@earendil-works/pi-agent-core";
import { TOOL_META } from "../tool-meta";
import { builtinProvider } from "./builtin";
import { mcpToolProviders } from "./mcp";
import { skillToolProvider } from "./skill";
import { initSkills } from "../skills";

/**
 * 工具注册表（Phase 1a.1）
 * 把「工具从哪来」与「工具怎么执行」解耦：
 * - 内置工具（builtin）、MCP 工具、Skill 工具各自实现 ToolProvider；
 * - resolve() 聚合所有 provider 的工具，同名冲突时后注册者覆盖；
 * - resolve(filter) 预留 surface/capability 筛选，Phase 5 子 agent 按此取只读/读写工具集。
 *
 * 说明：未在 TOOL_META 中登记的工具（未来 MCP/Skill 工具）默认不被 filter 剔除，
 * 其 capability/surface 元数据由各自 provider 在后续 Phase 补充。
 */

export interface ToolProvider {
  id: string; // builtin / mcp:<server> / skill:<name>
  load(): Promise<AgentTool[]>;
}

export interface ToolFilter {
  surface?: "work" | "coding";
  capability?: "readonly" | "readwrite";
}

export class ToolRegistry {
  private providers: ToolProvider[] = [];

  register(provider: ToolProvider): void {
    this.providers.push(provider);
  }

  async resolve(filter?: ToolFilter): Promise<AgentTool[]> {
    const byName = new Map<string, AgentTool>();
    const order: string[] = [];

    for (const provider of this.providers) {
      const tools = await provider.load();
      for (const tool of tools) {
        if (!byName.has(tool.name)) order.push(tool.name);
        byName.set(tool.name, tool); // 同名冲突：后注册者覆盖
      }
    }

    let result = order.map((name) => byName.get(name)!);
    if (filter) result = result.filter((tool) => matchesFilter(tool, filter));
    return result;
  }
}

function matchesFilter(tool: AgentTool, filter: ToolFilter): boolean {
  const meta = TOOL_META[tool.name];
  if (filter.capability && meta?.capability && meta.capability !== filter.capability) {
    return false;
  }
  if (filter.surface && meta?.surface && meta.surface !== filter.surface) {
    return false;
  }
  return true;
}

// ------------------------------------------------------------ 默认注册表

/** 默认注册表（builtin + 已连接 MCP server + 后续 Skill），供 Agent 构造与筛选 */
const defaultRegistry = new ToolRegistry();
let registryInitialized = false;

/** 幂等初始化默认注册表：builtin 优先，再注册已连接的 MCP server 与 enabled Skill 工具 */
export async function initToolRegistry(): Promise<void> {
  if (registryInitialized) return;
  registryInitialized = true;
  defaultRegistry.register(builtinProvider);
  for (const p of await mcpToolProviders()) defaultRegistry.register(p);
  // Phase 4：Skill 工具（先登记 skill，保证已登记技能就绪；同名由 builtin/MCP 实现兜底）
  initSkills();
  defaultRegistry.register(await skillToolProvider());
}

/** 解析 Agent 工具集（含 MCP 工具；未初始化时先初始化） */
export async function resolveAgentTools(filter?: ToolFilter): Promise<AgentTool[]> {
  await initToolRegistry();
  return defaultRegistry.resolve(filter);
}

/** 仅用于测试：重置默认注册表（下次 resolve 重新初始化） */
export function resetToolRegistry(): void {
  registryInitialized = false;
  (defaultRegistry as unknown as { providers: ToolProvider[] }).providers = [];
}
