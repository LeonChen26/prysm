/**
 * 工具注册表（tools/registry.ts）验证脚本 —— ToolRegistry 纯内存断言。
 * 覆盖：多 provider 注册、同名冲突后注册者覆盖、capability 筛选、surface 筛选、未知工具不被剔除。
 * 运行：npx tsx tests/unit/test-tool-registry.ts
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ToolRegistry, type ToolProvider } from "../../lib/tools/registry";

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

// 构造极简 AgentTool（只填 name 字段，够用）
function mkTool(name: string, desc = ""): AgentTool {
  return {
    name,
    description: desc,
    parameters: { type: "object", properties: {} },
    execute: async () => ({} as unknown as ReturnType<AgentTool["execute"]>),
  } as AgentTool;
}

console.log("== 单 provider 解析 ==");
{
  const reg = new ToolRegistry();
  const p: ToolProvider = {
    id: "p1",
    load: async () => [mkTool("list_dir"), mkTool("read_file")],
  };
  reg.register(p);
  const tools = await reg.resolve();
  expectEq("单 provider 工具数量", tools.map((t) => t.name).sort(), ["list_dir", "read_file"]);
}

console.log("\n== 多 provider 合并 ==");
{
  const reg = new ToolRegistry();
  reg.register({ id: "builtin", load: async () => [mkTool("list_dir"), mkTool("read_file")] });
  reg.register({ id: "extra", load: async () => [mkTool("web_search"), mkTool("fetch_url")] });
  const names = (await reg.resolve()).map((t) => t.name).sort();
  expectEq("多 provider 合并", names, ["fetch_url", "list_dir", "read_file", "web_search"]);
}

console.log("\n== 同名冲突：后注册者覆盖 + 保留注册顺序 ==");
{
  const reg = new ToolRegistry();
  const t1 = mkTool("list_dir", "builtin 版本");
  const t2 = mkTool("list_dir", "skill 版本");
  reg.register({ id: "builtin", load: async () => [t1, mkTool("read_file")] });
  reg.register({ id: "skill", load: async () => [t2, mkTool("todo_create")] });
  const tools = await reg.resolve();
  const names = tools.map((t) => t.name);
  // 首次出现顺序：builtin 先注册 → list_dir/read_file 在前；skill 后注册 → todo_create 在后
  expectEq("名称顺序（按首次出现）", names, ["list_dir", "read_file", "todo_create"]);
  // 但 list_dir 的实例应为 skill 的（后注册者覆盖）
  const hit = tools.find((t) => t.name === "list_dir")!;
  expectEq("同名冲突后注册者覆盖 description", hit.description, "skill 版本");
}

console.log("\n== capability 筛选：readonly ==");
{
  const reg = new ToolRegistry();
  const tools = [
    mkTool("list_dir"),        // TOOL_META: readonly
    mkTool("read_file"),       // TOOL_META: readonly
    mkTool("write_file"),      // TOOL_META: readwrite, sensitive
    mkTool("run_bash"),        // TOOL_META: readwrite
    mkTool("custom_unknown"),  // 无 TOOL_META → 不被 filter 剔除
  ];
  reg.register({ id: "t", load: async () => tools });
  const readonly = (await reg.resolve({ capability: "readonly" })).map((t) => t.name).sort();
  // readonly 只保留在 TOOL_META 中明确标记为 readonly 的；
  // custom_unknown 无 meta.capability 因此不被 filter.capability 剔除（matchesFilter 返回 true）
  expectEq(
    "capability=readonly 过滤结果",
    readonly,
    ["custom_unknown", "list_dir", "read_file"],
  );
}

console.log("\n== capability 筛选：readwrite ==");
{
  const reg = new ToolRegistry();
  const tools = [
    mkTool("list_dir"),    // readonly → 剔除
    mkTool("write_file"),  // readwrite → 保留
    mkTool("run_bash"),    // readwrite → 保留
    mkTool("custom_new"),  // 无 meta → 保留
  ];
  reg.register({ id: "t", load: async () => tools });
  const rw = (await reg.resolve({ capability: "readwrite" })).map((t) => t.name).sort();
  expectEq("capability=readwrite 过滤结果", rw, ["custom_new", "run_bash", "write_file"]);
}

console.log("\n== surface 筛选（TOOL_META 中目前未设置 surface，未知工具均通过） ==");
{
  const reg = new ToolRegistry();
  const tools = [mkTool("list_dir"), mkTool("custom_x")];
  reg.register({ id: "t", load: async () => tools });
  const work = (await reg.resolve({ surface: "work" })).map((t) => t.name).sort();
  const coding = (await reg.resolve({ surface: "coding" })).map((t) => t.name).sort();
  // 因现有 TOOL_META 均未设置 surface，matchesFilter 对 surface filter 一律放行
  expectEq("surface=work 结果（meta 未设置均保留）", work, ["custom_x", "list_dir"]);
  expectEq("surface=coding 结果（meta 未设置均保留）", coding, ["custom_x", "list_dir"]);
}

console.log("\n== capability + surface 联合筛选 ==");
{
  const reg = new ToolRegistry();
  const tools = [
    mkTool("list_dir"),   // readonly → capability=readwrite 剔除
    mkTool("write_file"), // readwrite → 保留
    mkTool("alpha"),      // 无 meta → 两条件都通过 → 保留
  ];
  reg.register({ id: "t", load: async () => tools });
  const out = (await reg.resolve({ capability: "readwrite", surface: "coding" })).map((t) => t.name).sort();
  expectEq("联合筛选结果", out, ["alpha", "write_file"]);
}

console.log("\n== resolve 无 provider 时返回空数组 ==");
{
  const reg = new ToolRegistry();
  const out = await reg.resolve();
  expectEq("无 provider → 空数组", out, []);
}

console.log("\n✓ 工具注册表验证通过");
process.exit(0);
