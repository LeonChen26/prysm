/**
 * 会话管理（session.ts）验证脚本 —— 纯函数断言，无需 LLM。
 * 覆盖：创建/列表/查询/消息往返保存/删除。
 * 运行：npx tsx test-session.ts
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createSession,
  deleteSession,
  getSession,
  getSessionMessages,
  listSessions,
  renameSession,
  saveSessionMessages,
} from "./lib/session";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

const mk = (role: "user" | "assistant", text: string): AgentMessage => ({
  role,
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

async function main() {
  // 清理旧会话
  for (const s of listSessions()) deleteSession(s.id);

  console.log("== 创建会话 ==");
  const a = createSession();
  if (!a.id || a.title !== "新会话") fail(`会话创建异常: ${JSON.stringify(a)}`);
  const b = createSession("自定义标题");
  if (b.title !== "自定义标题") fail("自定义标题未生效");
  console.log(`  ✓ A=${a.title} B=${b.title}`);

  console.log("== 列表与查询 ==");
  const list = listSessions();
  if (list.length !== 2) fail(`应有两个会话，实际 ${list.length}`);
  const got = getSession(a.id);
  if (!got || got.id !== a.id) fail("按 id 查询失败");
  if (getSession("not-exist")) fail("不存在的 id 应返回 undefined");
  console.log(`  ✓ 列表 ${list.length} 个，查询命中`);

  console.log("== 消息往返保存 ==");
  const msgs = [mk("user", "帮我写一个文件"), mk("assistant", "好的")];
  saveSessionMessages(a.id, msgs);
  const restored = getSessionMessages(a.id);
  if (restored.length !== 2) fail(`恢复消息数应为 2，实际 ${restored.length}`);
  if (restored[0].role !== "user" || restored[1].role !== "assistant") {
    fail("消息角色还原错误");
  }
  const t0 = restored[0].content;
  if (Array.isArray(t0) && t0[0].type === "text" && t0[0].text !== "帮我写一个文件") {
    fail("消息内容还原错误");
  }
  console.log(`  ✓ 保存并还原 ${restored.length} 条消息`);

  console.log("== 重命名与更新排序 ==");
  renameSession(a.id, "重命名后的标题");
  const renamed = getSession(a.id);
  if (renamed?.title !== "重命名后的标题") fail("重命名未生效");
  const list2 = listSessions();
  if (list2[0].id !== a.id) fail("最近更新的会话应排最前");
  console.log(`  ✓ 重命名生效，A 排最前`);

  console.log("== 删除 ==");
  deleteSession(b.id);
  if (getSession(b.id)) fail("删除后仍可查询");
  if (getSessionMessages(b.id).length !== 0) fail("删除后消息未清理");
  const list3 = listSessions();
  if (list3.length !== 1) fail(`删除后应剩 1 个，实际 ${list3.length}`);
  console.log("  ✓ 删除会话并清理消息");

  // 清理
  for (const s of listSessions()) deleteSession(s.id);
  console.log("\n✓ 会话管理验证通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
