/**
 * 会话管理（阶段 8）
 * 会话元数据与消息持久化到 SQLite（sessions.db），支持多会话新建/切换/恢复。
 *
 * 消息以 AgentMessage 的原始 JSON 存储（含 toolCall/toolResult 块），
 * 恢复时原样还原，保证 agent 上下文完整。
 *
 * 删除语义：单条/批量删除为软删（deleted=1 隐藏，行保留可追溯，且轮次级联）；
 * 清空/删除会话为物理删除（真删）。
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { messageText } from "./messages";
import { basePath } from "./config";

/** 会话形态：work（办公/自动化）或 coding（编码），Phase 1b 起持久化 */
export type Surface = "work" | "coding";

export interface SessionInfo {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 置顶标记：1 置顶（排序优先），0 普通 */
  pinned: number;
  /** 会话形态（创建时确定，一个会话只属于一个 surface） */
  surface: Surface;
  /** 绑定的工作目录（创建时确定；undefined = 使用默认 agent-workdir） */
  workdir?: string;
}

let db: DatabaseSync | undefined;

function getDb(): DatabaseSync {
  if (db) return db;
  const d = new DatabaseSync(basePath("sessions.db"));
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_messages
      ON session_messages(session_id, id);
  `);
  // 旧库迁移：补 pinned / surface 列（已存在则忽略）
  const cols = d.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "pinned")) {
    d.exec("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "surface")) {
    d.exec("ALTER TABLE sessions ADD COLUMN surface TEXT NOT NULL DEFAULT 'coding'");
  }
  if (!cols.some((c) => c.name === "workdir")) {
    d.exec("ALTER TABLE sessions ADD COLUMN workdir TEXT");
  }
  // 旧库迁移：消息软删标记列（deleted=1 的消息从读取视图隐藏，行保留可追溯）
  const mcols = d
    .prepare("PRAGMA table_info(session_messages)")
    .all() as { name: string }[];
  if (!mcols.some((c) => c.name === "deleted")) {
    d.exec(
      "ALTER TABLE session_messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
    );
  }
  db = d;
  return d;
}

function rowToSession(row: Record<string, unknown>): SessionInfo {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    pinned: Number(row.pinned ?? 0),
    surface: row.surface === "work" ? "work" : "coding",
    workdir: typeof row.workdir === "string" && row.workdir ? row.workdir : undefined,
  };
}

export function createSession(
  title = "新会话",
  surface: Surface = "coding",
  workdir?: string,
): SessionInfo {
  const d = getDb();
  const id = randomUUID();
  const now = Date.now();
  d.prepare(
    "INSERT INTO sessions (id, title, created_at, updated_at, pinned, surface, workdir) VALUES (?, ?, ?, ?, 0, ?, ?)",
  ).run(id, title, now, now, surface, workdir ?? null);
  return { id, title, createdAt: now, updatedAt: now, pinned: 0, surface, workdir };
}

/** 按最近更新排序的会话列表（置顶优先） */
export function listSessions(): SessionInfo[] {
  const d = getDb();
  const rows = d
    .prepare("SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export function getSession(id: string): SessionInfo | undefined {
  const d = getDb();
  const row = d
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export function renameSession(id: string, title: string): void {
  const d = getDb();
  d.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(
    title,
    Date.now(),
    id,
  );
}

/** 置顶 / 取消置顶会话（不刷新更新时间，避免干扰"最近活跃"排序） */
export function pinSession(id: string, pinned: boolean): void {
  const d = getDb();
  d.prepare("UPDATE sessions SET pinned = ? WHERE id = ?").run(
    pinned ? 1 : 0,
    id,
  );
}

/** 清空会话消息（保留会话本身，标题不变） */
export function clearSessionMessages(id: string): void {
  const d = getDb();
  d.prepare("DELETE FROM session_messages WHERE session_id = ?").run(id);
  touchSession(id);
}

/** 会话最近更新时间的"会话"行为也触发 updated_at 刷新 */
export function touchSession(id: string): void {
  const d = getDb();
  d.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
    Date.now(),
    id,
  );
}

export function deleteSession(id: string): void {
  const d = getDb();
  d.prepare("DELETE FROM session_messages WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

/** 读取会话消息并还原为 AgentMessage[]（按写入顺序，跳过已软删消息） */
export function getSessionMessages(sessionId: string): AgentMessage[] {
  const d = getDb();
  const rows = d
    .prepare(
      "SELECT content FROM session_messages WHERE session_id = ? AND deleted = 0 ORDER BY id",
    )
    .all(sessionId) as { content: string }[];
  const messages: AgentMessage[] = [];
  for (const r of rows) {
    try {
      const m = JSON.parse(r.content) as AgentMessage;
      if (m && typeof m === "object" && "role" in m && "content" in m) {
        messages.push(m);
      }
    } catch {
      /* 跳过损坏记录 */
    }
  }
  return messages;
}

/** 删除会话中的单条消息（按写入顺序的索引），返回删除后的消息列表 */
export function deleteSessionMessage(
  sessionId: string,
  index: number,
): AgentMessage[] {
  return deleteSessionMessages(sessionId, [index]);
}

/**
 * 批量软删会话消息（按未删数组索引）。
 * 轮次级联：删除点之后、下一条 user 消息之前的回复一并隐藏，
 * 保证上下文不会出现"没有提问却有回答"的断裂。返回删除后的消息列表。
 */
export function deleteSessionMessages(
  sessionId: string,
  indices: number[],
): AgentMessage[] {
  const d = getDb();
  const rows = d
    .prepare(
      "SELECT id, role FROM session_messages WHERE session_id = ? AND deleted = 0 ORDER BY id",
    )
    .all(sessionId) as { id: number; role: string }[];
  // 前端 UI 消息数组不含 toolResult（toUiMessage 过滤），先把 UI 索引映射回全量行下标
  const uiToRow: number[] = [];
  for (let k = 0; k < rows.length; k++) {
    if (rows[k].role === "user" || rows[k].role === "assistant") {
      uiToRow.push(k);
    }
  }
  const valid = [...new Set(indices)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < uiToRow.length)
    .sort((a, b) => b - a);
  if (valid.length === 0) {
    throw new Error(`没有有效的消息索引: ${indices.join(",")}`);
  }
  const toDelete = new Set<number>();
  for (const i of valid) {
    const start = uiToRow[i];
    for (let j = start; j < rows.length; j++) {
      // 下一条 user 消息（非删除点本身）是下一轮的起点，不在级联范围内
      if (j > start && rows[j].role === "user") break;
      toDelete.add(rows[j].id);
    }
  }
  const upd = d.prepare("UPDATE session_messages SET deleted = 1 WHERE id = ?");
  for (const id of toDelete) upd.run(id);
  touchSession(sessionId);
  return getSessionMessages(sessionId);
}

/** 全量替换会话消息（简单可靠，会话消息量经压缩控制在合理范围；软删行保留） */
export function saveSessionMessages(
  sessionId: string,
  messages: AgentMessage[],
): void {
  const d = getDb();
  d.exec("BEGIN");
  try {
    // 只物理删除未软删的行，deleted=1 的历史行保留（软删可追溯，行 id 保持稳定）
    d.prepare("DELETE FROM session_messages WHERE session_id = ? AND deleted = 0").run(
      sessionId,
    );
    const ins = d.prepare(
      "INSERT INTO session_messages (session_id, role, content, ts) VALUES (?, ?, ?, ?)",
    );
    const now = Date.now();
    for (const m of messages) {
      ins.run(sessionId, m.role, JSON.stringify(m), m.timestamp ?? now);
    }
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
  touchSession(sessionId);
}

export interface SearchHit {
  sessionId: string;
  title: string;
  snippet: string;
}

/** 在会话消息内容中搜索关键词，返回命中的会话与片段（每个会话最多 1 条，按最新命中） */
export function searchSessionMessages(
  query: string,
  limit = 20,
): SearchHit[] {
  // 转义 LIKE 通配符，使用户输入的 % / _ 按字面匹配而非通配
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  const q = `%${escaped}%`;
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT m.session_id AS sid, s.title AS title, m.content AS content
       FROM session_messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.content LIKE ? ESCAPE '\\' AND m.deleted = 0
       ORDER BY m.id DESC
       LIMIT 300`,
    )
    .all(q) as { sid: string; title: string; content: string }[];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.sid) || hits.length >= limit) continue;
    let text = "";
    try {
      text = messageText(JSON.parse(r.content) as AgentMessage);
    } catch {
      continue;
    }
    if (!text) continue;
    const idx = text.indexOf(query);
    if (idx < 0) continue;
    const start = Math.max(0, idx - 30);
    const snippet =
      (start > 0 ? "…" : "") + text.slice(start, idx + query.length + 60);
    seen.add(r.sid);
    hits.push({ sessionId: r.sid, title: r.title, snippet });
  }
  return hits;
}

