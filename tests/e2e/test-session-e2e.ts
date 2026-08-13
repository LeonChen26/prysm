/**
 * 多会话管理 —— 真实 DeepSeek 端到端验证（走 HTTP）。
 * 流程：清空会话 → 建 A → A 里写文件任务 → 建 B → B 里发消息 →
 *       验证会话隔离（B 看不到 A 内容）→ 切回 A 恢复上下文继续追问。
 * 运行前需启动 dev server；运行：npx tsx test-session-e2e.ts
 */
import { AGENT_WORKDIR } from "../../lib/tools";
import fs from "node:fs/promises";
import path from "node:path";

interface SseEvent {
  type: string;
  id?: string;
  delta?: string;
  message?: string;
}

const BASE = "http://localhost:3000";

async function sendMessage(sessionId: string, message: string): Promise<string> {
  const res = await fetch(`${BASE}/api/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionId }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`发送失败: ${res.status} ${await res.text()}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let reply = "";
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
      if (ev.type === "delta") reply += ev.delta ?? "";
      if (ev.type === "approval_required") {
        fetch(`${BASE}/api/agent/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: ev.id, approve: true }),
        }).catch(() => {});
      }
      if (ev.type === "error") throw new Error(`SSE error: ${ev.message}`);
    }
  }
  return reply;
}

async function main() {
  const testDir = path.join(AGENT_WORKDIR, "testops-a");
  await fs.rm(testDir, { recursive: true, force: true });

  // 清空已有会话
  const sessions = await (await fetch(`${BASE}/api/sessions`)).json();
  for (const s of sessions.sessions ?? []) {
    await fetch(`${BASE}/api/sessions/${s.id}`, { method: "DELETE" });
  }

  // 1. 建会话 A，发写文件任务
  const aRes = await (await fetch(`${BASE}/api/sessions`, { method: "POST" })).json();
  const a = aRes.session;
  console.log(`== 会话 A: ${a.id} (${a.title}) ==`);
  const aReply1 = await sendMessage(
    a.id,
    "在 agent-workdir/testops-a 创建 secret.txt，内容为 XKCD-9000",
  );
  console.log(`  A 回复: ${aReply1.slice(0, 60)}...`);

  // 2. 建会话 B，发独立消息
  const bRes = await (await fetch(`${BASE}/api/sessions`, { method: "POST" })).json();
  const b = bRes.session;
  console.log(`\n== 会话 B: ${b.id} (${b.title}) ==`);
  const bReply = await sendMessage(b.id, "你好，打个招呼即可");
  console.log(`  B 回复: ${bReply.slice(0, 60)}...`);

  // 3. 验证会话列表
  const list = (await (await fetch(`${BASE}/api/sessions`)).json()).sessions;
  if (list.length !== 2) {
    console.error(`✗ 会话列表应为 2 个，实际 ${list.length}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n== 会话列表 ${list.length} 个: ${list.map((s: { title: string }) => s.title).join(" / ")}`);

  // 4. 会话隔离：B 的消息不应包含 A 的内容
  const bDetail = await (await fetch(`${BASE}/api/sessions/${b.id}`)).json();
  const bText = JSON.stringify(bDetail.messages);
  if (bText.includes("secret.txt") || bText.includes("XKCD")) {
    console.error("✗ 会话 B 泄漏了会话 A 的消息内容");
    process.exitCode = 1;
    return;
  }
  console.log("  ✓ 会话隔离：B 不含 A 的内容");

  // 5. 切回 A：持久化历史存在 + 恢复上下文后继续追问
  const aDetail = await (await fetch(`${BASE}/api/sessions/${a.id}`)).json();
  const aMsgs = aDetail.messages as { role: string; text: string }[];
  if (aMsgs.length < 2) {
    console.error(`✗ 会话 A 应持久化 ≥2 条消息，实际 ${aMsgs.length}`);
    process.exitCode = 1;
    return;
  }
  if (!JSON.stringify(aMsgs).includes("secret.txt")) {
    console.error("✗ 会话 A 持久化消息中缺少 secret.txt 任务");
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ 会话 A 持久化 ${aMsgs.length} 条消息，含历史任务`);

  console.log("\n== 切回 A 继续追问 ==");
  const aReply2 = await sendMessage(a.id, "我们刚才创建的文件内容是什么？");
  console.log(`  A 回复: ${aReply2.slice(0, 120)}`);
  const aDetail2 = await (await fetch(`${BASE}/api/sessions/${a.id}`)).json();
  const aMsgs2 = aDetail2.messages as { role: string; text: string }[];
  if (aMsgs2.length <= aMsgs.length) {
    console.error("✗ 追问后会话 A 消息未增长（上下文未恢复）");
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ 追问后 A 消息数增长到 ${aMsgs2.length}`);

  // 清理
  for (const s of list) {
    await fetch(`${BASE}/api/sessions/${s.id}`, { method: "DELETE" });
  }
  await fs.rm(testDir, { recursive: true, force: true });
  console.log("\n✓ 多会话管理真实端到端验证通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
