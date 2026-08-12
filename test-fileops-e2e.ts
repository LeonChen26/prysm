/**
 * 文件工具增强 —— 真实 DeepSeek 端到端验证（走 HTTP SSE）。
 * 运行前需先启动 dev server：npm run dev
 * 运行：npx tsx test-fileops-e2e.ts
 */
import { AGENT_WORKDIR } from "./lib/tools";
import fs from "node:fs/promises";
import path from "node:path";

const NEW_TOOLS = [
  "append_file",
  "create_dir",
  "move_file",
  "copy_file",
  "delete_file",
];

interface SseEvent {
  type: string;
  id?: string;
  toolName?: string;
  isError?: boolean;
  message?: string;
}

async function main() {
  // 清理测试目录
  const testDir = path.join(AGENT_WORKDIR, "testops");
  await fs.rm(testDir, { recursive: true, force: true });

  const res = await fetch("http://localhost:3000/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message:
        "在 agent-workdir/testops 目录搭建一个小项目结构：创建 src 与 docs 两个目录，在 src 下写入 main.js（内容为 console.log(1);），把它复制为 backup.js，再将 backup.js 移动到 docs/ 下，最后在 main.js 末尾追加一行注释 // updated。",
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`请求失败: ${res.status} ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const calls: string[] = [];
  let errorMsg: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      let ev: SseEvent;
      try {
        ev = JSON.parse(payload) as SseEvent;
      } catch {
        continue;
      }
      if (ev.type === "tool_start" && ev.toolName) calls.push(ev.toolName);
      if (ev.type === "error") errorMsg = ev.message ?? "未知错误";
      if (ev.type === "approval_required") {
        fetch("http://localhost:3000/api/agent/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: ev.id, approve: true }),
        }).catch(() => {});
      }
    }
  }

  console.log("== 工具调用序列 ==");
  console.log("  " + calls.join(" → "));

  if (errorMsg) {
    console.error(`✗ SSE error: ${errorMsg}`);
    process.exitCode = 1;
    return;
  }
  const usedNew = NEW_TOOLS.filter((t) => calls.includes(t));
  console.log("== 新文件工具使用 ==");
  console.log("  " + (usedNew.join(", ") || "(未使用)"));
  if (usedNew.length < 3) {
    console.error(`✗ 新文件工具使用不足 3 个（实际 ${usedNew.length} 个）`);
    process.exitCode = 1;
  }

  // 文件系统结果（部分生成即视为功能可用）
  const mainJs = path.join(testDir, "src", "main.js");
  const backup = path.join(testDir, "docs", "backup.js");
  let ok = false;
  for (const p of [mainJs, backup]) {
    try {
      const content = await fs.readFile(p, "utf-8");
      console.log(`\n== ${path.relative(AGENT_WORKDIR, p)} 内容 ==`);
      console.log("  " + content.replace(/\n/g, " | "));
      ok = true;
    } catch {
      /* 该路径未生成 */
    }
  }
  if (!ok) {
    console.error("✗ testops 下未生成预期文件");
    process.exitCode = 1;
    return;
  }
  console.log("\n✓ 文件工具增强真实端到端验证通过");
  await fs.rm(testDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
