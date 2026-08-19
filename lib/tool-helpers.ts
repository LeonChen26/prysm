import { exec } from "node:child_process";

/** 工具执行结果 */
export interface CommandResult {
  exitCode: number;
  output: string;
}

/** 在指定目录执行 shell 命令（超时后终止，输出截断到 8000 字符） */
export function runCommand(
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
export async function checkPort(port: number): Promise<string> {
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

/** 文件名通配（支持 * 和 ?）转正则 */
export function globToRegex(pattern: string): RegExp | null {
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
export function globPathToRegex(pattern: string): RegExp | null {
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

/** 统计字符串中的换行数（用于定位 old_string / new_string 的行号） */
export function countNewlines(s: string): number {
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
export function buildEditDiff(
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
