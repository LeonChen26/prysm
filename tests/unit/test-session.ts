/**
 * 会话管理（session.ts）验证脚本 —— 纯函数断言，无需 LLM。
 * 覆盖：创建/列表/查询/消息往返保存/删除/workdir 绑定/surface 持久化/
 *      deleteSessionMessage(s)、searchSessionMessages、dumpAllSessions/restoreAllSessions。
 * 运行：npx tsx test-session.ts
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DatabaseSync } from "node:sqlite";
import { basePath } from "../../lib/config";
import {
  clearSessionMessages,
  createSession,
  deleteSession,
  deleteSessionMessage,
  deleteSessionMessages,
  dumpAllSessions,
  getSession,
  getSessionMessages,
  listSessions,
  pinSession,
  renameSession,
  restoreAllSessions,
  saveSessionMessages,
  searchSessionMessages,
} from "../../lib/session";

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

/** 读取库中该会话已软删（deleted=1）的消息行数，用于验证软删行保留 */
function countDeletedRows(sessionId: string): number {
  const d = new DatabaseSync(basePath("sessions.db"));
  try {
    const row = d
      .prepare(
        "SELECT COUNT(*) AS c FROM session_messages WHERE session_id = ? AND deleted = 1",
      )
      .get(sessionId) as { c: number };
    return Number(row.c);
  } finally {
    d.close();
  }
}

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

  console.log("== 置顶 ==");
  pinSession(b.id, true);
  const pinnedA = getSession(a.id);
  const pinnedB = getSession(b.id);
  if (pinnedA?.pinned !== 0 || pinnedB?.pinned !== 1) fail("置顶标记未生效");
  const listPin = listSessions();
  if (listPin[0].id !== b.id) fail("置顶会话应排最前");
  pinSession(b.id, false);
  if (getSession(b.id)?.pinned !== 0) fail("取消置顶未生效");
  const listUnpin = listSessions();
  if (listUnpin[0].id !== a.id) fail("取消置顶后按更新时间排序");
  console.log("  ✓ 置顶/取消置顶生效，排序正确");

  console.log("== 清空消息 ==");
  clearSessionMessages(a.id);
  if (getSessionMessages(a.id).length !== 0) fail("清空后消息应为空");
  if (!getSession(a.id)) fail("清空不应删除会话本身");
  console.log("  ✓ 清空消息保留会话");

  console.log("== 删除 ==");
  deleteSession(b.id);
  if (getSession(b.id)) fail("删除后仍可查询");
  if (getSessionMessages(b.id).length !== 0) fail("删除后消息未清理");
  const list3 = listSessions();
  if (list3.length !== 1) fail(`删除后应剩 1 个，实际 ${list3.length}`);
  console.log("  ✓ 删除会话并清理消息");

  // 清理
  for (const s of listSessions()) deleteSession(s.id);

  console.log("\n== surface / workdir 绑定 ==");
  const sWork = createSession("办公会话", "work");
  if (sWork.surface !== "work") fail("surface=work 未生效");
  if (sWork.workdir !== undefined) fail("未指定 workdir 时应为 undefined");
  const sCode = createSession("编码会话", "coding", "/project/my-app");
  if (sCode.surface !== "coding") fail("surface 默认应为 coding");
  if (sCode.workdir !== "/project/my-app") fail("workdir 绑定未生效");
  const gs = getSession(sCode.id);
  if (!gs || gs.workdir !== "/project/my-app") fail("持久化后 workdir 无法读取");
  const sDef = createSession("默认");
  if (sDef.surface !== "coding") fail("默认 surface 应为 coding");
  console.log(`  ✓ surface/workdir 绑定正确：work=${sWork.surface} coding=${sCode.surface} workdir=${sCode.workdir}`);

  console.log("\n== deleteSessionMessage(s) 软删与轮次级联 ==");
  const delMsgs: AgentMessage[] = [
    mk("user", "第一条用户消息"),
    mk("assistant", "第一条助手回复"),
    mk("user", "第二条用户消息"),
    mk("assistant", "第二条助手回复"),
    mk("user", "第三条用户消息"),
  ];
  saveSessionMessages(sCode.id, delMsgs);
  const before = getSessionMessages(sCode.id);
  if (before.length !== 5) fail(`应为 5 条，实际 ${before.length}`);
  // 删除单条（索引 2：第二条用户消息）→ 级联隐藏其回复（索引 3）
  const after1 = deleteSessionMessage(sCode.id, 2);
  if (after1.length !== 3) fail(`删除+级联后应为 3，实际 ${after1.length}`);
  const texts = after1.map((m) => {
    const c = m.content;
    if (Array.isArray(c)) return (c[0] as { text?: string })?.text ?? "";
    return String(c ?? "");
  });
  const expected = ["第一条用户消息", "第一条助手回复", "第三条用户消息"];
  for (let i = 0; i < expected.length; i++) {
    if (texts[i] !== expected[i]) {
      fail(`删除后索引 ${i} 应为 "${expected[i]}"，实际 "${texts[i]}"`);
    }
  }
  // 软删行保留在库中（deleted=1），未物理删除
  if (countDeletedRows(sCode.id) !== 2) {
    fail(`软删行应保留 2 条，实际 ${countDeletedRows(sCode.id)}`);
  }

  // 批量删除：删除剩余索引 0（第一条用户消息，级联第一条助手回复）与 2（第三条用户消息）
  const after2 = deleteSessionMessages(sCode.id, [0, 2]);
  if (after2.length !== 0) fail(`批量删除+级联后应为 0，实际 ${after2.length}`);
  if (countDeletedRows(sCode.id) !== 5) {
    fail(`软删行应累计 5 条，实际 ${countDeletedRows(sCode.id)}`);
  }

  // 无效索引集合应抛错
  let threwEmpty = false;
  try { deleteSessionMessages(sCode.id, [999]); } catch { threwEmpty = true; }
  if (!threwEmpty) fail("无效索引应抛错");

  // 软删行在后续全量保存中不被物理删除、也不复活
  saveSessionMessages(sCode.id, [mk("user", "新消息")]);
  const after3 = getSessionMessages(sCode.id);
  if (after3.length !== 1) fail(`保存后应只剩新消息，实际 ${after3.length}`);
  const c3 = after3[0].content;
  const t3 = Array.isArray(c3) ? (c3[0] as { text?: string })?.text ?? "" : String(c3 ?? "");
  if (t3 !== "新消息") fail(`保存后新消息内容不正确: "${t3}"`);
  if (countDeletedRows(sCode.id) !== 5) fail("全量保存不应清掉软删行");
  console.log(`  ✓ 软删、轮次级联、行保留、保存不复活，均正确`);

  console.log("\n== 含 toolResult 时的 UI 索引对齐 ==");
  const toolMsgs: AgentMessage[] = [
    mk("user", "调用工具"),
    mk("assistant", "工具调用中"),
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read_file",
      content: [{ type: "text", text: "文件内容" }],
      isError: false,
      timestamp: Date.now(),
    },
    mk("assistant", "工具结果回复"),
    mk("user", "第二条提问"),
    mk("assistant", "第二条回复"),
  ];
  saveSessionMessages(sCode.id, toolMsgs);
  // UI 数组（不含 toolResult）：0 调用工具, 1 工具调用中, 2 工具结果回复, 3 第二条提问, 4 第二条回复
  // 删除 UI 索引 3（第二条提问）→ 应级联"第二条回复"，toolResult 与"工具结果回复"保留
  const afterTool = deleteSessionMessage(sCode.id, 3);
  const toolTexts = afterTool.map((m) => {
    const c = m.content;
    if (Array.isArray(c)) return (c[0] as { text?: string })?.text ?? "";
    return String(c ?? "");
  });
  const expectedTool = ["调用工具", "工具调用中", "文件内容", "工具结果回复"];
  if (toolTexts.length !== expectedTool.length) {
    fail(`toolResult 场景删除后应为 ${expectedTool.length} 条，实际 ${toolTexts.length}`);
  }
  for (let i = 0; i < expectedTool.length; i++) {
    if (toolTexts[i] !== expectedTool[i]) {
      fail(`toolResult 场景索引 ${i} 应为 "${expectedTool[i]}"，实际 "${toolTexts[i]}"`);
    }
  }
  console.log(`  ✓ toolResult 轮次中 UI 索引映射正确（删 UI 3 → 剩 ${toolTexts.length} 条）`);

  // 重置 sCode 消息以便后续测试
  saveSessionMessages(sCode.id, delMsgs);

  console.log("\n== searchSessionMessages 搜索（软删过滤） ==");
  const hits = searchSessionMessages("第一条");
  if (hits.length < 1) fail("应至少搜到一条");
  if (hits[0].sessionId !== sCode.id) fail("搜索命中会话错误");
  if (!hits[0].snippet.includes("第一条")) fail("搜索片段应包含关键词");
  // 软删后已隐藏的消息不应再被搜到
  deleteSessionMessage(sCode.id, 0); // 级联隐藏"第一条用户消息/回复"
  const hitsAfterDel = searchSessionMessages("第一条");
  if (hitsAfterDel.some((h) => h.sessionId === sCode.id)) {
    fail("软删后仍搜到已隐藏消息");
  }
  // 重置回 5 条未删，供导出用例使用
  saveSessionMessages(sCode.id, delMsgs);
  // 搜索不存在的内容 → 空
  const noHit = searchSessionMessages("完全不存在的关键词 xyzzy");
  if (noHit.length !== 0) fail("搜索不存在关键词应返回空");
  console.log(`  ✓ 搜索命中 ${hits.length} 条，软删过滤生效`);

  console.log("\n== dumpAllSessions / restoreAllSessions 往返 ==");
  const dump = dumpAllSessions();
  if (dump.sessions.length < 2) fail(`应至少有 2 个会话可导出，实际 ${dump.sessions.length}`);
  if (!dump.messagesBySession[sCode.id]) fail("导出应包含 sCode 的消息");
  const msgCount = dump.messagesBySession[sCode.id].length;
  if (msgCount !== 5) fail(`导出消息数应为 5，实际 ${msgCount}`);

  // 清空并恢复
  for (const s of listSessions()) deleteSession(s.id);
  if (listSessions().length !== 0) fail("删除后库应为空");
  const restoredCount = restoreAllSessions(dump.sessions, dump.messagesBySession);
  if (restoredCount !== dump.sessions.length) fail("恢复的会话数与导出不一致");
  const restoredSessions = listSessions();
  if (restoredSessions.length !== dump.sessions.length) fail("恢复后会话数不匹配");
  // 验证 workdir / surface 保留
  const restoredCode = getSession(sCode.id);
  if (!restoredCode || restoredCode.workdir !== "/project/my-app" || restoredCode.surface !== "coding") {
    fail("恢复后 workdir/surface 未保留");
  }
  const restoredMsgs = getSessionMessages(sCode.id);
  if (restoredMsgs.length !== 5) fail(`恢复后消息数应为 5，实际 ${restoredMsgs.length}`);
  // 真删语义：会话级删除会物理清掉软删行，恢复后库中不应再有软删行
  if (countDeletedRows(sCode.id) !== 0) {
    fail(`恢复后不应有软删行，实际 ${countDeletedRows(sCode.id)}`);
  }
  console.log(`  ✓ 导出-恢复往返保留 surface/workdir/消息（${restoredCount} 个会话），软删行随真删清除`);

  // 清理
  for (const s of listSessions()) deleteSession(s.id);
  console.log("\n✓ 会话管理验证通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
