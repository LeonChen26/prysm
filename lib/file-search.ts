import fs from "node:fs/promises";
import path from "node:path";
import { globPathToRegex, globToRegex } from "./tool-helpers";

export interface FileHit {
  path: string;
  line: number;
  text: string;
  context?: string;
}

/** 递归遍历中跳过的常见无关目录 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);

/** 按文件名 glob 在指定根目录下递归查找文件（限制深度/数量）
 *
 * @param root    绝对路径：搜索起始目录
 * @param workdir 工作区绝对路径：用于计算返回结果的相对路径
 */
export async function findInWorkdir(
  pattern: string,
  root: string,
  limit: number,
  workdir: string,
): Promise<{ path: string; size: number }[]> {
  const re = globPathToRegex(pattern);
  if (!re) throw new Error(`无效的 glob 模式: ${pattern}`);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error(`不是目录: ${root}`);
  const hits: { path: string; size: number }[] = [];

  const walk = async (dir: string) => {
    if (hits.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(full);
      } else if (e.isFile()) {
        const rel = path.relative(workdir, full).replace(/\\/g, "/");
        if (re.test(rel)) {
          const size = (await fs.stat(full)).size;
          hits.push({ path: rel, size });
        }
      }
    }
  };
  await walk(root);
  return hits;
}

/** 在指定工作目录下递归搜索关键词（限制单文件大小，跳过常见无关目录） */
export async function searchInWorkdir(
  query: string,
  pattern: string | undefined,
  limit: number,
  workdir: string,
  ignoreCase = false,
  context = 0,
): Promise<FileHit[]> {
  const hits: FileHit[] = [];
  const re = pattern ? globToRegex(pattern) : null;
  const q = ignoreCase ? query.toLowerCase() : query;
  const MAX_FILE_BYTES = 1024 * 1024; // 跳过 1MB 以上大文件

  const walk = async (dir: string) => {
    if (hits.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= limit) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        if (re && !re.test(e.name)) continue;
        const full = path.join(dir, e.name);
        try {
          const stat = await fs.stat(full);
          if (stat.size > MAX_FILE_BYTES) continue;
          const text = await fs.readFile(full, "utf-8");
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const lineText = ignoreCase ? lines[i].toLowerCase() : lines[i];
            if (lineText.includes(q)) {
              let ctx: string | undefined;
              if (context > 0) {
                const start = Math.max(0, i - context);
                const end = Math.min(lines.length, i + context + 1);
                ctx = lines
                  .slice(start, end)
                  .map((l, k) => {
                    const n = start + k + 1;
                    return `${n === i + 1 ? ">" : " "}${n}: ${l.slice(0, 200)}`;
                  })
                  .join("\n");
              }
              hits.push({
                path: path.relative(workdir, full).replace(/\\/g, "/"),
                line: i + 1,
                text: lines[i].slice(0, 200),
                context: ctx,
              });
              if (hits.length >= limit) return;
            }
          }
        } catch {
          /* 二进制或读取失败则跳过 */
        }
      }
    }
  };

  await walk(workdir);
  return hits;
}
