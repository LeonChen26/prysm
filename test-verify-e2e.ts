/**
 * 自主校验循环 —— 真实 DeepSeek 端到端验证（走 HTTP SSE）。
 * 验证：任务写入文件后，agent 调用 verify_file 自检交付物。
 * 运行前需启动 dev server；运行：npx tsx test-verify-e2e.ts
 */
import { AGENT_WORKDIR } from "./lib/tools";
import fs from "node:fs/promises";
import path from "node:path";

interface SseEvent {
  type: string;
  id?: string;
  toolName?: string;
  isError?: boolean;
  args?: Record<string, unknown>;
  message?: string;
}

async function main() {
  const testDir = path.join(AGENT_WORKDIR, "testverify");
  await fs.rm(testDir, { recursive: true, force: true });

  const res = await fetch("http://localhost:3000/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message:
        "在 agent-workdir/testverify 目录创建校验报告 verify-report.md，标题为《自主校验验证报告》，正文写一段说明。完成后必须调用 verify_file 校验该文件存在且包含标题文字，确认无误后再总结。",
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`请求失败: ${res.status} ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const calls: string[] = [];
  const verifyCalls: { args: Record<string, unknown>; isError: boolean }[] = [];
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
      if (ev.type === "tool_start" && ev.toolName === "verify_file") {
        verifyCalls.push({ args: ev.args ?? {}, isError: false });
      }
      if (ev.type === "tool_end" && ev.toolName === "verify_file") {
        const last = verifyCalls[verifyCalls.length - 1];
        if (last) last.isError = !!ev.isError;
      }
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
  console.log("== verify_file 调用 ==");
  verifyCalls.forEach((v, i) => {
    console.log(
      `  [${i}] path=${JSON.stringify(v.args.path)} expect=${JSON.stringify(v.args.expect ?? null)} isError=${v.isError}`,
    );
  });

  if (errorMsg) {
    console.error(`✗ SSE error: ${errorMsg}`);
    process.exitCode = 1;
    return;
  }
  if (verifyCalls.length === 0) {
    console.error("✗ agent 未调用 verify_file 自检");
    process.exitCode = 1;
    return;
  }
  if (verifyCalls.some((v) => v.isError)) {
    console.error("✗ verify_file 调用出现错误");
    process.exitCode = 1;
    return;
  }
  const report = path.join(testDir, "verify-report.md");
  const content = await fs.readFile(report, "utf-8");
  if (!content.includes("自主校验验证报告")) {
    console.error("✗ 报告文件内容缺少标题");
    process.exitCode = 1;
    return;
  }
  console.log("\n✓ 自主校验循环真实端到端验证通过");
  await fs.rm(testDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
