/**
 * 工作区路径与白名单（共享模块）
 * Agent 文件工具与文件浏览器的统一路径校验入口。
 * Phase 1a.3：路径基准通过 config.baseDir 注入，不再直读 process.cwd()。
 * Phase 1b：可访问根目录由 workspace 表驱动（含默认工作区 + env 一次性导入 + 后续 UI 管理）。
 */

import path from "node:path";
import { basePath } from "./config";
import { listWorkspaces, isRootAuthorized, type WorkspaceRecord } from "./workspace";

/** 权威：当前默认工作区根（config.baseDir/agent-workdir） */
export function getAgentWorkdir(): string {
  return basePath("agent-workdir");
}

/** 权威：全部可访问的工作区根（workspace 表驱动；Phase 1b 起替代 env AGENT_ALLOWED_PATHS） */
export function getAllowedRoots(): string[] {
  return listWorkspaces().map((w) => w.root);
}

// 兼容导出（默认值）：未 configure 时等于 getAgentWorkdir()/getAllowedRoots()，
// 供测试与历史导入使用；Electron 下请改用 getAgentWorkdir()/getAllowedRoots()。
// 注意：ALLOWED_ROOTS 在模块加载时即读取 workspace 表（触发一次播种），属预期行为。
export const AGENT_WORKDIR = getAgentWorkdir();
export const ALLOWED_ROOTS = getAllowedRoots();

/**
 * 解析结果（Phase 2 结构化）
 * - ok:true    路径可访问，path 为解析后的绝对路径
 * - unauthorized: 落在某工作区根内，但该工作区未授权（默认拒绝），可走授权流
 * - outside:   落在所有工作区根之外（永不授权，直接拒绝）
 */
export type ResolveResult =
  | { ok: true; path: string }
  | {
      ok: false;
      reason: "outside" | "unauthorized";
      /** unauthorized 时为所属工作区根；outside 时为 undefined */
      root?: string;
      workspaceId?: string;
    };

/**
 * 解析相对路径并校验可访问性（Phase 2 起返回结构化结果，不再抛错）。
 * 判定规则：
 * 1. 落在某个工作区根内且该工作区已授权（默认工作区恒授权）→ ok
 * 2. 落在某工作区根内但未授权 → unauthorized（需授权）
 * 3. 落在所有工作区根之外 → outside（永不授权）
 * @param relative 相对路径（可用 ../ 越界，但最终必须落在某个工作区根内）
 * @param root 基准根（缺省默认工作区）；可用于指定浏览/操作某个具体工作区
 */
export function resolveInWorkdir(relative: string, root?: string): ResolveResult {
  const base = root ? path.resolve(root) : getAgentWorkdir();
  const resolved = path.resolve(base, relative);
  const workspaces = listWorkspaces();

  // 按根路径最长匹配找到所属工作区
  let owner: WorkspaceRecord | undefined;
  let ownerLen = -1;
  for (const w of workspaces) {
    const r = w.root;
    if (resolved === r || resolved.startsWith(r + path.sep)) {
      if (r.length > ownerLen) {
        owner = w;
        ownerLen = r.length;
      }
    }
  }

  if (!owner) {
    return { ok: false, reason: "outside" };
  }
  if (!isRootAuthorized(owner)) {
    return { ok: false, reason: "unauthorized", root: owner.root, workspaceId: owner.id };
  }
  return { ok: true, path: resolved };
}

/**
 * 解析并校验，未授权/越界时抛错（工具执行层用，保持历史抛错行为）。
 * 错误消息区分「未授权」与「越界」，便于调用方/用户理解。
 */
export function resolveInWorkdirOrThrow(relative: string, root?: string): string {
  const r = resolveInWorkdir(relative, root);
  if (r.ok) return r.path;
  if (r.reason === "unauthorized") {
    throw new Error(`目录未授权: "${relative}" 位于未授权的工作区根「${r.root}」，需先授权该目录`);
  }
  throw new Error(`路径越界: "${relative}" 不在可访问的工作区根内`);
}
