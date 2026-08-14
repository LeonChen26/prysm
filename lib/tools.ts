import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createTodos, formatTodos, listTodos, modifyTodos, type TodoUpdate } from "./todo";
import { fetchUrlAsText, webSearch } from "./web";
import { AGENT_WORKDIR, ALLOWED_ROOTS, getAllowedRoots, getAgentWorkdir, resolveInWorkdirOrThrow } from "./paths";
import { TOOL_META } from "./tool-meta";
import type { SubagentSpec } from "./subagent";
import { proposePlan } from "./plan";
import type { Surface } from "./session";

// re-export 兼容历史导入（测试脚本从 lib/tools 引入 AGENT_WORKDIR）
export { AGENT_WORKDIR, ALLOWED_ROOTS } from "./paths";

/**
 * spawn_subagent 执行器（Phase 5 延迟注入打破 tools↔agent 循环依赖）。
 * agent.ts 的 runSubagentCore 通过 setSpawnSubagentImpl 注入；未注入时工具返回"未启用"。
 */
export type SpawnSubagentImpl = (spec: SubagentSpec) => Promise<string>;
let spawnSubagentImpl: SpawnSubagentImpl | undefined;
export function setSpawnSubagentImpl(fn: SpawnSubagentImpl | undefined): void {
  spawnSubagentImpl = fn;
}

/**
 * plan_propose 会话上下文（Phase 7 延迟注入）。
 * agent route 在提示前通过 setPlanCtx 注入当前会话的 sessionId/surface，
 * 供 plan_propose 工具唯一确定计划归属（单用户本地场景，多会话并发时以最近一次为准）。
 */
let planCtx: { sessionId: string; surface: Surface } | undefined;
export function setPlanCtx(ctx: { sessionId: string; surface: Surface } | undefined): void {
  planCtx = ctx;
}

interface FileHit {
  path: string;
  line: number;
  text: string;
  context?: string; // 前后文行，增强版新增
}

