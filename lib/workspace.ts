/**
 * 工作区数据模型（Phase 1b）
 * workspace 表落 prysm.db（baseDir 参数化），管理全部可访问的工作区根目录：
 * - 首次启动播种默认工作区（agent-workdir）
 * - 从 env AGENT_ALLOWED_PATHS 一次性导入（仅当表为空时；导入后 env 只读兼容，不再作为权威来源）
 * - 后续由 UI / API 增删（Phase 1b+），Phase 2 追加目录授权状态（authorized，默认拒绝）
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { basePath, envValue } from "./config";
import { getPrysmDb } from "./prysm-db";

export interface WorkspaceRecord {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  /** 目录授权状态（0 未授权 / 1 已授权），Phase 2 使用 */
  authorized: number;
}

/** 默认工作区根（与 paths.getAgentWorkdir 同源；独立计算避免 paths↔workspace 循环依赖） */
export function getDefaultWorkspaceRoot(): string {
  return basePath("agent-workdir");
}

let seeded = false;

function getDb(): DatabaseSync {
  const d = getPrysmDb();
  if (!seeded) {
    seed(d);
    // Phase 2 自愈：默认工作区恒授权（兼容旧库遗留 authorized=0）
    d.prepare(
      "UPDATE workspace SET authorized = 1 WHERE id = 'default' AND authorized = 0",
    ).run();
    seeded = true;
  }
  return d;
}

/** env AGENT_ALLOWED_PATHS 读出的根目录（逗号分隔，去空白、去重、解析为绝对路径） */
function envAllowedRoots(): string[] {
  return [
    ...new Set(
      (envValue("AGENT_ALLOWED_PATHS") ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => path.resolve(p)),
    ),
  ];
}

/** 首次播种：表为空时写入默认工作区（内置沙箱，默认授权）+ 一次性导入 env 白名单 */
function seed(d: DatabaseSync): void {
  const row = d.prepare("SELECT COUNT(*) AS c FROM workspace").get() as {
    c: number;
  };
  if (row.c > 0) return;
  const now = Date.now();
  const insert = d.prepare(
    "INSERT INTO workspace (id, name, root, created_at, authorized) VALUES (?, ?, ?, ?, ?)",
  );
  // 默认工作区（agent-workdir）为内置沙箱，Phase 2 起默认授权
  insert.run("default", "默认工作区", getDefaultWorkspaceRoot(), now, 1);
  for (const root of envAllowedRoots()) {
    insert.run(randomUUID(), path.basename(root) || root, root, now, 0);
  }
}

function rowToWorkspace(row: Record<string, unknown>): WorkspaceRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    root: String(row.root),
    createdAt: Number(row.created_at),
    authorized: Number(row.authorized ?? 0),
  };
}

/** 全部工作区（默认工作区在最前） */
export function listWorkspaces(): WorkspaceRecord[] {
  const d = getDb();
  const rows = d
    .prepare("SELECT * FROM workspace ORDER BY created_at ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToWorkspace);
}

export function getWorkspace(id: string): WorkspaceRecord | undefined {
  const d = getDb();
  const row = d.prepare("SELECT * FROM workspace WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToWorkspace(row) : undefined;
}

export function getWorkspaceByRoot(root: string): WorkspaceRecord | undefined {
  const d = getDb();
  const row = d
    .prepare("SELECT * FROM workspace WHERE root = ?")
    .get(path.resolve(root)) as Record<string, unknown> | undefined;
  return row ? rowToWorkspace(row) : undefined;
}

/** 新增工作区（root 已存在则返回现有记录） */
export function addWorkspace(root: string, name?: string): WorkspaceRecord {
  const existing = getWorkspaceByRoot(root);
  if (existing) return existing;
  const resolved = path.resolve(root);
  const now = Date.now();
  const id = randomUUID();
  const finalName = name?.trim() || path.basename(resolved) || resolved;
  getDb()
    .prepare(
      "INSERT INTO workspace (id, name, root, created_at, authorized) VALUES (?, ?, ?, ?, 0)",
    )
    .run(id, finalName, resolved, now);
  return { id, name: finalName, root: resolved, createdAt: now, authorized: 0 };
}

/** 删除工作区（默认工作区不可删除） */
export function removeWorkspace(id: string): void {
  if (id === "default") return;
  getDb().prepare("DELETE FROM workspace WHERE id = ?").run(id);
}

/** 默认工作区记录（种子第一条；不存在时兜底默认值） */
export function getDefaultWorkspace(): WorkspaceRecord {
  const w = getWorkspace("default");
  if (w) return w;
  return {
    id: "default",
    name: "默认工作区",
    root: getDefaultWorkspaceRoot(),
    createdAt: 0,
    authorized: 0,
  };
}

/**
 * 目录授权（Phase 2，默认拒绝）
 * 默认工作区（内置沙箱）恒为已授权；其余工作区首次访问需授权（authorized=1）后方可读写。
 */

/** 授权某工作区（可访问其根目录），返回更新后的记录 */
export function grantWorkspaceAccess(id: string): WorkspaceRecord | undefined {
  const w = getWorkspace(id);
  if (!w) return undefined;
  getDb().prepare("UPDATE workspace SET authorized = 1 WHERE id = ?").run(id);
  return { ...w, authorized: 1 };
}

/** 撤销某工作区授权（默认工作区不可撤销，保持恒可访问） */
export function revokeWorkspaceAccess(id: string): WorkspaceRecord | undefined {
  if (id === "default") return getDefaultWorkspace();
  const w = getWorkspace(id);
  if (!w) return undefined;
  getDb().prepare("UPDATE workspace SET authorized = 0 WHERE id = ?").run(id);
  return { ...w, authorized: 0 };
}

/** 设置授权状态（authorized 布尔），默认工作区忽略撤销请求 */
export function setWorkspaceAuthorized(
  id: string,
  authorized: boolean,
): WorkspaceRecord | undefined {
  return authorized ? grantWorkspaceAccess(id) : revokeWorkspaceAccess(id);
}

/** 记录级授权判定：默认工作区恒授权，其余看 authorized 字段 */
export function isRootAuthorized(w: WorkspaceRecord): boolean {
  return w.id === "default" || w.authorized === 1;
}

/** 按根目录查授权：命中工作区且已授权返回 true；未命中（不在任何工作区根内）返回 false */
export function isWorkspaceRootAuthorized(root: string): boolean {
  const w = getWorkspaceByRoot(root);
  return w ? isRootAuthorized(w) : false;
}
