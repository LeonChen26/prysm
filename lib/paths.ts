/**
 * 工作区路径与白名单（共享模块）
 * Agent 文件工具与文件浏览器的统一路径校验入口。
 */

import path from "node:path";

/** 所有文件工具的作用域：项目下的 agent-workdir 目录 */
export const AGENT_WORKDIR = path.resolve(process.cwd(), "agent-workdir");

/** 额外可访问的根目录白名单（AGENT_ALLOWED_PATHS，逗号分隔的绝对或相对路径） */
export const ALLOWED_ROOTS = (process.env.AGENT_ALLOWED_PATHS ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => path.resolve(p));

/** 解析相对路径并校验在工作区内（或白名单根目录下），越界抛错 */
export function resolveInWorkdir(relative: string): string {
  const resolved = path.resolve(AGENT_WORKDIR, relative);
  if (
    resolved !== AGENT_WORKDIR &&
    !resolved.startsWith(AGENT_WORKDIR + path.sep)
  ) {
    // 不在工作区内：检查是否落在白名单根目录下
    const insideAllowed = ALLOWED_ROOTS.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    );
    if (!insideAllowed) {
      throw new Error(`路径越界: "${relative}" 不在 agent-workdir 内`);
    }
  }
  return resolved;
}
