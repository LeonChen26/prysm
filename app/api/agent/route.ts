import { contentText } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getAgent, mapEvent } from "@/lib/agent";
import { subscribeApprovals } from "@/lib/approval";
import { rememberNewMessages } from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toUiMessage(m: AgentMessage) {
  if (m.role === "user") {
    return { role: "user" as const, text: contentText(m.content) };
  }
  if (m.role === "assistant") {
    return { role: "assistant" as const, text: contentText(m.content) };
  }
  return null;
}

/** GET /api/agent —— 返回当前会话的消息历史 */
export async function GET() {
  try {
    const agent = await getAgent();
    const messages = agent.state.messages
      .map(toUiMessage)
      .filter((m): m is NonNullable<typeof m> => m !== null);
    return Response.json({ messages });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/agent —— 发送消息，返回 SSE 事件流 */
export async function POST(req: Request) {
  let message: string;
  try {
    const body = await req.json();
    message = String(body?.message ?? "").trim();
  } catch {
    return Response.json({ error: "请求体必须是 JSON: { message: string }" }, { status: 400 });
  }
  if (!message) {
    return Response.json({ error: "message 不能为空" }, { status: 400 });
  }

  let agent;
  try {
    agent = await getAgent();
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  if (agent.state.isStreaming) {
    return Response.json({ error: "agent 正在处理上一条消息，请稍候" }, { status: 409 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      const unsub = agent!.subscribe(async (event) => {
        const ui = mapEvent(event);
        if (ui) send(ui);
      });
      // 审批请求事件（来自 beforeToolCall）也推送到同一条 SSE 流
      const unsubApprovals = subscribeApprovals((req) =>
        send({
          type: "approval_required",
          id: req.id,
          toolName: req.toolName,
          args: req.args,
        }),
      );

      try {
        await agent!.prompt(message);
        await agent!.waitForIdle();
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // 阶段 4：把本轮新增的对话轨迹写入情景记忆
        try {
          const stored = rememberNewMessages(agent!.state.messages);
          if (stored > 0) console.log(`[memory] 已写入 ${stored} 条情景记忆`);
        } catch (err) {
          console.error("[memory] 写入失败:", err);
        }
        unsubApprovals();
        unsub();
        send({ type: "done" });
        try {
          controller.close();
        } catch {
          /* 客户端已断开 */
        }
      }
    },
    cancel() {
      agent?.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
