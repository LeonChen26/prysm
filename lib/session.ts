/**
 * 会话管理（阶段 8）
 * 会话元数据与消息持久化到 SQLite（sessions.db），支持多会话新建/切换/恢复。
 *
 * 消息以 AgentMessage 的原始 JSON 存储（含 toolCall/toolResult 块），
 * 恢复时原样还原，保证 agent 上下文完整。
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const SESSIONS_DB = path.resolve(process.cwd(), "sessions.db");

export interface SessionInfo {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

let db: DatabaseSync | undefined;

function getDb(): DatabaseSync {
  if (db) return db;
  const d = new DatabaseSync(SESSIONS_DB);
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
  db = d;
  return d;
}

function rowToSession(row: Record<string, unknown>): SessionInfo {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function createSession(title = "新会话"): SessionInfo {
  const d = getDb();
  const id = randomUUID();
  const now = Date.now();
  d.prepare(
    "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(id, title, now, now);
  return { id, title, createdAt: now, updatedAt: now };
}

/** 按最近更新排序的会话列表 */
export function listSessions(): SessionInfo[] {
  const d = getDb();
  const rows = d
    .prepare("SELECT * FROM sessions ORDER BY updated_at DESC")
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
