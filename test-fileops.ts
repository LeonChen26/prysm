/**
 * 文件工具增强验证脚本 —— 使用 faux provider，无需真实 LLM。
 * 覆盖：create_dir / write_file / append_file / read_file /
 *       copy_file / move_file / list_dir / delete_file / 越界拦截
 *
 * 运行：npx tsx test-fileops.ts
 */
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { mapEvent, SYSTEM_PROMPT } from "./lib/agent";
import { tools, AGENT_WORKDIR } from "./lib/tools";
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
  if (a !== "hello world") fail(`a.txt 内容应为 "hello world"，实际 "${a}"`);
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

  console.log("\n✓ 文件工具增强验证通过（含越界拦截）");
  await fs.rm(testDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
