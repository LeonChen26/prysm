/**
 * 工作区文件浏览（文件浏览器）
 * 在 agent-workdir 内列出目录、预览文件、新建/上传文件。
 * 路径校验复用 lib/paths 的 resolveInWorkdir，保证不能越界。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveInWorkdir } from "./paths";

export interface WorkdirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/** 列出指定相对目录下的条目（目录优先 + 名称排序） */
export async function listWorkdir(
  rel = "",
): Promise<{ dir: string; entries: WorkdirEntry[] }> {
  const dir = resolveInWorkdir(rel);
  const names = await fs.readdir(dir, { withFileTypes: true });
  const entries: WorkdirEntry[] = [];
  for (const e of names) {
    try {
      const full = path.join(dir, e.name);
      const st = e.isDirectory() ? null : await fs.stat(full);
      entries.push({
        name: e.name,
        isDir: e.isDirectory(),
        size: st?.size ?? 0,
        mtime: st?.mtimeMs ?? 0,
      });
    } catch {
      /* 忽略无法 stat 的条目（如断链） */
    }
  }
  entries.sort((a, b) =>
    a.isDir === b.isDir
      ? a.name.localeCompare(b.name, "zh-CN")
      : a.isDir
        ? -1
        : 1,
  );
  return { dir: rel, entries };
}

export interface WorkdirFileContent {
  content: string;
  truncated: boolean;
  size: number;
}

const MAX_PREVIEW_BYTES = 200 * 1024;

/** 读取文本文件内容（最大 200KB，超出截断），仅限文件 */
export async function readWorkdirFile(
  rel: string,
): Promise<WorkdirFileContent> {
  const file = resolveInWorkdir(rel);
  const st = await fs.stat(file);
  if (st.isDirectory()) throw new Error("这是一个目录，请选择文件");
  const buf = await fs.readFile(file);
  const truncated = buf.length > MAX_PREVIEW_BYTES;
  return {
    content: buf.subarray(0, MAX_PREVIEW_BYTES).toString("utf-8"),
    truncated,
    size: buf.length,
  };
}

/** 新建文件（可带初始内容）或目录 */
export async function createWorkdirEntry(
  rel: string,
  type: "file" | "dir",
  content: string,
): Promise<void> {
  const target = resolveInWorkdir(rel);
  if (type === "dir") {
    await fs.mkdir(target, { recursive: true });
  } else {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content ?? "", "utf-8");
  }
}

/** 写入文件（覆盖），返回字节数 */
export async function writeWorkdirFile(
  rel: string,
  data: Uint8Array,
): Promise<number> {
  const target = resolveInWorkdir(rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  return data.byteLength;
}
