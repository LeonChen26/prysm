import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createTodos, formatTodos, listTodos, modifyTodos, type TodoUpdate } from "./todo";
import { fetchUrlAsText, webSearch } from "./web";
import { AGENT_WORKDIR, ALLOWED_ROOTS, resolveInWorkdir } from "./paths";

// re-export 兼容历史导入（测试脚本从 lib/tools 引入 AGENT_WORKDIR）
export { AGENT_WORKDIR, ALLOWED_ROOTS } from "./paths";

interface FileHit {
  path: string;
  line: number;
  text: string;
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

/** 在工作区内递归搜索关键词（限制单文件大小，跳过常见无关目录） */
async function searchInWorkdir(
  query: string,
  pattern: string | undefined,
  limit: number,
): Promise<FileHit[]> {
  const hits: FileHit[] = [];
  const re = pattern ? globToRegex(pattern) : null;
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
            if (lines[i].includes(query)) {
              hits.push({
                path: path.relative(AGENT_WORKDIR, full).replace(/\\/g, "/"),
                line: i + 1,
                text: lines[i].slice(0, 200),
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
  updates?: TodoUpdate[];
  append?: { title: string; detail?: string }[];
}

export const tools: AgentTool<any>[] = [
  {
    name: "list_dir",
    label: "列出目录",
    description:
      "列出工作区（agent-workdir）内指定目录下的文件与子目录。dir 为空表示根目录。",
    parameters: Type.Object({
      dir: Type.Optional(
        Type.String({ description: "相对路径目录，默认 '' 表示工作区根目录" }),
      ),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const dir = resolveInWorkdir(params.dir ?? "");
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
    label: "读取文件",
    description: "读取工作区内的文本文件内容，最大支持 100KB。",
    parameters: Type.Object({
      path: Type.String({ description: "相对文件路径" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const file = resolveInWorkdir(params.path);
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
    label: "写入文件",
    description: "在工作区写入或覆盖一个文本文件（自动创建父目录）。",
    parameters: Type.Object({
      path: Type.String({ description: "相对文件路径" }),
      content: Type.String({ description: "要写入的完整内容" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const file = resolveInWorkdir(params.path);
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
    label: "追加写入",
    description:
      "在文件末尾追加内容（文件不存在则创建）。用于增量记录、日志、续写等。",
    parameters: Type.Object({
      path: Type.String({ description: "相对文件路径" }),
      content: Type.String({ description: "要追加的内容" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const file = resolveInWorkdir(params.path);
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
    name: "create_dir",
    label: "创建目录",
    description: "在工作区创建目录（可一次创建多级，已存在则跳过）。",
    parameters: Type.Object({
      path: Type.String({ description: "相对目录路径" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const dir = resolveInWorkdir(params.path);
      await fs.mkdir(dir, { recursive: true });
      return {
        content: [{ type: "text", text: `目录已就绪: ${params.path}` }],
        details: { path: params.path },
      };
    },
  },
  {
    name: "move_file",
    label: "移动/重命名",
    description: "移动或重命名工作区内的文件或目录（自动创建目标父目录）。",
    parameters: Type.Object({
      from: Type.String({ description: "源相对路径（文件或目录）" }),
      to: Type.String({ description: "目标相对路径" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const src = resolveInWorkdir(params.from);
      const dst = resolveInWorkdir(params.to);
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
    label: "复制文件",
    description: "在工作区内复制文件（自动创建目标父目录）。",
    parameters: Type.Object({
      from: Type.String({ description: "源相对文件路径" }),
      to: Type.String({ description: "目标相对文件路径" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const src = resolveInWorkdir(params.from);
      const dst = resolveInWorkdir(params.to);
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
    label: "删除文件",
    description: "删除工作区内的文件（不删除目录）。属于敏感操作，需要用户确认。",
    parameters: Type.Object({
      path: Type.String({ description: "相对文件路径" }),
    }),
    execute: async (_toolCallId, _params) => {
      const params = _params as ToolArgs;
      const file = resolveInWorkdir(params.path);
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
      const file = resolveInWorkdir(params.path);
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
    label: "创建任务计划",
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
    label: "抓取网页",
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
    label: "搜索文件内容",
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
    name: "run_bash",
    label: "执行命令",
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
    label: "端口查询",
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
];