/** 文件名通配（支持 * 和 ?）转正则 */
function globToRegex(pattern: string): RegExp | null {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${escaped}$`, "i");
  } catch {
    return null;
  }
}

/**
 * 路径级 glob 转正则（按文件名查找）：
 * - `**` 匹配跨任意层级目录
 * - `*`  匹配单段（不含 /）
 * - `?`  匹配单个字符（不含 /）
 * pattern 不含 "/" 时视为匹配任意层级下的文件名（自动补全局前缀）。
 */
function globPathToRegex(pattern: string): RegExp | null {
  let full = pattern;
  if (!full.includes("/")) full = `**/${full}`;
  const escaped = full
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000") // 占位，避免被 * 规则拆开
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  try {
    return new RegExp(`^${escaped}$`, "i");
  } catch {
    return null;
  }
}

/** 按文件名 glob 在工作区内递归查找文件（限制深度/数量，跳过常见无关目录） */
async function findInWorkdir(
  pattern: string,
  subPath: string | undefined,
  limit: number,
): Promise<{ path: string; size: number }[]> {
  const re = globPathToRegex(pattern);
  if (!re) throw new Error(`无效的 glob 模式: ${pattern}`);
  const root = resolveInWorkdirOrThrow(subPath ?? "");
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error(`不是目录: ${subPath ?? ""}`);
  const hits: { path: string; size: number }[] = [];
  const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);
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
        const rel = path.relative(AGENT_WORKDIR, full).replace(/\\/g, "/");
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

/** 在工作区内递归搜索关键词（限制单文件大小，跳过常见无关目录） */
async function searchInWorkdir(
  query: string,
  pattern: string | undefined,
  limit: number,
  ignoreCase = false,
  context = 0,
): Promise<FileHit[]> {
  const hits: FileHit[] = [];
  const re = pattern ? globToRegex(pattern) : null;
  const q = ignoreCase ? query.toLowerCase() : query;
  const MAX_FILE_BYTES = 1024 * 1024; // 跳过 1MB 以上大文件
  const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);

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
                path: path.relative(AGENT_WORKDIR, full).replace(/\\/g, "/"),
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

  await walk(AGENT_WORKDIR);
  return hits;
}

/** 统计字符串中的换行数（用于定位 old_string / new_string 的行号） */
function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * 生成行级 unified diff 文本（单 hunk：替换区间 + 前后 3 行上下文）。
 * 供 edit_file 展示精准变更，便于模型/用户核对改动是否符合预期。
 *
 * @param relPath  相对路径（用于 --- / +++ 头）
 * @param oldLines 原文件按行拆分
 * @param newLines 替换后文件按行拆分
 * @param oldStartLine old_string 首行（0 基）
 * @param oldEndLine   old_string 尾行（0 基）
 * @param newEndLine   new_string 尾行（0 基，相对 newLines）
 */
function buildEditDiff(
  relPath: string,
  oldLines: string[],
  newLines: string[],
  oldStartLine: number,
  oldEndLine: number,
  newEndLine: number,
): string {
  const CTX = 3;
  const hs = Math.max(0, oldStartLine - CTX);
  const he = Math.min(oldLines.length, oldEndLine + 1 + CTX);
  const oldAffected = oldEndLine - oldStartLine + 1;
  const newAffected = newEndLine - oldStartLine + 1;
  const oldCount = he - hs;
  const newCount = oldCount - oldAffected + newAffected;
  const out: string[] = [
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    `@@ -${hs + 1},${oldCount} +${hs + 1},${newCount} @@`,
  ];
  for (let i = hs; i < oldStartLine; i++) out.push(` ${oldLines[i]}`);
  for (let i = oldStartLine; i <= oldEndLine; i++) out.push(`-${oldLines[i]}`);
  for (let i = oldStartLine; i <= newEndLine; i++) out.push(`+${newLines[i]}`);
  for (let i = oldEndLine + 1; i < he; i++) out.push(` ${oldLines[i]}`);
  return out.join("\n");
}

interface CommandResult {
  exitCode: number;
  output: string;
}

/** 在指定目录执行 shell 命令（超时后终止，输出截断到 8000 字符） */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n");
        const exitCode = err
          ? (err as { code?: number }).code ?? -1
          : 0;
        resolve({ exitCode, output });
      },
    );
  });
}

/** 查询指定端口是否被占用，返回人类可读的结果（跨平台） */
async function checkPort(port: number): Promise<string> {
  if (process.platform === "win32") {
    const r = await runCommand("netstat -ano", process.cwd(), 10_000);
    if (r.exitCode !== 0) return `查询失败: ${r.output}`;
    const re = new RegExp(`:${port}\\s`);
    const lines = r.output
      .split("\n")
      .filter((l) => re.test(l) && /LISTENING/i.test(l));
    if (lines.length === 0) return `端口 ${port} 未被占用`;
    const pids = new Set<string>();
    for (const l of lines) {
      const m = l.trim().match(/(\d+)\s*$/);
      if (m) pids.add(m[1]);
    }
    const names: string[] = [];
    for (const pid of pids) {
      const t = await runCommand(
        `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
        process.cwd(),
        10_000,
      );
      const m = t.output.match(/"([^"]+)"/);
      names.push(m ? `${m[1]} (PID ${pid})` : `PID ${pid}`);
    }
    return (
      `端口 ${port} 被占用（${lines.length} 个监听项）：\n` +
      lines.slice(0, 8).join("\n") +
      `\n进程: ${names.join("、") || "未知"}`
    );
  }
  // macOS / Linux
  const r = await runCommand(
    `lsof -i :${port} -P -n 2>/dev/null || true`,
    process.cwd(),
    10_000,
  );
  if (r.exitCode === 0 && r.output.trim()) {
    return `端口 ${port} 占用情况:\n${r.output}`;
  }
  return `端口 ${port} 未被占用`;
}

/**
 * 各工具 execute 收到的参数（运行时来自模型 JSON，Schema 校验由框架完成）。
 * 必需字段由各自 schema 保证存在，这里仅供 TS 静态检查。
 */
interface ToolArgs {
  dir: string;
  path: string;
  content: string;
  from: string;
  to: string;
  query: string;
  url: string;
  command: string;
  port: number;
  items: { title: string; detail?: string }[];
  expect?: string;
  limit?: number;
  pattern?: string;
  old_string?: string;
  new_string?: string;
  updates?: TodoUpdate[];
  append?: { title: string; detail?: string }[];
}

