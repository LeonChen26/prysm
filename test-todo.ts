/**
 * 任务规划（todo 工具）验证脚本 —— 使用 faux provider，无需真实 LLM。
 * 验证：
 * 1. todo_create / todo_modify / todo_list 工具流转
 * 2. mapEvent 把 details.todos 透传到 tool_end 事件
 * 3. 状态流转 pending → completed、追加、错误路径
 *
 * 运行：node test-todo.ts
 */
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { mapEvent, SYSTEM_PROMPT } from "./lib/agent";
import { tools } from "./lib/tools";
import type { UiEvent } from "./lib/agent";

interface TodoItem {
  id: string;
  title: string;
  status: string;
  detail?: string;
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

async function main() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  const toolLog: { name: string; isError: boolean }[] = [];
  const todoSnapshots: TodoItem[][] = [];

  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model, tools },
    streamFn: models.streamSimple.bind(models),
  });

  agent.subscribe(async (event: AgentEvent) => {
    const ui = mapEvent(event);
    if (!ui) return;
    switch (ui.type) {
      case "tool_start":
        toolLog.push({ name: ui.toolName, isError: false });
        break;
      case "tool_end":
        if (ui.isError) toolLog.push({ name: ui.toolName, isError: true });
        if (ui.todos) todoSnapshots.push(ui.todos as TodoItem[]);
        break;
      default:
        break;
    }
  });

  // 脚本化响应序列（每次 LLM 调用消费一个）
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "todo_create",
          {
            items: [
              { title: "创建 README", detail: "说明项目用途" },
              { title: "写入 hello.txt" },
            ],
          },
          { id: "c1" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall(
          "todo_modify",
          {
            updates: [{ id: "todo-1", status: "completed" }],
            append: [{ title: "核对结果" }],
          },
          { id: "c2" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall(
          "todo_modify",
          { updates: [{ id: "todo-99", status: "completed" }] },
          { id: "c3" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [fauxToolCall("todo_list", {}, { id: "c4" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("全部任务已完成", { stopReason: "endTurn" }),
  ]);

  await agent.prompt("帮我做一个复杂任务");
  await agent.waitForIdle();

  console.log("== 工具调用序列 ==");
  for (const line of toolLog)
    console.log(`  ${line.name}${line.isError ? " (ERROR)" : ""}`);
  console.log("\n== todos 快照（每次 tool_end） ==");
  for (const snap of todoSnapshots) {
    console.log(
      "  " + snap.map((t) => `${t.id}[${t.status}]${t.title}`).join(" | "),
    );
  }

  // ---------- 断言 ----------
  const toolNames = toolLog.filter((l) => !l.isError).map((l) => l.name);
  const expectedTools = ["todo_create", "todo_modify", "todo_modify", "todo_list"];
  if (toolNames.join(",") !== expectedTools.join(",")) {
    fail(`工具调用序列不符: ${toolNames.join(",")}`);
  }
  if (!toolLog.some((l) => l.isError && l.name === "todo_modify")) {
    fail("应包含一次 todo_modify 失败（不存在的 id）");
  }

  // 错误调用不透传 todos（result 为错误对象），因此只有 3 个快照
  if (todoSnapshots.length !== 3) {
    fail(`应有 3 个 todos 快照，实际 ${todoSnapshots.length}`);
  }

  // 快照 1：todo_create 后全部 pending
  const snap1 = todoSnapshots[0];
  if (snap1.length !== 2 || !snap1.every((t) => t.status === "pending")) {
    fail("快照 1 应为 2 个 pending 任务");
  }
  if (snap1[0].id !== "todo-1" || snap1[1].id !== "todo-2") {
    fail(`任务 id 生成不符: ${snap1.map((t) => t.id).join(",")}`);
  }

  // 快照 2：todo-1 completed，追加了 todo-3
  const snap2 = todoSnapshots[1];
  const t1 = snap2.find((t) => t.id === "todo-1");
  if (!t1 || t1.status !== "completed") fail("todo-1 应已标记为 completed");
  if (snap2.length !== 3 || snap2[2].title !== "核对结果") {
    fail("快照 2 应包含追加的任务 todo-3");
  }

  // 快照 3（todo_list 返回）：错误不影响清单，应与快照 2 一致
  const snap3 = todoSnapshots[2];
  if (JSON.stringify(snap3) !== JSON.stringify(snap2)) {
    fail("快照 3 应与快照 2 一致（错误不改变清单）");
  }

  console.log("\n✓ todo 工具流转 + todos 透传验证通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
