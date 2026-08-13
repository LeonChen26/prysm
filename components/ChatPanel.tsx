"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

interface SessionInfo {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface SseEvent {
  type:
    | "session"
    | "turn_start"
    | "delta"
    | "tool_start"
    | "tool_end"
    | "turn_end"
    | "agent_end"
    | "approval_required"
    | "stopped"
    | "error"
    | "done";
  delta?: string;
  id?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  todos?: TodoItem[];
  sessionId?: string;
  title?: string;
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

const TOOL_META: Record<string, { label: string; type: string }> = {
  list_dir: { label: "列出目录", type: "文件" },
  read_file: { label: "读取文件", type: "文件" },
  write_file: { label: "写入文件", type: "文件" },
  append_file: { label: "追加写入", type: "文件" },
  create_dir: { label: "创建目录", type: "文件" },
  move_file: { label: "移动/重命名", type: "文件" },
  copy_file: { label: "复制文件", type: "文件" },
  delete_file: { label: "删除文件", type: "文件" },
  verify_file: { label: "校验文件", type: "文件" },
  todo_create: { label: "创建任务计划", type: "任务" },
  todo_modify: { label: "更新任务计划", type: "任务" },
  todo_list: { label: "查看任务计划", type: "任务" },
  web_search: { label: "网页搜索", type: "网络" },
  fetch_url: { label: "抓取网页", type: "网络" },
};

const TODO_STATUS_LABELS: Record<TodoItem["status"], string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "完成",
  cancelled: "已取消",
};

/** 会话相对时间：刚刚 / x分钟前 / x小时前 / x天前 / 日期 */
function formatRelTime(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** Markdown 代码块：hover 显示复制按钮 */
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!ref.current) return;
    try {
      await navigator.clipboard.writeText(ref.current.textContent ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };
  return (
    <div className="code-block">
      <button
        type="button"
        className={`code-copy ${copied ? "code-copied" : ""}`}
        onClick={copy}
      >
        {copied ? "已复制" : "复制"}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

export function ChatPanel() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [cards, setCards] = useState<ToolCard[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalCard[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const scrollRef = useRef<HTMLDivElement>(null);

  // 应用主题到 <html> 并持久化（React 19 hydration 下 useState 惰性初始化不可靠，统一在 mount 后读取）
  const applyTheme = useCallback((t: "light" | "dark") => {
    document.documentElement.dataset.theme = t;
    localStorage.setItem("wb-theme", t);
  }, []);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("wb-theme");
    } catch {
      /* 隐私模式等场景可能不可用 */
    }
    const init: "light" | "dark" =
      saved === "light" || saved === "dark"
        ? saved
        : matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    setTheme(init);
    applyTheme(init);
  }, [applyTheme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, [applyTheme]);

  // 加载会话列表，并选中最近的会话
  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then(async (data) => {
        const list = (data?.sessions ?? []) as SessionInfo[];
        setSessions(list);
        if (list.length > 0) {
          setSessionId(list[0].id);
          const res = await fetch(`/api/sessions/${list[0].id}`);
          const detail = await res.json();
          if (detail?.messages) setMessages(detail.messages);
        }
      })
      .catch(() => {});
  }, []);

  /** 切换到指定会话 */
  const switchSession = useCallback(
    async (id: string) => {
      if (busy) return;
      setSessionId(id);
      setCards([]);
      setTodos([]);
      setApprovals([]);
      setError(null);
      setMessages([]);
      try {
        const res = await fetch(`/api/sessions/${id}`);
        const data = await res.json();
        if (data?.messages) setMessages(data.messages);
        else if (data?.error) setError(data.error);
      } catch {
        setError("加载会话失败");
      }
    },
    [busy],
  );

  /** 新建会话 */
  const newSession = useCallback(async () => {
    if (busy) return;
    try {
      const res = await fetch("/api/sessions", { method: "POST" });
      const data = await res.json();
      const s = data?.session as SessionInfo | undefined;
      if (s) {
        setSessions((list) => [s, ...list]);
        setSessionId(s.id);
        setMessages([]);
        setCards([]);
        setTodos([]);
        setApprovals([]);
        setError(null);
      }
    } catch {
      setError("新建会话失败");
    }
  }, [busy]);

