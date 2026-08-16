/**
 * 偏好记忆（对齐 TraeWork「记忆」设计）
 * 将对后续协作有价值的偏好与规则保存为 markdown 文件，注入系统提示词持续生效。
 *
 * - 全局记忆：<baseDir>/memory/user_profile.md（所有工作区生效）
 * - 项目记忆：<baseDir>/memory/projects/<encoded-workdir>/project_memory.md（按绑定工作目录区分）
 * - 格式：每行一条（`- 内容` 或纯文本行），便于 AI 工具按行增删
 * - 管理：AI 工具 remember_memory / forget_memory；设置面板查看编辑；纳入备份恢复
 *
 * 与 lib/memory.ts（SQLite 情景记忆，检索式注入）互补：前者存对话轨迹，本模块存显式偏好/规则。
 */
import fs from "node:fs";
import path from "node:path";
import { basePath } from "./config";
import { getDefaultWorkspaceRoot } from "./workspace";

/** 偏好记忆作用域 */
export type MemoryScope = "global" | "project";

/** 记忆根目录：<baseDir>/memory */
function memoryRoot(): string {
  return basePath("memory");
}

/** 全局记忆文件路径 */
export function globalMemoryPath(): string {
  return path.join(memoryRoot(), "user_profile.md");
}

/** 工作目录编码为安全目录名（盘符/冒号/分隔符替换为 _） */
export function encodeWorkdir(workdir: string): string {
  return workdir
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^_+/, "")
    .replace(/_+/g, "_");
}

/** 项目记忆文件路径（无 workdir 时回退默认工作区根） */
export function projectMemoryPath(workdir?: string): string {
  const key = encodeWorkdir(workdir ?? getDefaultWorkspaceRoot());
  return path.join(memoryRoot(), "projects", key, "project_memory.md");
}

/** 读取记忆文件（不存在返回空串） */
export function readMemoryFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

/** 写入记忆文件（自动创建父目录） */
export function writeMemoryFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

/** 按作用域取记忆文件路径 */
export function memoryFileFor(scope: MemoryScope, workdir?: string): string {
  return scope === "global" ? globalMemoryPath() : projectMemoryPath(workdir);
}

/** 读取作用域记忆文本（project 无 workdir 时回退默认工作区） */
export function readPreferenceMemory(
  scope: MemoryScope,
  workdir?: string,
): string {
  return readMemoryFile(memoryFileFor(scope, workdir));
}

/** 记忆条目（按行拆分，去除空行与 markdown 标题行） */
export function listPreferenceEntries(
  scope: MemoryScope,
  workdir?: string,
): string[] {
  return readPreferenceMemory(scope, workdir)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^#{1,6}\s/.test(l));
}

/**
 * 追加记忆条目（按行去重：文件已含相同行则跳过），返回新增条数。
 * 每行一条；content 可含多行，逐行写入。
 */
export function upsertPreference(
  scope: MemoryScope,
  content: string,
  workdir?: string,
): number {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return 0;
  const file = memoryFileFor(scope, workdir);
  const existing = new Set(listPreferenceEntries(scope, workdir));
  const added = lines.filter((l) => !existing.has(l));
  if (added.length === 0) return 0;
  const next = listPreferenceEntries(scope, workdir).concat(added);
  writeMemoryFile(file, next.join("\n") + "\n");
  return added.length;
}

/**
 * 删除包含关键词的记忆条目（行级匹配），返回删除条数。
 * content 为空返回 0；单行匹配为"该行包含 content 整串"。
 */
export function removePreference(
  scope: MemoryScope,
  content: string,
  workdir?: string,
): number {
  const q = content.trim();
  if (!q) return 0;
  const entries = listPreferenceEntries(scope, workdir);
  const kept = entries.filter((l) => !l.includes(q));
  if (kept.length === entries.length) return 0;
  writeMemoryFile(memoryFileFor(scope, workdir), kept.join("\n") + "\n");
  return entries.length - kept.length;
}

/** 清空作用域记忆，返回删除条数 */
export function clearPreference(scope: MemoryScope, workdir?: string): number {
  const n = listPreferenceEntries(scope, workdir).length;
  if (n > 0) writeMemoryFile(memoryFileFor(scope, workdir), "");
  return n;
}

/** 导出全部偏好记忆（备份用） */
export function dumpPreferenceMemory(): {
  global: string;
  projects: Record<string, string>;
} {
  const projects: Record<string, string> = {};
  const dir = path.join(memoryRoot(), "projects");
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const md = path.join(dir, e.name, "project_memory.md");
      projects[e.name] = readMemoryFile(md);
    }
  } catch {
    /* 目录不存在则无项目记忆 */
  }
  return { global: readMemoryFile(globalMemoryPath()), projects };
}

/** 恢复全部偏好记忆（备份用，覆盖式） */
export function restorePreferenceMemory(data: {
  global?: string;
  projects?: Record<string, string>;
}): void {
  if (typeof data?.global === "string") {
    writeMemoryFile(globalMemoryPath(), data.global);
  }
  for (const [key, content] of Object.entries(data?.projects ?? {})) {
    const p = path.join(memoryRoot(), "projects", key, "project_memory.md");
    // 防御路径穿越：key 仅允许 [A-Za-z0-9_-]
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    writeMemoryFile(p, content);
  }
}

/**
 * 组装偏好记忆注入文本（系统提示词用；无内容返回空串）。
 * 全局 + 当前工作区项目，两级拼接并附带管理引导。
 */
export function buildPreferencePrompt(workdir?: string): string {
  const global = readPreferenceMemory("global").trim();
  const project = readPreferenceMemory("project", workdir).trim();
  if (!global && !project) return "";
  const parts: string[] = [
    "【用户偏好记忆】以下偏好与规则长期生效，请遵循。用户明确说“记住/更新/删除”偏好时，用 remember_memory / forget_memory 工具管理这些记忆：",
  ];
  if (global) parts.push(`全局：\n${global}`);
  if (project) {
    parts.push(
      `项目（当前工作区${workdir ? ` ${workdir}` : ""}）：\n${project}`,
    );
  }
  return parts.join("\n");
}
