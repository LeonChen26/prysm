/**
 * 会话管理（阶段 8）
 * 会话元数据与消息持久化到 SQLite（sessions.db），支持多会话新建/切换/恢复。
 *
 * 消息以 AgentMessage 的原始 JSON 存储（含 toolCall/toolResult 块），
 * 恢复时原样还原，保证 agent 上下文完整。
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

/** 读取会话消息并还原为 AgentMessage[]（按写入顺序） */
export function getSessionMessages(sessionId: string): AgentMessage[] {
  const d = getDb();
  const rows = d
    .prepare(
      "SELECT content FROM session_messages WHERE session_id = ? ORDER BY id",
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

/** 批量删除会话消息（按索引，自动从大到小避免错位），返回删除后的消息列表 */
export function deleteSessionMessages(
  sessionId: string,
  indices: number[],
): AgentMessage[] {
  const messages = getSessionMessages(sessionId);
  const sorted = [...new Set(indices)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < messages.length)
    .sort((a, b) => b - a);
  if (sorted.length === 0) {
    throw new Error(`没有有效的消息索引: ${indices.join(",")}`);
  }
  for (const i of sorted) messages.splice(i, 1);
  saveSessionMessages(sessionId, messages);
  return messages;
}

/** 全量替换会话消息（简单可靠，会话消息量经压缩控制在合理范围） */
export function saveSessionMessages(
  sessionId: string,
  messages: AgentMessage[],
): void {
  const d = getDb();
  d.prepare("DELETE FROM session_messages WHERE session_id = ?").run(sessionId);
  const ins = d.prepare(
    "INSERT INTO session_messages (session_id, role, content, ts) VALUES (?, ?, ?, ?)",
  );
  const now = Date.now();
  for (const m of messages) {
    ins.run(sessionId, m.role, JSON.stringify(m), m.timestamp ?? now);
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
  const q = `%${query}%`;
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT m.session_id AS sid, s.title AS title, m.content AS content
       FROM session_messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.content LIKE ?
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