  /** 删除会话 */
  const removeSession = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/sessions/${id}`, { method: "DELETE" });
        const rest = sessions.filter((s) => s.id !== id);
        setSessions(rest);
        if (id === sessionId) {
          setCards([]);
          setTodos([]);
          setApprovals([]);
          setError(null);
          if (rest.length > 0) {
            switchSession(rest[0].id);
          } else {
            setSessionId(null);
            setMessages([]);
          }
        }
      } catch {
        setError("删除会话失败");
      }
    },
    [sessions, sessionId, switchSession],
  );

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
        body: JSON.stringify({ message: text, sessionId }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `请求失败: ${res.status}`);
      }
      await readSSE(res, (ev) => {
        switch (ev.type) {
          case "session":
            // 服务端确认/分配的会话（未指定时取最新或新建）
            if (ev.sessionId) {
              setSessionId(ev.sessionId);
              setSessions((list) => {
                const exists = list.some((s) => s.id === ev.sessionId);
                return exists
                  ? list
                  : [{ id: ev.sessionId!, title: ev.title ?? "新会话", createdAt: 0, updatedAt: 0 }, ...list];
              });
            }
            break;
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
          case "stopped":
            setError(ev.message ?? "任务已停止");
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
  }, [input, busy, sessionId]);

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

  /** 中断当前正在执行的任务 */
  const stop = useCallback(async () => {
    if (!sessionId) return;
    try {
      await fetch("/api/agent/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch {
      /* SSE 流会自行结束 */
    }
  }, [sessionId]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="traffic-lights" aria-hidden="true">
          <span className="tl tl-red" />
          <span className="tl tl-yellow" />
          <span className="tl tl-green" />
        </div>
        <div className="brand">
          <span className="brand-dot" />
          <h1>WorkBuddy Agent</h1>
        </div>
        <div className={`status ${busy ? "status-busy" : ""}`}>
          <span className="status-dot" />
          {busy ? "正在执行任务…" : "空闲"}
        </div>
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          title={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
          aria-label="切换主题"
        >
          {theme === "dark" ? (
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          ) : (
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
            </svg>
          )}
        </button>
      </header>

      <main className="app-main">
        <aside className="session-panel">
          <div className="session-head">
            <span className="session-title">会话</span>
            <button
              className="session-new"
              onClick={newSession}
              disabled={busy}
              title="新建会话"
            >
              ＋
            </button>
          </div>
          <div className="session-scroll">
            {sessions.length === 0 ? (
              <p className="session-empty">还没有会话</p>
            ) : (
              <ul className="session-list">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <button
                      className={`session-item ${s.id === sessionId ? "session-active" : ""}`}
                      onClick={() => switchSession(s.id)}
                    >
                      <span className="session-item-title">
                        {s.title || "未命名会话"}
                      </span>
                      <span className="session-item-time">
                        {formatRelTime(s.updatedAt)}
                      </span>
                      <span
                        className="session-item-del"
                        role="button"
                        title="删除会话"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeSession(s.id);
                        }}
                      >
                        ×
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section className="chat">
          <div className="chat-scroll">
            {messages.length === 0 && (
              <div className="empty">
                <div className="empty-icon" aria-hidden="true">
                  <svg
                    width="40"
                    height="40"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" />
                    <path d="M9 10.5h6M9 13.5h3" />
                  </svg>
                </div>
                <p className="empty-title">开始你的第一个任务</p>
                <p className="empty-sub">
                  例如：搜索 DeepSeek 最新模型，或在 agent-workdir 里整理一个项目的 README
                </p>
              </div>
            )}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const next = messages[i + 1];
              // iMessage 气泡分组：连续同角色消息合并，仅组尾显示尾巴与头像
              const groupEnd = !next || next.role !== m.role;
              const groupMid = !!prev && prev.role === m.role && !!next && next.role === m.role;
              const cls = [
                "message",
                `message-${m.role}`,
                groupEnd ? "group-end" : "",
                groupMid ? "group-mid" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <div key={i} className={cls}>
                  <div className="message-role" aria-hidden={!groupEnd}>
                    {m.role === "user" ? (
                      <span aria-hidden="true">●</span>
                    ) : (
                      <span aria-hidden="true">✦</span>
                    )}
                  </div>
                  <div className="message-body">
                    {m.text ? (
                      <div className="md">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{ pre: CodeBlock }}
                        >
                          {m.text}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <span className="cursor-blink" />
                    )}
                  </div>
                </div>
              );
            })}
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
            <textarea
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // 自动增高（上限 6 行）
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="描述你要完成的任务…（Enter 发送，Shift+Enter 换行）"
              disabled={busy}
              rows={1}
            />
            {busy ? (
              <button type="button" className="btn-stop" onClick={stop}>
                停止
              </button>
            ) : (
              <button
                type="submit"
                className="btn-send"
                disabled={!input.trim()}
                aria-label="发送"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            )}
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
                      需要确认：{TOOL_META[a.toolName]?.label ?? a.toolName}
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
                      <span className={`card-badge card-badge-${card.status}`}>
                        {TOOL_META[card.toolName]?.type ?? "工具"}
                      </span>
                      <span className="card-status" aria-hidden="true" />
                      <span className="card-name">
                        {TOOL_META[card.toolName]?.label ?? card.toolName}
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
