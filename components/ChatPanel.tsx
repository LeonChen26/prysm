"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

/** Markdown 渲染组件集：表格加边框类、图片懒加载+加载失败占位、链接新标签打开 */
const markdownComponents = {
  table: (props: React.HTMLAttributes<HTMLTableElement>) => (
    <table className="md-table" {...props} />
  ),
  img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    <span className="md-img-wrap">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img loading="lazy" {...props} alt={props.alt ?? ""} />
    </span>
  ),
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a target="_blank" rel="noopener noreferrer" {...props} />
  ),
};

interface UiMessage {
  role: "user" | "assistant";
  text: string;
}

interface ToolCard {
  id: string;
  toolName: string;
  args: unknown;
  status: "running" | "done" | "error";
  result?: string;
  /** 工具开始时间戳（用于计算耗时） */
  startedAt?: number;
  /** 工具执行耗时（毫秒） */
  elapsedMs?: number;
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
  pinned?: number;
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
  result?: string;
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

/** 空状态快捷任务入口 */
const QUICK_TASKS = [
  "搜索 DeepSeek 最新模型并给出对比",
  "整理 agent-workdir 里的项目并生成 README",
  "写一份 Next.js 服务端组件的介绍",
];

/** 会话分组：今天 / 昨天 / 7天内 / 更早（基于 updatedAt） */
function groupOf(ts: number): string {
  if (!ts) return "更早";
  const now = new Date();
  const startToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  if (ts >= startToday) return "今天";
  if (ts >= startToday - 86400_000) return "昨天";
  if (ts >= startToday - 7 * 86400_000) return "7天内";
  return "更早";
}

const GROUP_ORDER = ["今天", "昨天", "7天内", "更早"];

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

/** 工具耗时：<1s 显示毫秒，否则保留一位小数秒 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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
  const [sessionQuery, setSessionQuery] = useState("");
  /** 会话消息内容搜索结果（点击跳转到对应会话） */
  const [searchResults, setSearchResults] = useState<
    { sessionId: string; title: string; snippet: string }[]
  >([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  /** 会话多选批量删除模式 */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** todo 追加步骤 */
  const [todoAppendOpen, setTodoAppendOpen] = useState(false);
  const [todoAppendText, setTodoAppendText] = useState("");
  /** 消息编辑：正在编辑的用户消息索引（-1 表示非编辑态） */
  const [editingIndex, setEditingIndex] = useState(-1);
  /** todo 拖拽：记录被拖动的项 id */
  const todoDragRef = useRef<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  /** busy 的同步镜像，避免 useCallback 闭包读到过期值 */
  const busyRef = useRef(false);
  /** 智能滚动：用户停留在底部时才自动跟随；主动滚动离开底部则暂停 */
  const stickRef = useRef(true);
  /** 最近一次程序性滚动的时间戳（用于忽略其引发的 scroll 事件） */
  const programmaticScrollRef = useRef(0);

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

  // 会话搜索：本地标题过滤之外，防抖查询后端消息内容匹配
  useEffect(() => {
    const q = sessionQuery.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/sessions/search?q=${encodeURIComponent(q)}`);
        const data = await r.json();
        if (Array.isArray(data?.results)) setSearchResults(data.results);
      } catch {
        /* 静默 */
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [sessionQuery]);

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
      setEditingIndex(-1);
      setInput("");
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

  /** 从搜索结果跳转到对应会话 */
  const jumpToSession = useCallback(
    async (id: string) => {
      if (busy) return;
      setSessionQuery("");
      setSearchResults([]);
      await switchSession(id);
    },
    [busy, switchSession],
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

  /** 拉取最新会话列表（发送后刷新标题与时间） */
  const refreshSessions = useCallback(async () => {
    try {
      const r = await fetch("/api/sessions");
      const data = await r.json();
      if (Array.isArray(data?.sessions)) setSessions(data.sessions);
    } catch {
      /* 静默 */
    }
  }, []);

  /** 置顶 / 取消置顶会话 */
  const togglePin = useCallback(
    async (id: string) => {
      try {
        const s = sessions.find((x) => x.id === id);
        if (!s) return;
        const pinned = !(s.pinned === 1);
        const r = await fetch(`/api/sessions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pinned }),
        });
        if (!r.ok) throw new Error("置顶失败");
        setSessions((list) =>
          list.map((x) => (x.id === id ? { ...x, pinned: pinned ? 1 : 0 } : x)),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sessions],
  );

  /** 导出会话为 Markdown / JSON 文件 */
  const exportSession = useCallback(
    (id: string, format: "md" | "json") => {
      const s = sessions.find((x) => x.id === id);
      if (!s) return;
      const a = document.createElement("a");
      a.href = `/api/sessions/${id}/export?format=${format}`;
      a.download = `${s.title || "会话"}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    [sessions],
  );

  /** 清空会话消息（保留会话） */
  const clearSession = useCallback(
    async (id: string) => {
      try {
        const r = await fetch(`/api/sessions/${id}/clear`, { method: "POST" });
        if (!r.ok) throw new Error("清空失败");
        if (id === sessionId) {
          setMessages([]);
          setCards([]);
          setTodos([]);
          setApprovals([]);
          setError(null);
        }
        refreshSessions();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId, refreshSessions],
  );

  /** 智能滚动：记录用户是否停留在底部 */
  const onChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    // 程序性自动滚动（smooth 动画）期间会连续触发 scroll 事件，
    // 若不忽略会把 stickRef 误判为 false，导致自动跟随被意外关闭
    if (Date.now() - programmaticScrollRef.current < 600) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  // 消息 / 卡片变化时：仅当用户停留在底部才自动滚动跟随
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el && stickRef.current) {
      programmaticScrollRef.current = Date.now();
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages, cards, todos, busy]);

  /**
   * 核心：向 agent 发送消息并消费 SSE 流。
   * @param text         用户消息内容
   * @param rewindToText 重新生成时回退到该用户消息（后端按文本截断历史）
   * @param appendUser   是否追加 user 消息（重新生成时历史已含该消息，跳过）
   */
  const streamReply = useCallback(
    async (text: string, rewindToText?: string, appendUser = true) => {
      const t = text.trim();
      if (!t || busyRef.current) return;
      setError(null);
      setCards([]);
      setTodos([]);
      setApprovals([]);
      if (appendUser) {
        setMessages((m) => [
          ...m,
          { role: "user", text: t },
          { role: "assistant", text: "" },
        ]);
      } else {
        setMessages((m) => [...m, { role: "assistant", text: "" }]);
      }
      setBusy(true);
      busyRef.current = true;
      stickRef.current = true;

      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: t, sessionId, rewindToText }),
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
                    : [
                        {
                          id: ev.sessionId!,
                          title: ev.title ?? "新会话",
                          createdAt: 0,
                          updatedAt: 0,
                        },
                        ...list,
                      ];
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
                  startedAt: Date.now(),
                },
              ]);
              break;
            case "tool_end":
              setCards((c) =>
                c.map((card) => {
                  if (card.id !== ev.id) return card;
                  return {
                    ...card,
                    status: ev.isError ? "error" : "done",
                    result: ev.result,
                    elapsedMs:
                      Date.now() - (card.startedAt ?? Date.now()),
                  };
                }),
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
        busyRef.current = false;
        refreshSessions();
      }
    },
    [sessionId, refreshSessions],
  );

  /** 发送输入框内容（编辑态时截断并替换目标消息后重发） */
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    if (editingIndex >= 0 && messages[editingIndex]?.role === "user") {
      const idx = editingIndex;
      setEditingIndex(-1);
      // 截断到该条用户消息并替换为编辑后的内容，后端按 rewindToText 同步截断历史
      setMessages((m) => m.slice(0, idx).concat([{ role: "user", text }]));
      await streamReply(text, text, false);
      return;
    }
    await streamReply(text);
  }, [input, streamReply, editingIndex, messages]);

  /** 进入消息编辑态：载入输入框并聚焦 */
  const startEdit = useCallback(
    (msgIndex: number) => {
      const target = messages[msgIndex];
      if (!target || target.role !== "user" || busyRef.current) return;
      setEditingIndex(msgIndex);
      setInput(target.text);
      setError(null);
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>(".chat-input")?.focus();
      });
    },
    [messages],
  );

  /** 取消消息编辑 */
  const cancelEdit = useCallback(() => {
    setEditingIndex(-1);
    setInput("");
  }, []);

  /** 快捷任务入口 */
  const sendQuick = useCallback(
    async (preset: string) => {
      setInput("");
      await streamReply(preset);
    },
    [streamReply],
  );

  /** 重新生成：截断到该条回复之前的用户消息，回退历史并重新执行 */
  const regenerate = useCallback(
    async (msgIndex: number) => {
      const target = messages[msgIndex];
      if (!target || target.role !== "assistant" || busyRef.current) return;
      let uIdx = -1;
      for (let i = msgIndex - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          uIdx = i;
          break;
        }
      }
      if (uIdx < 0) return;
      const userText = messages[uIdx].text;
      setMessages(messages.slice(0, uIdx + 1));
      await streamReply(userText, userText, false);
    },
    [messages, streamReply],
  );

  /** 复制单条消息全文 */
  const copyMessage = useCallback(
    async (text: string, e: ReactMouseEvent<HTMLButtonElement>) => {
      if (!text) return;
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        // 剪贴板 API 不可用时回退到 execCommand
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand("copy");
          document.body.removeChild(ta);
        } catch {
          ok = false;
        }
      }
      if (!ok) return;
      const btn = e.currentTarget;
      btn.textContent = "已复制";
      btn.classList.add("msg-action-copied");
      setTimeout(() => {
        btn.textContent = "复制";
        btn.classList.remove("msg-action-copied");
      }, 1200);
    },
    [],
  );

  /** 保存会话重命名 */
  const saveRename = useCallback(async () => {
    if (!renamingId) return;
    const title = renameValue.trim();
    const id = renamingId;
    setRenamingId(null);
    if (!title) return;
    try {
      const res = await fetch(`/api/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "重命名失败");
      }
      setSessions((list) =>
        list.map((s) => (s.id === id ? { ...s, title } : s)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [renamingId, renameValue]);

  /** 进入会话重命名编辑态 */
  const startRename = useCallback((id: string, title: string) => {
    setRenamingId(id);
    setRenameValue(title);
  }, []);

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

  // 任务进度（供进度条渲染）
  const doneCount = todos.filter((t) => t.status === "completed").length;
  const todoPct = todos.length
    ? Math.round((doneCount / todos.length) * 100)
    : 0;

  /** 展开 / 收起工具卡片的结果 */
  const toggleCard = useCallback((id: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** 退出会话多选模式 */
  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  /** 批量删除选中的会话 */
  const batchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    for (const id of ids) {
      try {
        await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      } catch {
        /* 单个失败不阻断批量删除 */
      }
    }
    const remaining = sessions.filter((s) => !selectedIds.has(s.id));
    setSessions(remaining);
    if (sessionId && selectedIds.has(sessionId)) {
      setCards([]);
      setTodos([]);
      setApprovals([]);
      setError(null);
      if (remaining.length > 0) {
        switchSession(remaining[0].id);
      } else {
        setSessionId(null);
        setMessages([]);
      }
    }
    exitSelectMode();
  }, [selectedIds, sessions, sessionId, switchSession, exitSelectMode]);

  /** todo 拖拽落点：把拖动的项移到目标项之前 */
  const handleTodoDrop = useCallback(
    async (targetId: string) => {
      const fromId = todoDragRef.current;
      todoDragRef.current = null;
      if (!fromId || fromId === targetId) return;
      const ids = todos.map((t) => t.id);
      const from = ids.indexOf(fromId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0) return;
      ids.splice(from, 1);
      ids.splice(to, 0, fromId);
      const map = new Map(todos.map((t) => [t.id, t]));
      setTodos(ids.map((id) => map.get(id)!).filter(Boolean));
      try {
        const res = await fetch("/api/todos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reorder", ids }),
        });
        const data = await res.json();
        if (data?.todos) setTodos(data.todos);
      } catch {
        setError("排序同步失败");
      }
    },
    [todos],
  );

  /** 删除单个 todo 步骤 */
  const removeTodo = useCallback(async (id: string) => {
    try {
      const res = await fetch("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", ids: [id] }),
      });
      const data = await res.json();
      if (data?.todos) setTodos(data.todos);
      else if (data?.error) setError(data.error);
    } catch {
      setError("删除步骤失败");
    }
  }, []);

  /** 追加 todo 步骤 */
  const appendTodo = useCallback(async () => {
    const title = todoAppendText.trim();
    if (!title) return;
    setTodoAppendText("");
    setTodoAppendOpen(false);
    try {
      const res = await fetch("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "append", items: [{ title }] }),
      });
      const data = await res.json();
      if (data?.todos) setTodos(data.todos);
      else if (data?.error) setError(data.error);
    } catch {
      setError("添加步骤失败");
    }
  }, [todoAppendText]);

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
            <span className="session-title">
              {selectMode ? `已选 ${selectedIds.size}` : "会话"}
            </span>
            {selectMode ? (
              <div className="session-head-actions">
                <button
                  className="session-batch-del"
                  disabled={selectedIds.size === 0}
                  onClick={batchDelete}
                >
                  删除
                </button>
                <button
                  className="session-batch-cancel"
                  onClick={exitSelectMode}
                >
                  取消
                </button>
              </div>
            ) : (
              <div className="session-head-actions">
                <button
                  className="session-multi"
                  onClick={() => setSelectMode(true)}
                  title="多选删除"
                  aria-label="多选删除"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="4" />
                  </svg>
                </button>
                <button
                  className="session-new"
                  onClick={newSession}
                  disabled={busy}
                  title="新建会话"
                >
                  ＋
                </button>
              </div>
            )}
          </div>
          <div className="session-search">
            <input
              value={sessionQuery}
              onChange={(e) => setSessionQuery(e.target.value)}
              placeholder="搜索会话 / 消息…"
            />
          </div>
          {sessionQuery.trim() && searchResults.length > 0 && (
            <div className="search-results">
              <p className="search-results-label">消息匹配</p>
              {searchResults.map((r) => (
                <button
                  key={r.sessionId}
                  type="button"
                  className="search-result-item"
                  onClick={() => jumpToSession(r.sessionId)}
                >
                  <span className="search-result-title">{r.title || "未命名会话"}</span>
                  <span className="search-result-snippet">{r.snippet}</span>
                </button>
              ))}
            </div>
          )}
          <div className="session-scroll">
            {sessions.length === 0 ? (
              <p className="session-empty">还没有会话</p>
            ) : (
              (() => {
                const q = sessionQuery.trim().toLowerCase();
                const filtered = q
                  ? sessions.filter((s) =>
                      (s.title || "").toLowerCase().includes(q),
                    )
                  : sessions;
                if (filtered.length === 0) {
                  return <p className="session-empty">没有匹配的会话</p>;
                }
                const groups = GROUP_ORDER.map((key) => ({
                  key,
                  items: filtered.filter(
                    (s) => groupOf(s.updatedAt) === key,
                  ),
                })).filter((g) => g.items.length > 0);
                return (
                  <>
                    {groups.map((g) => (
                      <div key={g.key} className="session-group">
                        <p className="session-group-label">{g.key}</p>
                        <ul className="session-list">
                          {g.items.map((s) => (
                            <li key={s.id}>
                              {renamingId === s.id ? (
                                <input
                                  className="session-rename-input"
                                  value={renameValue}
                                  autoFocus
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") saveRename();
                                    if (e.key === "Escape")
                                      setRenamingId(null);
                                  }}
                                  onBlur={saveRename}
                                  onClick={(e) => e.stopPropagation()}
                                />
                              ) : (
                                <button
                                  className={`session-item ${s.id === sessionId && !selectMode ? "session-active" : ""} ${selectedIds.has(s.id) ? "session-selected" : ""}`}
                                  onClick={() => {
                                    if (selectMode) {
                                      setSelectedIds((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(s.id)) next.delete(s.id);
                                        else next.add(s.id);
                                        return next;
                                      });
                                    } else {
                                      switchSession(s.id);
                                    }
                                  }}
                                >
                                  {selectMode && (
                                    <span
                                      className={`session-check ${selectedIds.has(s.id) ? "session-check-on" : ""}`}
                                      aria-hidden="true"
                                    />
                                  )}
                                  <span className="session-item-title">
                                    {s.pinned === 1 && (
                                      <span className="session-pin-badge" title="已置顶">📌</span>
                                    )}
                                    {s.title || "未命名会话"}
                                  </span>
                                  <span className="session-item-time">
                                    {formatRelTime(s.updatedAt)}
                                  </span>
                                  {!selectMode && (
                                    <span className="session-item-actions">
                                      <span
                                        className="session-item-act"
                                        role="button"
                                        title={s.pinned === 1 ? "取消置顶" : "置顶会话"}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          togglePin(s.id);
                                        }}
                                      >
                                        {s.pinned === 1 ? "🔓" : "📌"}
                                      </span>
                                      <span
                                        className="session-item-act"
                                        role="button"
                                        title="导出 Markdown"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          exportSession(s.id, "md");
                                        }}
                                      >
                                        ⬇
                                      </span>
                                      <span
                                        className="session-item-act"
                                        role="button"
                                        title="导出 JSON"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          exportSession(s.id, "json");
                                        }}
                                      >
                                        ⚙
                                      </span>
                                      <span
                                        className="session-item-act"
                                        role="button"
                                        title="清空会话消息"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          clearSession(s.id);
                                        }}
                                      >
                                        ∅
                                      </span>
                                      <span
                                        className="session-item-act"
                                        role="button"
                                        title="重命名会话"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          startRename(s.id, s.title || "");
                                        }}
                                      >
                                        ✎
                                      </span>
                                      <span
                                        className="session-item-act session-item-del"
                                        role="button"
                                        title="删除会话"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          removeSession(s.id);
                                        }}
                                      >
                                        ×
                                      </span>
                                    </span>
                                  )}
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </>
                );
              })()
            )}
          </div>
        </aside>

        <section className="chat">
          <div
            className="chat-scroll"
            ref={chatScrollRef}
            onScroll={onChatScroll}
          >
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
                <div className="quick-chips">
                  {QUICK_TASKS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className="quick-chip"
                      disabled={busy}
                      onClick={() => sendQuick(q)}
                    >
                      {q}
                    </button>
                  ))}
                </div>
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
                      <>
                        <div className="md">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            rehypePlugins={[rehypeHighlight]}
                            components={{ ...markdownComponents, pre: CodeBlock }}
                          >
                            {m.text}
                          </ReactMarkdown>
                        </div>
                        {busy && i === messages.length - 1 && m.role === "assistant" && (
                          <span className="cursor-blink" aria-hidden="true" />
                        )}
                      </>
                    ) : busy && i === messages.length - 1 ? (
                      <span className="thinking" aria-label="思考中">
                        <span className="thinking-dot" />
                        <span className="thinking-dot" />
                        <span className="thinking-dot" />
                      </span>
                    ) : (
                      <span className="cursor-blink" />
                    )}
                    {groupEnd && m.text && (
                      <div className="msg-actions">
                        <button
                          type="button"
                          className="msg-action"
                          onClick={(e) => copyMessage(m.text, e)}
                        >
                          复制
                        </button>
                        {m.role === "user" && (
                          <button
                            type="button"
                            className="msg-action"
                            onClick={() => startEdit(i)}
                          >
                            编辑
                          </button>
                        )}
                        {m.role === "assistant" && (
                          <button
                            type="button"
                            className="msg-action"
                            onClick={() => regenerate(i)}
                          >
                            重新生成
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {error && <div className="error-banner">{error}</div>}
          </div>

          <form
            className="input-bar"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            {editingIndex >= 0 && (
              <div className="edit-banner">
                <span>正在编辑第 {editingIndex + 1} 条消息，发送后将截断后续内容重新生成</span>
                <button type="button" className="edit-cancel" onClick={cancelEdit}>
                  取消
                </button>
              </div>
            )}
            <textarea
              className="chat-input"
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
                    {doneCount}/{todos.length}
                  </span>
                </div>
                <div className="todo-progress">
                  <div className="todo-progress-track">
                    <div
                      className="todo-progress-fill"
                      style={{ width: `${todoPct}%` }}
                    />
                  </div>
                  <span className="todo-progress-label">{todoPct}%</span>
                </div>
                <ol className="todo-list">
                  {todos.map((t) => (
                    <li
                      key={t.id}
                      draggable
                      className={`todo-item todo-${t.status}`}
                      title="拖拽调整顺序"
                      onDragStart={(e) => {
                        todoDragRef.current = t.id;
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        handleTodoDrop(t.id);
                      }}
                      onDragEnd={() => {
                        todoDragRef.current = null;
                      }}
                    >
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
                      <button
                        type="button"
                        className="todo-del"
                        title="删除该步骤"
                        aria-label="删除该步骤"
                        onClick={() => removeTodo(t.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ol>
                <div className="todo-append">
                  {todoAppendOpen ? (
                    <input
                      className="todo-append-input"
                      value={todoAppendText}
                      autoFocus
                      placeholder="新步骤名称，Enter 添加"
                      onChange={(e) => setTodoAppendText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") appendTodo();
                        if (e.key === "Escape") {
                          setTodoAppendOpen(false);
                          setTodoAppendText("");
                        }
                      }}
                      onBlur={appendTodo}
                    />
                  ) : (
                    <button
                      type="button"
                      className="todo-append-btn"
                      onClick={() => setTodoAppendOpen(true)}
                    >
                      ＋ 添加步骤
                    </button>
                  )}
                </div>
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
                    className={`card card-${card.status} ${card.status === "running" ? "card-indeterminate" : ""}`}
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
                          : `${card.status === "done" ? "完成" : "失败"}${card.elapsedMs != null ? ` · ${formatDuration(card.elapsedMs)}` : ""}`}
                      </span>
                    </div>
                    <code className="card-args">
                      {JSON.stringify(card.args)?.slice(0, 120)}
                    </code>
                    {card.result && (
                      <>
                        <button
                          type="button"
                          className={`card-expand ${expandedCards.has(card.id) ? "card-expand-open" : ""}`}
                          onClick={() => toggleCard(card.id)}
                        >
                          {expandedCards.has(card.id) ? "收起结果" : "查看结果"}
                        </button>
                        {expandedCards.has(card.id) && (
                          <pre className="card-result">{card.result}</pre>
                        )}
                      </>
                    )}
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
