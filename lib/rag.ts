/**
 * 知识库 / RAG（Phase 6）
 * work 形态对项目文档做检索增强，区别于「情景记忆」（跨会话经验）。
 * - 存储：Node 内置 SQLite + FTS5（零额外依赖，与 memory 同方案），独立索引文件 agent-rag.db。
 * - 索引范围：已授权工作区根目录下的文本文件；增量扫描（按 mtime+size 跳过未变更）。
 * - 检索：BM25 关键词匹配（中文按字符分词），无需外部嵌入模型。
 *
 * 在 buildContext 中作为第③步（压缩 → 情景记忆 → RAG）注入。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { basePath, envValue } from "./config";
import { listWorkspaces, isRootAuthorized, type WorkspaceRecord } from "./workspace";

/** RAG 是否启用（惰性读 env，支持配置注入）；默认启用 */
export function ragEnabled(): boolean {
  return envValue("RAG_ENABLED") !== "false";
}
/** 注入进上下文的检索结果最大字符数 */
export function ragMaxChars(): number {
  return Number(envValue("RAG_MAX_CHARS") ?? 4000);
}
/** 每轮检索返回的最大文档段数 */
export function ragRecallK(): number {
  return Number(envValue("RAG_RECALL_K") ?? 5);
}
/** 单次扫描处理的最大文件数（防失控） */
export function ragScanLimit(): number {
  return Number(envValue("RAG_SCAN_LIMIT") ?? 2000);
}

let db: DatabaseSync | undefined;

function getDb(): DatabaseSync {
  if (db) return db;
  const d = new DatabaseSync(basePath("agent-rag.db"));
  d.exec(`
    CREATE TABLE IF NOT EXISTS rag_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dir TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      content TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL,
      UNIQUE(dir, rel_path)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS rag_docs_fts USING fts5(content, tokenize='unicode61');
  `);
  db = d;
  return d;
}

/** 中文之间插空格，使 FTS 按字符分词（与 memory 同策略） */
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
  "上", "下", "中", "过", "做", "想", "看", "问", "请", "如何", "文档",
]);

/** 提取查询关键词：去停用词，最多保留 TOP_N 个 */
function queryTokens(query: string, topN = 10): string[] {
  return tokenizeForFts(query)
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .slice(0, topN);
}

/** FTS5 MATCH 短语转义：去掉双引号等语法残留，防止含引号查询抛 SQL 错误 */
function ftsPhrase(token: string): string {
  return `"${token.replace(/"/g, " ").trim()}"`;
}

/** 索引时跳过的大小写无关扩展名（二进制/与代码无关） */
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".bmp", ".tiff",
  ".pdf", ".zip", ".gz", ".tar", ".rar", ".7z",
  ".mp3", ".mp4", ".mov", ".avi", ".wav", ".flac", ".ogg",
  ".exe", ".dll", ".so", ".dylib", ".class", ".jar", ".wasm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".lock", ".sum", ".pyc", ".o", ".a",
]);
/** 索引时跳过的目录名 */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".svn", ".hg", "dist", "build",
  ".idea", ".vscode", "coverage", ".cache", "vendor", "out",
]);

export interface IndexStats {
  root: string;
  added: number;
  updated: number;
  removed: number;
  total: number;
}

/** 重建/增量索引单个工作区根：按已存 mtime+size 跳过未变更文件，删除已消失文件 */
export async function indexRoot(root: string): Promise<IndexStats> {
  const d = getDb();
  const relPaths = new Set<string>();
  let added = 0;
  let updated = 0;
  let scanned = 0;
  let truncated = false; // 扫描触及上限被截断：此时无法区分"文件已消失"与"未扫描到"，跳过删除阶段

  const walk = async (dir: string, rel: string) => {
    if (scanned >= ragScanLimit()) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (scanned >= ragScanLimit()) {
        truncated = true;
        return;
      }
      const abs = path.join(dir, e.name);
      const relStr = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(abs, relStr);
      } else if (e.isFile()) {
        relPaths.add(relStr);
        const ext = path.extname(e.name).toLowerCase();
        if (SKIP_EXT.has(ext)) continue;
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.size > 1024 * 1024) continue; // 跳过 1MB 以上
        scanned++;
        const existing = d
          .prepare("SELECT id, mtime_ms, size FROM rag_docs WHERE dir = ? AND rel_path = ?")
          .get(root, relStr) as { id: number; mtime_ms: number; size: number } | undefined;
        if (
          existing &&
          existing.mtime_ms === stat.mtimeMs &&
          existing.size === stat.size
        ) {
          continue; // 未变更
        }
        let text: string;
        try {
          const buf = await fs.readFile(abs);
          // 二进制探测：前 8KB 含 NUL 视为二进制，跳过
          if (buf.subarray(0, 8192).includes(0)) continue;
          text = buf.toString("utf-8");
        } catch {
          continue;
        }
        if (!text.trim()) continue;
        if (existing) {
          d.prepare(
            "UPDATE rag_docs SET content = ?, mtime_ms = ?, size = ? WHERE id = ?",
          ).run(text, stat.mtimeMs, stat.size, existing.id);
          d.prepare("UPDATE rag_docs_fts SET content = ? WHERE rowid = ?").run(
            tokenizeForFts(text),
            existing.id,
          );
          updated++;
        } else {
          const r = d
            .prepare(
              "INSERT INTO rag_docs (dir, rel_path, content, mtime_ms, size) VALUES (?, ?, ?, ?, ?)",
            )
            .run(root, relStr, text, stat.mtimeMs, stat.size);
          d.prepare("INSERT OR IGNORE INTO rag_docs_fts (rowid, content) VALUES (?, ?)").run(
            Number(r.lastInsertRowid),
            tokenizeForFts(text),
          );
          added++;
        }
      }
    }
  };

  await walk(root, "");
  // 删除已从磁盘消失的文件（仅当本轮完整扫描；被上限截断时跳过，防误删未遍历文件）
  const existing = d
    .prepare("SELECT rel_path FROM rag_docs WHERE dir = ?")
    .all(root) as { rel_path: string }[];
  let removed = 0;
  if (!truncated) {
    for (const row of existing) {
      if (!relPaths.has(row.rel_path)) {
        const r = d
          .prepare("DELETE FROM rag_docs WHERE dir = ? AND rel_path = ?")
          .run(root, row.rel_path);
        if (r.changes > 0) removed++;
      }
    }
  }
  // 清理孤儿 FTS 行（rowid 不再对应 rag_docs.id）
  if (removed > 0) {
    d.prepare("DELETE FROM rag_docs_fts WHERE rowid NOT IN (SELECT id FROM rag_docs)").run();
  }
  const total = (
    d.prepare("SELECT COUNT(*) AS c FROM rag_docs WHERE dir = ?").get(root) as { c: number }
  ).c;
  return { root, added, updated, removed, total };
}

