/**
 * 并行工具执行 —— 真实 DeepSeek 端到端回归（走 HTTP SSE）。
 * 任务：读取目录下多个文件，观察 agent 是否一次发起多个 read_file。
 * 运行前需启动 dev server；运行：npx tsx test-parallel-e2e.ts
 */
import { AGENT_WORKDIR } from "../../lib/tools";
import fs from "node:fs/promises";
import path from "node:path";

interface SseEvent {
  type: string;
  id?: string;
  delta?: string;
  toolName?: string;
  message?: string;
}

async function main() {
  // 准备测试文件
  const testDir = path.join(AGENT_WORKDIR, "testpar");
  await fs.rm(testDir, { recursive: true, force: true });
  await fs.mkdir(testDir, { recursive: true });
  await fs.writeFile(path.join(testDir, "a.txt"), "内容A alpha", "utf-8");
  await fs.writeFile(path.join(testDir, "b.txt"), "内容B beta", "utf-8");
  await fs.writeFile(path.join(testDir, "c.txt"), "内容C gamma", "utf-8");

  const res = await fetch("http://localhost:3000/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "读取 agent-workdir/testpar 目录下的所有文件内容并汇总告诉我。",
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`请求失败: ${res.status} ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const calls: string[] = [];
  let reply = "";
  let errorMsg: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload) continue;
      let ev: SseEvent;
      try {
        ev = JSON.parse(payload) as SseEvent;
      } catch {
        continue;
      }
      if (ev.type === "tool_start" && ev.toolName) calls.push(ev.toolName);
      if (ev.type === "delta") reply += ev.delta ?? "";
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
  }
  if (!calls.includes("read_file")) {
    console.error("✗ 未调用 read_file");
    process.exitCode = 1;
  }
  // 检查回复是否汇总了三个文件
  const hasAlpha = reply.includes("alpha");
  const hasBeta = reply.includes("beta");
  const hasGamma = reply.includes("gamma");
  console.log(`== 汇总覆盖: alpha=${hasAlpha} beta=${hasBeta} gamma=${hasGamma} ==`);
  if (!hasAlpha || !hasBeta || !hasGamma) {
    console.error("✗ 回复未覆盖全部文件内容");
    process.exitCode = 1;
  }

  console.log("\n✓ 并行模式真实端到端回归通过");
  await fs.rm(testDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
