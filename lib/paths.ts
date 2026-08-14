/**
 * 工作区路径与白名单（共享模块）
 * Agent 文件工具与文件浏览器的统一路径校验入口。
 * Phase 1a.3：路径基准通过 config.baseDir 注入，不再直读 process.cwd()。
 * Phase 1b：可访问根目录由 workspace 表驱动（含默认工作区 + env 一次性导入 + 后续 UI 管理）。
 * 安全加固：通过 realpath 解析符号链接，防止工作区内的符号链接指向沙箱外部。
 */

import fs from "node:fs";
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
 * 安全兜底：对已存在的路径组件解析 realpath，防止通过工作区内的符号链接
 *   跳出沙箱（例如 `workdir/evil-symlink -> /etc`，字符串层面在工作区内，
 *   但 realpath 已跳至外部）。
 * @param relative 相对路径（可用 ../ 越界，但最终必须落在某个工作区根内）
 * @param root 基准根（缺省默认工作区）；可用于指定浏览/操作某个具体工作区
 */
export function resolveInWorkdir(relative: string, root?: string): ResolveResult {
  const base = root ? path.resolve(root) : getAgentWorkdir();
  const resolved = path.resolve(base, relative);
  const workspaces = listWorkspaces();

  // 第 1 步：字符串层面匹配工作区根（处理 nonexistent 路径，避免 realpath 抛 ENOENT 的必要前置）
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

  // 第 2 步（安全加固）：解析已存在组件的真实路径，再次校验沙箱边界
  // - 解析失败（EACCES / 循环链等）一律保守处理为 outside
  const realResolved = resolveExistingRealpath(resolved);
  if (realResolved === null) {
    return { ok: false, reason: "outside" };
  }
  // 如果 realpath 与字符串解析结果不同，必须重新校验所属工作区
  if (realResolved !== resolved) {
    let realOwner: WorkspaceRecord | undefined;
    let realOwnerLen = -1;
    for (const w of workspaces) {
      const r = w.root;
      if (realResolved === r || realResolved.startsWith(r + path.sep)) {
        if (r.length > realOwnerLen) {
          realOwner = w;
          realOwnerLen = r.length;
        }
      }
    }
    if (!realOwner) {
      return { ok: false, reason: "outside" };
    }
    owner = realOwner;
  }

  if (!isRootAuthorized(owner)) {
    return { ok: false, reason: "unauthorized", root: owner.root, workspaceId: owner.id };
  }
  // 当存在符号链接时，返回 realpath，确保后续 fs.* 调用实际操作的是已经过校验的路径
  return { ok: true, path: realResolved };
}

/**
 * 对路径中已存在的组件做 realpath 解析；不存在的组件保持原样拼回。
 * 解析失败（EACCES / ELOOP 等）时返回 null —— 调用方应按"越界"保守处理。
 */
function resolveExistingRealpath(target: string): string | null {
  try {
    if (fs.existsSync(target)) {
      // fs.realpathSync.native 使用原生系统调用（不进行 JS 层规范化），
      // 可正确解析跨目录符号链接，并在 Windows 上给出稳定的真实路径。
      try {
        return (fs.realpathSync as typeof fs.realpathSync & {
          native?: (p: string) => string;
        }).native?.(target) ?? fs.realpathSync(target);
      } catch {
        return fs.realpathSync(target);
      }
    }
  } catch {
    return null;
  }

  // 目标不存在：向上找到第一个存在的父目录，解析其 realpath，再拼回剩余尾巴
  let cursor = target;
  const tails: string[] = [];
  while (true) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      // 已爬到根都不存在，返回原字符串（交由字符串层面判定）
      return target;
    }
    tails.push(path.basename(cursor));
    try {
      if (fs.existsSync(parent)) {
        let parentReal: string;
        try {
          parentReal =
            (fs.realpathSync as typeof fs.realpathSync & {
              native?: (p: string) => string;
            }).native?.(parent) ?? fs.realpathSync(parent);
        } catch {
          parentReal = fs.realpathSync(parent);
        }
        tails.reverse();
        return path.join(parentReal, ...tails);
      }
    } catch {
      return null;
    }
    cursor = parent;
  }
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
