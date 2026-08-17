/**
 * 情景记忆（lib/memory.ts）验证脚本。
 * 覆盖：批量写入/去重、增量写入、重置指针、中英文检索、分页列表、
 *      单条删除、清空、导出/恢复、K 值配置。
 * 运行：npx tsx tests/unit/test-memory.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configure, resetConfig } from "../../lib/config";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  rememberMessages,
  rememberNewMessages,
  resetMemoryTracking,
  retrieveEpisodeDetails,
  retrieveEpisodes,
  countEpisodes,
  listEpisodes,
  deleteEpisode,
  clearEpisodes,
  dumpEpisodes,
  restoreEpisodes,
  memoryRecallK,
} from "../../lib/memory";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
function expectEq(name: string, actual: unknown, want: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${name}`);
}
function expectTrue(name: string, cond: boolean) {
  if (!cond) fail(name);
  console.log(`  ✓ ${name}`);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-memory-"));
configure({ baseDir: base, env: process.env });

function msg(role: string, text: string, ts?: number): AgentMessage {
  return { role, content: text, timestamp: ts ?? Date.now() } as AgentMessage;
}

console.log("== rememberMessages：批量写入 + UNIQUE 去重 ==");
{
  resetMemoryTracking();
  clearEpisodes();

  const msgs = [
    msg("user", "全文搜索如何实现"),
    msg("assistant", "使用 FTS5 实现全文搜索功能支持中文"),
    msg("user", "文件管理系统如何设计"),
    msg("assistant", "文件管理使用文件系统 API 操作项目文件"),
  ];
  expectEq("首次写入 4 条", rememberMessages(msgs), 4);
  expectEq("总数 4", countEpisodes(), 4);

  expectEq("重复写入返回 0", rememberMessages(msgs), 0);
  expectEq("总数仍为 4", countEpisodes(), 4);

  const newMsgs = [...msgs, msg("user", "新增的唯一内容")];
  expectEq("混合去重：只写入新增 1 条", rememberMessages(newMsgs), 1);
  expectEq("总数 5", countEpisodes(), 5);
}

console.log("\n== rememberNewMessages：增量写入 ==");
{
  resetMemoryTracking();
  clearEpisodes();

  const conv1 = [
    msg("user", "增量消息一"),
    msg("assistant", "增量回复一"),
  ];
  expectEq("首次增量写入 2 条", rememberNewMessages(conv1), 2);
  expectEq("总数 2", countEpisodes(), 2);

  expectEq("相同消息再次写入 0 条", rememberNewMessages(conv1), 0);

  const conv2 = [
    ...conv1,
    msg("user", "增量消息二"),
    msg("assistant", "增量回复二"),
  ];
  expectEq("追加 2 条新消息", rememberNewMessages(conv2), 2);
  expectEq("总数 4", countEpisodes(), 4);
}

console.log("\n== resetMemoryTracking：重置增量指针 ==");
{
  resetMemoryTracking();
  clearEpisodes();

  const conv = [
    msg("user", "重置测试消息"),
    msg("assistant", "重置测试回复"),
  ];
  expectEq("初始写入 2 条", rememberNewMessages(conv), 2);
  expectEq("总数 2", countEpisodes(), 2);

  resetMemoryTracking();

  conv.push(msg("user", "重置后新增消息"));
  expectEq("重置后增量写入 1 条", rememberNewMessages(conv), 1);
  expectEq("总数 3", countEpisodes(), 3);
}

console.log("\n== retrieveEpisodeDetails：中文检索 ==");
{
  resetMemoryTracking();
  clearEpisodes();

  rememberMessages([
    msg("user", "全文搜索如何实现"),
    msg("assistant", "使用 FTS5 实现全文搜索功能支持中文"),
    msg("user", "文件管理系统如何设计"),
    msg("assistant", "文件管理使用文件系统 API 操作项目文件"),
    msg("user", "代码错误排查方法"),
    msg("assistant", "代码错误通过类型检查和单元测试来排查"),
  ]);

  const hits = retrieveEpisodeDetails("全文搜索");
  expectTrue("搜索 '全文搜索' 有命中", hits.length > 0);
  expectTrue("命中包含 FTS5 相关内容",
    hits.some((h) => h.content.includes("FTS5") || h.content.includes("全文")));

  const hits2 = retrieveEpisodeDetails("文件管理");
  expectTrue("搜索 '文件管理' 有命中", hits2.length > 0);
  expectTrue("命中包含文件系统相关内容",
    hits2.some((h) => h.content.includes("文件") || h.content.includes("API")));

  const hits3 = retrieveEpisodeDetails("代码错误");
  expectTrue("搜索 '代码错误' 有命中", hits3.length > 0);

  const empty = retrieveEpisodeDetails("不存在的词汇xyzabc");
  expectEq("无关键词返回空数组", empty, []);

  const empty2 = retrieveEpisodeDetails("");
  expectEq("空查询返回空数组", empty2, []);

  const stopwordOnly = retrieveEpisodeDetails("你我他");
  expectEq("停用词过滤后无有效 token 返回空", stopwordOnly, []);
}

console.log("\n== retrieveEpisodeDetails：英文检索 ==");
{
  resetMemoryTracking();
  clearEpisodes();

  rememberMessages([
    msg("user", "How to implement full text search?"),
    msg("assistant", "Use FTS5 for full text search with Chinese tokenization"),
    msg("user", "How to handle file management?"),
    msg("assistant", "File management uses the file system API for project files"),
  ]);

  const hits = retrieveEpisodeDetails("search");
  expectTrue("搜索 'search' 有命中", hits.length > 0);
  expectTrue("命中包含 search 相关内容",
    hits.some((h) => h.content.toLowerCase().includes("search")));

  const hits2 = retrieveEpisodeDetails("file");
  expectTrue("搜索 'file' 有命中", hits2.length > 0);

  const empty = retrieveEpisodeDetails("xyznonexistent");
  expectEq("无匹配英文词返回空数组", empty, []);
}

console.log("\n== retrieveEpisodes：返回拼接文本 ==");
{
  resetMemoryTracking();
  clearEpisodes();

  rememberMessages([
    msg("user", "拼接文本测试"),
    msg("assistant", "拼接结果验证"),
  ]);

  const text = retrieveEpisodes("拼接");
  expectTrue("返回非空字符串", text.length > 0);
  expectTrue("包含 role 前缀格式 [role]", text.includes("[user]") || text.includes("[assistant]"));
  expectTrue("包含原始内容", text.includes("拼接"));

  const empty = retrieveEpisodes("不存在的词");
  expectEq("无命中返回空串", empty, "");
}

console.log("\n== countEpisodes：准确计数 ==");
{
  resetMemoryTracking();
  clearEpisodes();

  expectEq("空库为 0", countEpisodes(), 0);

  rememberMessages([msg("user", "a"), msg("assistant", "b")]);
  expectEq("写入 2 条后为 2", countEpisodes(), 2);

  rememberMessages([msg("user", "c")]);
  expectEq("再写入 1 条为 3", countEpisodes(), 3);
}

console.log("\n== listEpisodes：分页 + 最新在前 ==");
{
  resetMemoryTracking();
  clearEpisodes();

  const ids: number[] = [];
  for (let i = 0; i < 10; i++) {
    const r = rememberMessages([msg("user", `分页测试消息 ${i}`)]);
    if (r > 0) ids.push(i);
  }
  expectEq("共写入 10 条", countEpisodes(), 10);

  const page1 = listEpisodes(3, 0);
  expectEq("第 1 页大小为 3", page1.length, 3);
  expectTrue("第 1 页最新在前", page1[0].id > page1[1].id && page1[1].id > page1[2].id);

  const page2 = listEpisodes(3, 3);
  expectEq("第 2 页大小为 3", page2.length, 3);

  const lastPage = listEpisodes(3, 9);
  expectEq("最后一页可能不足", lastPage.length, 1);

  const all = listEpisodes(100, 0);
  expectEq("全部分页获取 10 条", all.length, 10);

  const newestFirst = all.every((e, i, arr) => i === 0 || e.id < arr[i - 1].id);
  expectTrue("全部按 id 降序", newestFirst);

  const emptyPage = listEpisodes(5, 100);
  expectEq("越界偏移返回空", emptyPage, []);
}

console.log("\n== deleteEpisode：单条删除 ==");
{
  resetMemoryTracking();
  clearEpisodes();

  rememberMessages([
    msg("user", "删除测试 1"),
    msg("user", "删除测试 2"),
    msg("user", "删除测试 3"),
  ]);
  expectEq("写入 3 条", countEpisodes(), 3);

  const before = listEpisodes(10, 0);
  const targetId = before[1].id;
  const removed = deleteEpisode(targetId);
  expectTrue("删除返回 true", removed);
  expectEq("删除后为 2", countEpisodes(), 2);

  const after = listEpisodes(10, 0);
  expectTrue("已删除条目不在列表中", !after.some((e) => e.id === targetId));

  const removedAgain = deleteEpisode(targetId);
  expectTrue("重复删除返回 false", !removedAgain);
  expectEq("总数不变", countEpisodes(), 2);
}

console.log("\n== clearEpisodes：清空全部 ==");
{
  resetMemoryTracking();
  clearEpisodes();

  rememberMessages([
    msg("user", "a"),
    msg("assistant", "b"),
    msg("user", "c"),
  ]);
  expectEq("写入 3 条", countEpisodes(), 3);

  const cleared = clearEpisodes();
  expectEq("清空返回 3", cleared, 3);
  expectEq("清空后为 0", countEpisodes(), 0);

  const clearedAgain = clearEpisodes();
  expectEq("再次清空返回 0", clearedAgain, 0);
}

console.log("\n== dumpEpisodes / restoreEpisodes：往返 ==");
{
  resetMemoryTracking();
  clearEpisodes();

  rememberMessages([
    msg("user", "往返测试 用户消息"),
    msg("assistant", "往返测试 助手回复"),
  ]);

  const dump = dumpEpisodes();
  expectEq("导出 2 条", dump.length, 2);
  expectTrue("导出包含原文", dump.some((e) => e.content.includes("往返测试")));

  clearEpisodes();
  expectEq("清空后为 0", countEpisodes(), 0);

  const restored = restoreEpisodes(dump);
  expectEq("恢复返回条数", restored, dump.length);
  expectEq("恢复后总数为 2", countEpisodes(), 2);

  const after = dumpEpisodes();
  expectEq("恢复后导出条数为 2", after.length, 2);
  expectTrue("恢复后内容一致",
    after.every((e, i) => e.content === dump[i].content && e.role === dump[i].role));

  const emptyRestore = restoreEpisodes([]);
  expectEq("空数组恢复返回 0", emptyRestore, 0);

  const withInvalid = restoreEpisodes([
    { id: 999, role: "user", content: "", ts: Date.now() },
    { id: 1000, role: "user", content: "有效内容", ts: Date.now() },
  ]);
  expectEq("含空内容条目恢复返回 2", withInvalid, 2);
  expectTrue("有效条目被恢复", countEpisodes() >= 1);
}

console.log("\n== memoryRecallK：可配置 K 值 ==");
{
  const k = memoryRecallK();
  expectTrue("K 值为正数", k > 0);
  expectTrue("K 值为数字", typeof k === "number");
}

console.log("\n== 综合：检索排序 (BM25) ==");
{
  resetMemoryTracking();
  clearEpisodes();

  rememberMessages([
    msg("user", "专属关键词 alpha-beta-gamma"),
    msg("assistant", "这是一条无关的回复"),
    msg("user", "另一条无关的消息"),
    msg("assistant", "包含专属关键词 alpha-beta-gamma 的回复"),
  ]);

  const hits = retrieveEpisodeDetails("专属关键词 alpha");
  expectTrue("能搜到专属关键词", hits.length >= 1);
}

resetConfig();
try {
  fs.rmSync(base, { recursive: true, force: true });
} catch {
  /* Windows 下 SQLite 文件可能仍被占用，忽略清理错误 */
}
console.log("\n✓ 情景记忆验证通过");
process.exit(0);