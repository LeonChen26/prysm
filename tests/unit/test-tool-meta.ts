/**
 * 工具元数据（tool-meta.ts）验证脚本 —— 纯常量断言，无需依赖。
 * 覆盖：敏感工具标记一致性、capability 完整性、工具登记数量（与 tools.ts 内置工具集合对齐）。
 * 运行：npx tsx tests/unit/test-tool-meta.ts
 */
import { TOOL_META, type ToolCapability, type ToolMeta } from "../../lib/tool-meta";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

const SENSITIVE_EXPECTED = new Set(["write_file", "delete_file", "run_bash"]);
const READWRITE_EXPECTED = new Set([
  "write_file",
  "append_file",
  "create_dir",
  "move_file",
  "copy_file",
  "delete_file",
  "run_bash",
]);
const READONLY_EXPECTED = new Set([
  "list_dir",
  "read_file",
  "verify_file",
  "todo_create",
  "todo_modify",
  "todo_list",
  "web_search",
  "fetch_url",
  "search_files",
  "env_info",
  "port_check",
]);

console.log("== TOOL_META 基本完整性 ==");
const count = Object.keys(TOOL_META).length;
console.log(`  ✓ 共登记 ${count} 个工具`);
if (count < 18) fail(`登记工具数过少，期望至少 18，实际 ${count}`);

console.log("\n== 敏感工具标记（sensitive=true） ==");
for (const name of Object.keys(TOOL_META)) {
  const meta = TOOL_META[name];
  if (SENSITIVE_EXPECTED.has(name)) {
    if (!meta.sensitive) fail(`工具 ${name} 应标记为 sensitive=true`);
    console.log(`  ✓ ${name} 标记为敏感`);
  } else {
    if (meta.sensitive) fail(`工具 ${name} 不应标记为敏感（默认非敏感）`);
  }
}

console.log("\n== capability 字段（readonly/readwrite） ==");
for (const name of Object.keys(TOOL_META)) {
  const meta = TOOL_META[name];
  const cap = meta.capability;
  if (!cap) fail(`工具 ${name} 缺少 capability`);
  if (cap !== "readonly" && cap !== "readwrite") {
    fail(`工具 ${name} capability 值非法: ${cap}`);
  }
  if (READWRITE_EXPECTED.has(name) && cap !== "readwrite") {
    fail(`工具 ${name} 应为 readwrite，实际 ${cap}`);
  }
  if (READONLY_EXPECTED.has(name) && cap !== "readonly") {
    fail(`工具 ${name} 应为 readonly，实际 ${cap}`);
  }
}
console.log(`  ✓ 全部 ${count} 个工具 capability 合法且与预期一致`);

console.log("\n== label / type 非空 ==");
for (const [name, meta] of Object.entries(TOOL_META)) {
  if (!meta.label || typeof meta.label !== "string") {
    fail(`工具 ${name} label 非法`);
  }
  if (!meta.type || typeof meta.type !== "string") {
    fail(`工具 ${name} type 非法`);
  }
}
console.log("  ✓ 所有工具 label 与 type 均为非空字符串");

console.log("\n== type 分类覆盖 ==");
const typeSet = new Set<string>();
for (const meta of Object.values(TOOL_META)) typeSet.add(meta.type);
console.log(`  ✓ type 分类: ${Array.from(typeSet).join(", ")}`);
if (!typeSet.has("文件")) fail("应有 文件 分类");
if (!typeSet.has("系统")) fail("应有 系统 分类");
if (!typeSet.has("网络")) fail("应有 网络 分类");
if (!typeSet.has("任务")) fail("应有 任务 分类");

console.log("\n✓ 工具元数据验证通过");
process.exit(0);
