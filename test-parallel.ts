/**
 * 并行工具执行验证脚本 —— 使用 faux provider + 自定义延迟工具。
 * 单条 assistant 消息含 4 个工具调用（3 个 probe_sleep + 1 个 todo_create），
 * 验证并行模式：3 个 200ms 延迟工具应同时执行（总耗时显著小于串行和）。
 * 运行：npx tsx test-parallel.ts
 */
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { SYSTEM_PROMPT, mapEvent } from "./lib/agent";
import { tools } from "./lib/tools";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

async function main() {
  const timings: { name: string; start: number; end: number }[] = [];
  const probeTool: AgentTool = {
    name: "probe_sleep",
    label: "并行探测",
    description: "睡眠指定毫秒数并记录时间戳（仅测试用）",
    parameters: Type.Object({
      name: Type.String(),
      ms: Type.Number(),
    }),
    execute: async (_id, params) => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, params.ms));
      timings.push({ name: params.name, start, end: Date.now() });
      return {
        content: [{ type: "text", text: `slept ${params.ms}ms` }],
        details: { name: params.name },
      };
    },
  };

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  const toolCalls: string[] = [];
  let todosSeen: unknown = null;

  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model, tools: [...tools, probeTool] },
    streamFn: models.streamSimple.bind(models),
    toolExecution: "parallel",
  });

  agent.subscribe(async (event: AgentEvent) => {
    const ui = mapEvent(event);
    if (!ui) return;
    if (ui.type === "tool_start") toolCalls.push(ui.toolName);
    if (ui.type === "tool_end" && ui.todos) todosSeen = ui.todos;
  });

  // 单条 assistant 消息：3 个 200ms 延迟 + 1 个 todo_create
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("probe_sleep", { name: "p1", ms: 200 }, { id: "c1" }),
        fauxToolCall("probe_sleep", { name: "p2", ms: 200 }, { id: "c2" }),
        fauxToolCall("probe_sleep", { name: "p3", ms: 200 }, { id: "c3" }),
        fauxToolCall("todo_create", { items: [{ title: "并行验证任务" }] }, { id: "c4" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("全部完成", { stopReason: "endTurn" }),
  ]);

  const t0 = Date.now();
  await agent.prompt("并行执行这些工具");
  await agent.waitForIdle();
  const totalMs = Date.now() - t0;

  console.log("== 工具调用 ==");
  console.log("  " + toolCalls.join(" + "));
  console.log("== probe 时间戳 ==");
  for (const t of timings) {
    console.log(`  ${t.name}: start=${t.start - t0}ms end=${t.end - t0}ms`);
  }
  console.log(`== 总耗时 ${totalMs}ms ==`);

  // 断言
  if (timings.length !== 3) fail(`3 个 probe 应全部执行，实际 ${timings.length}`);
  if (toolCalls.filter((n) => n === "probe_sleep").length !== 3) {
    fail("probe_sleep 调用数不符");
  }
  if (!todosSeen) fail("todo_create 的 todos 未透传");

  // 并行性：串行 3×200ms ≈ 600ms+；并行应显著更短
  const firstStart = Math.min(...timings.map((t) => t.start));
  const lastEnd = Math.max(...timings.map((t) => t.end));
  const span = lastEnd - firstStart;
  console.log(`== 首尾跨度 ${span}ms（串行预期 ≥600ms） ==`);
  if (span > 450) {
    fail(`工具疑似串行执行（跨度 ${span}ms），并行未生效`);
  }
  if (totalMs > 1000) {
    fail(`总耗时异常（${totalMs}ms）`);
  }

  console.log("\n✓ 并行工具执行验证通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
