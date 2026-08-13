/**
 * 任务规划模式
 * 为复杂任务提供结构化的任务清单管理（todo 工具）。
 * 状态持久化到 todo.db（SQLite），进程重启后自动恢复，实现跨会话/跨重启的任务计划留存。
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  title: string;
  detail?: string;
  status: TodoStatus;
}

export interface TodoUpdate {
  id: string;
  status?: TodoStatus;
  title?: string;
}

const TODO_DB = path.resolve(process.cwd(), "todo.db");

let todos: TodoItem[] = [];
let seq = 0;
let db: DatabaseSync | undefined;

function getDb(): DatabaseSync {
  if (db) return db;
  const d = new DatabaseSync(TODO_DB);
  d.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      detail TEXT,
      status TEXT NOT NULL,
      sort INTEGER NOT NULL
    );
  `);
  db = d;
  return d;
}

/** 进程启动时从数据库恢复任务清单（不恢复自增序号，保证 createTodos 仍从 todo-1 开始） */
function loadTodos(): void {
  try {
    const rows = getDb()
      .prepare("SELECT * FROM todos ORDER BY sort")
      .all() as {
      id: string;
      title: string;
      detail: string | null;
      status: string;
    }[];
    todos = rows.map((r) => ({
      id: r.id,
      title: r.title,
      detail: r.detail ?? undefined,
      status: r.status as TodoStatus,
    }));
  } catch {
    /* 数据库损坏则忽略 */
  }
}

/** 变更后全量落盘（简单可靠，清单规模很小） */
function saveTodos(): void {
  const d = getDb();
  d.exec("BEGIN");
  try {
    d.exec("DELETE FROM todos");
    const ins = d.prepare(
      "INSERT INTO todos (id, title, detail, status, sort) VALUES (?, ?, ?, ?, ?)",
    );
    todos.forEach((t, i) =>
      ins.run(t.id, t.title, t.detail ?? null, t.status, i),
    );
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

/** 生成不冲突的 id（恢复的历史清单可能占用低序号，冲突则跳过） */
function genId(): string {
  for (;;) {
    const id = `todo-${++seq}`;
    if (!todos.some((t) => t.id === id)) return id;
  }
}

loadTodos();

/** 返回深拷贝快照，避免调用方持有的引用被后续状态变更污染 */
function snapshot(): TodoItem[] {
  return todos.map((t) => ({ ...t }));
}

export function formatTodos(list: TodoItem[]): string {
  if (list.length === 0) return "(暂无任务)";
  return list
    .map(
      (t) =>
        `[${t.id}] [${t.status}] ${t.title}${t.detail ? ` — ${t.detail}` : ""}`,
    )
    .join("\n");
}

/** todo_create：覆盖式创建新的任务清单 */
export function createTodos(
  items: { title: string; detail?: string }[],
): { todos: TodoItem[]; msg: string } {
  todos = items.map((it, i) => ({
    id: genId(),
    title: it.title,
    detail: it.detail,
    status: "pending",
  }));
  saveTodos();
  return {
    todos: snapshot(),
    msg: `已创建任务计划（${todos.length} 个步骤），随后逐步执行并更新状态。`,
  };
}

/** todo_modify：按 id 更新状态/标题，或追加子任务 */
export function modifyTodos(
  updates?: TodoUpdate[],
  append?: { title: string; detail?: string }[],
): { todos: TodoItem[]; msg: string } {
  for (const u of updates ?? []) {
    const t = todos.find((item) => item.id === u.id);
    if (!t) throw new Error(`任务 "${u.id}" 不存在，请先 todo_list 查看当前清单`);
    if (u.status) t.status = u.status;
    if (u.title) t.title = u.title;
  }
  for (const a of append ?? []) {
    todos.push({ id: genId(), title: a.title, detail: a.detail, status: "pending" });
  }
  saveTodos();
  return {
    todos: snapshot(),
    msg: "任务清单已更新。",
  };
}

/** todo_list：列出当前清单 */
export function listTodos(): { todos: TodoItem[]; msg: string } {
  return {
    todos: snapshot(),
    msg:
      todos.length === 0
        ? "当前没有任务计划。"
        : `当前任务清单：\n${formatTodos(todos)}`,
  };
}

/** todo_reorder：按给定 id 顺序重排清单（未提及的项按原相对顺序排在末尾） */
export function reorderTodos(ids: string[]): { todos: TodoItem[]; msg: string } {
  const map = new Map(todos.map((t) => [t.id, t]));
  const next: TodoItem[] = [];
  for (const id of ids) {
    const t = map.get(id);
    if (t) next.push(t);
  }
  for (const t of todos) {
    if (!ids.includes(t.id)) next.push(t);
  }
  todos = next;
  saveTodos();
  return { todos: snapshot(), msg: "任务顺序已更新。" };
}

/** todo_remove：按 id 删除子任务 */
export function removeTodos(ids: string[]): { todos: TodoItem[]; msg: string } {
  todos = todos.filter((t) => !ids.includes(t.id));
  saveTodos();
  return { todos: snapshot(), msg: "已删除任务。" };
}

/** 导出当前任务清单（供备份恢复） */
export function exportTodos(): TodoItem[] {
  return snapshot();
}

/** 导入任务清单（替换现有清单，保留原 id 与状态） */
export function importTodos(list: TodoItem[]): void {
  todos = (Array.isArray(list) ? list : []).map((t) => ({
    id: t.id,
    title: t.title,
    detail: t.detail,
    status: t.status ?? "pending",
  }));
  saveTodos();
}
