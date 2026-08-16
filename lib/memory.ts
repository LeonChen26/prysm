import { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { messageText } from "./messages";
import { basePath, envValue } from "./config";

/**
 * 情景记忆（阶段 4）
 * 存储原始 episode（对话轨迹），检索时用 BM25 全文匹配注入上下文。
 * 参考 MemMachine 的 ground-truth-preserving 思路：保存原始记录，
 * 不依赖 LLM 反复提取，降低累积误差与成本。
 *
 * 存储：Node 内置 SQLite + FTS5（零额外依赖）
 * 中文检索：写入时在中文字符间插空格，让 unicode61 按字符分词
 */

/** 每轮检索返回的最大 episode 数（惰性读 env，支持配置注入） */
export function memoryRecallK(): number {
  return Number(envValue("MEMORY_RECALL_K") ?? 5);
}
/** 每条 episode 注入时截断的最大字符数 */
const MAX_CHARS_PER_EPISODE = 200;

let db: DatabaseSync | undefined;
/** 记录已写入的会话消息条数，避免每次全量扫描 */
let lastStoredCount = 0;

function getDb(): DatabaseSync {
  if (db) return db;
  const d = new DatabaseSync(basePath("agent-memory.db"));
  d.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL,
      UNIQUE(role, content)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(content, tokenize='unicode61');
  `);
  db = d;
  return d;
}

/** 中文之间插空格，使 FTS 按字符分词 */
function tokenizeForFts(text: string): string {
  return text
    .replace(/([\u4e00-\u9fff\u3000-\u303f])/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 检索时的中文停用词（无信息量的通用词） */
const STOPWORDS = new Set([
  "你", "我", "他", "她", "它", "的", "了", "吗", "呢", "吧", "啊", "在",
  "是", "有", "和", "与", "或", "什么", "怎么", "哪些", "哪个", "记得",
  "之前", "然后", "现在", "一个", "这个", "那个", "可以", "请", "还",
  "让", "把", "对", "就", "都", "也", "要", "会", "能", "被", "给",
  "上", "下", "中", "过", "做", "想", "看", "问",
]);

/** 提取查询关键词：去停用词，最多保留 TOP_N 个 */
function queryTokens(query: string, topN = 8): string[] {
  return tokenizeForFts(query)
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .slice(0, topN);
}

/** FTS5 MATCH 短语转义：去掉双引号与 NEAR 等语法残留，防止含引号查询抛 SQL 错误 */
function ftsPhrase(token: string): string {
  return `"${token.replace(/"/g, " ").trim()}"`;
}

/** 批量写入 episode（按 role+content 去重），返回新增条数 */
export function rememberMessages(messages: AgentMessage[]): number {
  const d = getDb();
  const ins = d.prepare(
    "INSERT OR IGNORE INTO episodes (role, content, ts) VALUES (?, ?, ?)",
  );
  const insFts = d.prepare(
    "INSERT OR IGNORE INTO episodes_fts (rowid, content) VALUES (?, ?)",
  );
  let stored = 0;
  d.exec("BEGIN");
  try {
    for (const m of messages) {
      const text = messageText(m).trim();
      if (!text) continue;
      const r = ins.run(m.role, text, m.timestamp ?? Date.now());
      if (r.changes > 0) {
        insFts.run(Number(r.lastInsertRowid), tokenizeForFts(text));
        stored++;
      }
    }
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
  return stored;
}

/** 只写入会话中新增的消息（基于已存条数增量），返回新增条数 */
export function rememberNewMessages(messages: AgentMessage[]): number {
  if (messages.length <= lastStoredCount) return 0;
  const newOnes = messages.slice(lastStoredCount);
  lastStoredCount = messages.length;
  return rememberMessages(newOnes);
}

/** 会话重置时同步重置增量指针 */
export function resetMemoryTracking(): void {
  lastStoredCount = 0;
}

/** 检索命中的单条情景记忆明细 */
export interface MemoryHit {
  role: string;
  content: string;
  ts: number;
}

/** 按查询检索相关历史 episode，返回命中明细（无结果返回空数组） */
export function retrieveEpisodeDetails(
  query: string,
  k = memoryRecallK(),
): MemoryHit[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  // OR 匹配 + BM25 排序：让包含更多关键词的 episode 排前（token 经 ftsPhrase 转义防语法错误）
  const match = tokens.map(ftsPhrase).join(" OR ");
  return getDb()
    .prepare(
      `SELECT e.role, e.content, e.ts
       FROM episodes_fts JOIN episodes e ON e.id = episodes_fts.rowid
       WHERE episodes_fts MATCH ?
       ORDER BY bm25(episodes_fts)
       LIMIT ?`,
    )
    .all(match, k) as unknown as MemoryHit[];
}

/** 按查询检索相关历史 episode，返回拼接文本（无结果返回空串） */
export function retrieveEpisodes(query: string, k = memoryRecallK()): string {
  const rows = retrieveEpisodeDetails(query, k);
  if (rows.length === 0) return "";
  return rows
    .map((r) => `[${r.role}] ${r.content.slice(0, MAX_CHARS_PER_EPISODE)}`)
    .join("\n");
}

/** 当前记忆库中的 episode 总数（调试用） */
export function countEpisodes(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM episodes")
    .get() as { n: number };
  return row.n;
}

export interface MemoryEpisode {
  id: number;
  role: string;
  content: string;
  ts: number;
}

/** 分页列出记忆条目（最新在前） */
export function listEpisodes(limit = 50, offset = 0): MemoryEpisode[] {
  const rows = getDb()
    .prepare(
      "SELECT id, role, content, ts FROM episodes ORDER BY id DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset) as {
    id: number;
    role: string;
    content: string;
    ts: number;
  }[];
  return rows;
}

/** 删除单条记忆（同时清理 FTS 索引） */
export function deleteEpisode(id: number): boolean {
  const d = getDb();
  const r = d.prepare("DELETE FROM episodes WHERE id = ?").run(id);
  d.prepare("DELETE FROM episodes_fts WHERE rowid = ?").run(id);
  return r.changes > 0;
}

/** 清空全部记忆（含 FTS 索引） */
export function clearEpisodes(): number {
  const d = getDb();
  const before = d.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number };
  d.exec("DELETE FROM episodes_fts");
  d.exec("DELETE FROM episodes");
  return before.n;
}

/** 导出全部记忆（供备份恢复） */
export function dumpEpisodes(): MemoryEpisode[] {
  return listEpisodes(10_000, 0);
}

/** 清空并重建记忆库（事务），保留原 id 与时间，返回导入条数 */
export function restoreEpisodes(episodes: MemoryEpisode[]): number {
  const d = getDb();
  d.exec("BEGIN");
  try {
    d.exec("DELETE FROM episodes_fts");
    d.exec("DELETE FROM episodes");
    const ins = d.prepare(
      "INSERT OR IGNORE INTO episodes (id, role, content, ts) VALUES (?, ?, ?, ?)",
    );
    const insFts = d.prepare(
      "INSERT OR IGNORE INTO episodes_fts (rowid, content) VALUES (?, ?)",
    );
    let stored = 0;
    for (const e of episodes) {
      if (!e || typeof e.content !== "string" || !e.content.trim()) continue;
      const r = ins.run(
        e.id,
        e.role ?? "assistant",
        e.content,
        e.ts ?? Date.now(),
      );
      if (r.changes > 0) {
        insFts.run(Number(e.id), tokenizeForFts(e.content));
        stored++;
      }
    }
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
  return episodes.length;
}
