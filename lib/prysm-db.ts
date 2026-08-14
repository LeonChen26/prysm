/**
 * prysm.db 共享连接（Phase 2）
 * 配置与授权类数据集中管理：workspace / policy 等表共用一个 SQLite 连接，
 * 不再散建多个 DB 文件（audit.db / sessions.db / agent-memory.db / todo.db 维持独立）。
 * 位置经 config.basePath 参数化（Web=process.cwd()，Electron=userData）。
 */

import { DatabaseSync } from "node:sqlite";
import { basePath } from "./config";

let db: DatabaseSync | undefined;

/** 共享的 prysm.db 连接（建表一次，幂等） */
export function getPrysmDb(): DatabaseSync {
  if (db) return db;
  const d = new DatabaseSync(basePath("prysm.db"));
  d.exec(`
    CREATE TABLE IF NOT EXISTS workspace (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      authorized INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS policy (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_policy_kind ON policy(kind);
    CREATE TABLE IF NOT EXISTS model_route (
      role TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db = d;
  return d;
}

/** 测试专用：关闭并丢弃连接，下次调用按新 baseDir 重建 */
export function resetPrysmDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* 忽略关闭异常 */
    }
    db = undefined;
  }
}
