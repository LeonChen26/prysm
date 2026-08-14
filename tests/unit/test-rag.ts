/**
 * 知识库 / RAG（lib/rag.ts）验证脚本。
 * 覆盖：索引、增量跳过、变更检测、删除清理、检索命中、越界/二进制跳过。
 * 不触发真实 LLM 调用。
 * 运行：npx tsx tests/unit/test-rag.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configure, resetConfig } from "../../lib/config";
import {
  clearRagIndex,
  indexRoot,
  ragStats,
  resetRag,
  retrieveRag,
  retrieveRagText,
} from "../../lib/rag";

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

function expectTrue(name: string, actual: unknown) {
  if (!actual) fail(`${name}: 期望为真，实际 ${JSON.stringify(actual)}`);
  console.log(`  ✓ ${name}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const root = path.join(os.tmpdir(), "prysm-rag-root");
const dir = path.join(os.tmpdir(), "prysm-rag-data");

function write(rel: string, content: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function rm(rel: string) {
  fs.rmSync(path.join(root, rel), { force: true });
}

function resetAll() {
  resetConfig();
  resetRag();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  configure({ baseDir: dir, env: {} });
}

console.log("== 索引：文本文件入库，跳过二进制/目录忽略 ==");
{
  resetAll();
  write("readme.md", "Prysm 是一个通用助手，支持多模态与知识库检索。");
  write("src/api.ts", "export function fetchUsers() { return []; }");
  // 会被跳过：二进制（NUL 字节）、node_modules、无扩展名大文件不在范围内
  fs.writeFileSync(path.join(root, "a.bin"), Buffer.from([0, 1, 2, 3, 0]));
  write("node_modules/x.js", "忽略我");
  expectTrue("索引文件存在", fs.existsSync(path.join(root, "readme.md")));

  const st = await indexRoot(root);
  expectEq("新增 2 个文本文件", st.added, 2);
  expectEq("跳过二进制与 node_modules，总数 2", st.total, 2);
}

console.log("\n== 增量：未变更文件二扫为 0 变更 ==");
{
  const st = await indexRoot(root);
  expectEq("add=0", st.added, 0);
  expectEq("update=0", st.updated, 0);
  expectEq("remove=0", st.removed, 0);
  const stats = ragStats();
  expectEq("总文档仍为 2", stats.total, 2);
}

console.log("\n== 变更检测：修改内容触发 update ==");
{
  write("readme.md", "Prysm 现在支持了全新的知识库检索增强能力。");
  await sleep(5); // 确保 mtime 变化
  const st = await indexRoot(root);
  expectEq("readme 被更新", st.updated, 1);
}

console.log("\n== 删除清理：删除文件触发 remove ==");
{
  rm("src/api.ts");
  const st = await indexRoot(root);
  expectEq("removed=1", st.removed, 1);
  expectEq("总数降为 1", st.total, 1);
}

console.log("\n== 检索命中：BM25 按关键词返回 ==");
{
  const hits = retrieveRag("知识库 检索");
  expectTrue("命中 readme", hits.length >= 1);
  expectTrue("命中路径含 readme", hits[0].relPath.includes("readme.md"));
  expectTrue("片段含关键词", hits[0].snippet.includes("知识库"));
  const text = retrieveRagText("知识库 检索");
  expectTrue("拼接文本含 readme 片段", text.includes("readme.md"));
}

console.log("\n== 空查询 / 未命中返回空 ==");
{
  expectEq("空查询返回空数组", retrieveRag(""), []);
  expectEq("无命中返回空", retrieveRag("不存在的词汇xyzabc"), []);
  expectEq("拼接文本为空串", retrieveRagText(""), "");
}

console.log("\n== 清空索引 ==");
{
  clearRagIndex();
  expectEq("清空后总数为 0", ragStats().total, 0);
}

resetAll();
console.log("\n✓ 知识库/RAG 验证通过");
process.exit(0);