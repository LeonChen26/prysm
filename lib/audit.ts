/**
 * 审批历史审计
 * 记录每次敏感工具审批的决定（同意 / 拒绝 / 超时），持久化到 audit.db，可回溯。
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const AUDIT_DB = path.resolve(process.cwd(), "audit.db");

export type AuditAction = "approved" | "denied" | "timeout";

export interface AuditRecord {
  id: number;
  toolName: string;
  args: string;
  action: AuditAction;
  ts: number;
}

let db: DatabaseSync | undefined;

function getDb(): DatabaseSync {
  if (db) return db;
  const d = new DatabaseSync(AUDIT_DB);
  d.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      args TEXT,
      action TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);
  db = d;
  return d;
}

/** 记录一条审批决定（args 截断到 500 字符） */
export function logApproval(
  toolName: string,
  args: unknown,
  action: AuditAction,
): void {
  try {
    const argsText = JSON.stringify(args ?? {});
    getDb()
      .prepare(
        "INSERT INTO approvals (tool_name, args, action, ts) VALUES (?, ?, ?, ?)",
      )
      .run(toolName, argsText.slice(0, 500), action, Date.now());
  } catch (err) {
    console.error("[audit] 写入失败:", err);
  }
}

/** 最近审批记录（新在前） */
export function listApprovals(limit = 50): AuditRecord[] {
  const rows = getDb()
    .prepare(
      "SELECT id, tool_name AS toolName, args, action, ts FROM approvals ORDER BY id DESC LIMIT ?",
    )
    .all(limit) as unknown as AuditRecord[];
  return rows;
}

/** 审批记录总数 */
export function countApprovals(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM approvals")
    .get() as { n: number };
  return row.n;
}

/** 清空审批历史 */
export function clearApprovals(): number {
  const d = getDb();
  const before = d.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number };
  d.exec("DELETE FROM approvals");
  return before.n;
}
