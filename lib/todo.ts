/**
 * 任务规划模式
 * 为复杂任务提供结构化的任务清单管理（todo 工具）。
 * 状态为会话级（内存），随 agent 单例生命周期。
 */

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

let todos: TodoItem[] = [];
let seq = 0;

function genId(): string {
  return `todo-${++seq}`;
}

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
  return { todos: snapshot(), msg: "任务顺序已更新。" };
}

/** todo_remove：按 id 删除子任务 */
export function removeTodos(ids: string[]): { todos: TodoItem[]; msg: string } {
  todos = todos.filter((t) => !ids.includes(t.id));
  return { todos: snapshot(), msg: "已删除任务。" };
}
