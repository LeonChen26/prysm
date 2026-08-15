/**
 * 会话级工作目录上下文（绑定目录）
 * coding 会话创建时可绑定一个具体目录；此后 Agent 的文件工具与命令执行
 * 都以该目录为根（resolveInWorkdir 的 root 基准），而非全局共享的 agent-workdir。
 *
 * 工具执行层（tools.ts）在每次执行前通过 getSessionWorkdir(sessionId) 解析根目录；
 * 未绑定的会话回退到全局默认工作区。
 */

/** sessionId → 绑定的工作目录（绝对路径） */
const sessionWorkdirs = new Map<string, string>();

/** 记录某会话绑定的工作目录（创建会话时写入） */
export function setSessionWorkdir(sessionId: string, workdir: string): void {
  sessionWorkdirs.set(sessionId, workdir);
}

/** 读取某会话绑定的工作目录（未绑定返回 undefined） */
export function getSessionWorkdir(sessionId: string): string | undefined {
  return sessionWorkdirs.get(sessionId);
}

/** 会话删除 / 切换时清理映射（避免内存泄漏） */
export function clearSessionWorkdir(sessionId: string): void {
  sessionWorkdirs.delete(sessionId);
}

/** 全部已绑定目录的会话（调试/测试用） */
export function listSessionWorkdirs(): Record<string, string> {
  return Object.fromEntries(sessionWorkdirs);
}
