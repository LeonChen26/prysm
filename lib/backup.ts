/**
 * 数据备份与恢复
 * 一键导出 / 导入：全部会话与消息 + 情景记忆 + 任务计划。
 * 输出为一个自包含的 JSON 文件，导入时清空并重建（事务）。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  dumpAllSessions,
  restoreAllSessions,
  type SessionInfo,
} from "./session";
import {
  dumpEpisodes,
  restoreEpisodes,
  type MemoryEpisode,
} from "./memory";
import { exportTodos, importTodos, type TodoItem } from "./todo";

export interface BackupFile {
  /** 备份格式版本（当前 1） */
  version: 1;
  exportedAt: number;
  sessions: SessionInfo[];
  messagesBySession: Record<string, AgentMessage[]>;
  memory: MemoryEpisode[];
  todos: TodoItem[];
}

/** 导出全部数据为备份对象 */
export function exportBackup(): BackupFile {
  const { sessions, messagesBySession } = dumpAllSessions();
  return {
    version: 1,
    exportedAt: Date.now(),
    sessions,
    messagesBySession,
    memory: dumpEpisodes(),
    todos: exportTodos(),
  };
}

export interface RestoreStats {
  sessions: number;
  messages: number;
  memory: number;
  todos: number;
}

/** 校验并导入备份（清空重建），返回各类数据条数 */
export function importBackup(data: unknown): RestoreStats {
  const b = data as Partial<BackupFile>;
  if (!b || b.version !== 1 || !Array.isArray(b.sessions)) {
    throw new Error("备份文件格式不正确：缺少 version=1 或 sessions 数组");
  }
  const messagesBySession: Record<string, AgentMessage[]> = {};
  for (const [sid, msgs] of Object.entries(b.messagesBySession ?? {})) {
    messagesBySession[sid] = Array.isArray(msgs) ? msgs : [];
  }
  const messageCount = Object.values(messagesBySession).reduce(
    (n, msgs) => n + msgs.length,
    0,
  );
  const memory = Array.isArray(b.memory) ? b.memory : [];
  const todos = Array.isArray(b.todos) ? b.todos : [];

  restoreAllSessions(b.sessions, messagesBySession);
  restoreEpisodes(memory);
  importTodos(todos);

  return {
    sessions: b.sessions.length,
    messages: messageCount,
    memory: memory.length,
    todos: todos.length,
  };
}
