import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createTodos, formatTodos, listTodos, modifyTodos } from "./todo";

/** 所有文件工具的作用域：项目下的 agent-workdir 目录 */
export const AGENT_WORKDIR = path.resolve(process.cwd(), "agent-workdir");

function resolveInWorkdir(relative: string): string {
  const resolved = path.resolve(AGENT_WORKDIR, relative);
  if (resolved !== AGENT_WORKDIR && !resolved.startsWith(AGENT_WORKDIR + path.sep)) {
    throw new Error(`路径越界: "${relative}" 不在 agent-workdir 内`);
  }
  return resolved;
}

export const tools: AgentTool[] = [
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
    execute: async (_toolCallId, params) => {
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
    execute: async (_toolCallId, params) => {
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
    execute: async (_toolCallId, params) => {
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
    execute: async (_toolCallId, params) => {
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
    execute: async (_toolCallId, params) => {
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
];
