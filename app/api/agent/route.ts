import { contentText } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  consumeStopped,
  generateTitle,
  getAgent,
  logRun,
  mapEvent,
} from "@/lib/agent";
import { subscribeApprovalLifecycle } from "@/lib/approval";
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
    return {
      role: "user" as const,
      text: contentText(m.content),
      timestamp: m.timestamp ?? 0,
    };
  }
  if (m.role === "assistant") {
    return {
      role: "assistant" as const,
      text: contentText(m.content),
      timestamp: m.timestamp ?? 0,
    };
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
  let body: { message?: unknown; sessionId?: unknown; rewindToText?: unknown };
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

  // 重新生成：回退会话历史到指定用户消息（含该条），随后用相同消息重新执行
  if (typeof body.rewindToText === "string" && body.rewindToText.trim()) {
    const t = body.rewindToText.trim();
    const msgs = agent.state.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "user" && contentText(m.content).trim() === t) {
        agent.state.messages = msgs.slice(0, i + 1);
        break;
      }
    }
  }

  // 闭包捕获变量：此处 agent 已窄化为非空，用 const 引用避免闭包内重复断言
  const a = agent;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      // 首个事件：告知前端实际使用的会话
      send({ type: "session", sessionId: session.id, title: session.title });

      // 本轮工具调用统计（供运行统计概览）
      const toolCalls: Record<string, number> = {};
      const unsub = a.subscribe(async (event) => {
        const ui = mapEvent(event);
        if (!ui) return;
        if (ui.type === "tool_end") {
          toolCalls[ui.toolName] = (toolCalls[ui.toolName] ?? 0) + 1;
        }
        send(ui);
      });
      // 审批生命周期事件（来自 beforeToolCall）推送到同一条 SSE 流：
      // required → approval_required（带风险/过期时间）；resolved/expired → 结束事件；
      // notice → policy_notice（策略直接拦截提示）。多会话并发时按会话隔离推送。
      const unsubApprovals = subscribeApprovalLifecycle((e) => {
        if (e.type === "required") {
          if (e.state.sessionId && e.state.sessionId !== session.id) return;
          send({
            type: "approval_required",
            id: e.state.id,
            toolName: e.state.toolName,
            args: e.state.args,
            risk: e.state.risk,
            riskReason: e.state.riskReason,
            expiresAt: e.state.expiresAt,
          });
        } else if (e.type === "resolved" || e.type === "expired") {
          if (e.state.sessionId && e.state.sessionId !== session.id) return;
          send({
            type: e.type === "resolved" ? "approval_resolved" : "approval_expired",
            id: e.state.id,
            approve: e.type === "resolved" && e.state.status === "approved",
          });
        } else if (e.type === "notice") {
          if (e.sessionId && e.sessionId !== session.id) return;
          send({
            type: "policy_notice",
            id: e.id,
            toolName: e.toolName,
            args: e.args,
            action: e.action,
            reason: e.reason,
          });
        }
      });

      let aborted = false;
      let runError: unknown = undefined;
      const runStartedAt = Date.now();
      try {
        await a.prompt(message);
        await a.waitForIdle();
      } catch (err) {
        runError = err;
        // 用户通过 /api/agent/stop 中止：区分"主动停止"与"真实错误"
        aborted =
          (err instanceof Error &&
            (err.name === "AbortError" || /abort/i.test(err.message))) ||
          !!a.signal?.aborted;
        if (!aborted) {
          send({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        const stopped = aborted || consumeStopped(session.id);
        const msgs = a.state.messages;
        // 阶段 8：持久化会话消息（全量替换）
        try {
          saveSessionMessages(session.id, msgs);
          // 新会话用首条用户消息自动命名
          if (session.title === "新会话") {
            const firstUser = msgs.find((m) => m.role === "user");
            if (firstUser) {
              const t = contentText(firstUser.content).trim().slice(0, 20);
              if (t) {
                renameSession(session.id, t);
                session.title = t;
              }
            }
          }
          // 智能标题：仍为默认命名（首条消息截断）且已多轮对话时，用模型生成精炼标题
          const userMsgs = msgs.filter((m) => m.role === "user");
          const firstText = userMsgs.length
            ? contentText(userMsgs[0].content).trim()
            : "";
          const isDefault =
            session.title === "新会话" ||
            (!!firstText && session.title === firstText.slice(0, 20));
          if (isDefault && userMsgs.length >= 2 && !stopped && !aborted) {
            try {
              const better = await generateTitle(msgs);
              if (better && better !== session.title) {
                renameSession(session.id, better);
                console.log(`[title] 会话标题 → "${better}"`);
              }
            } catch (err) {
              console.error("[title] 自动标题生成失败:", err);
            }
          }
        } catch (err) {
          console.error("[session] 持久化失败:", err);
        }
        // 运行日志（供前端查看最近执行记录）
        logRun({
          sessionId: session.id,
          title: session.title,
          startedAt: runStartedAt,
          durationMs: Date.now() - runStartedAt,
          messageCount: msgs.length,
          stopped,
          toolCalls,
          error:
            !aborted && runError
              ? runError instanceof Error
                ? runError.message
                : String(runError)
              : undefined,
        });
        // 阶段 4：把消息写入情景记忆（按内容去重，恢复的历史不会重复写入）
        try {
          const stored = rememberMessages(a.state.messages);
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
