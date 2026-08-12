/**
 * 审批规则化 —— 真实 DeepSeek 端到端验证（走 HTTP SSE）。
 * 验证：写入 notes/（白名单命中）免审批；写入 testops/（未命中）触发审批。
 * 运行前需启动 dev server（.env.local 含 APPROVAL_ALLOW_PATHS=notes/,*.md）。
 * 运行：npx tsx test-policy-e2e.ts
 */
import { AGENT_WORKDIR } from "./lib/tools";
import fs from "node:fs/promises";
import path from "node:path";

interface SseEvent {
  type: string;
  id?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  message?: string;
}

async function main() {
  // 清理测试残留
  for (const p of ["testops", "notes"]) {
    await fs.rm(path.join(AGENT_WORKDIR, p), { recursive: true, force: true });
  }

  const res = await fetch("http://localhost:3000/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message:
        "在 agent-workdir 下创建两个文件：先创建 notes/note.txt，内容写「白名单自动放行」，再创建 testops/plain.txt，内容写「需要审批」。两个文件都用 write_file 写入。",
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`请求失败: ${res.status} ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const approvals = new Set<string>();
  const writes = new Map<string, string>(); // toolCallId -> path
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
      if (ev.type === "approval_required") {
        if (ev.id) approvals.add(ev.id);
      }
      if (ev.type === "tool_start" && ev.toolName === "write_file" && ev.id) {
        const p = String(ev.args?.path ?? "");
        writes.set(ev.id, p);
      }
      if (ev.type === "error") errorMsg = ev.message ?? "未知错误";
      if (ev.type === "approval_required") {
        // 自动批准（模拟用户点击）
        fetch("http://localhost:3000/api/agent/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: ev.id, approve: true }),
        }).catch(() => {});
      }
    }
  }

  console.log("== write_file 调用与审批情况 ==");
  let noteWrite: string | null = null;
  let plainWrite: string | null = null;
  for (const [id, p] of writes) {
    const approved = approvals.has(id);
    console.log(`  ${p}  ${approved ? "→ 触发审批（已批准）" : "→ 自动放行"}`);
    if (p.startsWith("notes/")) noteWrite = approved ? "approved" : "auto";
    if (p.startsWith("testops/")) plainWrite = approved ? "approved" : "auto";
  }

  if (errorMsg) {
    console.error(`✗ SSE error: ${errorMsg}`);
    process.exitCode = 1;
    return;
  }
  if (noteWrite === null) {
    console.error("✗ 未捕获到 notes/ 目录的 write_file");
    process.exitCode = 1;
    return;
  }
  if (plainWrite === null) {
    console.error("✗ 未捕获到 testops/ 目录的 write_file");
    process.exitCode = 1;
    return;
  }
  if (noteWrite !== "auto") {
    console.error(`✗ notes/ 写入应自动放行，实际 ${noteWrite}`);
    process.exitCode = 1;
    return;
  }
  if (plainWrite !== "approved") {
    console.error(`✗ testops/ 写入应触发审批，实际 ${plainWrite}`);
    process.exitCode = 1;
    return;
  }

  // 校验文件确实落盘
  const noteFile = path.join(AGENT_WORKDIR, "notes", "note.txt");
  const plainFile = path.join(AGENT_WORKDIR, "testops", "plain.txt");
  for (const f of [noteFile, plainFile]) {
    if (!(await fs.readFile(f, "utf-8"))) {
      console.error(`✗ 文件未成功写入: ${f}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log("\n✓ 审批规则化真实端到端验证通过");
  await fs.rm(path.join(AGENT_WORKDIR, "testops"), { recursive: true, force: true });
  await fs.rm(path.join(AGENT_WORKDIR, "notes"), { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
