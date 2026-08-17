/**
 * 文件工具增强验证脚本 —— 使用 faux provider，无需真实 LLM。
 * 覆盖：create_dir / write_file / append_file / edit_file(diff) / read_file /
 *       find(glob 查找) / copy_file / move_file / list_dir / delete_file / 越界拦截
 *
 * 运行：npx tsx test-fileops.ts
 */
// 注入临时工作区：必须在 lib/tools / lib/agent 之前 import（ESM 按序求值），
// 避免测试读取开发库 prysm.db 的工作区状态（项目根若为已授权工作区会导致越界用例失效）。
import "./_tmp-workdir";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { mapEvent, SYSTEM_PROMPT } from "../../lib/agent";
import { tools, AGENT_WORKDIR } from "../../lib/tools";
import fs from "node:fs/promises";
import path from "node:path";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

async function main() {
  // 清理上一次测试残留
  const testDir = path.join(AGENT_WORKDIR, "testops");
  await fs.rm(testDir, { recursive: true, force: true });

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  const calls: string[] = [];
  const errors: string[] = [];

  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model, tools },
    streamFn: models.streamSimple.bind(models),
  });

  agent.subscribe(async (event: AgentEvent) => {
    const ui = mapEvent(event);
    if (!ui) return;
    if (ui.type === "tool_start") calls.push(ui.toolName);
    if (ui.type === "tool_end" && ui.isError) errors.push(ui.toolName);
  });

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("create_dir", { path: "testops" }, { id: "c1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("write_file", { path: "testops/a.txt", content: "hello" }, { id: "c2" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("append_file", { path: "testops/a.txt", content: " world" }, { id: "c3" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("read_file", { path: "testops/a.txt" }, { id: "c4" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("edit_file", { path: "testops/a.txt", old_string: "hello world", new_string: "hello universe" }, { id: "c45" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("find", { pattern: "*.txt" }, { id: "c46" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("copy_file", { from: "testops/a.txt", to: "testops/b.txt" }, { id: "c5" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("move_file", { from: "testops/b.txt", to: "testops/c.txt" }, { id: "c6" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("list_dir", { dir: "testops" }, { id: "c7" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("delete_file", { path: "testops/c.txt" }, { id: "c8" })], { stopReason: "toolUse" }),
    // 越界：期望被 resolveInWorkdir 拦截 → 工具报错
    fauxAssistantMessage([fauxToolCall("append_file", { path: "../escape.txt", content: "x" }, { id: "c9" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("文件操作全部完成", { stopReason: "endTurn" }),
  ]);

  await agent.prompt("在 testops 目录里做一轮完整的文件操作演练");
  await agent.waitForIdle();

  console.log("== 工具调用序列 ==");
  console.log("  " + calls.join(" → "));
  console.log("== 报错工具 ==");
  console.log("  " + (errors.join(", ") || "(无)"));

  // ---------- 断言 ----------
  const expected = [
    "create_dir",
    "write_file",
    "append_file",
    "read_file",
    "edit_file",
    "find",
    "copy_file",
    "move_file",
    "list_dir",
    "delete_file",
    "append_file",
  ];
  if (calls.join(",") !== expected.join(",")) {
    fail(`工具序列不符: ${calls.join(",")}`);
  }
  if (!errors.includes("append_file")) {
    fail("越界 append_file 应报错");
  }

  // 文件系统实际状态
  const a = await fs.readFile(path.join(testDir, "a.txt"), "utf-8");
  if (a !== "hello universe") fail(`a.txt 内容应为 "hello universe"，实际 "${a}"`);
  const entries = await fs.readdir(testDir);
  if (entries.length !== 1 || entries[0] !== "a.txt") {
    fail(`testops 应只剩 a.txt，实际 ${entries.join(",")}`);
  }
  const escapePath = path.join(AGENT_WORKDIR, "..", "escape.txt");
  try {
    await fs.access(escapePath);
    fail("越界文件 escape.txt 不应被创建");
  } catch {
    /* 期望不存在 */
  }

  // ---------- edit_file diff 输出断言 ----------
  console.log("\n== edit_file diff 输出 ==");
  const editTool = tools.find((t) => t.name === "edit_file");
  if (!editTool) fail("缺少 edit_file 工具实现");
  const editResult = (await editTool.execute("t1", {
    path: "testops/a.txt",
    old_string: "universe",
    new_string: "cosmos",
  })) as { content: { type: string; text: string }[] };
  const diffText = editResult.content[0].text;
  if (
    !diffText.includes("--- a/testops/a.txt") ||
    !diffText.includes("+++ b/testops/a.txt") ||
    !diffText.includes("@@")
  ) {
    fail(`diff 应含 ---/+++/@@ 头:\n${diffText}`);
  }
  if (!diffText.includes("-hello universe") || !diffText.includes("+hello cosmos")) {
    fail(`diff 应含 -旧行 与 +新行:\n${diffText}`);
  }
  const edited = await fs.readFile(path.join(testDir, "a.txt"), "utf-8");
  if (edited !== "hello cosmos") fail(`编辑后内容应为 "hello cosmos"，实际 "${edited}"`);

  // 未找到 old_string → 抛错
  let threw = false;
  try {
    await editTool.execute("t2", {
      path: "testops/a.txt",
      old_string: "not-exist",
      new_string: "x",
    });
  } catch {
    threw = true;
  }
  if (!threw) fail("未找到 old_string 时应抛错拒绝修改");

  // 重复匹配 → 抛错
  await fs.writeFile(path.join(testDir, "a.txt"), "dup\ndup\n", "utf-8");
  threw = false;
  try {
    await editTool.execute("t3", {
      path: "testops/a.txt",
      old_string: "dup",
      new_string: "x",
    });
  } catch {
    threw = true;
  }
  if (!threw) fail("old_string 出现多次时应抛错拒绝修改");

  // ---------- find 工具断言（按文件名 glob 查找） ----------
  console.log("\n== find 工具 ==");
  const findTool = tools.find((t) => t.name === "find");
  if (!findTool) fail("缺少 find 工具实现");
  const f1 = (await findTool.execute("t4", { pattern: "*.txt" })) as {
    content: { type: string; text: string }[];
  };
  if (!f1.content[0].text.includes("a.txt")) {
    fail(`find *.txt 应命中 a.txt:\n${f1.content[0].text}`);
  }
  const f2 = (await findTool.execute("t5", { pattern: "no_such_xyz" })) as {
    content: { type: string; text: string }[];
  };
  if (!f2.content[0].text.includes("未找到")) {
    fail(`find 无匹配应提示未找到:\n${f2.content[0].text}`);
  }
  const f3 = (await findTool.execute("t6", { pattern: "a.*", path: "testops" })) as {
    content: { type: string; text: string }[];
  };
  if (!f3.content[0].text.includes("a.txt")) {
    fail(`find 限定目录应命中 a.txt:\n${f3.content[0].text}`);
  }
  // 读放开（Phase 1）：find 可搜索工作区外目录（../ 越界不再拒绝），用不存在的模式保证确定性
  let threw2 = false;
  let fOutside: { content: { type: string; text: string }[] } | undefined;
  try {
    fOutside = (await findTool.execute("t7", {
      pattern: "*.zzz-no-such",
      path: "../",
    })) as { content: { type: string; text: string }[] };
  } catch {
    threw2 = true;
  }
  if (threw2) fail("find 越界子目录不再抛错（读放开）");
  if (!fOutside || !fOutside.content[0].text.includes("未找到")) {
    fail(`find 越界子目录应正常返回未找到结果（读放开）:\n${fOutside?.content[0].text}`);
  }

  console.log("\n✓ 文件工具增强验证通过（含 edit_file diff、find 查找与越界拦截）");
  await fs.rm(testDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
