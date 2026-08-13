import { contentText } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { consumeStopped, getAgent, mapEvent } from "@/lib/agent";
import { subscribeApprovals } from "@/lib/approval";
import { rememberMessages } from "@/lib/memory";
import {
  createSession,
  getSession,
  listSessions,
  renameSession,
  saveSessionMessages,
  type SessionInfo,
} from "@/lib/session";

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

/** 解析请求中的会话：显式指定且存在则用之，否则取最新会话，无则新建 */
function resolveSession(body: { sessionId?: unknown }): SessionInfo {
  if (typeof body.sessionId === "string" && body.sessionId) {
    const s = getSession(body.sessionId);
    if (s) return s;
  }
  return listSessions()[0] ?? createSession();
}

/** GET /api/agent?sessionId=xxx —— 返回指定会话（默认最新）的消息历史 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    let session: SessionInfo | undefined = sessionId
      ? getSession(sessionId)
      : undefined;
    if (!session) session = listSessions()[0];
    if (!session) return Response.json({ messages: [], session: null });

    const agent = await getAgent(session.id);
    const messages = agent.state.messages
      .map(toUiMessage)
      .filter((m): m is NonNullable<typeof m> => m !== null);
    return Response.json({
      messages,
      session: { id: session.id, title: session.title },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/agent —— 发送消息，返回 SSE 事件流 */
export async function POST(req: Request) {
  let body: { message?: unknown; sessionId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON: { message: string }" }, { status: 400 });
  }
  const message = String(body?.message ?? "").trim();
  if (!message) {
    return Response.json({ error: "message 不能为空" }, { status: 400 });
  }
  const session = resolveSession(body);

  let agent;
  try {
    agent = await getAgent(session.id);
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

      // 首个事件：告知前端实际使用的会话
      send({ type: "session", sessionId: session.id, title: session.title });

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

      let aborted = false;
      try {
        await agent!.prompt(message);
        await agent!.waitForIdle();
      } catch (err) {
        // 用户通过 /api/agent/stop 中止：区分"主动停止"与"真实错误"
        aborted =
          (err instanceof Error &&
            (err.name === "AbortError" || /abort/i.test(err.message))) ||
          !!agent!.signal?.aborted;
        if (!aborted) {
          send({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        const stopped = aborted || consumeStopped(session.id);
        // 阶段 8：持久化会话消息（全量替换）
        try {
          saveSessionMessages(session.id, agent!.state.messages);
          // 新会话用首条用户消息自动命名
          if (session.title === "新会话") {
            const firstUser = agent!.state.messages.find((m) => m.role === "user");
            if (firstUser) {
              const t = contentText(firstUser.content).trim().slice(0, 20);
              if (t) renameSession(session.id, t);
            }
          }
        } catch (err) {
          console.error("[session] 持久化失败:", err);
        }
        // 阶段 4：把消息写入情景记忆（按内容去重，恢复的历史不会重复写入）
        try {
          const stored = rememberMessages(agent!.state.messages);
          if (stored > 0) console.log(`[memory] 已写入 ${stored} 条情景记忆`);
        } catch (err) {
          console.error("[memory] 写入失败:", err);
        }
        unsubApprovals();
        unsub();
        send(
          stopped
            ? { type: "stopped", message: "任务已停止" }
            : { type: "done" },
        );
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