/** 索引全部已授权工作区根，返回各根统计 */
export async function indexWorkspaces(): Promise<IndexStats[]> {
  const roots = listWorkspaces()
    .filter((w) => isRootAuthorized(w))
    .map((w) => w.root);
  const out: IndexStats[] = [];
  for (const root of roots) out.push(await indexRoot(root));
  return out;
}

export interface RagHit {
  dir: string;
  relPath: string;
  snippet: string;
}

/** 按查询检索知识库，返回按相关度排序的文档段（不含空结果） */
export function retrieveRag(query: string, k = ragRecallK()): RagHit[] {
  if (!ragEnabled()) return [];
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const match = tokens.map(ftsPhrase).join(" OR ");
  const rows = getDb()
    .prepare(
      `SELECT d.dir, d.rel_path, d.content
       FROM rag_docs_fts JOIN rag_docs d ON d.id = rag_docs_fts.rowid
       WHERE rag_docs_fts MATCH ?
       ORDER BY bm25(rag_docs_fts)
       LIMIT ?`,
    )
    .all(match, k) as { dir: string; rel_path: string; content: string }[];
  return rows.map((r) => {
    // 定位首个命中关键词附近片段
    const idx = snippetIndex(r.content, tokens);
    const start = Math.max(0, idx - 120);
    const snippet = r.content.slice(start, start + 240);
    return { dir: r.dir, relPath: r.rel_path, snippet };
  });
}

/** 在文本中定位首个关键词位置（取第一个命中 token 的索引） */
function snippetIndex(content: string, tokens: string[]): number {
  for (const t of tokens) {
    const i = content.indexOf(t);
    if (i >= 0) return i;
  }
  return 0;
}

/** 检索并拼接为可注入上下文的文本（受 ragMaxChars 预算约束） */
export function retrieveRagText(query: string): string {
  const hits = retrieveRag(query);
  if (hits.length === 0) return "";
  const budget = ragMaxChars();
  let out = "";
  for (const h of hits) {
    const part = `[${path.basename(h.relPath)}] ${h.snippet}\n`;
    if (out.length + part.length > budget) {
      out += part.slice(0, budget - out.length);
      break;
    }
    out += part;
  }
  return out.trim();
}

/** 对外搜索 API：返回文档命中（含片段），供前端展示 */
export function searchDocs(
  query: string,
  limit = 20,
): { dir: string; relPath: string; snippet: string }[] {
  return retrieveRag(query, limit);
}

/** 索引概览（调试用） */
export function ragStats(): { total: number; byRoot: Record<string, number> } {
  const d = getDb();
  const total = (
    d.prepare("SELECT COUNT(*) AS c FROM rag_docs").get() as { c: number }
  ).c;
  const rows = d
    .prepare("SELECT dir, COUNT(*) AS c FROM rag_docs GROUP BY dir")
    .all() as { dir: string; c: number }[];
  const byRoot: Record<string, number> = {};
  for (const r of rows) byRoot[r.dir] = r.c;
  return { total, byRoot };
}

/** 清空索引（仅测试/dev） */
export function clearRagIndex(): void {
  const d = getDb();
  d.exec("DELETE FROM rag_docs_fts");
  d.exec("DELETE FROM rag_docs");
}

/** 关闭并重置索引连接（仅测试） */
export function resetRag(): void {
  try {
    db?.close();
  } catch {
    /* 未打开 */
  }
  db = undefined;
}

/** 供测试使用的内部访问：重建某个根（等价 indexRoot） */
export async function reindexRoot(root: string): Promise<IndexStats> {
  return indexRoot(root);
}