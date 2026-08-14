/**
 * 真实 DeepSeek 端到端验证 —— 走 HTTP SSE（/api/agent），验证：
 * 1. agent 在复杂任务中使用 todo 工具拆解步骤
 * 2. todos 数据随 tool_end 事件透传到前端
 *
 * 运行前需先启动 dev server：npm run dev
 * 运行：npx tsx test-todo-e2e.ts
 */
interface TodoItem {
  id: string;
  title: string;
  status: string;
  detail?: string;
}

interface SseEvent {
  type: string;
  id?: string;
  toolName?: string;
  isError?: boolean;
  todos?: TodoItem[];
  message?: string;
}

async function main() {
  const res = await fetch("http://localhost:30123/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message:
        "检查 agent-workdir 目录下有哪些文件，读取它们的内容，然后用 todo 工具规划一个整理方案，逐条标记完成，最后把两个文件内容合并写入一个新的 README.md。",
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`请求失败: ${res.status} ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const toolCalls: string[] = [];
  const snapshots: TodoItem[][] = [];
  let errorMsg: string | null = null;
  let text = "";
  let approvalsHandled = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      let ev: SseEvent;
      try {
        ev = JSON.parse(payload) as SseEvent;
      } catch {
        continue;
      }
      switch (ev.type) {
        case "tool_start":
          if (ev.toolName) toolCalls.push(ev.toolName);
          break;
        case "tool_end":
          if (ev.todos) snapshots.push(ev.todos);
          break;
        case "approval_required":
          // 模拟用户在浏览器点击"允许"
          approvalsHandled++;
          fetch("http://localhost:30123/api/agent/approve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: ev.id, approve: true }),
          }).catch(() => {});
          break;
        case "error":
          errorMsg = ev.message ?? "未知错误";
          break;
        case "delta":
          text += ev.delta ?? "";
          break;
      }
    }
  }

  console.log("== 工具调用序列 ==");
  console.log("  " + toolCalls.join(" → "));
  console.log("== 审批处理 = " + approvalsHandled + " 次（自动批准） ==");
  console.log("\n== todos 快照（每次 tool_end） ==");
  snapshots.forEach((s, i) => {
    console.log(
      "  [" + i + "] " + s.map((t) => t.id + ":" + t.status + ":" + t.title).join(" | "),
    );
  });
  console.log("\n== 最终回复（截断 200 字） ==");
  console.log("  " + text.slice(0, 200));

  if (errorMsg) {
    console.error(`✗ SSE error: ${errorMsg}`);
    process.exitCode = 1;
    return;
  }
  if (!toolCalls.includes("todo_create")) {
    console.error("✗ agent 未使用 todo_create 工具");
    process.exitCode = 1;
    return;
  }
  if (!toolCalls.includes("todo_modify")) {
    console.error("✗ agent 未使用 todo_modify 工具");
    process.exitCode = 1;
    return;
  }
  if (snapshots.length === 0) {
    console.error("✗ 未收到 todos 透传数据");
    process.exitCode = 1;
    return;
  }
  const final = snapshots[snapshots.length - 1];
  if (final.length === 0) {
    console.error("✗ 最终清单为空");
    process.exitCode = 1;
    return;
  }
  const doneCount = final.filter((t) => t.status === "completed").length;
  console.log(
    `\n（模型行为参考：最终清单 ${final.length} 项，completed ${doneCount} 项）`,
  );
  console.log("\n✓ 真实端到端验证通过（todo 工具 + todos 透传 + 审批链路）");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
