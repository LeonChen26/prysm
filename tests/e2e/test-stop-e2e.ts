/**
 * 停止/中断控制 —— 真实 DeepSeek 端到端验证（走 HTTP）。
 * 流程：发起长任务（写 20 个文件）→ 200ms 后 POST /api/agent/stop →
 *       期望收到 stopped 事件 → 再发一条消息验证 agent 后续可用。
 * 运行前需启动 dev server；运行：npx tsx test-stop-e2e.ts
 */
import { AGENT_WORKDIR } from "../../lib/tools";
import fs from "node:fs/promises";
import path from "node:path";

const BASE = "http://localhost:30123";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SseEvent {
  type: string;
  id?: string;
  message?: string;
}

async function readAllEvents(res: Response): Promise<SseEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: SseEvent[] = [];
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
      try {
        events.push(JSON.parse(payload) as SseEvent);
      } catch {
        /* 忽略 */
      }
    }
  }
  return events;
}

async function main() {
  const testDir = path.join(AGENT_WORKDIR, "teststop");
  await fs.rm(testDir, { recursive: true, force: true });

  // 建一个独立会话，避免污染
  const s = (await (await fetch(`${BASE}/api/sessions`, { method: "POST" })).json()).session;
  const sessionId = s.id;

  // 长任务：写 20 个文件（每次 write_file 走审批自动批准，耗时长）
  const res = await fetch(`${BASE}/api/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message:
        "请立即执行，不要询问：在 agent-workdir/teststop 目录依次写入 20 个文件 file-01.txt 到 file-20.txt，每个文件内容为该文件编号数字。逐个写入，全部完成后再总结。",
      sessionId,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`发送失败: ${res.status} ${await res.text()}`);
  }

  // 读流的同时，200ms 后发起停止
  const reading = readAllEvents(res);
  let stopResp: { ok?: boolean; stopped?: boolean; error?: string } = {};
  await sleep(200);
  try {
    const stopRes = await fetch(`${BASE}/api/agent/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    stopResp = await stopRes.json();
  } catch (err) {
    stopResp = { error: err instanceof Error ? err.message : String(err) };
  }
  const events = await reading;

  const types = events.map((e) => e.type);
  const replyText = events
    .filter((e) => e.type === "delta")
    .map((e) => e.message)
    .join("");
  console.log("== 事件序列 ==");
  console.log("  " + types.join(" → "));
  console.log("== 首段回复 ==");
  console.log(`  ${replyText.slice(0, 120)}`);
  console.log("== stop API 响应 ==");
  console.log(`  ${JSON.stringify(stopResp)}`);

  if (stopResp.error) {
    console.error(`✗ stop API 失败: ${stopResp.error}`);
    process.exitCode = 1;
    return;
  }
  // 审批自动批准
  for (const ev of events) {
    if (ev.type === "approval_required") {
      fetch(`${BASE}/api/agent/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ev.id, approve: true }),
      }).catch(() => {});
    }
  }

  const stopped = types.includes("stopped");
  const done = types.includes("done");
  const hasError = types.includes("error");
  if (hasError) {
    const errEv = events.find((e) => e.type === "error");
    console.error(`✗ SSE 出现错误: ${errEv?.message}`);
    process.exitCode = 1;
    return;
  }
  if (stopped) {
    console.log("  ✓ 收到 stopped 事件（任务被中断）");
  } else if (done) {
    console.log("  ⚠ 任务过快已完成，未触发停止（20 文件任务不应这么快）");
    process.exitCode = 1;
    return;
  } else {
    console.error("✗ 既未 stopped 也未 done");
    process.exitCode = 1;
    return;
  }

  // 停止后 agent 应仍可用：再发一条简单消息
  console.log("\n== 停止后继续对话 ==");
  const res2 = await fetch(`${BASE}/api/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "你好，回复 收到 即可", sessionId }),
  });
  const events2 = await readAllEvents(res2);
  const types2 = events2.map((e) => e.type);
  const reply = events2
    .filter((e) => e.type === "delta")
    .map((e) => e.message)
    .join("");
  console.log("  " + types2.join(" → "));
  console.log(`  回复: ${reply.slice(0, 60)}`);
  if (!types2.includes("done") || types2.includes("error")) {
    console.error("✗ 停止后 agent 无法正常对话");
    process.exitCode = 1;
    return;
  }
  console.log("  ✓ 停止后 agent 仍可用");

  // 清理
  await fetch(`${BASE}/api/sessions/${sessionId}`, { method: "DELETE" });
  await fs.rm(testDir, { recursive: true, force: true });
  console.log("\n✓ 停止/中断控制端到端验证通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
