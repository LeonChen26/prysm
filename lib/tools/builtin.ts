import type { AgentTool } from "@earendil-works/pi-agent-core";
import { tools as builtinTools } from "../tools";
import type { ToolProvider } from "./registry";

/**
 * 内置工具 provider（Phase 1a.1）
 * 现有 18 个工具（lib/tools.ts）原样迁入，load() 返回同步数组的 Promise。
 */

/** spawn_subagent 占位（Phase 5 实现）——通过延迟注入 factory 打破 tools↔agent 循环依赖 */
export interface SubagentFactory {
  (params: {
    task: string;
    capability: "readonly" | "readwrite";
    surface?: "work" | "coding";
  }): Promise<{ summary: string }>;
}

export const builtinProvider: ToolProvider = {
  id: "builtin",
  async load(): Promise<AgentTool[]> {
    return builtinTools;
  },
};