/** 导出全部会话与消息（供备份恢复，保留 id/时间/置顶） */
export function dumpAllSessions(): {
  sessions: SessionInfo[];
  messagesBySession: Record<string, AgentMessage[]>;
} {
  const sessions = listSessions();
  const messagesBySession: Record<string, AgentMessage[]> = {};
  for (const s of sessions) {
    messagesBySession[s.id] = getSessionMessages(s.id);
  }
  return { sessions, messagesBySession };
}

/** 清空并重建会话库（事务），返回导入的会话数 */
export function restoreAllSessions(
  sessions: SessionInfo[],
  messagesBySession: Record<string, AgentMessage[]>,
): number {
  const d = getDb();
  d.exec("BEGIN");
  try {
    d.exec("DELETE FROM session_messages");
    d.exec("DELETE FROM sessions");
    const insS = d.prepare(
      "INSERT INTO sessions (id, title, created_at, updated_at, pinned, surface, workdir) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insM = d.prepare(
      "INSERT INTO session_messages (session_id, role, content, ts) VALUES (?, ?, ?, ?)",
    );
    for (const s of sessions) {
      insS.run(
        s.id,
        s.title,
        s.createdAt,
        s.updatedAt,
        s.pinned ?? 0,
        s.surface ?? "coding",
        s.workdir ?? null,
      );
      for (const m of messagesBySession[s.id] ?? []) {
        insM.run(s.id, m.role, JSON.stringify(m), m.timestamp ?? Date.now());
      }
    }
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
  return sessions.length;
}
