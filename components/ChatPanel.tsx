"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UiMessage {
  role: "user" | "assistant";
  text: string;
}

interface ToolCard {
  id: string;
  toolName: string;
  args: unknown;
  status: "running" | "done" | "error";
}

interface TodoItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  detail?: string;
}

interface ApprovalCard {
  id: string;
  toolName: string;
  args: unknown;
}

interface SseEvent {
  type:
    | "turn_start"
    | "delta"
    | "tool_start"
    | "tool_end"
    | "turn_end"
    | "agent_end"
    | "approval_required"
    | "error"
    | "done";
  delta?: string;
  id?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  todos?: TodoItem[];
  message?: string;
}

async function readSSE(response: Response, onEvent: (ev: SseEvent) => void) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
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
      try {
        onEvent(JSON.parse(payload) as SseEvent);
      } catch {
        /* 忽略无法解析的事件 */
      }
    }
  }
}

const TOOL_LABELS: Record<string, string> = {
  list_dir: "列出目录",
  read_file: "读取文件",
  write_file: "写入文件",
  append_file: "追加写入",
  create_dir: "创建目录",
  move_file: "移动/重命名",
  copy_file: "复制文件",
  delete_file: "删除文件",
  todo_create: "创建任务计划",
  todo_modify: "更新任务计划",
  todo_list: "查看任务计划",
};

const TODO_STATUS_LABELS: Record<TodoItem["status"], string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "完成",
  cancelled: "已取消",
};

export function ChatPanel() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [cards, setCards] = useState<ToolCard[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalCard[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 挂载时拉取会话历史
  useEffect(() => {
    fetch("/api/agent")
      .then((r) => r.json())
      .then((data) => {
        if (data?.messages) setMessages(data.messages);
      })
      .catch(() => {});
  }, []);

  // 消息 / 卡片变化时自动滚动到底部
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, cards, todos, busy]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    setMessages((m) => [...m, { role: "user", text }]);
    setMessages((m) => [...m, { role: "assistant", text: "" }]);
    setBusy(true);

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `请求失败: ${res.status}`);
      }
      await readSSE(res, (ev) => {
        switch (ev.type) {
          case "delta":
            setMessages((m) => {
              const copy = [...m];
              const last = copy[copy.length - 1];
              if (last?.role === "assistant") {
                copy[copy.length - 1] = {
                  ...last,
                  text: last.text + (ev.delta ?? ""),
                };
              }
              return copy;
            });
            break;
          case "tool_start":
            setCards((c) => [
              ...c,
              {
                id: ev.id!,
                toolName: ev.toolName!,
                args: ev.args,
                status: "running",
              },
            ]);
            break;
          case "tool_end":
            setCards((c) =>
              c.map((card) =>
                card.id === ev.id
                  ? { ...card, status: ev.isError ? "error" : "done" }
                  : card,
              ),
            );
            if (ev.todos) setTodos(ev.todos);
            break;
          case "approval_required":
            setApprovals((a) => [
              ...a,
              { id: ev.id!, toolName: ev.toolName!, args: ev.args },
            ]);
            break;
          case "error":
            setError(ev.message ?? "发生错误");
            break;
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [input, busy]);

  const decideApproval = useCallback(async (id: string, approve: boolean) => {
    setApprovals((a) => a.filter((item) => item.id !== id));
    try {
      const res = await fetch("/api/agent/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, approve }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "审批请求失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-dot" />
          <h1>WorkBuddy Agent</h1>
        </div>
        <div className={`status ${busy ? "status-busy" : ""}`}>
          <span className="status-dot" />
          {busy ? "正在执行任务…" : "空闲"}
        </div>
      </header>

      <main className="app-main">
        <section className="chat">
          <div className="chat-scroll">
            {messages.length === 0 && (
              <div className="empty">
                <p className="empty-title">开始你的第一个任务</p>
                <p className="empty-sub">
                  例如：在 agent-workdir 里创建一个 README 文件，说明这个项目的用途
                </p>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`message message-${m.role}`}>
                <div className="message-role">{m.role === "user" ? "你" : "Agent"}</div>
                <div className="message-body">
                  {m.text ? (
                    <p style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.text}</p>
                  ) : (
                    <span className="cursor-blink" />
                  )}
                </div>
              </div>
            ))}
            {error && <div className="error-banner">{error}</div>}
            <div ref={scrollRef} />
          </div>

          <form
            className="input-bar"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="描述你要完成的任务…"
              disabled={busy}
            />
            <button type="submit" disabled={busy || !input.trim()}>
              发送
            </button>
          </form>
        </section>

        <aside className="panel">
          <div className="panel-title">
            <h2>任务记录</h2>
            <span className="panel-count">{cards.length}</span>
          </div>
          <div className="panel-scroll">
            {approvals.length > 0 && (
              <div className="approval-list">
                {approvals.map((a) => (
                  <div key={a.id} className="approval-card">
                    <div className="approval-title">
                      需要确认：{TOOL_LABELS[a.toolName] ?? a.toolName}
                    </div>
                    <code className="approval-args">
                      {JSON.stringify(a.args)?.slice(0, 120)}
                    </code>
                    <div className="approval-actions">
                      <button
                        className="btn-approve"
                        onClick={() => decideApproval(a.id, true)}
                      >
                        允许
                      </button>
                      <button
                        className="btn-deny"
                        onClick={() => decideApproval(a.id, false)}
                      >
                        拒绝
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {todos.length > 0 && (
              <div className="todo-section">
                <div className="panel-title">
                  <h2>任务计划</h2>
                  <span className="panel-count">
                    {
                      todos.filter((t) => t.status === "completed").length
                    }
                    /{todos.length}
                  </span>
                </div>
                <ol className="todo-list">
                  {todos.map((t) => (
                    <li key={t.id} className={`todo-item todo-${t.status}`}>
                      <span className="todo-mark" aria-hidden="true">
                        {t.status === "completed" ? "✓" : ""}
                      </span>
                      <div className="todo-body">
                        <div className="todo-title">{t.title}</div>
                        {t.detail && (
                          <div className="todo-detail">{t.detail}</div>
                        )}
                      </div>
                      <span className="todo-state">
                        {TODO_STATUS_LABELS[t.status]}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {cards.length === 0 ? (
              <p className="panel-empty">
                Agent 调用工具时会在这里显示执行卡片。
              </p>
            ) : (
              <ul className="card-list">
                {cards.map((card) => (
                  <li
                    key={card.id}
                    className={`card card-${card.status}`}
                  >
                    <div className="card-head">
                      <span className="card-status" aria-hidden="true" />
                      <span className="card-name">
                        {TOOL_LABELS[card.toolName] ?? card.toolName}
                      </span>
                      <span className="card-state">
                        {card.status === "running"
                          ? "运行中"
                          : card.status === "done"
                            ? "完成"
                            : "失败"}
                      </span>
                    </div>
                    <code className="card-args">
                      {JSON.stringify(card.args)?.slice(0, 120)}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
