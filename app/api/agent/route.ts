import { contentText } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { consumeStopped, generateTitle, logRun, setApprovalMode } from "@/lib/agent";
import { judgeRun } from "@/lib/judge";
import { runWithToolCtx, runWithWorkdir } from "@/lib/tools";
import { rememberMessages } from "@/lib/memory";
import { createCore } from "@/lib/core";
import { toImageContents, extractImages } from "@/lib/attachments";
import {
  getSession,
  renameSession,
  saveSessionMessages,
  type SessionInfo,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 统一入口：注入 baseDir/env，核心模块经 config 上下文读取（Phase 1a.3） */
const core = createCore({ baseDir: process.cwd(), env: process.env });

function toUiMessage(m: AgentMessage) {
  if (m.role === "user" || m.role === "assistant") {
    return {
      role: m.role,
      text: contentText(m.content),
      timestamp: m.timestamp ?? 0,
      images: extractImages(m.content),
    };
  }
  return null;
}

/** 解析请求中的会话：显式指定且存在则用之，否则取当前 surface 下最新会话，无则新建 */
function resolveSession(body: { sessionId?: unknown; surface?: unknown }): SessionInfo {
  if (typeof body.sessionId === "string" && body.sessionId) {
    const s = getSession(body.sessionId);
    if (s) return s;
  }
  const surface = body.surface === "work" || body.surface === "coding" ? body.surface : undefined;
  const list = core.listSessions();
  // 优先取同 surface 的最新会话，避免无会话时消息串到另一种形态（修复前取全局最新）
  if (surface) {
    const match = list.find((s) => (s.surface ?? "coding") === surface);
    if (match) return match;
  }
  return list[0] ?? core.createSession(surface ? { surface } : undefined);
}

/** GET /api/agent?sessionId=xxx —— 返回指定会话（默认最新）的消息历史 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    let session: SessionInfo | undefined = sessionId
      ? getSession(sessionId)
      : undefined;
    if (!session) session = core.listSessions()[0];
    if (!session) return Response.json({ messages: [], session: null });

    const agent = await core.getAgent(session.id);
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
  let body: {
    message?: unknown;
    sessionId?: unknown;
    rewindToText?: unknown;
    rewindToIndex?: unknown;
    approvalMode?: unknown;
    images?: { data?: unknown; mimeType?: unknown }[];
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON: { message: string }" }, { status: 400 });
  }
  const message = String(body?.message ?? "").trim();
  if (!message) {
    return Response.json({ error: "message 不能为空" }, { status: 400 });
  }
  // 多模态（Phase 6）：透传图片块（base64 + mimeType）给模型
  const images = (Array.isArray(body?.images) ? body.images : [])
    .filter((img) => img && typeof img.data === "string" && img.data && typeof img.mimeType === "string")
    .map((img) => ({ data: img.data as string, mimeType: img.mimeType as string }));
  const imageContents = toImageContents(images);
  // 同步审批模式（持久化到 permission.json activeMode；dangerous 兼容为 full）
  const am = body?.approvalMode;
  if (am === "manual" || am === "auto" || am === "full" || am === "custom" || am === "dangerous") {
    setApprovalMode(am);
  }
  const session = resolveSession(body);

  let agent;
  try {
    agent = await core.getAgent(session.id);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  if (agent.state.isStreaming) {
    return Response.json({ error: "agent 正在处理上一条消息，请稍候" }, { status: 409 });
  }

  // 重写历史（按索引定位，编辑重发用）：截断到该索引（不含被替换的旧消息），
  // 随后 prompt 会追加编辑后的新消息。文本匹配只保留给"重新生成"（原文未变）。
  const rewindToIndex =
    typeof body.rewindToIndex === "number" && Number.isInteger(body.rewindToIndex)
      ? body.rewindToIndex
      : undefined;
  if (rewindToIndex !== undefined) {
    const msgs = agent.state.messages;
    if (rewindToIndex >= 0) {
      // 前端 UI 消息数组不含 toolResult（toUiMessage 过滤），先把 UI 索引
      // 映射回全量消息数组的下标，再截断（不含被替换的旧 user 消息）。
      let ui = 0;
      let cut = msgs.length;
      for (let j = 0; j < msgs.length; j++) {
        const r = msgs[j].role;
        if (r === "user" || r === "assistant") {
          if (ui === rewindToIndex) {
            cut = j;
            break;
          }
          ui++;
        }
      }
      agent.state.messages = msgs.slice(0, cut);
    }
  } else if (typeof body.rewindToText === "string" && body.rewindToText.trim()) {
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
      // 流关闭后 bus 回调仍可能触发（如计划在客户端断开后被审批），此时 enqueue 会抛
      // "Invalid state: Controller is already closed"。用 closed 标记 + try/catch 守卫，
      // 关闭后静默忽略后续事件，避免未捕获异常中断审批/计划落库。
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // 首个事件：告知前端实际使用的会话
      send({ type: "session", sessionId: session.id, title: session.title });

      // Phase 7.5：通信层落地 —— 核心层（agent/approval/plan）已直接 emit 到共享 AgentEventBus，
      // 这里只做传输适配：订阅 bus，按会话隔离推送，SSE 行为不变。
      // tool_call 统计供运行统计概览（同样来自 bus，带 sessionId）。
      const toolCalls: Record<string, number> = {};
      const usage = { input: 0, output: 0, cacheRead: 0, totalTokens: 0, cost: 0 };
      const unsubBus = core.eventBus.subscribe((event) => {
        const sid = (event as { sessionId?: string }).sessionId;
        // 按会话隔离：精确匹配当前会话；子 agent 事件 sessionId 为 `${sessionId}:${subagentId}`，
        // 前缀匹配放行（修复前子 agent 审批事件被丢弃，审批卡到超时自动拒绝）
        if (sid && sid !== session.id && !sid.startsWith(session.id + ":")) return;
        const type = (event as { type?: string }).type;
        if (type === "tool_end") {
          const name = (event as { toolName?: string }).toolName;
          if (name) toolCalls[name] = (toolCalls[name] ?? 0) + 1;
        }
        if (type === "turn_end") {
          const u = (event as {
            usage?: {
              input?: number;
              output?: number;
              cacheRead?: number;
              totalTokens?: number;
              cost?: { total?: number };
            };
          }).usage;
          if (u) {
            usage.input += u.input ?? 0;
            usage.output += u.output ?? 0;
            usage.cacheRead += u.cacheRead ?? 0;
            usage.totalTokens += u.totalTokens ?? 0;
            usage.cost += u.cost?.total ?? 0;
          }
        }
        send(event);
      });

      let aborted = false;
      let runError: unknown = undefined;
      const runStartedAt = Date.now();
      // 在「工具会话上下文 + 会话绑定工作目录」下执行 prompt + 工具调用链；
      // 使用 AsyncLocalStorage 保证并发请求各自读到自己的 sessionId/workdir，
      // 不会因全局变量被其他请求覆盖（plan_propose 归属 / 记忆归属 / 工作目录）。
      try {
        await runWithToolCtx(
          {
            sessionId: session.id,
            surface: session.surface ?? "coding",
            workdir: session.workdir,
          },
          async () => {
            await runWithWorkdir(session.workdir, async () => {
              await a.prompt(message, imageContents.length > 0 ? imageContents : undefined);
              await a.waitForIdle();
            });
          },
        );
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
        // 运行日志（持久化到 insights.db，供前端查看最近执行记录与观测统计）
        const runRec = logRun({
          sessionId: session.id,
          title: session.title,
          startedAt: runStartedAt,
          durationMs: Date.now() - runStartedAt,
          messageCount: msgs.length,
          stopped,
          toolCalls,
          usage,
          error:
            !aborted && runError
              ? runError instanceof Error
                ? runError.message
                : String(runError)
              : undefined,
        });
        // LLM-as-Judge 自动评分（默认关闭，PRYSM_LLM_JUDGE=1 启用；fire-and-forget，不影响响应）
        try {
          const userMsg = msgs.find((m) => m.role === "user");
          const replyMsg = [...msgs].reverse().find((m) => m.role === "assistant");
          void judgeRun(runRec, {
            userText: userMsg ? contentText(userMsg.content) : undefined,
            replyText: replyMsg ? contentText(replyMsg.content) : undefined,
          });
        } catch (err) {
          console.error("[judge] 触发失败:", err);
        }
        // 阶段 4：把消息写入情景记忆（按内容去重，恢复的历史不会重复写入）
        try {
          const stored = rememberMessages(a.state.messages);
          if (stored > 0) console.log(`[memory] 已写入 ${stored} 条情景记忆`);
        } catch (err) {
          console.error("[memory] 写入失败:", err);
        }
        unsubBus();
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