export const tools: AgentTool<any>[] = [
  {
    name: "list_dir",
    label: TOOL_META["list_dir"].label,
    description:
      "列出工作区（agent-workdir）内指定目录下的文件与子目录。dir 为空表示根目录。",
    parameters: Type.Object({
      dir: Type.Optional(
        Type.String({ description: "相对路径目录，默认 '' 表示工作区根目录" }),
      ),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const dir = resolveInWorkdirOrThrow(params.dir ?? "");
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const lines = entries.map((e) => (e.isDirectory() ? `[dir] ${e.name}` : e.name));
      return {
        content: [{ type: "text", text: lines.join("\n") || "(空目录)" }],
        details: { dir: params.dir ?? "" },
      };
    },
  },
  {
    name: "read_file",
    label: TOOL_META["read_file"].label,
    description: "读取工作区内的文本文件内容，最大支持 100KB。",
    parameters: Type.Object({
      path: Type.String({ description: "相对文件路径" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const file = resolveInWorkdirOrThrow(params.path);
      const stat = await fs.stat(file);
      if (stat.size > 100 * 1024) {
        throw new Error(`文件过大 (${stat.size} 字节)，仅支持读取 100KB 以内`);
      }
      const text = await fs.readFile(file, "utf-8");
      return {
        content: [{ type: "text", text }],
        details: { path: params.path, size: stat.size },
      };
    },
  },
  {
    name: "write_file",
    label: TOOL_META["write_file"].label,
    description: "在工作区写入或覆盖一个文本文件（自动创建父目录）。",
    parameters: Type.Object({
      path: Type.String({ description: "相对文件路径" }),
      content: Type.String({ description: "要写入的完整内容" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const file = resolveInWorkdirOrThrow(params.path);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, params.content, "utf-8");
      return {
        content: [
          {
            type: "text",
            text: `已写入 ${params.path} (${params.content.length} 字符)`,
          },
        ],
        details: { path: params.path },
      };
    },
  },
  {
    name: "append_file",
    label: TOOL_META["append_file"].label,
    description:
      "在文件末尾追加内容（文件不存在则创建）。用于增量记录、日志、续写等。",
    parameters: Type.Object({
      path: Type.String({ description: "相对文件路径" }),
      content: Type.String({ description: "要追加的内容" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const file = resolveInWorkdirOrThrow(params.path);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, params.content, "utf-8");
      return {
        content: [
          {
            type: "text",
            text: `已追加到 ${params.path} (${params.content.length} 字符)`,
          },
        ],
        details: { path: params.path },
      };
    },
  },
  {
    name: "edit_file",
    label: TOOL_META["edit_file"].label,
    description:
      "精准编辑：用 new_string 替换文件中唯一匹配的 old_string（支持跨行，必须精确一致且唯一）。返回变更的 unified diff 便于核对。找不到或匹配多次时拒绝修改，需调整后重试。属于敏感操作，需要用户确认。",
    parameters: Type.Object({
      path: Type.String({ description: "相对文件路径" }),
      old_string: Type.String({
        description: "要替换的原文（必须与文件内容完全一致，且只出现一次）",
      }),
      new_string: Type.String({
        description: "替换后的新文本（可为空串表示删除该段）",
      }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const file = resolveInWorkdirOrThrow(params.path);
      if (params.old_string === undefined) {
        throw new Error("edit_file 缺少必需参数 old_string");
      }
      if (params.new_string === undefined) {
        throw new Error("edit_file 缺少必需参数 new_string");
      }
      if (params.old_string.length === 0) {
        throw new Error("old_string 不能为空，请指定要替换的原文片段");
      }
      const oldText = await fs.readFile(file, "utf-8");
      const idx = oldText.indexOf(params.old_string);
      if (idx === -1) {
        throw new Error(
          `未在 ${params.path} 中找到要替换的原文，请提供与文件内容完全一致的 old_string`,
        );
      }
      if (oldText.indexOf(params.old_string, idx + 1) !== -1) {
        throw new Error(
          `old_string 在 ${params.path} 中出现多次，请包含更多前后文使其唯一`,
        );
      }
      const newText =
        oldText.slice(0, idx) +
        params.new_string +
        oldText.slice(idx + params.old_string.length);
      const oldLines = oldText.split("\n");
      const newLines = newText.split("\n");
      const oldStartLine = countNewlines(oldText.slice(0, idx));
      const oldEndLine = countNewlines(oldText.slice(0, idx + params.old_string.length));
      const newEndLine = countNewlines(newText.slice(0, idx + params.new_string.length));
      const diff = buildEditDiff(
        params.path,
        oldLines,
        newLines,
        oldStartLine,
        oldEndLine,
        newEndLine,
      );
      await fs.writeFile(file, newText, "utf-8");
      return {
        content: [
          {
            type: "text",
            text: `已精准编辑 ${params.path}：\n${diff}`,
          },
        ],
        details: {
          path: params.path,
          oldLines: oldEndLine - oldStartLine + 1,
          newLines: newEndLine - oldStartLine + 1,
          diff,
        },
      };
    },
  },
  {
    name: "create_dir",
    label: TOOL_META["create_dir"].label,
    description: "在工作区创建目录（可一次创建多级，已存在则跳过）。",
    parameters: Type.Object({
      path: Type.String({ description: "相对目录路径" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const dir = resolveInWorkdirOrThrow(params.path);
      await fs.mkdir(dir, { recursive: true });
      return {
        content: [{ type: "text", text: `目录已就绪: ${params.path}` }],
        details: { path: params.path },
      };
    },
  },
  {
    name: "move_file",
    label: TOOL_META["move_file"].label,
    description: "移动或重命名工作区内的文件或目录（自动创建目标父目录）。",
    parameters: Type.Object({
      from: Type.String({ description: "源相对路径（文件或目录）" }),
      to: Type.String({ description: "目标相对路径" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const src = resolveInWorkdirOrThrow(params.from);
      const dst = resolveInWorkdirOrThrow(params.to);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.rename(src, dst);
      return {
        content: [
          { type: "text", text: `已移动/重命名: ${params.from} → ${params.to}` },
        ],
        details: { from: params.from, to: params.to },
      };
    },
  },
  {
    name: "copy_file",
    label: TOOL_META["copy_file"].label,
    description: "在工作区内复制文件（自动创建目标父目录）。",
    parameters: Type.Object({
      from: Type.String({ description: "源相对文件路径" }),
      to: Type.String({ description: "目标相对文件路径" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const src = resolveInWorkdirOrThrow(params.from);
      const dst = resolveInWorkdirOrThrow(params.to);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
      return {
        content: [
          { type: "text", text: `已复制: ${params.from} → ${params.to}` },
        ],
        details: { from: params.from, to: params.to },
      };
    },
  },
  {
    name: "delete_file",
    label: TOOL_META["delete_file"].label,
    description: "删除工作区内的文件（不删除目录）。属于敏感操作，需要用户确认。",
    parameters: Type.Object({
      path: Type.String({ description: "相对文件路径" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const file = resolveInWorkdirOrThrow(params.path);
      await fs.unlink(file);
      return {
        content: [{ type: "text", text: `已删除文件: ${params.path}` }],
        details: { path: params.path },
      };
    },
  },
  {
    name: "verify_file",
    label: "校验文件",
    description:
      "自检工具：检查工作区内文件是否存在、返回大小与内容预览（前 200 字符）。提供 expect 参数时，同时检查内容是否包含该片段并返回校验通过/失败。任务完成后用它验证交付物，不要仅口头声称完成。",
    parameters: Type.Object({
      path: Type.String({ description: "相对文件路径" }),
      expect: Type.Optional(
        Type.String({ description: "期望内容包含的片段（可选）" }),
      ),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const file = resolveInWorkdirOrThrow(params.path);
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) {
          return {
            content: [{ type: "text", text: `校验失败: ${params.path} 不是文件` }],
            details: { path: params.path, exists: true, isFile: false },
          };
        }
        const text = await fs.readFile(file, "utf-8");
        const preview = text.slice(0, 200);
        if (params.expect !== undefined) {
          const matched = text.includes(params.expect);
          return {
            content: [
              {
                type: "text",
                text: matched
                  ? `校验通过: ${params.path} 包含预期内容 "${params.expect}"`
                  : `校验失败: ${params.path} 不包含 "${params.expect}"（内容: ${preview}）`,
              },
            ],
            details: {
              path: params.path,
              exists: true,
              size: stat.size,
              matched,
              preview,
            },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `${params.path} 存在，大小 ${stat.size} 字节\n${preview}`,
            },
          ],
          details: { path: params.path, exists: true, size: stat.size, preview },
        };
      } catch {
        return {
          content: [{ type: "text", text: `文件不存在: ${params.path}` }],
          details: { path: params.path, exists: false },
        };
      }
    },
  },
  {
    name: "todo_create",
    label: TOOL_META["todo_create"].label,
    description:
      "把复杂任务拆解为可执行的子任务清单。会覆盖当前的任务计划。适用于多步骤任务开始前。",
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          title: Type.String({ description: "子任务标题" }),
          detail: Type.Optional(Type.String({ description: "补充说明" })),
        }),
        { description: "子任务列表（按执行顺序）" },
      ),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const { todos, msg } = createTodos(params.items);
      return {
        content: [{ type: "text", text: `${msg}\n${formatTodos(todos)}` }],
        details: { todos },
      };
    },
  },
  {
    name: "todo_modify",
    label: "更新任务计划",
    description:
      "更新任务清单：按 id 修改子任务状态（pending/in_progress/completed/cancelled）或标题，也可以追加新的子任务。",
    parameters: Type.Object({
      updates: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({ description: "子任务 id" }),
            status: Type.Optional(
              Type.Union([
                Type.Literal("pending"),
                Type.Literal("in_progress"),
                Type.Literal("completed"),
                Type.Literal("cancelled"),
              ]),
            ),
            title: Type.Optional(Type.String()),
          }),
        ),
      ),
      append: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String({ description: "子任务标题" }),
            detail: Type.Optional(Type.String()),
          }),
        ),
      ),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const { todos, msg } = modifyTodos(params.updates, params.append);
      return {
        content: [{ type: "text", text: `${msg}\n${formatTodos(todos)}` }],
        details: { todos },
      };
    },
  },
  {
    name: "todo_list",
    label: "查看任务计划",
    description: "列出当前任务清单及各子任务状态。",
    parameters: Type.Object({}),
    execute: async (_toolCallId) => {
      const { todos, msg } = listTodos();
      return {
        content: [{ type: "text", text: msg }],
        details: { todos },
      };
    },
  },
  {
    name: "web_search",
    label: "网页搜索",
    description:
      "搜索互联网获取实时信息（最新新闻、文档、数据等）。返回标题、URL 和摘要列表。当需要最新信息、或问题超出你的知识范围（如时事、价格、版本号）时使用。",
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词" }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10,
          description: "返回结果条数，默认 5",
        }),
      ),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const results = await webSearch(params.query, params.limit ?? 5);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `未找到与 "${params.query}" 相关的搜索结果` }],
          details: { query: params.query, results: [] },
        };
      }
      const text = results
        .map(
          (r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || "(无摘要)"}`,
        )
        .join("\n");
      return {
        content: [{ type: "text", text }],
        details: { query: params.query, results },
      };
    },
  },
  {
    name: "fetch_url",
    label: TOOL_META["fetch_url"].label,
    description:
      "抓取指定网页内容并转为纯文本（自动提取标题，最大约 200KB）。用于阅读搜索结果中的文章、官方文档或新闻全文。",
    parameters: Type.Object({
      url: Type.String({ description: "网页 URL（http/https）" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const page = await fetchUrlAsText(params.url);
      const body = page.text || "(页面无可读文本内容)";
      return {
        content: [
          { type: "text", text: `标题: ${page.title}\n${page.truncated ? "(内容过长已截断)\n" : ""}${body}` },
        ],
        details: { url: page.url, title: page.title, truncated: page.truncated },
      };
    },
  },
  {
    name: "search_files",
    label: TOOL_META["search_files"].label,
    description:
      "在工作区（agent-workdir）内递归搜索包含指定关键词的文件，返回文件名、行号与命中行。可选 pattern 过滤文件名（支持 * 通配，如 '*.md'）。用于定位代码、笔记或配置中的相关内容。",
    parameters: Type.Object({
      query: Type.String({ description: "要搜索的内容关键词" }),
      pattern: Type.Optional(
        Type.String({ description: "文件名过滤通配符，如 *.md / *.ts（可选）" }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 50,
          description: "最大返回命中条数，默认 20",
        }),
      ),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const hits = await searchInWorkdir(params.query, params.pattern, params.limit ?? 20);
      if (hits.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `在工作区中未找到包含 "${params.query}" 的文件${params.pattern ? `（文件名匹配 ${params.pattern}）` : ""}`,
            },
          ],
          details: { query: params.query, hits: [] },
        };
      }
      const text = hits
        .map((h) => `${h.path}:${h.line}: ${h.text.trim()}`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `找到 ${hits.length} 处匹配（${hits.length >= (params.limit ?? 20) ? "已达上限 " : ""}）：\n${text}`,
          },
        ],
        details: { query: params.query, count: hits.length, hits },
      };
    },
  },
  {
    name: "find",
    label: TOOL_META["find"].label,
    description:
      "按文件名 glob 在工作区（agent-workdir）内递归查找文件（跳过 node_modules/.git 等无关目录）。支持 ** 跨层级、* 单段、? 单字符；纯文件名模式如 '*.md' 自动匹配任意层级。与 search_files（按内容搜索）互补。",
    parameters: Type.Object({
      pattern: Type.String({ description: "文件名 glob 模式，如 *.ts / src/**/*.tsx / *.md" }),
      path: Type.Optional(
        Type.String({ description: "限定搜索的子目录（相对路径，默认整个工作区）" }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: "最大返回条数，默认 20",
        }),
      ),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      if (!params.pattern) throw new Error("find 缺少必需参数 pattern");
      const hits = await findInWorkdir(params.pattern, params.path, params.limit ?? 20);
      if (hits.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `在工作区中未找到文件名匹配 "${params.pattern}" 的文件${params.path ? `（限定目录 ${params.path}）` : ""}`,
            },
          ],
          details: { pattern: params.pattern, hits: [] },
        };
      }
      const text = hits.map((h) => `${h.path}  (${h.size} B)`).join("\n");
      return {
        content: [
          {
            type: "text",
            text: `找到 ${hits.length} 个匹配文件${hits.length >= (params.limit ?? 20) ? "（已达上限）" : ""}：\n${text}`,
          },
        ],
        details: { pattern: params.pattern, count: hits.length, hits },
      };
    },
  },
  {
    name: "run_bash",
    label: TOOL_META["run_bash"].label,
    description:
      "在工作区（agent-workdir）目录下执行 shell 命令（Linux/macOS 为 bash，Windows 为 cmd）。返回命令输出（最多 8000 字符）。属于敏感操作，需要用户确认。适合运行脚本、构建、查看环境等操作。",
    parameters: Type.Object({
      command: Type.String({ description: "要执行的 shell 命令" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const { exitCode, output } = await runCommand(params.command, AGENT_WORKDIR);
      const truncated =
        output.length > 8000 ? output.slice(0, 8000) + "\n...(输出已截断)" : output;
      return {
        content: [
          {
            type: "text",
            text: `[exit ${exitCode}]\n${truncated || "(无输出)"}`,
          },
        ],
        details: { command: params.command, exitCode, truncated: output.length > 8000 },
      };
    },
  },
  {
    name: "env_info",
    label: "环境信息",
    description:
      "查看当前运行环境信息：操作系统与架构、Node 版本、进程运行时长与内存占用、工作区（agent-workdir）路径和白名单目录。用于排查环境相关问题时快速了解 Agent 的运行上下文。",
    parameters: Type.Object({}),
    execute: async () => {
      const mem = process.memoryUsage();
      const lines = [
        `平台: ${process.platform} ${process.arch}`,
        `Node 版本: ${process.version}`,
        `运行时长: ${Math.floor(process.uptime() / 60)} 分钟 ${Math.floor(process.uptime() % 60)} 秒`,
        `内存占用: ${(mem.rss / 1024 / 1024).toFixed(1)} MB (rss) / ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB (heap)`,
        `工作区目录: ${AGENT_WORKDIR}`,
        ALLOWED_ROOTS.length > 0
          ? `白名单目录: ${ALLOWED_ROOTS.join(", ")}`
          : "白名单目录: (无)",
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { platform: process.platform, arch: process.arch },
      };
    },
  },
  {
    name: "port_check",
    label: TOOL_META["port_check"].label,
    description:
      "检查指定端口是否被占用，被占用时返回监听项与进程信息（PID、进程名）。用于排查端口冲突、确认服务是否已启动等场景。",
    parameters: Type.Object({
      port: Type.Integer({
        minimum: 1,
        maximum: 65535,
        description: "要查询的端口号（1-65535）",
      }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const text = await checkPort(params.port);
      return {
        content: [{ type: "text", text }],
        details: { port: params.port },
      };
    },
  },
  {
    name: "spawn_subagent",
    label: "派生子 agent",
    description:
      "派生一个独立的子 agent 并行完成子任务（只读研究型可读文件/搜索，读写执行型可修改文件）。子 agent 上下文与主会话隔离，完成后只返回摘要。适合将可并行的独立子任务委派出去。",
    parameters: Type.Object({
      task: Type.String({ description: "交给子 agent 的任务描述" }),
      capability: Type.Optional(
        Type.Union(
          [
            Type.Literal("readonly", { description: "只读：不可修改文件" }),
            Type.Literal("readwrite", { description: "读写：可修改文件" }),
          ],
          { description: "子 agent 能力类型，默认 readonly" },
        ),
      ),
      surface: Type.Optional(
        Type.Union(
          [Type.Literal("work"), Type.Literal("coding")],
          { description: "会话形态（可选）" },
        ),
      ),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1000,
          description: "子 agent 超时（毫秒），默认 120000",
        }),
      ),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs & {
        task: string;
        capability?: "readonly" | "readwrite";
        surface?: "work" | "coding";
        timeoutMs?: number;
      };
      if (!spawnSubagentImpl) {
        return {
          content: [
            {
              type: "text",
              text: "子 agent 编排尚未启用（Phase 5 未注入执行器）。",
            },
          ],
          details: { enabled: false },
        };
      }
      const summary = await spawnSubagentImpl({
        parentSessionId: _toolCallId,
        task: params.task,
        capability: params.capability ?? "readonly",
        surface: params.surface,
        timeoutMs: params.timeoutMs,
      });
      return {
        content: [
          { type: "text", text: `子 agent 完成，摘要：\n${summary}` },
        ],
        details: { summary },
      };
    },
  },
  {
    name: "plan_propose",
    label: "提出执行计划",
    description:
      "在执行一项复杂任务前，先产出结构化计划（步骤 + 涉及工具 + 预期）并等待用户确认。计划提交后本调用会阻塞，直到用户在界面确认或拒绝；批准后继续执行，拒绝则根据反馈调整。适合多步骤、可能改动文件或调用外部工具的任务。",
    parameters: Type.Object({
      summary: Type.Optional(Type.String({ description: "计划整体目标的一句话概括" })),
      steps: Type.Array(
        Type.Object({
          title: Type.String({ description: "步骤标题" }),
          detail: Type.Optional(Type.String({ description: "步骤说明" })),
          tool: Type.Optional(Type.String({ description: "涉及的工具（如 write_file / mcp__xxx__tool）" })),
          expected: Type.Optional(Type.String({ description: "该步骤的预期结果" })),
        }),
        { description: "计划步骤列表" },
      ),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1000,
          description: "等待确认超时（毫秒），默认 5 分钟",
        }),
      ),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs & {
        summary?: string;
        steps: { title: string; detail?: string; tool?: string; expected?: string }[];
        timeoutMs?: number;
      };
      if (!planCtx) {
        return {
          content: [
            {
              type: "text",
              text: "计划模式尚未就绪（缺少会话上下文）。",
            },
          ],
          details: { enabled: false },
        };
      }
      if (!Array.isArray(params.steps) || params.steps.length === 0) {
        return {
          content: [
            { type: "text", text: "计划步骤不能为空，请列出至少一个步骤后再提交。" },
          ],
          details: { error: "empty_steps" },
        };
      }
      const { approved, plan } = await proposePlan({
        sessionId: planCtx.sessionId,
        surface: planCtx.surface,
        summary: params.summary,
        steps: params.steps,
        timeoutMs: params.timeoutMs,
      });
      const planText = plan.steps
        .map((s) => `- ${s.title}${s.tool ? `（工具: ${s.tool}）` : ""}`)
        .join("\n");
      if (approved) {
        return {
          content: [
            {
              type: "text",
              text: `用户已确认以下计划，开始逐步执行：\n${planText}`,
            },
          ],
          details: { planId: plan.id, approved: true },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `用户${plan.reason ? `（${plan.reason}）` : ""}未确认该计划，请根据反馈调整后重新规划。计划：\n${planText}`,
          },
        ],
        details: { planId: plan.id, approved: false, reason: plan.reason },
      };
    },
  },
];
