/**
 * 审批历史审计
 * 记录每次敏感工具审批的决定，持久化到 audit.db，可回溯。
 * 动作分类：approved（同意）/ denied（拒绝）/ timeout（超时）/ denied_auto（策略拦截）/
 *           auto（白名单自动放行）。
 */

import { DatabaseSync } from "node:sqlite";
import { basePath } from "./config";

export type AuditAction =
  | "approved"
  | "denied"
  | "timeout"
  | "denied_auto"
  | "auto";

export interface AuditRecord {
  id: number;
  toolName: string;
  args: string;
  action: AuditAction;
  ts: number;
  /** 关联的会话 id（多会话并发时用于定位） */
  sessionId?: string;
  /** 审批时的风险等级 */
  risk?: string;
  /** 命中原因 / 策略说明（如拦截原因、自动放行规则） */
  reason?: string;
}

export interface AuditFilter {
  tool?: string;
  action?: AuditAction;
  offset?: number;
}

let db: DatabaseSync | undefined;

function getDb(): DatabaseSync {
  if (db) return db;
  const d = new DatabaseSync(basePath("audit.db"));
  d.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      args TEXT,
      action TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);
  // 增量迁移：老库补充新列（幂等，列已存在时静默跳过）
  const cols = new Set(
    (d.prepare("PRAGMA table_info(approvals)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (!cols.has("session_id")) d.exec("ALTER TABLE approvals ADD COLUMN session_id TEXT");
  if (!cols.has("risk")) d.exec("ALTER TABLE approvals ADD COLUMN risk TEXT");
  if (!cols.has("reason")) d.exec("ALTER TABLE approvals ADD COLUMN reason TEXT");
  db = d;
  return d;
}

/** 常见密钥字段名：命中即脱敏 */
const SECRET_KEY_RE = /token|secret|password|passwd|apikey|api_key|key|authorization|cookie|credential/i;

/**
 * 序列化工具参数并脱敏：
 * - key 命中密钥命名 → 值替换为 [redacted]
 * - 文本中内嵌的长密钥串（如 sk-xxx）也一并打码
 */
export function redactArgs(args: unknown): string {
  const redact = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      if (key && SECRET_KEY_RE.test(key)) return "[redacted]";
      return value.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "sk-[redacted]");
    }
    if (Array.isArray(value)) return value.map((v) => redact(v));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = redact(v, k);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(redact(args ?? {}));
}

/** 记录一条审批决定（args 脱敏并截断到 500 字符） */
export function logApproval(
  toolName: string,
  args: unknown,
  action: AuditAction,
  opts: { sessionId?: string; risk?: string; reason?: string } = {},
): void {
  try {
    const argsText = redactArgs(args);
    getDb()
      .prepare(
        "INSERT INTO approvals (tool_name, args, action, ts, session_id, risk, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        toolName,
        argsText.slice(0, 500),
        action,
        Date.now(),
        opts.sessionId ?? null,
        opts.risk ?? null,
        opts.reason ?? null,
      );
  } catch (err) {
    console.error("[audit] 写入失败:", err);
  }
}

function whereClause(filter: AuditFilter): { where: string; params: string[] } {
  const conds: string[] = [];
  const params: string[] = [];
  if (filter.tool) {
    conds.push("tool_name = ?");
    params.push(filter.tool);
  }
  if (filter.action) {
    conds.push("action = ?");
    params.push(filter.action);
  }
  return { where: conds.length ? " WHERE " + conds.join(" AND ") : "", params };
}

/** 最近审批记录（新在前），支持按工具/动作筛选与分页 */
export function listApprovals(limit = 50, filter: AuditFilter = {}): AuditRecord[] {
  const { where, params } = whereClause(filter);
  const rows = getDb()
    .prepare(
      `SELECT id, tool_name AS toolName, args, action, ts,
              session_id AS sessionId, risk, reason
       FROM approvals${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, filter.offset ?? 0) as unknown as AuditRecord[];
  return rows;
}

/** 审批记录总数（可按筛选条件计数） */
export function countApprovals(filter: AuditFilter = {}): number {
  const { where, params } = whereClause(filter);
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM approvals${where}`)
    .get(...params) as { n: number };
  return row.n;
}

/** 清空审批历史 */
export function clearApprovals(): number {
  const d = getDb();
  const before = d.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number };
  d.exec("DELETE FROM approvals");
  return before.n;
}
