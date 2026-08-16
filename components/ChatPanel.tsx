"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import { mdToPlainText } from "@/lib/plaintext";
import { TOOL_META } from "@/lib/tool-meta";
import { DiffView, isDiffText } from "./DiffView";
import {
  BracesIcon,
  CheckIcon,
  ClockIcon,
  CodeBlock,
  DownloadIcon,
  extractFileRefs,
  FileDownIcon,
  FileRefCards,
  PencilIcon,
  PersonIcon,
  PinIcon,
  PinOffIcon,
  PlanIcon,
  PrismIcon,
  RiskIcon,
  SparkleIcon,
  ToolTypeIcon,
  TrashIcon,
  UploadIcon,
  WbChevron,
  WbFileIcon,
  WbFolderIcon,
  XIcon,
} from "./chat-blocks";
import { SettingsPanel } from "./settings-view";
import AutomationPanel from "./automation-panel";
import {
  formatApprovalArgs,
  formatDuration,
  formatGroupLabel,
  formatMsgTime,
  formatRelTime,
  GROUP_ORDER,
  addUsage,
  clearToolCards,
  loadToolCards,
  readSSE,
  RISK_LABELS,
  saveToolCards,
  TODO_STATUS_LABELS,
  toolCardStateClass,
  toolCardStateText,
  type ApprovalCard,
  type PlanCard,
  type RunStats,
  type SessionInfo,
  type SseEvent,
  type TodoItem,
  type ToolApproval,
  type ToolCard,
  type UiMessage,
  type UsageInfo,
  type ContextAnalysis,
  type InsightsOverview,
  type JudgeTrendPoint,
  type ModelStat,
  type ModelRoutesResponse,
} from "./chat-types";

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

/** 工具结果视图：diff 文本高亮渲染，其余保持等宽纯文本 */
function CardResultView({ result }: { result: string }) {
  return isDiffText(result) ? (
    <DiffView text={result} />
  ) : (
    <pre className="card-result">{result}</pre>
  );
}

/** 时间轴标签格式：跨天用 MM-DD，同日用 HH:MM（迷你图紧凑显示） */
function formatAxisTime(at: number, multiDay: boolean): string {
  const d = new Date(at);
  const p = (v: number) => String(v).padStart(2, "0");
  return multiDay
    ? `${p(d.getMonth() + 1)}-${p(d.getDate())}`
    : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 同一自然日判断（用于决定轴标签用日期还是时刻） */
function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** 均匀采样至多 MAX 个下标（始终含首尾），避免轴标签拥挤 */
function sampleAxisIdx(n: number, max = 4): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const idxs = new Set<number>([0, n - 1]);
  for (let i = 1; i < max - 1; i++) {
    idxs.add(Math.round((i / (max - 1)) * (n - 1)));
  }
  return [...idxs].sort((a, b) => a - b);
}

/** AI 评分迷你趋势图（评估面板）：按运行时间序画折线，7 分以下为低分点，底部对齐时间轴标签 */
function JudgeTrendChart({ trend }: { trend: JudgeTrendPoint[] }) {
  if (trend.length < 1) return null;
  const W = 100;
  const H = 40;
  const PAD = 4;
  const y = (s: number) => PAD + ((10 - s) / 10) * (H - 2 * PAD);
  const n = trend.length;
  const x = (i: number) =>
    n === 1 ? W / 2 : PAD + (i / (n - 1)) * (W - 2 * PAD);
  const pts = trend
    .map((p, i) => `${x(i).toFixed(1)},${y(p.score).toFixed(1)}`)
    .join(" ");
  const multiDay = !isSameLocalDay(trend[0].at, trend[n - 1].at);
  const axisIdx = sampleAxisIdx(n);
  return (
    <div className="insights-trend">
      <div className="insights-trend-head">
        <span className="insights-trend-title">AI 评分趋势</span>
        <span className="insights-trend-hint">7 分以下为低分</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="insights-trend-svg"
      >
        <line
          x1={PAD}
          y1={y(7)}
          x2={W - PAD}
          y2={y(7)}
          className="insights-trend-threshold"
        />
        <polyline points={pts} className="insights-trend-line" />
        {trend.map((p, i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.score)}
            r="1.8"
            className={`insights-trend-dot ${p.score < 7 ? "low" : "ok"}`}
          >
            <title>{`${p.score}/10 · ${formatAxisTime(p.at, multiDay)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="insights-trend-axis">
        {axisIdx.map((i) => {
          const pct = (x(i) / W) * 100;
          const style =
            i === 0
              ? { left: `${pct}%`, textAlign: "left" as const }
              : i === n - 1
                ? { left: `${pct}%`, textAlign: "right" as const }
                : {
                    left: `${pct}%`,
                    textAlign: "center" as const,
                    transform: "translateX(-50%)",
                  };
          return (
            <span
              key={i}
              className="insights-trend-axis-label"
              style={style}
            >
              {formatAxisTime(trend[i].at, multiDay)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** 模型表现（评估面板）：按运行次数排序，展示各模型 AI 均分 / 低分 / 规则问题 */
function ModelStatsView({ stats }: { stats: ModelStat[] }) {
  if (stats.length === 0) return null;
  return (
    <div className="insights-models">
      <div className="insights-models-head">
        <span className="insights-models-title">模型表现</span>
        <span className="insights-models-hint">按运行次数排序</span>
      </div>
      {stats.map((m) => {
        const hasScore = m.avgJudgeScore != null;
        const pct = hasScore
          ? Math.max(0, Math.min(100, (m.avgJudgeScore! / 10) * 100))
          : 0;
        return (
          <div className="insights-model" key={m.model}>
            <div className="insights-model-top">
              <span className="insights-model-name" title={m.model}>
                {m.model}
              </span>
              <div className="insights-model-meta">
                <span className="insights-model-runs">{m.runs} 次</span>
                {hasScore && (
                  <span
                    className={`insights-model-score ${
                      m.avgJudgeScore! < 7 ? "low" : ""
                    }`}
                  >
                    {m.avgJudgeScore}
                  </span>
                )}
                {m.lowScoreCount > 0 && (
                  <span className="insights-model-flag low">
                    低分 {m.lowScoreCount}
                  </span>
                )}
                {m.ruleIssues > 0 && (
                  <span className="insights-model-flag issue">
                    问题 {m.ruleIssues}
                  </span>
                )}
              </div>
            </div>
            <div className="insights-model-bar">
              <div
                className={`insights-model-bar-fill ${
                  hasScore ? "" : "empty"
                }`}
                style={hasScore ? { width: `${pct}%` } : undefined}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 单张工具卡片（会话区内联与右侧面板复用） */
function ToolCardView({
  card,
  resultOpen,
  onToggleResult,
}: {
  card: ToolCard;
  resultOpen: boolean;
  onToggleResult: () => void;
}) {
  return (
    <div
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
        <span
          className={`card-state ${toolCardStateClass(card)}`}
          title={card.approval?.reason}
        >
          {toolCardStateText(card)}
        </span>
      </div>
      <code className="card-args">{JSON.stringify(card.args)?.slice(0, 120)}</code>
      {card.result && (
        <>
          <button
            type="button"
            className={`card-expand ${resultOpen ? "card-expand-open" : ""}`}
            onClick={onToggleResult}
          >
            {resultOpen ? "收起结果" : "查看结果"}
          </button>
          {resultOpen && <CardResultView result={card.result} />}
        </>
      )}
    </div>
  );
}

/** 一轮问答的工具调用组摘要信息（工具名去重 + 总耗时 + 成功/失败计数） */
function toolGroupSummary(cards: ToolCard[]): {
  names: string;
  totalMs: number;
  done: number;
  err: number;
} {
  const names = [
    ...new Set(cards.map((c) => TOOL_META[c.toolName]?.label ?? c.toolName)),
  ];
  const totalMs = cards.reduce((s, c) => s + (c.elapsedMs ?? 0), 0);
  const done = cards.filter((c) => c.status === "done").length;
  const err = cards.filter((c) => c.status === "error").length;
  return { names: names.join("、"), totalMs, done, err };
}

/** 工具卡片组：一轮问答的多次工具调用折叠为一条摘要，点击展开 */
function ToolCardGroup({
  cards,
  expanded,
  onToggle,
  expandedCards,
  onToggleCard,
}: {
  cards: ToolCard[];
  expanded: boolean;
  onToggle: () => void;
  expandedCards: Set<string>;
  onToggleCard: (id: string) => void;
}) {
  const { names, totalMs, done, err } = toolGroupSummary(cards);
  return (
    <div className={`tool-group ${expanded ? "tool-group-open" : ""}`}>
      <button type="button" className="tool-group-head" onClick={onToggle}>
        <span className="tool-group-badge" aria-hidden="true">
          {cards.length}
        </span>
        <span className="tool-group-summary">{names}</span>
        {totalMs > 0 && (
          <span className="tool-group-time">{formatDuration(totalMs)}</span>
        )}
        <span className={`tool-group-state ${err > 0 ? "has-err" : ""}`}>
          {err > 0 ? `✓${done} · ✗${err}` : `✓${done}`}
        </span>
        <span className="tool-group-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div className="tool-group-body">
          {cards.map((card) => (
            <ToolCardView
              key={card.id}
              card={card}
              resultOpen={expandedCards.has(card.id)}
              onToggleResult={() => onToggleCard(card.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 按问答轮分组工具卡片（无 turnNo 的旧数据归入最后一轮） */
function groupCardsByTurn(
  cards: ToolCard[],
  userCount: number,
): Map<number, ToolCard[]> {
  const map = new Map<number, ToolCard[]>();
  for (const card of cards) {
    const t = card.turnNo && card.turnNo >= 1 ? card.turnNo : userCount;
    const group = map.get(t) ?? [];
    group.push(card);
    map.set(t, group);
  }
  return map;
}

/** 空状态快捷任务入口（Coding 形态） */
const QUICK_TASKS = [
  "搜索 DeepSeek 最新模型并给出对比",
  "整理 agent-workdir 里的项目并生成 README",
  "写一份 Next.js 服务端组件的介绍",
];

/** 规则评估 label → 中文（评估面板展示） */
const RULE_SCORE_LABELS: Record<string, string> = {
  run_error: "运行错误",
  run_stopped: "手动停止",
  no_tools: "未用工具",
  llm_judge: "AI 评分",
};

/** Work 形态空会话模板（办公任务）：点击即创建对应任务的会话并立即发起 */
const WORK_TEMPLATES: {
  id: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
  prompt: string;
}[] = [
  {
    id: "weekly-report",
    title: "写周报",
    desc: "自动汇总本周工作内容，生成结构化周报",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M3 9h18M8 2v4M16 2v4" />
        <path d="M8 14l2.5-2.5 2 2L16 10" />
      </svg>
    ),
    prompt:
      "请帮我生成本周周报，包含工作内容、进度、问题和下周计划，需要结构化格式、分点列出。",
  },
  {
    id: "meeting-minutes",
    title: "会议纪要",
    desc: "从录音/文字记录中提取关键决策和行动项",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 3h10a1 1 0 0 1 1 1v17l-3-2-3 2-3-2-3 2V4a1 1 0 0 1 1-1Z" />
        <path d="M9 8h6M9 12h6M9 16h4" />
      </svg>
    ),
    prompt:
      "请整理以下会议记录，提取关键决策、行动项和负责人，生成结构化会议纪要：\n\n[在此粘贴会议记录或录音文字稿]",
  },
  {
    id: "data-analysis",
    title: "数据分析",
    desc: "导入表格数据，生成可视化图表和洞察报告",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 20h16" />
        <rect x="6" y="12" width="3" height="6" rx="0.5" />
        <rect x="11" y="8" width="3" height="10" rx="0.5" />
        <rect x="16" y="4" width="3" height="14" rx="0.5" />
      </svg>
    ),
    prompt:
      "请分析附件中的数据表格，生成可视化图表（柱状图/折线图），并总结关键趋势和洞察。",
  },
];

/** 超过该字符数的消息默认折叠，点击展开 */
const LONG_MSG_THRESHOLD = 4000;

/** 审批动作展示文案 */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  approved: "允许",
  denied: "拒绝",
  timeout: "超时",
  denied_auto: "拦截",
  auto: "自动放行",
};

export function ChatPanel() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [cards, setCards] = useState<ToolCard[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalCard[]>([]);
  /** Plan mode（Phase 7）：待确认计划卡片 */
  const [plans, setPlans] = useState<PlanCard[]>([]);
  /** 倒计时心跳（每秒 +1，驱动审批卡片剩余秒数刷新） */
  const [countdownTick, setCountdownTick] = useState(0);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sessionQuery, setSessionQuery] = useState("");
  /** 会话消息内容搜索结果（点击跳转到对应会话） */
  const [searchResults, setSearchResults] = useState<
    { sessionId: string; title: string; snippet: string }[]
  >([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  /** 工具卡片组（按轮次 turnNo）展开状态 */
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  /** 会话多选批量删除模式 */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** todo 追加步骤 */
  const [todoAppendOpen, setTodoAppendOpen] = useState(false);
  const [todoAppendText, setTodoAppendText] = useState("");
  /** 情景记忆：条目列表 + 总数 + 面板折叠 */
  const [memoryEpisodes, setMemoryEpisodes] = useState<
    { id: number; role: string; content: string; ts: number }[]
  >([]);
  const [memoryTotal, setMemoryTotal] = useState(0);
  const [memoryOpen, setMemoryOpen] = useState(false);
  /** 运行日志：最近 Agent 执行记录 + 折叠 */
  const [runLogs, setRunLogs] = useState<
    {
      id: number;
      title: string;
      startedAt: number;
      durationMs: number;
      messageCount: number;
      stopped: boolean;
      error?: string;
    }[]
  >([]);
  const [logsOpen, setLogsOpen] = useState(false);
  /** 审批历史：最近审批决定 + 折叠 */
  const [audits, setAudits] = useState<
    {
      id: number;
      toolName: string;
      args: string;
      action: string;
      ts: number;
      risk?: string;
      reason?: string;
    }[]
  >([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditOpen, setAuditOpen] = useState(false);
  /** 审批历史筛选：工具 / 动作 / 分页偏移 */
  const [auditTool, setAuditTool] = useState("");
  const [auditAction, setAuditAction] = useState("");
  const [auditOffset, setAuditOffset] = useState(0);
  /** 运行统计概览：汇总 + 工具排行 + 按天分布 */
  const [stats, setStats] = useState<RunStats | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  /** 浏览器通知开关（任务完成时提醒） */
  const [notifyOn, setNotifyOn] = useState(false);
  /** Surface 形态：Work（办公自动化）/ Coding（编码） */
  const [surface, setSurface] = useState<"work" | "coding">("coding");
  /** 新建会话绑定目录选择器 */
  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  const [dirPickerValue, setDirPickerValue] = useState("");
  const [dirPickerRoots, setDirPickerRoots] = useState<
    { id: string; name: string; root: string; authorized: number }[]
  >([]);
  /** 右侧面板是否折叠：Work 形态默认收起以专注对话，Coding 形态展开 */
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  /** 左栏视图：会话列表 / 文件浏览器 / 自动化 / 设置 */
  const [activityView, setActivityView] = useState<"sessions" | "files" | "automation" | "settings">("sessions");
  /** 右栏 Tab：工具卡片 / 记忆 / 日志 / 审计 / 上下文 / 评估 */
  const [rightTab, setRightTab] = useState<
    "cards" | "memory" | "logs" | "audit" | "context" | "insights"
  >("cards");
  /** 本轮问答的累计 turn 级 token 用量（turn_end 事件累加） */
  const [runUsage, setRunUsage] = useState<UsageInfo | null>(null);
  /** 上下文构成分析（GET /api/context 结果） */
  const [contextAnalysis, setContextAnalysis] = useState<ContextAnalysis | null>(null);
  /** 观测+评估聚合（GET /api/insights 结果） */
  const [insights, setInsights] = useState<InsightsOverview | null>(null);
  /** 评估面板筛选：all=全部 / issue=仅问题 / low=仅低分（AI 评分 <7） */
  const [insightsFilter, setInsightsFilter] = useState<"all" | "issue" | "low">(
    "all",
  );
  /** 模型路由目录（输入框模型选择器数据，GET /api/model-routes） */
  const [modelRoutes, setModelRoutes] = useState<ModelRoutesResponse | null>(
    null,
  );
  /** 输入框模型下拉是否展开 */
  const [modelOpen, setModelOpen] = useState(false);
  /** 输入框审批模式下拉是否展开 */
  const [approvalOpen, setApprovalOpen] = useState(false);
  /** 审批模式：手动 / 自动（LLM Guardian 决策，拒绝回退用户）/ 完全访问（不审批）/ 自定义（细粒度配置）。
   *  持久化到 localStorage（服务端写入 permission.json）。初始固定 manual，避免 SSR 水合不一致。 */
  const [approvalMode, setApprovalMode] = useState<"manual" | "auto" | "full" | "custom">("manual");
  /** 待发送的图片附件（多模态，随消息传给 /api/agent） */
  const [pendingImages, setPendingImages] = useState<
    { id: string; dataUrl: string; mimeType: string; name: string }[]
  >([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 工作区文件浏览器 */
  const [wbDirs, setWbDirs] = useState<
    Record<string, { name: string; isDir: boolean; size: number; mtime: number }[]>
  >({});
  const [wbExpanded, setWbExpanded] = useState<Set<string>>(new Set());
  const [wbPreview, setWbPreview] = useState<{
    path: string;
    content: string;
    truncated: boolean;
  } | null>(null);
  const [wbCreateOpen, setWbCreateOpen] = useState(false);
  const [wbCreateName, setWbCreateName] = useState("");
  const [wbCreateType, setWbCreateType] = useState<"file" | "dir">("file");
  /** 超长消息展开集合（默认折叠） */
  const [longOpen, setLongOpen] = useState<Set<number>>(new Set());
  /** 消息多选批量删除模式 */
  const [msgSelectMode, setMsgSelectMode] = useState(false);
  const [msgSelected, setMsgSelected] = useState<Set<number>>(new Set());
  /** 消息编辑：正在编辑的用户消息索引（-1 表示非编辑态） */
  const [editingIndex, setEditingIndex] = useState(-1);
  /** 人工评分：按消息索引记录 👍/👎（仅本地态，后端以 /api/insights/score 持久化） */
  const [ratings, setRatings] = useState<Record<number, "good" | "bad">>({});
  /** 评语草稿：被评分后出现的可选评语输入，按消息索引存 */
  const [ratingComments, setRatingComments] = useState<Record<number, string>>({});
  /** 侧栏宽度（可拖拽调宽，持久化到 localStorage）：左栏 160-380，中间聊天区 480-960 */
  const [leftW, setLeftW] = useState(220);
  const [midW, setMidW] = useState(720);
  const leftWRef = useRef(220);
  const midWRef = useRef(720);
  /** todo 拖拽：记录被拖动的项 id */
  const todoDragRef = useRef<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  /** busy 的同步镜像，避免 useCallback 闭包读到过期值 */
  const busyRef = useRef(false);
  /** 智能滚动：用户停留在底部时才自动跟随；主动滚动离开底部则暂停 */
  const stickRef = useRef(true);
  /** 最近一次程序性滚动的时间戳（用于忽略其引发的 scroll 事件） */
  const programmaticScrollRef = useRef(0);
  /** 当前会话 user 消息数量（工具卡片轮次标签 turnNo = 会话内第几条 user 消息） */
  const userCountRef = useRef(0);

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

  // 读取通知开关设置
  useEffect(() => {
    try {
      if (localStorage.getItem("wb-notify") === "1") setNotifyOn(true);
    } catch {
      /* 忽略 */
    }
  }, []);

  // 读取持久化的侧栏宽度（本地保存，不跟随他人 clone 的默认值）
  useEffect(() => {
    try {
      const l = Number(localStorage.getItem("prysm-sidebar-left"));
      const m = Number(localStorage.getItem("prysm-sidebar-mid"));
      if (Number.isFinite(l) && l >= 160 && l <= 380) {
        leftWRef.current = l;
        setLeftW(l);
      }
      // 中间聊天区可拖 480-960；右侧栏自动补齐剩余空间
      if (Number.isFinite(m) && m >= 480 && m <= 960) {
        midWRef.current = m;
        setMidW(m);
      }
    } catch {
      /* 忽略 */
    }
  }, []);

  // 视口缩小时收缩中间聊天区，避免把右栏挤出可读范围
  useEffect(() => {
    const onResize = () => {
      const maxMid = Math.max(
        480,
        window.innerWidth - leftWRef.current - 200 - 16 * 2 - 40,
      );
      if (midWRef.current > maxMid) {
        midWRef.current = maxMid;
        setMidW(maxMid);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** 侧栏拖拽调宽：左栏 / 中间聊天区拖动向右增宽；右栏自动补齐剩余（宽度范围持久化） */
  const startResize = useCallback((which: "left" | "mid") => (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = which === "left" ? leftWRef.current : midWRef.current;
    const min = which === "left" ? 160 : 480;
    // 中间区上限 960，同时保证右栏至少 200px（视口内可用空间）
    const max =
      which === "left"
        ? 380
        : Math.max(min, Math.min(960, window.innerWidth - leftWRef.current - 200 - 16 * 2 - 40));
    document.body.classList.add("resizing");
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const w = Math.min(Math.max(startW + delta, min), max);
      if (which === "left") {
        leftWRef.current = w;
        setLeftW(w);
      } else {
        midWRef.current = w;
        setMidW(w);
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
      try {
        localStorage.setItem("prysm-sidebar-left", String(leftWRef.current));
        localStorage.setItem("prysm-sidebar-mid", String(midWRef.current));
      } catch {
        /* 隐私模式忽略 */
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  /** 切换通知开关（首次开启时请求浏览器授权） */
  const toggleNotify = useCallback(async () => {
    if (!("Notification" in window)) {
      setError("当前浏览器不支持通知");
      return;
    }
    if (!notifyOn && Notification.permission === "default") {
      const p = await Notification.requestPermission();
      if (p !== "granted") {
        setError("通知权限未授予");
        return;
      }
    }
    setNotifyOn((v) => {
      const next = !v;
      try {
        localStorage.setItem("wb-notify", next ? "1" : "0");
      } catch {
        /* 忽略 */
      }
      return next;
    });
  }, [notifyOn]);

  /** 任务完成时发送浏览器通知（页面不在前台且已授权） */
  const notifyCompletion = useCallback(
    (sessionTitle: string) => {
      if (!notifyOn) return;
      try {
        if (document.visibilityState === "visible") return;
        if (!("Notification" in window) || Notification.permission !== "granted") return;
        new Notification("Prysm 任务完成", {
          body: sessionTitle || "未命名会话",
          tag: "wb-task-done",
        });
      } catch {
        /* 通知失败静默 */
      }
    },
    [notifyOn],
  );

  /** 待审批请求出现时通知（页面不在前台且已授权；随任务完成开关启用） */
  const notifyApproval = useCallback(
    (toolLabel: string) => {
      if (!notifyOn) return;
      try {
        if (document.visibilityState === "visible") return;
        if (!("Notification" in window) || Notification.permission !== "granted") return;
        new Notification("Prysm 需要审批", {
          body: `等待确认：${toolLabel}`,
          tag: "wb-approval",
        });
      } catch {
        /* 通知失败静默 */
      }
    },
    [notifyOn],
  );

  /** 短暂信息提示（6 秒后自动消失），供策略拦截等通知使用 */
  const showNotice = useCallback((msg: string) => {
    setInfo(msg);
    window.setTimeout(() => setInfo((v) => (v === msg ? null : v)), 6000);
  }, []);

  /** 把审批结果沉淀到对应工具卡片（供对话流追溯） */
  const applyApprovalToCard = useCallback(
    (id: string, action: ToolApproval["action"], reason?: string) => {
      setCards((c) =>
        c.map((card) =>
          card.id === id ? { ...card, approval: { action, reason } } : card,
        ),
      );
    },
    [],
  );

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

  // 加载会话列表，并选中最近且属于当前形态的会话
  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then(async (data) => {
        const list = (data?.sessions ?? []) as SessionInfo[];
        setSessions(list);
        const first = list.find((s) => (s.surface ?? "coding") === surface);
        if (first) {
          setSessionId(first.id);
          // 初始加载同样恢复该会话已完成的工具卡片（持久化回顾）
          setCards(loadToolCards(first.id));
          const res = await fetch(`/api/sessions/${first.id}`);
          const detail = await res.json();
          if (detail?.messages) setMessages(detail.messages);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 切换到指定会话 */
  const switchSession = useCallback(
    async (id: string) => {
      if (busy) return;
      setSessionId(id);
      // 恢复该会话已完成的工具卡片（localStorage 持久化，供切会话/刷新后回顾）
      setCards(loadToolCards(id));
      setTodos([]);
      setApprovals([]);
      setPlans([]);
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

  /** 当前形态可见的会话（一个会话只属于一个 surface） */
  const visibleSessions = useMemo(
    () => sessions.filter((s) => (s.surface ?? "coding") === surface),
    [sessions, surface],
  );

  /** 切换形态：过滤会话列表，并把当前会话切到新形态下最近的一个；Work 默认收起右侧面板 */
  const changeSurface = useCallback(
    (next: "work" | "coding") => {
      setSurface(next);
      setPanelCollapsed(next === "work"); // Work 专注对话（收起工具面板），Coding 展开
      const cur = sessions.find((s) => s.id === sessionId);
      if (cur && (cur.surface ?? "coding") !== next) {
        const first = sessions.find((s) => (s.surface ?? "coding") === next);
        if (first) {
          switchSession(first.id);
        } else {
          setSessionId(null);
          setMessages([]);
          setCards([]);
          setTodos([]);
          setApprovals([]);
          setPlans([]);
          setError(null);
        }
      }
    },
    [sessions, sessionId, switchSession],
  );

  /** 删除会话 */
  const removeSession = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/sessions/${id}`, { method: "DELETE" });
        clearToolCards(id);
        const rest = sessions.filter((s) => s.id !== id);
        setSessions(rest);
        if (id === sessionId) {
          setCards([]);
          setTodos([]);
          setApprovals([]);
          setPlans([]);
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

  /** 拉取情景记忆列表（展开时或发送后刷新） */
  const refreshMemory = useCallback(async () => {
    try {
      const r = await fetch("/api/memory?limit=50");
      const data = await r.json();
      if (Array.isArray(data?.episodes)) {
        setMemoryEpisodes(data.episodes);
        setMemoryTotal(Number(data.total ?? data.episodes.length));
      }
    } catch {
      /* 静默 */
    }
  }, []);

  /** 拉取最近运行日志 */
  const refreshRunLogs = useCallback(async () => {
    try {
      const r = await fetch("/api/agent/logs");
      const data = await r.json();
      if (Array.isArray(data?.logs)) setRunLogs(data.logs);
    } catch {
      /* 静默 */
    }
  }, []);

  /** 拉取最近审批历史（支持按工具/动作筛选与分页） */
  const refreshAudits = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (auditTool) params.set("tool", auditTool);
      if (auditAction) params.set("action", auditAction);
      if (auditOffset > 0) params.set("offset", String(auditOffset));
      const r = await fetch(`/api/audit?${params}`);
      const data = await r.json();
      if (Array.isArray(data?.approvals)) {
        setAudits(data.approvals);
        setAuditTotal(Number(data.total ?? data.approvals.length));
      }
    } catch {
      /* 静默 */
    }
  }, [auditTool, auditAction, auditOffset]);

  /** 清空审批历史 */
  const clearAudits = useCallback(async () => {
    try {
      const r = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });
      const data = await r.json();
      if (data?.ok) {
        setAudits([]);
        setAuditTotal(0);
      }
    } catch {
      setError("清空审批历史失败");
    }
  }, []);

  /** 拉取运行统计概览 */
  const refreshStats = useCallback(async () => {
    try {
      const r = await fetch("/api/stats");
      const data = await r.json();
      if (data?.stats) setStats(data.stats);
    } catch {
      /* 静默 */
    }
  }, []);

  /** 拉取会话上下文构成分析 */
  const refreshContext = useCallback(async () => {
    if (!sessionId) return;
    try {
      const r = await fetch(`/api/context/${sessionId}`);
      const data = await r.json();
      if (Array.isArray(data?.categories)) setContextAnalysis(data);
    } catch {
      /* 静默 */
    }
  }, [sessionId]);

  /** 拉取观测+评估聚合（运行记录 + 评分汇总） */
  const refreshInsights = useCallback(async () => {
    try {
      const r = await fetch("/api/insights");
      const data = await r.json();
      if (Array.isArray(data?.runs) && data?.summary) setInsights(data);
    } catch {
      /* 静默 */
    }
  }, []);

  /** 拉取模型路由目录（输入框模型选择器数据） */
  const refreshModelRoutes = useCallback(async () => {
    try {
      const r = await fetch("/api/model-routes");
      const data = await r.json();
      if (data?.routes && Array.isArray(data?.providers)) {
        setModelRoutes(data);
      }
    } catch {
      /* 静默 */
    }
  }, []);

  /** 切换主 Agent（orchestrator）模型：PUT /api/model-routes 后本地更新 */
  const switchModel = useCallback(
    async (provider: string, model: string) => {
      try {
        await fetch("/api/model-routes", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "orchestrator", provider, model }),
        });
        setModelRoutes((cur) =>
          cur
            ? {
                ...cur,
                routes: { ...cur.routes, orchestrator: { provider, model } },
              }
            : cur,
        );
      } catch {
        /* 静默 */
      }
    },
    [],
  );

  // 挂载时加载模型路由目录
  useEffect(() => {
    void refreshModelRoutes();
  }, [refreshModelRoutes]);

  /** 删除单条情景记忆 */
  const removeMemory = useCallback(
    async (id: number) => {
      try {
        const r = await fetch(`/api/memory?id=${id}`, { method: "DELETE" });
        const data = await r.json();
        if (data?.total !== undefined) setMemoryTotal(data.total);
        setMemoryEpisodes((list) => list.filter((e) => e.id !== id));
      } catch {
        setError("删除记忆失败");
      }
    },
    [],
  );

  /** 清空全部情景记忆 */
  const clearAllMemory = useCallback(async () => {
    if (memoryTotal === 0) return;
    try {
      const r = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });
      const data = await r.json();
      if (data?.ok) {
        setMemoryEpisodes([]);
        setMemoryTotal(0);
      }
    } catch {
      setError("清空记忆失败");
    }
  }, [memoryTotal]);

  /** 清空运行日志 */
  const clearRunLogs = useCallback(async () => {
    try {
      await fetch("/api/agent/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });
      setRunLogs([]);
    } catch {
      setError("清空日志失败");
    }
  }, []);

  /** 加载工作区某目录的条目（缓存到 wbDirs） */
  const loadDir = useCallback(async (dir: string) => {
    try {
      const r = await fetch(`/api/workdir?path=${encodeURIComponent(dir)}`);
      const data = await r.json();
      if (Array.isArray(data?.entries)) {
        setWbDirs((prev) => ({ ...prev, [dir]: data.entries }));
      }
    } catch {
      /* 静默 */
    }
  }, []);

  /** 展开 / 收起目录（展开时懒加载） */
  const toggleDir = useCallback(
    (dir: string) => {
      setWbExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dir)) {
          next.delete(dir);
        } else {
          next.add(dir);
          if (!wbDirs[dir]) loadDir(dir);
        }
        return next;
      });
    },
    [wbDirs, loadDir],
  );

  /** 预览文件内容 */
  const openFile = useCallback(async (path: string) => {
    try {
      const r = await fetch(`/api/workdir/content?path=${encodeURIComponent(path)}`);
      const data = await r.json();
      if (data?.ok) {
        setWbPreview({ path, content: data.content, truncated: data.truncated });
      } else {
        setError(data?.error ?? "读取文件失败");
      }
    } catch {
      setError("读取文件失败");
    }
  }, []);

  /** 新建文件 / 目录 */
  const createWorkdirEntry = useCallback(async () => {
    const name = wbCreateName.trim();
    if (!name) return;
    setWbCreateOpen(false);
    setWbCreateName("");
    try {
      const r = await fetch("/api/workdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: name, type: wbCreateType, content: "" }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        throw new Error(data?.error ?? "创建失败");
      }
      setInfo(`已创建${wbCreateType === "dir" ? "目录" : "文件"}: ${name}`);
      setWbDirs({});
      loadDir("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [wbCreateName, wbCreateType, loadDir]);

  /** 上传文件到工作区根目录 */
  const uploadWorkdirFile = useCallback(
    async (file: File) => {
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("dir", "");
        const r = await fetch("/api/workdir", { method: "POST", body: form });
        const data = await r.json();
        if (!r.ok || !data.ok) {
          throw new Error(data?.error ?? "上传失败");
        }
        setInfo(`已上传: ${data.path}（${data.bytes} 字节）`);
        setWbDirs({});
        loadDir("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [loadDir],
  );

  /** 消息多选批量删除 */
  const batchDeleteMessages = useCallback(async () => {
    if (msgSelected.size === 0 || !sessionId) return;
    const indices = [...msgSelected].sort((a, b) => a - b);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/messages`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ indices }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "删除失败");
      }
      setMessages((m) => m.filter((_, i) => !msgSelected.has(i)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setMsgSelectMode(false);
    setMsgSelected(new Set());
  }, [msgSelected, sessionId]);

  // 初始拉取情景记忆数量
  useEffect(() => {
    refreshMemory();
  }, [refreshMemory]);
  // 初始拉取运行日志
  useEffect(() => {
    refreshRunLogs();
  }, [refreshRunLogs]);
  // 初始拉取审批历史
  useEffect(() => {
    refreshAudits();
  }, [refreshAudits]);
  // 挂载时恢复未决审批（刷新页面后仍有剩余时间的审批请求继续展示）
  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent/pending")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data?.approvals)) return;
        const now = Number(data.now ?? Date.now());
        const cards = (data.approvals as ApprovalCard[])
          .filter((a) => a.expiresAt && a.expiresAt > now)
          .map((a) => ({ ...a, deciding: false }));
        if (cards.length > 0) setApprovals(cards);
      })
      .catch(() => {
        /* 静默：无 pending 或接口不可用 */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // 审批倒计时：存在待审批卡片时每秒刷新，并兜底清理已过期的卡片
  useEffect(() => {
    if (approvals.length === 0) return;
    const t = setInterval(() => {
      const now = Date.now();
      setApprovals((a) => a.filter((x) => !x.expiresAt || x.expiresAt > now));
      setCountdownTick((n) => n + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [approvals.length]);
  // 初始拉取运行统计
  useEffect(() => {
    refreshStats();
  }, [refreshStats]);
  // 初始加载工作区根目录
  useEffect(() => {
    loadDir("");
  }, [loadDir]);

  /** 导出全部数据备份（下载 JSON） */
  const exportBackup = useCallback(async () => {
    try {
      const r = await fetch("/api/backup");
      if (!r.ok) throw new Error("备份导出失败");
      const blob = await r.blob();
      const a = document.createElement("a");
      const date = new Date();
      const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
      a.href = URL.createObjectURL(blob);
      a.download = `prysm-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /** 从备份 JSON 文件恢复（清空重建） */
  const restoreBackup = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const r = await fetch("/api/backup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const res = await r.json();
        if (!r.ok || !res.ok) {
          throw new Error(res.error ?? "恢复失败");
        }
        setError(null);
        setInfo(
          `恢复完成：${res.sessions} 个会话、${res.messages} 条消息、${res.memory} 条记忆、${res.todos} 个任务`,
        );
        // 恢复后刷新会话与记忆
        const sessionsRes = await fetch("/api/sessions");
        const sessionsData = await sessionsRes.json();
        const list = (sessionsData?.sessions ?? []) as SessionInfo[];
        setSessions(list);
        if (list.length > 0) await switchSession(list[0].id);
        else {
          setSessionId(null);
          setMessages([]);
        }
        refreshMemory();
      } catch (err) {
        setError(err instanceof Error ? `恢复失败: ${err.message}` : String(err));
      }
    },
    [switchSession, refreshMemory],
  );

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
          setPlans([]);
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

  // 同步当前会话 user 消息数量（工具卡片轮次标签 turnNo 的基准）
  useEffect(() => {
    userCountRef.current = messages.filter((m) => m.role === "user").length;
  }, [messages]);

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
   * @param text             用户消息内容
   * @param rewindToText     重新生成时回退到该用户消息（后端按文本截断历史）
   * @param appendUser       是否追加 user 消息（重新生成时历史已含该消息，跳过）
   * @param overrideSessionId 显式指定会话（模板新建会话后避免闭包中旧 sessionId 造成重复建会话）
   */
  const streamReply = useCallback(
    async (
      text: string,
      rewindToText?: string,
      appendUser = true,
      overrideSessionId?: string | null,
      images?: { data: string; mimeType: string }[],
    ) => {
      const t = text.trim();
      if (!t || busyRef.current) return;
      if (appendUser) userCountRef.current += 1;
      const turnNo = userCountRef.current;
      setError(null);
      // 恢复该会话已完成的工具卡片回顾；本轮的实时卡片随后由 tool_start/tool_end 追加
      // 注意：新会话时 sessionId 由服务端 session 事件确认，此处先以 override/sessionId 兜底
      let activeSessionId = overrideSessionId ?? sessionId;
      setCards(loadToolCards(activeSessionId));
      setTodos([]);
      setApprovals([]);
      setPlans([]);
      setRunUsage(null);
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
          body: JSON.stringify({
            message: t,
            sessionId: overrideSessionId === undefined ? sessionId : overrideSessionId,
            rewindToText,
            approvalMode,
            ...(images && images.length > 0 ? { images } : {}),
          }),
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
                const sid = ev.sessionId;
                activeSessionId = sid;
                setSessionId(sid);
                setSessions((list) => {
                  const exists = list.some((s) => s.id === sid);
                  return exists
                    ? list
                    : [
                        {
                          id: sid,
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
            case "tool_start": {
              const id = ev.id;
              const toolName = ev.toolName;
              if (!id || !toolName) break;
              // 同一 toolCallId 去重：模型流式输出偶发重复 id 时避免重复卡片（React key 冲突）
              setCards((c) =>
                c.some((card) => card.id === id)
                  ? c
                  : [
                      ...c,
                      {
                        id,
                        toolName,
                        args: ev.args,
                        status: "running",
                        startedAt: Date.now(),
                        turnNo,
                      },
                    ],
              );
              break;
            }
            case "tool_end":
              setCards((c) => {
                const next: ToolCard[] = c.map((card) => {
                  if (card.id !== ev.id) return card;
                  return {
                    ...card,
                    status: ev.isError ? "error" : "done",
                    result: ev.result,
                    elapsedMs:
                      Date.now() - (card.startedAt ?? Date.now()),
                  };
                });
                // 持久化已完成卡片：切会话/刷新/新任务后仍可回顾
                saveToolCards(activeSessionId, next);
                return next;
              });
              if (ev.todos) setTodos(ev.todos);
              break;
            case "turn_end": {
              setRunUsage((prev) => addUsage(prev, ev.usage));
              break;
            }
            case "approval_required": {
              const id = ev.id;
              const toolName = ev.toolName;
              if (!id || !toolName) break;
              setApprovals((a) => [
                ...a,
                {
                  id,
                  toolName,
                  args: ev.args,
                  risk: ev.risk,
                  riskReason: ev.riskReason,
                  createdAt: Date.now(),
                  expiresAt: ev.expiresAt,
                },
              ]);
              notifyApproval(TOOL_META[toolName]?.label ?? toolName);
              break;
            }
            case "approval_resolved":
            case "approval_expired": {
              if (!ev.id) break;
              setApprovals((a) => a.filter((item) => item.id !== ev.id));
              const action: ToolApproval["action"] =
                ev.type === "approval_expired"
                  ? "timeout"
                  : ev.approve
                    ? "approved"
                    : "denied";
              applyApprovalToCard(ev.id, action);
              if (ev.type === "approval_expired") {
                showNotice("审批已超时，该操作已被拒绝");
              }
              refreshAudits();
              break;
            }
            case "policy_notice": {
              if (ev.id) applyApprovalToCard(ev.id, "denied_auto", ev.reason);
              const label = TOOL_META[ev.toolName ?? ""]?.label ?? ev.toolName ?? "";
              showNotice(`${label} 已被策略拦截：${ev.reason ?? "命中禁止规则"}`);
              break;
            }
            case "plan_proposed": {
              const id = ev.id;
              if (!id) break;
              setPlans((p) => [
                ...p,
                {
                  id,
                  surface: ev.surface,
                  summary: ev.summary,
                  steps: ev.steps ?? [],
                  createdAt: Date.now(),
                  expiresAt: ev.expiresAt,
                },
              ]);
              break;
            }
            case "plan_decided":
            case "plan_cancelled": {
              if (!ev.id) break;
              setPlans((p) =>
                p.map((item) =>
                  item.id === ev.id
                    ? {
                        ...item,
                        deciding: false,
                        ...(ev.type === "plan_cancelled"
                          ? { cancelled: true }
                          : { decided: ev.approve }),
                      }
                    : item,
                ),
              );
              break;
            }
            case "stopped":
              setError(ev.message ?? "任务已停止");
              break;
            case "error":
              setError(ev.message ?? "发生错误");
              break;
            case "done": {
              const s = sessions.find((x) => x.id === sessionId);
              notifyCompletion(s?.title ?? "");
              refreshAudits();
              break;
            }
          }
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        busyRef.current = false;
        refreshSessions();
        refreshMemory();
        refreshRunLogs();
        refreshStats();
      }
    },
    [sessionId, refreshSessions, refreshMemory, refreshRunLogs, refreshAudits, refreshStats, sessions, notifyCompletion, notifyApproval, showNotice, applyApprovalToCard, approvalMode],
  );

  /** 新建会话（携带当前 surface 形态；preset 可选：创建后立即以该提示词发起任务） */
  const newSession = useCallback(
    async (preset?: string, workdir?: string) => {
      if (busy) return;
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ surface, workdir }),
        });
        const data = await res.json();
        const s = data?.session as SessionInfo | undefined;
        if (s) {
          setSessions((list) => [s, ...list]);
          setSessionId(s.id);
          setMessages([]);
          setCards([]);
          setTodos([]);
          setApprovals([]);
          setPlans([]);
          setError(null);
          if (preset) {
            // 显式传入新会话 id，避免闭包中的旧 sessionId 触发后端另建会话
            await streamReply(preset, undefined, true, s.id);
          }
        }
      } catch {
        setError("新建会话失败");
      }
    },
    [busy, surface, streamReply],
  );

  /** 打开目录选择器（coding 新建会话时选择绑定目录） */
  const openDirPicker = useCallback(async () => {
    try {
      const r = await fetch("/api/workspaces");
      const data = await r.json();
      if (Array.isArray(data?.workspaces)) setDirPickerRoots(data.workspaces);
    } catch {
      /* 静默 */
    }
    setDirPickerValue("");
    setDirPickerOpen(true);
  }, []);

  /** 确认目录选择：以绑定目录创建 coding 会话（未输入则用默认工作区） */
  const confirmDirPicker = useCallback(async () => {
    const dir = dirPickerValue.trim();
    setDirPickerOpen(false);
    await newSession(undefined, dir || undefined);
  }, [dirPickerValue, newSession]);

  /** 会话列表新建按钮：coding 时先选目录，work 直接新建 */
  const handleNewSession = useCallback(() => {
    if (surface === "coding") void openDirPicker();
    else void newSession();
  }, [surface, openDirPicker, newSession]);

  /** 设置面板"运行技能"：新建会话并预设技能调用提示词（use_skill 按需加载） */
  const handleRunSkill = useCallback(
    (skill: { name: string }) => {
      void newSession(
        `请使用技能「${skill.name}」完成任务。请先调用 use_skill 工具加载该技能，再按其说明执行。`,
      );
    },
    [newSession],
  );

  /** 自动化面板"在对话中创建"：切回会话视图，预填创建提示并聚焦输入框（AI 经 create_automation 工具完成创建） */
  const handleCreateAutomationInChat = useCallback(() => {
    setActivityView("sessions");
    setInput("我想要创建一个定时任务。\n任务内容是：\n执行时间是：");
    setTimeout(() => chatInputRef.current?.focus(), 60);
  }, []);

  /** 自动化执行历史跳转：先切到该任务运行形态，再选中对应会话 */
  const handleJumpAutomationSession = useCallback(
    (sessionId: string, targetSurface?: "work" | "coding") => {
      if (targetSurface && targetSurface !== surface) changeSurface(targetSurface);
      void switchSession(sessionId);
    },
    [changeSurface, switchSession, surface],
  );

  /** 发送输入框内容（编辑态时截断并替换目标消息后重发） */
  const send = useCallback(async () => {
    let text = input.trim();
    if (!text) return;
    setInput("");
    // 发送后重置输入框高度为单行
    const ta = document.querySelector<HTMLTextAreaElement>(".chat-input");
    if (ta) ta.style.height = "auto";
    // 斜杠命令：/new /clear /export /theme /skill /help
    if (text.startsWith("/")) {
      const cmd = text.split(/\s+/)[0].toLowerCase();
      switch (cmd) {
        case "/new":
          await newSession();
          return;
        case "/clear":
          if (sessionId) await clearSession(sessionId);
          return;
        case "/export":
          if (sessionId) exportSession(sessionId, "md");
          return;
        case "/theme":
          toggleTheme();
          return;
        case "/skill": {
          const rest = text.slice("/skill".length).trim();
          const name = rest.split(/\s+/)[0] ?? "";
          const task = rest.slice(name.length).trim();
          if (!name) {
            setInfo("用法：/skill <技能名> [任务描述]");
            return;
          }
          text = `请使用技能「${name}」完成任务${task ? `：${task}` : ""}。请先调用 use_skill 工具加载该技能，再按其说明执行。`;
          break; // 改写后落到普通消息发送流程
        }
        case "/help":
          setInfo("命令：/new 新建 · /clear 清空 · /export 导出 · /theme 主题 · /skill 技能 · /help 帮助");
          return;
        default:
          break; // 非命令则按普通消息发送
      }
    }
    // 提取并清空待发送的图片附件（多模态）
    const images = pendingImages.map((img) => ({
      data: img.dataUrl.split(",")[1] ?? "",
      mimeType: img.mimeType,
    }));
    setPendingImages([]);
    if (editingIndex >= 0 && messages[editingIndex]?.role === "user") {
      const idx = editingIndex;
      setEditingIndex(-1);
      // 截断到该条用户消息并替换为编辑后的内容，后端按 rewindToText 同步截断历史
      setMessages((m) => m.slice(0, idx).concat([{ role: "user", text }]));
      await streamReply(text, text, false, undefined, images);
      return;
    }
    await streamReply(text, undefined, true, undefined, images);
  }, [
    input,
    streamReply,
    editingIndex,
    messages,
    newSession,
    sessionId,
    clearSession,
    exportSession,
    toggleTheme,
    pendingImages,
  ]);

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

  /** 复制单条消息：plain=true 复制纯文本（去 Markdown 语法），否则复制 Markdown 原文 */
  const copyMessage = useCallback(
    async (
      text: string,
      e: ReactMouseEvent<HTMLButtonElement>,
      plain = false,
    ) => {
      if (!text) return;
      const content = plain ? mdToPlainText(text) : text;
      if (!content) return;
      let ok = false;
      try {
        await navigator.clipboard.writeText(content);
        ok = true;
      } catch {
        // 剪贴板 API 不可用时回退到 execCommand
        try {
          const ta = document.createElement("textarea");
          ta.value = content;
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
      const original = btn.textContent ?? "复制";
      btn.textContent = "已复制";
      btn.classList.add("msg-action-copied");
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("msg-action-copied");
      }, 1200);
    },
    [],
  );

  /** 删除单条消息（同步会话存储与 Agent 历史） */
  const deleteMessage = useCallback(
    async (index: number) => {
      if (busyRef.current) return;
      const target = messages[index];
      if (!target) return;
      setMessages((m) => m.filter((_, i) => i !== index));
      if (editingIndex === index) setEditingIndex(-1);
      try {
        const res = await fetch(`/api/sessions/${sessionId}/messages`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ index }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error ?? "删除消息失败");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [messages, sessionId, editingIndex],
  );

  /** 人工评分：点击 👍/👎 切换（再次点击已选项则取消本地态），落库到 /api/insights/score */
  const rateMessage = useCallback(
    async (index: number, label: "good" | "bad") => {
      if (!sessionId) return;
      const current = ratings[index];
      const nextLabel = current === label ? undefined : label;
      setRatings((prev) => {
        const next = { ...prev };
        if (nextLabel) next[index] = nextLabel;
        else delete next[index];
        return next;
      });
      if (!nextLabel) return;
      try {
        const res = await fetch("/api/insights/score", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, label: nextLabel }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error ?? "评分失败");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId, ratings],
  );

  /** 提交可选评语（需先评分；关联同一 label 再次落库一条含 comment 的记录） */
  const submitRatingComment = useCallback(
    async (index: number) => {
      const label = ratings[index];
      const comment = ratingComments[index]?.trim();
      if (!sessionId || !label || !comment) return;
      try {
        const res = await fetch("/api/insights/score", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, label, comment }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error ?? "评语保存失败");
        }
        setRatingComments((prev) => ({ ...prev, [index]: "" }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId, ratings, ratingComments],
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

  /** 用户对某个审批请求作出决定：先标记 deciding（按钮 loading），成功后移除卡片 */
  const decideApproval = useCallback(
    async (id: string, approve: boolean) => {
      setApprovals((a) =>
        a.map((item) => (item.id === id ? { ...item, deciding: true } : item)),
      );
      try {
        const res = await fetch("/api/agent/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, approve }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setError(data?.error ?? "审批请求失败");
          // 失败时恢复按钮可点
          setApprovals((a) =>
            a.map((item) =>
              item.id === id ? { ...item, deciding: false } : item,
            ),
          );
        } else {
          setApprovals((a) => a.filter((item) => item.id !== id));
          refreshAudits();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setApprovals((a) =>
          a.map((item) => (item.id === id ? { ...item, deciding: false } : item)),
        );
      }
    },
    [refreshAudits],
  );

  /** 批量决定（并行工具调用产生多个待审批请求时一键处理） */
  const batchDecideApprovals = useCallback(
    (approve: boolean) => {
      const ids = approvals.map((a) => a.id);
      ids.forEach((id) => decideApproval(id, approve));
    },
    [approvals, decideApproval],
  );

  /** 决定计划（Phase 7）：批准执行 / 拒绝 */
  const decidePlan = useCallback(async (id: string, approve: boolean) => {
    setPlans((p) =>
      p.map((item) => (item.id === id ? { ...item, deciding: true } : item)),
    );
    try {
      const res = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: approve ? "approve" : "reject" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "计划决定失败");
        // 失败时恢复按钮可点
        setPlans((p) =>
          p.map((item) =>
            item.id === id ? { ...item, deciding: false } : item,
          ),
        );
      } else {
        // 后端会通过 plan_decided/plan_cancelled 同步状态；这里先本地标记结果
        setPlans((p) =>
          p.map((item) =>
            item.id === id ? { ...item, deciding: false, decided: approve } : item,
          ),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPlans((p) =>
        p.map((item) =>
          item.id === id ? { ...item, deciding: false } : item,
        ),
      );
    }
  }, []);

  /** 审批模式持久化到 localStorage */
  useEffect(() => {
    try {
      localStorage.setItem("prysm.approvalMode", approvalMode);
    } catch {
      /* 忽略 */
    }
  }, [approvalMode]);

  /** 挂载后读取上次保存的审批模式（仅在客户端执行，避免水合不一致；兼容历史 dangerous） */
  useEffect(() => {
    try {
      const saved = localStorage.getItem("prysm.approvalMode");
      const legacy = saved === "dangerous" ? "full" : saved;
      if (legacy === "auto" || legacy === "manual" || legacy === "full" || legacy === "custom") {
        setApprovalMode(legacy);
      }
    } catch {
      /* 忽略 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 完全访问模式：审批请求/计划提案到达即批准（auto 由服务端 LLM Guardian 决策，前端不再代批） */
  useEffect(() => {
    if (approvalMode !== "full") return;
    approvals.forEach((item) => {
      if (!item.deciding) void decideApproval(item.id, true);
    });
  }, [approvalMode, approvals, decideApproval]);

  /** 自动/完全访问：计划提案到达即批准执行 */
  useEffect(() => {
    if (approvalMode !== "auto" && approvalMode !== "full") return;
    plans.forEach((p) => {
      if (!p.deciding && typeof p.decided !== "boolean" && !p.cancelled) {
        void decidePlan(p.id, true);
      }
    });
  }, [approvalMode, plans, decidePlan]);

  /** 读取图片文件并加入待发送附件（校验 MIME 与大小，上限 10MB） */
  const addImageFiles = useCallback((files: File[] | FileList) => {
    const ALLOWED = new Set([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/svg+xml",
    ]);
    const MAX = 10 * 1024 * 1024;
    Array.from(files).forEach((file) => {
      if (!ALLOWED.has(file.type)) {
        setError(`不支持的图片类型：${file.name}（仅 png/jpeg/gif/webp/svg）`);
        return;
      }
      if (file.size > MAX) {
        setError(`图片过大：${file.name}（上限 10MB）`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        setPendingImages((list) => [
          ...list,
          {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            dataUrl,
            mimeType: file.type,
            name: file.name,
          },
        ]);
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const removePendingImage = useCallback((id: string) => {
    setPendingImages((list) => list.filter((img) => img.id !== id));
  }, []);

  /** 粘贴图片到输入框（多模态附件） */
  const handlePaste = useCallback(
    (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const files = items
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length > 0) {
        e.preventDefault();
        addImageFiles(files);
      }
    },
    [addImageFiles],
  );

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

  /** 折叠/展开某轮的工具卡片组 */
  const toggleGroup = useCallback((turnNo: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(turnNo)) next.delete(turnNo);
      else next.add(turnNo);
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
      setPlans([]);
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
      setTodos(
        ids.flatMap((id) => {
          const t = map.get(id);
          return t ? [t] : [];
        }),
      );
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

  /** 展开 / 收起超长消息 */
  const toggleLong = useCallback((i: number) => {
    setLongOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  // 全局快捷键：Ctrl/Cmd+N 新建会话、Ctrl/Cmd+K 聚焦会话搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        handleNewSession();
      } else if (k === "k") {
        e.preventDefault();
        sessionSearchRef.current?.focus();
        sessionSearchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNewSession]);

  /** 渲染工作区目录树（递归，懒加载；缩进与分支线由 .wb-children 提供） */
  const renderWbTree = (dir: string): React.ReactNode => {
    const entries = wbDirs[dir] ?? [];
    return entries.map((e) => {
      const childPath = dir ? `${dir}/${e.name}` : e.name;
      const active = wbPreview?.path === childPath;
      if (e.isDir) {
        const open = wbExpanded.has(childPath);
        return (
          <div key={childPath} className="wb-row">
            <button
              type="button"
              className={`wb-node${active ? " wb-node-active" : ""}`}
              onClick={() => toggleDir(childPath)}
            >
              <span
                className={`wb-arrow${open ? " wb-arrow-open" : ""}`}
                aria-hidden="true"
              >
                <WbChevron />
              </span>
              <span className="wb-icon wb-icon-folder" aria-hidden="true">
                <WbFolderIcon />
              </span>
              <span className="wb-name">{e.name}</span>
            </button>
            {open && <div className="wb-children">{renderWbTree(childPath)}</div>}
          </div>
        );
      }
      return (
        <div key={childPath} className="wb-row">
          <button
            type="button"
            className={`wb-node${active ? " wb-node-active" : ""}`}
            onClick={() => openFile(childPath)}
            title={e.size > 0 ? `${e.size} 字节` : "空文件"}
          >
            <span className="wb-arrow wb-arrow-empty" aria-hidden="true" />
            <span className="wb-icon wb-icon-file" aria-hidden="true">
              <WbFileIcon />
            </span>
            <span className="wb-name">{e.name}</span>
          </button>
        </div>
      );
    });
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-dot">
            <PrismIcon size={16} />
          </span>
          <h1>Prysm</h1>
        </div>
        <div className="surface-switch">
          <button
            className={`surface-tab ${surface === "work" ? "surface-tab-active" : ""}`}
            onClick={() => changeSurface("work")}
          >
            Work
          </button>
          <button
            className={`surface-tab ${surface === "coding" ? "surface-tab-active" : ""}`}
            onClick={() => changeSurface("coding")}
          >
            Coding
          </button>
        </div>
        <button
          className={`panel-toggle ${panelCollapsed ? "panel-collapsed" : ""}`}
          onClick={() => setPanelCollapsed((c) => !c)}
          title={panelCollapsed ? "展开右侧面板" : "收起右侧面板"}
          aria-label="切换右侧面板"
        >
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
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
          </svg>
        </button>
        <button
          className={`notify-toggle ${notifyOn ? "notify-on" : ""}`}
          onClick={toggleNotify}
          title={notifyOn ? "关闭任务完成通知" : "开启任务完成通知"}
          aria-label="切换完成通知"
        >
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
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
        </button>
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

      <main
        className={`app-main ${panelCollapsed ? "panel-hidden" : ""}`}
        style={
          {
            "--left-w": `${leftW}px`,
            "--mid-w": `${midW}px`,
          } as React.CSSProperties
        }
      >
        {/* Activity Bar */}
        <nav className="activity-bar">
          <button
            className={`activity-item ${activityView === "sessions" ? "activity-item-active" : ""}`}
            onClick={() => setActivityView("sessions")}
            title="会话"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            className={`activity-item ${activityView === "files" ? "activity-item-active" : ""}`}
            onClick={() => setActivityView("files")}
            title="文件"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            className={`activity-item ${activityView === "automation" ? "activity-item-active" : ""}`}
            onClick={() => setActivityView("automation")}
            title="自动化"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </button>
          <button
            className={`activity-item ${activityView === "settings" ? "activity-item-active" : ""}`}
            onClick={() => setActivityView("settings")}
            title="设置"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </nav>

        {/* Sidebar — content switches by activityView */}
        <aside className="session-panel">
          {activityView === "sessions" && (
            <>
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
                  onClick={handleNewSession}
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
              ref={sessionSearchRef}
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
            {visibleSessions.length === 0 ? (
              <p className="session-empty">
                {surface === "work"
                  ? "还没有 Work（办公自动化）会话，点击 ＋ 新建"
                  : "还没有 Coding（编码）会话，点击 ＋ 新建"}
              </p>
            ) : (
              (() => {
                const q = sessionQuery.trim().toLowerCase();
                const filtered = q
                  ? visibleSessions.filter((s) =>
                      (s.title || "").toLowerCase().includes(q),
                    )
                  : visibleSessions;
                if (filtered.length === 0) {
                  return <p className="session-empty">没有匹配的会话</p>;
                }
                const groups = GROUP_ORDER.map((key) => ({
                  key,
                  items: filtered.filter(
                    (s) => formatGroupLabel(s.updatedAt) === key,
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
                                      <span className="session-pin-badge" title="已置顶">
                                        <PinIcon size={12} />
                                      </span>
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
                                        {s.pinned === 1 ? <PinOffIcon /> : <PinIcon />}
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
                                        <FileDownIcon />
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
                                        <BracesIcon />
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
                                        <TrashIcon />
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
                                        <PencilIcon />
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
            </>
          )}

          {/* Files view */}
          {activityView === "files" && (
            <>
              <div className="session-head">
                <span className="session-title">文件</span>
                <div className="session-head-actions">
                  <label className="session-new" title="上传文件到工作区">
                    <UploadIcon size={14} />
                    <input
                      type="file"
                      hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadWorkdirFile(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <button
                    className="session-new"
                    onClick={() => setWbCreateOpen(true)}
                    title="新建文件/目录"
                  >
                    ＋
                  </button>
                </div>
              </div>
              <div className="session-scroll">
                <div className="wb-section">
                  {wbCreateOpen && (
                    <div className="wb-create">
                      <input
                        className="wb-create-input"
                        placeholder="名称（如 notes/readme.md）"
                        value={wbCreateName}
                        autoFocus
                        onChange={(e) => setWbCreateName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") createWorkdirEntry();
                          if (e.key === "Escape") {
                            setWbCreateOpen(false);
                            setWbCreateName("");
                          }
                        }}
                      />
                      <div className="wb-create-type">
                        <button
                          type="button"
                          className={`wb-type-btn ${wbCreateType === "file" ? "wb-type-on" : ""}`}
                          onClick={() => setWbCreateType("file")}
                        >
                          文件
                        </button>
                        <button
                          type="button"
                          className={`wb-type-btn ${wbCreateType === "dir" ? "wb-type-on" : ""}`}
                          onClick={() => setWbCreateType("dir")}
                        >
                          目录
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="wb-tree">
                    {wbDirs[""] !== undefined ? (
                      wbDirs[""].length === 0 ? (
                        <p className="wb-empty">（空）</p>
                      ) : (
                        renderWbTree("")
                      )
                    ) : (
                      <p className="wb-empty">加载中…</p>
                    )}
                  </div>
                  {wbPreview && (
                    <div className="wb-preview">
                      <div className="wb-preview-head">
                        <span className="wb-preview-path">{wbPreview.path}</span>
                        <button
                          type="button"
                          className="wb-preview-close"
                          onClick={() => setWbPreview(null)}
                        >
                          ×
                        </button>
                      </div>
                      <pre className="wb-preview-body">
                        {wbPreview.content}
                        {wbPreview.truncated ? "\n…(内容过长，已截断)" : ""}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* 自动化（定时任务）视图 */}
          {activityView === "automation" && (
            <>
              <div className="session-head">
                <span className="session-title">自动化</span>
              </div>
              <div className="session-scroll">
                <AutomationPanel
                  surface={surface}
                  onSurfaceChange={changeSurface}
                  onJumpSession={handleJumpAutomationSession}
                  onCreateInChat={handleCreateAutomationInChat}
                />
              </div>
            </>
          )}

          {/* Settings view */}
          {activityView === "settings" && (
            <>
              <div className="session-head">
                <span className="session-title">设置</span>
              </div>
              <div className="session-scroll">
                <SettingsPanel
                  surface={surface}
                  setSurface={changeSurface}
                  theme={theme}
                  toggleTheme={toggleTheme}
                  notifyOn={notifyOn}
                  toggleNotify={toggleNotify}
                  onExportBackup={exportBackup}
                  onRestoreBackup={restoreBackup}
                  onRunSkill={handleRunSkill}
                  memoryWorkdir={sessions.find((s) => s.id === sessionId)?.workdir}
                />
              </div>
            </>
          )}
        </aside>

        <div
          className="drag-handle drag-left"
          onMouseDown={startResize("left")}
          aria-hidden="true"
        />
        <section className="chat">
          <div
            className="chat-scroll"
            ref={chatScrollRef}
            onScroll={onChatScroll}
          >
            {messages.length > 0 && (
              <div className="msg-toolbar">
                {msgSelectMode ? (
                  <>
                    <span className="msg-toolbar-count">
                      已选 {msgSelected.size} 条
                    </span>
                    <button
                      type="button"
                      className="msg-toolbar-del"
                      disabled={msgSelected.size === 0}
                      onClick={batchDeleteMessages}
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      className="msg-toolbar-cancel"
                      onClick={() => {
                        setMsgSelectMode(false);
                        setMsgSelected(new Set());
                      }}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="msg-toolbar-multi"
                    onClick={() => setMsgSelectMode(true)}
                    title="多选批量删除消息"
                  >
                    多选删除
                  </button>
                )}
              </div>
            )}
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
                {surface === "work" ? (
                  <>
                    <p className="empty-title">选择办公任务模板</p>
                    <p className="empty-sub">
                      点击模板将创建对应任务的会话并立即开始，可自由补充细节
                    </p>
                    <div className="template-grid">
                      {WORK_TEMPLATES.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className="template-card"
                          disabled={busy}
                          onClick={() => newSession(t.prompt)}
                        >
                          <span className="template-icon" aria-hidden="true">
                            {t.icon}
                          </span>
                          <span className="template-body">
                            <strong className="template-title">{t.title}</strong>
                            <span className="template-desc">{t.desc}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
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
                  </>
                )}
              </div>
            )}
            {/* 每条用户消息后内联展示该轮工具调用组（折叠，可展开） */}
            {(() => {
              const indexToTurn = new Map<number, number>();
              messages.forEach((m, i) => {
                if (m.role === "user") indexToTurn.set(i, indexToTurn.size + 1);
              });
              const userCount = indexToTurn.size;
              const cardsByTurn = groupCardsByTurn(cards, userCount);
              return messages.map((m, i) => {
                // 跳过"纯工具调用"的空 assistant 消息：content 仅含 toolCall、无正文，
                // 在历史中不渲染空气泡（其动作已由工具卡片呈现）；仅保留正在流式的最新占位。
                if (
                  m.role === "assistant" &&
                  !m.text &&
                  !(busy && i === messages.length - 1)
                ) {
                  return <Fragment key={i} />;
                }
                const prev = messages[i - 1];
                const next = messages[i + 1];
                // iMessage 气泡分组：连续同角色消息合并，仅组尾显示尾巴与头像
                const groupEnd = !next || next.role !== m.role;
                const groupMid = !!prev && prev.role === m.role && !!next && next.role === m.role;
                const turnNo = indexToTurn.get(i) ?? 0;
              const longMsg = m.text.length > LONG_MSG_THRESHOLD;
              const msgCollapsed = longMsg && !longOpen.has(i);
              const cls = [
                "message",
                `message-${m.role}`,
                groupEnd ? "group-end" : "",
                groupMid ? "group-mid" : "",
                msgSelected.has(i) ? "msg-selected" : "",
              ]
                .filter(Boolean)
                .join(" ");
              const { cleaned: mdText, refs: fileRefs } = extractFileRefs(
                msgCollapsed ? m.text.slice(0, 3000) + "\n\n…" : m.text,
              );
              return (
                <Fragment key={i}>
                  <div
                    className={cls}
                    onClick={(e) => {
                      if (!msgSelectMode) return;
                      const t = e.target as HTMLElement;
                      if (t.closest("button, input, a, pre, code, .md")) return;
                      setMsgSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        return next;
                      });
                    }}
                  >
                  {msgSelectMode && (
                    <span
                      className={`msg-check ${msgSelected.has(i) ? "msg-check-on" : ""}`}
                      aria-hidden="true"
                    />
                  )}
                  <div className="message-role" aria-hidden={!groupEnd}>
                    {m.role === "user" ? (
                      <PersonIcon size={15} />
                    ) : (
                      <SparkleIcon size={15} />
                    )}
                  </div>
                  <div className="message-body">
                    {m.images && m.images.length > 0 && (
                      <div className="msg-images">
                        {m.images.map((img, ii) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            key={ii}
                            className="msg-image"
                            src={`data:${img.mimeType};base64,${img.data}`}
                            alt="消息图片"
                          />
                        ))}
                      </div>
                    )}
                    {m.text ? (
                      <>
                        {fileRefs.length > 0 && (
                          <FileRefCards refs={fileRefs} onOpen={openFile} />
                        )}
                        <div className="md">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeHighlight, rehypeKatex]}
                            components={{ ...markdownComponents, pre: CodeBlock }}
                          >
                            {mdText}
                          </ReactMarkdown>
                        </div>
                        {longMsg && (
                          <button
                            type="button"
                            className="msg-collapse"
                            onClick={() => toggleLong(i)}
                          >
                            {msgCollapsed
                              ? `展开全文（共 ${m.text.length} 字）`
                              : "收起"}
                          </button>
                        )}
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
                      <></>
                    )}
                    {groupEnd && m.text && (
                      <>
                      <div className="msg-meta">
                        {m.timestamp ? (
                          <span className="msg-time">
                            {formatMsgTime(m.timestamp)}
                          </span>
                        ) : null}
                        <div className="msg-actions">
                          <button
                            type="button"
                            className="msg-action"
                            title="复制纯文本（去除 Markdown 语法）"
                            onClick={(e) => copyMessage(m.text, e, true)}
                          >
                            复制
                          </button>
                          <button
                            type="button"
                            className="msg-action"
                            title="复制 Markdown 原文"
                            onClick={(e) => copyMessage(m.text, e)}
                          >
                            复制 MD
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
                            <>
                              <button
                                type="button"
                                className="msg-action"
                                onClick={() => regenerate(i)}
                              >
                                重新生成
                              </button>
                              <button
                                type="button"
                                className={`msg-action msg-action-rate ${
                                  ratings[i] === "good" ? "msg-action-rated-good" : ""
                                }`}
                                title="回答有帮助"
                                onClick={() => rateMessage(i, "good")}
                              >
                                👍
                              </button>
                              <button
                                type="button"
                                className={`msg-action msg-action-rate ${
                                  ratings[i] === "bad" ? "msg-action-rated-bad" : ""
                                }`}
                                title="回答有问题"
                                onClick={() => rateMessage(i, "bad")}
                              >
                                👎
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            className="msg-action msg-action-del"
                            title="删除这条消息"
                            onClick={() => deleteMessage(i)}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                      {m.role === "assistant" && ratings[i] && (
                        <div className="msg-rating-comment">
                          <input
                            type="text"
                            className="msg-rating-input"
                            placeholder="可选：补充一句评语…"
                            value={ratingComments[i] ?? ""}
                            onChange={(e) =>
                              setRatingComments((prev) => ({
                                ...prev,
                                [i]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") submitRatingComment(i);
                            }}
                          />
                          <button
                            type="button"
                            className="msg-action"
                            onClick={() => submitRatingComment(i)}
                          >
                            保存评语
                          </button>
                        </div>
                      )}
                      </>
                    )}
                  </div>
                  </div>
                  {turnNo > 0 && cardsByTurn.has(turnNo) && (
                    <div className="inline-tools">
                      <ToolCardGroup
                        cards={cardsByTurn.get(turnNo)!}
                        expanded={
                          expandedGroups.has(turnNo) ||
                          (busy && turnNo === userCount)
                        }
                        onToggle={() => toggleGroup(turnNo)}
                        expandedCards={expandedCards}
                        onToggleCard={toggleCard}
                      />
                    </div>
                  )}
                </Fragment>
              );
            });
            })()}
            {info && (
              <div className="info-banner" role="status">
                <CheckIcon size={14} />
                <span>{info}</span>
              </div>
            )}
            {error && (
              <div className="error-banner" role="alert">
                <XIcon size={14} />
                <span>{error}</span>
              </div>
            )}
          </div>

          {/* 审批请求：固定在对话窗内、输入框上方（不再放右侧栏） */}
          {approvals.length > 0 && (
            <div className="approval-dock">
              {approvals.length > 1 && (
                <div className="approval-batch">
                  <span>待确认 {approvals.length} 项</span>
                  <button
                    type="button"
                    className="approve-all"
                    onClick={() => batchDecideApprovals(true)}
                  >
                    全部允许
                  </button>
                  <button
                    type="button"
                    className="deny-all"
                    onClick={() => batchDecideApprovals(false)}
                  >
                    全部拒绝
                  </button>
                </div>
              )}
              <div className="approval-list">
                {approvals.map((a, i) => {
                  const risk = a.risk ?? "medium";
                  const leftMs = a.expiresAt
                    ? Math.max(0, a.expiresAt - Date.now())
                    : 0;
                  const leftSec = Math.ceil(leftMs / 1000);
                  void countdownTick;
                  return (
                    <div
                      key={a.id}
                      className={`approval-card risk-${risk} ${
                        a.deciding ? "approval-deciding" : ""
                      }`}
                      style={{ animationDelay: `${Math.min(i * 60, 300)}ms` }}
                    >
                      <div className="approval-title">
                        <span
                          className="approval-type-icon"
                          title={`${TOOL_META[a.toolName]?.type ?? "工具"}类操作`}
                        >
                          <ToolTypeIcon
                            type={TOOL_META[a.toolName]?.type}
                            size={15}
                          />
                        </span>
                        <span className="approval-tool">
                          {TOOL_META[a.toolName]?.label ?? a.toolName}
                        </span>
                        <span
                          className={`approval-risk risk-${risk}`}
                          title={a.riskReason}
                        >
                          <RiskIcon level={risk} size={11} />
                          {RISK_LABELS[risk] ?? risk}风险
                        </span>
                        {a.expiresAt && (
                          <span
                            className={`approval-countdown ${
                              leftSec <= 10 ? "approval-countdown-urgent" : ""
                            }`}
                          >
                            <ClockIcon size={11} />
                            {leftSec}s
                          </span>
                        )}
                      </div>
                      <div className="approval-body">
                        {a.riskReason && (
                          <div className="approval-reason">
                            <span className="approval-reason-dot" />
                            {a.riskReason}
                          </div>
                        )}
                        <div className="approval-args-block">
                          <span className="approval-args-label">参数</span>
                          <pre className="approval-args">
                            {formatApprovalArgs(a.toolName, a.args)}
                          </pre>
                        </div>
                      </div>
                      <div className="approval-actions">
                        <button
                          className="btn-approve"
                          disabled={a.deciding}
                          onClick={() => decideApproval(a.id, true)}
                        >
                          {a.deciding ? (
                            "处理中…"
                          ) : (
                            <>
                              <CheckIcon size={13} />
                              允许
                            </>
                          )}
                        </button>
                        <button
                          className="btn-deny"
                          disabled={a.deciding}
                          onClick={() => decideApproval(a.id, false)}
                        >
                          {a.deciding ? (
                            "处理中…"
                          ) : (
                            <>
                              <XIcon size={13} />
                              拒绝
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 计划确认（Plan mode Phase 7）：固定在对话窗内、输入框上方 */}
          {plans.length > 0 && (
            <div className="approval-dock plan-dock">
              <div className="approval-list">
                {plans.map((p, i) => {
                  const leftMs = p.expiresAt
                    ? Math.max(0, p.expiresAt - Date.now())
                    : 0;
                  const leftSec = Math.ceil(leftMs / 1000);
                  void countdownTick;
                  const resolved =
                    p.cancelled || typeof p.decided === "boolean";
                  return (
                    <div
                      key={p.id}
                      className={`plan-card ${p.deciding ? "approval-deciding" : ""} ${
                        resolved ? "plan-card-resolved" : ""
                      }`}
                      style={{ animationDelay: `${Math.min(i * 60, 300)}ms` }}
                    >
                      <div className="approval-title">
                        <span className="plan-badge">
                          <PlanIcon size={11} />
                          计划
                        </span>
                        <span className="approval-tool">
                          {p.surface ? `形态度量：${p.surface}` : "待确认计划"}
                        </span>
                        {!resolved && p.expiresAt && (
                          <span
                            className={`approval-countdown ${
                              leftSec <= 10 ? "approval-countdown-urgent" : ""
                            }`}
                          >
                            <ClockIcon size={11} />
                            {leftSec}s
                          </span>
                        )}
                      </div>
                      {p.summary && (
                        <div className="plan-summary">{p.summary}</div>
                      )}
                      <ol className="plan-steps">
                        {p.steps.map((s) => (
                          <li key={s.id}>
                            {s.title}
                            {s.tool && (
                              <span className="plan-step-tool">
                                {TOOL_META[s.tool]?.label ?? s.tool}
                              </span>
                            )}
                          </li>
                        ))}
                      </ol>
                      {p.cancelled ? (
                        <div className="plan-result plan-result-cancelled">
                          计划已取消
                        </div>
                      ) : typeof p.decided === "boolean" ? (
                        <div
                          className={`plan-result ${
                            p.decided
                              ? "plan-result-approved"
                              : "plan-result-rejected"
                          }`}
                        >
                          {p.decided ? "已批准，开始执行" : "已拒绝"}
                        </div>
                      ) : (
                        <div className="approval-actions">
                          <button
                            className="btn-approve"
                            disabled={p.deciding}
                            onClick={() => decidePlan(p.id, true)}
                          >
                            {p.deciding ? (
                              "处理中…"
                            ) : (
                              <>
                                <CheckIcon size={13} />
                                批准执行
                              </>
                            )}
                          </button>
                          <button
                            className="btn-deny"
                            disabled={p.deciding}
                            onClick={() => decidePlan(p.id, false)}
                          >
                            {p.deciding ? (
                              "处理中…"
                            ) : (
                              <>
                                <XIcon size={13} />
                                拒绝
                              </>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

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
            <div className="composer">
              {/* 文本输入区 */}
              <div className="composer-body">
                <textarea
                  className="chat-input"
                  ref={chatInputRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = Math.min(e.target.scrollHeight, 168) + "px";
                  }}
                  onPaste={handlePaste}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      send();
                      return;
                    }
                    if (e.key === "ArrowUp" && !e.shiftKey && !busyRef.current) {
                      if (input.trim() && editingIndex < 0) return;
                      const startFrom = editingIndex >= 0 ? editingIndex : messages.length;
                      for (let i = startFrom - 1; i >= 0; i--) {
                        if (messages[i].role === "user") {
                          e.preventDefault();
                          startEdit(i);
                          break;
                        }
                      }
                    }
                  }}
                  placeholder="描述任务…（/help 查看命令）"
                  disabled={busy}
                  rows={1}
                />
              </div>
              {/* 图片附件预览 */}
              {pendingImages.length > 0 && (
                <div className="composer-attach">
                  {pendingImages.map((img) => (
                    <div key={img.id} className="composer-attach-item">
                      <img src={img.dataUrl} alt={img.name} />
                      <button
                        type="button"
                        onClick={() => removePendingImage(img.id)}
                        aria-label="移除图片"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {/* 底部工具栏 */}
              <div className="composer-toolbar">
                <div className="composer-toolbar-left">
                  {/* 审批模式下拉 */}
                  <div className="toolbar-dropdown">
                    <button
                      type="button"
                      className={`toolbar-dropdown-btn${approvalMode === "auto" || approvalMode === "custom" ? " auto" : ""}${approvalMode === "full" ? " dangerous" : ""}`}
                      onClick={() => setApprovalOpen((v) => !v)}
                      title={approvalMode === "auto" ? "自动审批（LLM Guardian 决策）" : approvalMode === "full" ? "完全访问（不审批）" : approvalMode === "custom" ? "自定义审批" : "手动审批"}
                    >
                      {approvalMode === "full" ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 9v4" />
                          <path d="M12 17h.01" />
                          <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                        </svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        </svg>
                      )}
                      <span>{approvalMode === "auto" ? "自动审批" : approvalMode === "full" ? "完全访问" : approvalMode === "custom" ? "自定义" : "手动审批"}</span>
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                    {approvalOpen && (
                      <>
                        <div className="toolbar-dropdown-backdrop" onClick={() => setApprovalOpen(false)} />
                        <div className="toolbar-dropdown-menu">
                          <button
                            type="button"
                            className={`toolbar-dropdown-item${approvalMode === "manual" ? " active" : ""}`}
                            onClick={() => { setApprovalMode("manual"); setApprovalOpen(false); }}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                            </svg>
                            手动审批
                            <span className="toolbar-dropdown-hint">敏感操作需人工确认</span>
                          </button>
                          <button
                            type="button"
                            className={`toolbar-dropdown-item${approvalMode === "auto" ? " active" : ""}`}
                            onClick={() => { setApprovalMode("auto"); setApprovalOpen(false); }}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                            </svg>
                            自动审批
                            <span className="toolbar-dropdown-hint">LLM Guardian 决策</span>
                          </button>
                          <button
                            type="button"
                            className={`toolbar-dropdown-item${approvalMode === "full" ? " active" : ""}`}
                            onClick={() => { setApprovalMode("full"); setApprovalOpen(false); }}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 9v4" />
                              <path d="M12 17h.01" />
                              <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                            </svg>
                            完全访问
                            <span className="toolbar-dropdown-hint">无需任何审批</span>
                          </button>
                          <button
                            type="button"
                            className={`toolbar-dropdown-item${approvalMode === "custom" ? " active" : ""}`}
                            onClick={() => { setApprovalMode("custom"); setApprovalOpen(false); }}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M4 21v-7" />
                              <path d="M4 10V3" />
                              <path d="M12 21v-9" />
                              <path d="M12 8V3" />
                              <path d="M20 21v-5" />
                              <path d="M20 12V3" />
                              <path d="M1 14h6" />
                              <path d="M9 8h6" />
                              <path d="M17 16h6" />
                            </svg>
                            自定义
                            <span className="toolbar-dropdown-hint">细粒度配置</span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  {/* 图片附件按钮 */}
                  <button
                    type="button"
                    className="toolbar-btn"
                    onClick={() => fileInputRef.current?.click()}
                    title="添加图片"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="9" cy="9" r="2" />
                      <path d="M21 15l-5-5L5 21" />
                    </svg>
                  </button>
                </div>
                <div className="composer-toolbar-right">
                  {/* 模型选择 */}
                  {modelRoutes && (() => {
                    const route = modelRoutes.routes.orchestrator;
                    const usable = modelRoutes.providers.filter((p) => p.hasApiKey);
                    return (
                      <div className="toolbar-dropdown">
                        <button
                          type="button"
                          className="toolbar-dropdown-btn toolbar-model-btn"
                          onClick={() => setModelOpen((v) => !v)}
                          title={route?.model ?? "未配置"}
                        >
                          <span className="toolbar-model-dot" />
                          <span className="toolbar-model-name">{route?.model ?? "未配置"}</span>
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </button>
                        {modelOpen && (
                          <>
                            <div className="toolbar-dropdown-backdrop" onClick={() => setModelOpen(false)} />
                            <div className="toolbar-dropdown-menu toolbar-model-pop">
                              {usable.length === 0 && (
                                <div className="toolbar-dropdown-empty">未检测到可用 API Key</div>
                              )}
                              {usable.map((p) => (
                                <div className="toolbar-model-group" key={p.id}>
                                  <div className="toolbar-model-group-name">{p.name}</div>
                                  {p.models.map((m) => {
                                    const isActive = route?.provider === p.id && route?.model === m.id;
                                    return (
                                      <button
                                        type="button"
                                        key={m.id}
                                        className={`toolbar-dropdown-item${isActive ? " active" : ""}`}
                                        onClick={() => { void switchModel(p.id, m.id); setModelOpen(false); }}
                                      >
                                        <span>{m.id}</span>
                                        {isActive && (
                                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M20 6L9 17l-5-5" />
                                          </svg>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })()}
                  {/* 发送 / 停止 */}
                  {busy ? (
                    <button type="button" className="toolbar-btn toolbar-stop" onClick={stop} title="停止">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      </svg>
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className={`toolbar-send${input.trim() ? " active" : ""}`}
                      disabled={!input.trim()}
                      aria-label="发送"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 19V5M5 12l7-7 7 7" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) addImageFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
            <div className="composer-hint">
              <span>Enter 发送</span>
              <span className="composer-hint-dot">·</span>
              <span>Shift+Enter 换行</span>
              {input.length > 0 && (
                <>
                  <span className="composer-hint-dot">·</span>
                  <span className="composer-count">{input.length} 字符</span>
                </>
              )}
            </div>
          </form>
        </section>

        {!panelCollapsed && (
          <div
            className="drag-handle drag-right"
            onMouseDown={startResize("mid")}
            aria-hidden="true"
          />
        )}
        <aside className="panel" style={{ display: panelCollapsed ? "none" : "flex" }}>
          <div className="panel-tabs">
            <button
              className={`panel-tab ${rightTab === "cards" ? "panel-tab-active" : ""}`}
              onClick={() => setRightTab("cards")}
            >
              工具卡片 {cards.length > 0 && `(${cards.length})`}
            </button>
            <button
              className={`panel-tab ${rightTab === "memory" ? "panel-tab-active" : ""}`}
              onClick={() => { setRightTab("memory"); if (!memoryOpen) { setMemoryOpen(true); refreshMemory(); } }}
            >
              记忆 {memoryTotal > 0 && `(${memoryTotal})`}
            </button>
            <button
              className={`panel-tab ${rightTab === "logs" ? "panel-tab-active" : ""}`}
              onClick={() => {
                setRightTab("logs");
                setLogsOpen(true);
                setStatsOpen(true);
                refreshRunLogs();
                refreshStats();
              }}
            >
              日志
            </button>
            <button
              className={`panel-tab ${rightTab === "audit" ? "panel-tab-active" : ""}`}
              onClick={() => { setRightTab("audit"); if (!auditOpen) { setAuditOpen(true); refreshAudits(); } }}
            >
              审计
            </button>
            <button
              className={`panel-tab ${rightTab === "context" ? "panel-tab-active" : ""}`}
              onClick={() => { setRightTab("context"); refreshContext(); }}
            >
              上下文
            </button>
            <button
              className={`panel-tab ${rightTab === "insights" ? "panel-tab-active" : ""}`}
              onClick={() => { setRightTab("insights"); refreshInsights(); }}
            >
              评估
            </button>
          </div>
          <div className="panel-scroll">
            {/* Tab: 工具卡片 */}
            {rightTab === "cards" && (
              <>
                {/* Phase 7：当前形态可用的内置工具徽标（work/coding 工具集差异化可视化） */}
                <div className="surface-tools">
                  <div className="surface-tools-head">
                    <span className="surface-tools-label">
                      {surface === "work" ? "Work" : "Coding"} 形态工具
                    </span>
                    <span className="surface-tools-count">
                      {Object.values(TOOL_META).filter(
                        (m) => !m.surface || m.surface === surface,
                      ).length}{" "}
                      个内置工具
                    </span>
                  </div>
                  <div className="surface-tools-grid">
                    {Object.entries(TOOL_META)
                      .filter(([, m]) => !m.surface || m.surface === surface)
                      .map(([name, meta]) => (
                        <span
                          key={name}
                          className={`surface-tool-chip surface-tool-${meta.type}`}
                          title={`${name}${meta.sensitive ? "（敏感，操作需审批）" : ""}`}
                        >
                          {meta.label}
                        </span>
                      ))}
                  </div>
                  <p className="surface-tools-note">
                    {surface === "work"
                      ? "不含命令执行/环境调试类工具"
                      : "不含联网检索类工具"}
                  </p>
                </div>
                {todos.length > 0 && (
                  <div className="todo-section">
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
                  <div className="card-list">
                    {(() => {
                      const userCount = messages.filter(
                        (m) => m.role === "user",
                      ).length;
                      const cardsByTurn = groupCardsByTurn(cards, userCount);
                      return [...cardsByTurn.entries()]
                        .sort((a, b) => a[0] - b[0])
                        .map(([turnNo, group]) => (
                          <ToolCardGroup
                            key={turnNo}
                            cards={group}
                            expanded={
                              expandedGroups.has(turnNo) ||
                              (busy && turnNo === userCount)
                            }
                            onToggle={() => toggleGroup(turnNo)}
                            expandedCards={expandedCards}
                            onToggleCard={toggleCard}
                          />
                        ));
                    })()}
                  </div>
                )}
              </>
            )}

            {/* Tab: 记忆 */}
            {rightTab === "memory" && (
              <div className="memory-section">
                {memoryTotal > 0 ? (
                  <>
                    <div className="memory-body">
                      {memoryEpisodes.map((e) => (
                        <div key={e.id} className="memory-item">
                          <div className="memory-item-head">
                            <span
                              className={`memory-role memory-role-${e.role === "user" ? "user" : "assistant"}`}
                            >
                              {e.role === "user" ? "用户" : "Agent"}
                            </span>
                            <span className="memory-time">
                              {formatMsgTime(e.ts)}
                            </span>
                            <button
                              type="button"
                              className="memory-del"
                              title="删除该条记忆"
                              onClick={() => removeMemory(e.id)}
                            >
                              ×
                            </button>
                          </div>
                          <p className="memory-content">{e.content}</p>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="memory-clear"
                      onClick={clearAllMemory}
                    >
                      清空全部记忆
                    </button>
                  </>
                ) : (
                  <p className="panel-empty">暂无记忆</p>
                )}
              </div>
            )}

            {/* Tab: 日志 */}
            {rightTab === "logs" && (
              <div className="logs-section">
                {stats && (
                  <div className="stats-section">
                    <div className="stats-grid">
                      <div className="stats-cell">
                        <span className="stats-num">{stats.totalRuns}</span>
                        <span className="stats-label">总运行</span>
                      </div>
                      <div className="stats-cell">
                        <span className="stats-num stats-ok">
                          {Math.round(stats.successRate * 100)}%
                        </span>
                        <span className="stats-label">成功率</span>
                      </div>
                      <div className="stats-cell">
                        <span className="stats-num">{formatDuration(stats.totalDurationMs)}</span>
                        <span className="stats-label">总耗时</span>
                      </div>
                      <div className="stats-cell">
                        <span className="stats-num">
                          {stats.avgDurationMs ? formatDuration(stats.avgDurationMs) : "—"}
                        </span>
                        <span className="stats-label">平均耗时</span>
                      </div>
                    </div>
                    <div className="stats-sub-title">最近 7 天运行</div>
                    <div className="stats-days">
                      {stats.byDay.map((d) => {
                        const max = Math.max(...stats.byDay.map((x) => x.runs), 1);
                        return (
                          <div key={d.day} className="stats-day" title={`${d.day}：${d.runs} 次`}>
                            <div className="stats-day-bar-wrap">
                              <div
                                className="stats-day-bar"
                                style={{ height: `${Math.max((d.runs / max) * 100, d.runs > 0 ? 8 : 2)}%` }}
                              />
                            </div>
                            <span className="stats-day-label">{d.day.slice(3)}</span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="stats-sub-title">工具使用排行</div>
                    {stats.toolRanking.length === 0 ? (
                      <p className="stats-empty">暂无工具调用</p>
                    ) : (
                      <div className="stats-tools">
                        {stats.toolRanking.slice(0, 6).map((t) => {
                          const max = stats.toolRanking[0]?.count ?? 1;
                          return (
                            <div key={t.name} className="stats-tool">
                              <span className="stats-tool-name">
                                {TOOL_META[t.name]?.label ?? t.name}
                              </span>
                              <div className="stats-tool-bar-wrap">
                                <div
                                  className="stats-tool-bar"
                                  style={{ width: `${(t.count / max) * 100}%` }}
                                />
                              </div>
                              <span className="stats-tool-count">{t.count}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
                {runLogs.length > 0 ? (
                  <div className="logs-body">
                    {runLogs.map((l) => (
                      <div
                        key={l.id}
                        className={`log-item ${l.error ? "log-item-error" : l.stopped ? "log-item-stopped" : "log-item-done"}`}
                      >
                        <div className="log-item-head">
                          <span className="log-title">{l.title || "未命名会话"}</span>
                          <span className="log-state">
                            {l.error ? "错误" : l.stopped ? "停止" : "完成"}
                          </span>
                        </div>
                        <div className="log-item-meta">
                          <span>{formatMsgTime(l.startedAt)}</span>
                          <span>{formatDuration(l.durationMs)}</span>
                          <span>{l.messageCount} 条消息</span>
                        </div>
                        {l.error && (
                          <p className="log-error">{l.error.slice(0, 140)}</p>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="logs-clear"
                      onClick={clearRunLogs}
                    >
                      清空日志
                    </button>
                  </div>
                ) : (
                  <p className="panel-empty">暂无运行记录</p>
                )}
                <div className="panel-actions">
                  <button
                    type="button"
                    className="panel-action"
                    onClick={refreshRunLogs}
                  >
                    刷新日志
                  </button>
                  <button
                    type="button"
                    className="panel-action"
                    onClick={refreshStats}
                  >
                    刷新统计
                  </button>
                </div>
              </div>
            )}

            {/* Tab: 审计 */}
            {rightTab === "audit" && (
              <div className="audit-section">
                <div className="audit-filters">
                  <select
                    value={auditTool}
                    onChange={(e) => {
                      setAuditTool(e.target.value);
                      setAuditOffset(0);
                      refreshAudits();
                    }}
                    aria-label="按工具筛选"
                  >
                    <option value="">全部工具</option>
                    {Object.entries(TOOL_META).map(([key, meta]) => (
                      <option key={key} value={key}>
                        {meta.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={auditAction}
                    onChange={(e) => {
                      setAuditAction(e.target.value);
                      setAuditOffset(0);
                      refreshAudits();
                    }}
                    aria-label="按动作筛选"
                  >
                    <option value="">全部动作</option>
                    {Object.entries(AUDIT_ACTION_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                {audits.length > 0 ? (
                  <div className="audit-body">
                    {audits.map((a) => (
                      <div
                        key={a.id}
                        className={`audit-item audit-${a.action}`}
                      >
                        <div className="audit-item-head">
                          <span className="audit-tool">
                            {TOOL_META[a.toolName]?.label ?? a.toolName}
                          </span>
                          <span className="audit-action">
                            {AUDIT_ACTION_LABELS[a.action] ?? a.action}
                          </span>
                          <span className="audit-time">
                            {formatMsgTime(a.ts)}
                          </span>
                        </div>
                        {a.reason && (
                          <div className="audit-reason">{a.reason}</div>
                        )}
                        <code className="audit-args">
                          {a.args?.slice(0, 100)}
                        </code>
                      </div>
                    ))}
                    <div className="audit-footer">
                      <button
                        type="button"
                        className="audit-page"
                        disabled={auditOffset === 0}
                        onClick={() => {
                          setAuditOffset((o) => Math.max(0, o - 50));
                          refreshAudits();
                        }}
                      >
                        更新
                      </button>
                      <button
                        type="button"
                        className="audit-page"
                        disabled={auditOffset + 50 >= auditTotal}
                        onClick={() => {
                          setAuditOffset((o) => o + 50);
                          refreshAudits();
                        }}
                      >
                        更早
                      </button>
                      <button
                        type="button"
                        className="audit-clear"
                        onClick={clearAudits}
                      >
                        清空历史
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="panel-empty">暂无审批记录</p>
                )}
              </div>
            )}

            {/* Tab: 上下文 */}
            {rightTab === "context" && (
              <div className="context-section">
                {contextAnalysis ? (
                  <>
                    <div className="context-usage">
                      <div className="context-block-head">
                        <span className="context-block-label">真实 Token 用量</span>
                        <span className="context-block-note">模型返回</span>
                      </div>
                      <div className="context-usage-grid">
                        <div className="context-metric">
                          <span className="context-metric-k">本轮输入</span>
                          <span className="context-metric-v">
                            {runUsage
                              ? runUsage.input
                              : contextAnalysis.lastUsage?.input ?? 0}
                          </span>
                        </div>
                        <div className="context-metric">
                          <span className="context-metric-k">本轮输出</span>
                          <span className="context-metric-v">
                            {runUsage
                              ? runUsage.output
                              : contextAnalysis.lastUsage?.output ?? 0}
                          </span>
                        </div>
                        <div className="context-metric">
                          <span className="context-metric-k">累计输入</span>
                          <span className="context-metric-v">
                            {contextAnalysis.usageTotals?.input ?? 0}
                          </span>
                        </div>
                        <div className="context-metric">
                          <span className="context-metric-k">累计成本</span>
                          <span className="context-metric-v">
                            ¥{(contextAnalysis.usageTotals?.cost?.total ?? 0).toFixed(4)}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="context-compose">
                      <div className="context-block-head">
                        <span className="context-block-label">上下文构成</span>
                        <span className="context-block-note">估算</span>
                      </div>
                      <div className="context-bar">
                        {contextAnalysis.categories
                          .filter((c) => c.estimatedTokens > 0)
                          .map((c) => (
                            <span
                              key={c.key}
                              className={`context-bar-seg context-bar-${c.key}`}
                              style={{
                                width: `${(c.estimatedTokens / Math.max(contextAnalysis.totalEstimatedTokens, 1)) * 100}%`,
                              }}
                              title={`${c.label}: ${c.estimatedTokens} token`}
                            />
                          ))}
                      </div>
                      <ul className="context-list">
                        {contextAnalysis.categories.map((c) => (
                          <li key={c.key} className="context-row">
                            <span className={`context-dot context-dot-${c.key}`} />
                            <span className="context-row-label">{c.label}</span>
                            <span className="context-row-count">
                              {c.count > 0 ? `${c.count} 项` : ""}
                            </span>
                            <span className="context-row-tokens">
                              {c.estimatedTokens} tok
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="context-note">
                        构成为字符估算（中文≈1 字/token，英文≈4 字符/token），
                        非真实 tokenizer 输出；真实用量以「模型返回」为准。
                      </p>
                    </div>

                    {contextAnalysis.memoryHits.length > 0 && (
                      <div className="context-memory">
                        <div className="context-block-head">
                          <span className="context-block-label">本轮记忆命中</span>
                          <span className="context-block-note">
                            {contextAnalysis.memoryHits.length}/
                            {contextAnalysis.memoryTotal}
                          </span>
                        </div>
                        {contextAnalysis.memoryHits.map((h, i) => (
                          <div key={i} className="context-memory-item">
                            <span
                              className={`context-memory-role ${h.role === "user" ? "is-user" : ""}`}
                            >
                              {h.role === "user" ? "用户" : "Agent"}
                            </span>
                            <p className="context-memory-content">{h.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="panel-empty">加载上下文分析中…</p>
                )}
              </div>
            )}

            {/* Tab: 评估（观测+评估聚合，Langfuse 式闭环） */}
            {rightTab === "insights" && (
              <div className="insights-section">
                {insights ? (
                  <>
                    <div className="insights-summary">
                      <div className="insights-sum-cell">
                        <span className="insights-sum-num">{insights.summary.totalRuns}</span>
                        <span className="insights-sum-label">总运行</span>
                      </div>
                      <div className="insights-sum-cell">
                        <span className="insights-sum-num insights-good">{insights.summary.good}</span>
                        <span className="insights-sum-label">👍 好评</span>
                      </div>
                      <div className="insights-sum-cell">
                        <span className="insights-sum-num insights-bad">{insights.summary.bad}</span>
                        <span className="insights-sum-label">👎 差评</span>
                      </div>
                      <div className="insights-sum-cell">
                        <span className="insights-sum-num insights-warn">{insights.summary.ruleIssues}</span>
                        <span className="insights-sum-label">规则问题</span>
                      </div>
                      <div className="insights-sum-cell">
                        <span className="insights-sum-num insights-ai">
                          {insights.summary.avgJudgeScore != null
                            ? `${insights.summary.avgJudgeScore}`
                            : "—"}
                        </span>
                        <span className="insights-sum-label">
                          AI 均分{insights.summary.judgeCount > 0 ? `·${insights.summary.judgeCount}次` : ""}
                        </span>
                      </div>
                    </div>

                    <JudgeTrendChart trend={insights.judgeTrend} />

                    <ModelStatsView stats={insights.modelStats} />

                    {insights.suggestions.length > 0 && (
                      <div className="insights-suggest">
                        <div className="insights-suggest-head">
                          <span className="insights-suggest-title">优化建议</span>
                          <span className="insights-suggest-hint">
                            基于低分与规则问题聚合
                          </span>
                        </div>
                        {insights.suggestions.map((s, i) => (
                          <div className="insights-suggest-item" key={`${s.type}-${i}`}>
                            <div className="insights-suggest-row">
                              <span className={`insights-suggest-badge ${s.type}`}>
                                {s.type === "llm_judge"
                                  ? "AI 低分"
                                  : (RULE_SCORE_LABELS[s.type] ?? s.type)}
                              </span>
                              <span className="insights-suggest-count">
                                {s.count} 次
                              </span>
                            </div>
                            {s.comment && (
                              <p className="insights-suggest-comment">{s.comment}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="insights-filter">
                      {(
                        [
                          ["all", "全部"],
                          ["issue", "仅问题"],
                          ["low", "仅低分"],
                        ] as const
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          className={`insights-filter-chip ${
                            insightsFilter === key ? "active" : ""
                          }`}
                          onClick={() => setInsightsFilter(key)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {insights.runs.length === 0 ? (
                      <p className="panel-empty">暂无运行记录</p>
                    ) : (
                      <div className="insights-list">
                        {insights.runs
                          .filter((run) => {
                            if (insightsFilter === "all") return true;
                            const hasBad = run.scores.some(
                              (s) => s.kind === "human" && s.label === "bad",
                            );
                            const rules = run.scores.filter((s) => s.kind === "rule");
                            const issue =
                              !!run.error ||
                              run.stopped ||
                              hasBad ||
                              rules.length > 0;
                            if (insightsFilter === "issue") return issue;
                            // low：AI 评分 < 7 的坏案例（无评分视为不命中）
                            const aiScores = run.scores
                              .filter(
                                (s) => s.label === "llm_judge" && s.score != null,
                              )
                              .map((s) => s.score!);
                            return (
                              aiScores.length > 0 &&
                              Math.min(...aiScores) < 7
                            );
                          })
                          .map((run) => {
                          const hasBad = run.scores.some(
                            (s) => s.kind === "human" && s.label === "bad",
                          );
                          const rules = run.scores.filter((s) => s.kind === "rule");
                          const issue = !!run.error || run.stopped || hasBad || rules.length > 0;
                          // 最低 LLM-Judge 评分及其评语（低分复盘用）
                          const aiRated = run.scores
                            .filter((s) => s.label === "llm_judge" && s.score != null)
                            .sort((a, b) => (a.score! - b.score!));
                          const aiLow = aiRated[0];
                          return (
                            <div
                              key={run.id}
                              className={`insight-item ${issue ? "insight-item-issue" : ""}`}
                              onClick={() => switchSession(run.sessionId)}
                              title={issue ? "点击打开该会话复盘" : "点击打开该会话"}
                            >
                              <div className="insight-item-head">
                                <span className="insight-title">
                                  {run.title || "未命名会话"}
                                </span>
                                <span
                                  className={`insight-state ${
                                    run.error ? "err" : run.stopped ? "stopped" : "ok"
                                  }`}
                                >
                                  {run.error ? "错误" : run.stopped ? "停止" : "完成"}
                                </span>
                              </div>
                              <div className="insight-item-meta">
                                <span>{formatMsgTime(run.startedAt)}</span>
                                <span>{formatDuration(run.durationMs)}</span>
                                {run.usage && (
                                  <span>{run.usage.totalTokens} tok</span>
                                )}
                                {run.toolCalls && (
                                  <span>
                                    {Object.keys(run.toolCalls).length} 工具
                                  </span>
                                )}
                              </div>
                              {run.scores.length > 0 && (
                                <div className="insight-item-scores">
                                  {run.scores.map((s) => (
                                    <span
                                      key={s.id}
                                      className={`insight-score ${
                                        s.kind === "human"
                                          ? s.label === "good"
                                            ? "insight-score-good"
                                            : "insight-score-bad"
                                          : s.label === "llm_judge"
                                            ? "insight-score-ai"
                                            : "insight-score-rule"
                                      }`}
                                      title={s.comment}
                                    >
                                      {s.kind === "human"
                                        ? s.label === "good"
                                          ? "👍"
                                          : "👎"
                                        : s.label === "llm_judge"
                                          ? `AI 评分 ${s.score != null ? s.score + "/10" : "?"}`
                                          : (RULE_SCORE_LABELS[s.label] ?? s.label)}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {aiLow && aiLow.score! < 7 && (
                                <p className="insight-ai-comment">
                                  {aiLow.comment || "低分案例，建议复盘"}
                                </p>
                              )}
                              {run.error && (
                                <p className="insight-error">
                                  {run.error.slice(0, 120)}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="panel-empty">加载评估数据中…</p>
                )}
                <div className="panel-actions">
                  <button
                    type="button"
                    className="panel-action"
                    onClick={refreshInsights}
                  >
                    刷新评估
                  </button>
                </div>
              </div>
            )}
          </div>
        </aside>
      </main>

      {/* 目录选择器模态框：Coding 新建会话时选择绑定目录（绑定后不可重选） */}
      {dirPickerOpen && (
        <>
          <div
            className="input-model-backdrop"
            onClick={() => setDirPickerOpen(false)}
          />
          <div className="dir-picker-pop">
            <div className="dir-picker-header">
              <h3>选择绑定目录</h3>
              <button
                type="button"
                className="dir-picker-close"
                onClick={() => setDirPickerOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="dir-picker-body">
              <p className="dir-picker-label">已有工作区（点击选择）：</p>
              <div className="dir-picker-roots">
                {dirPickerRoots.length === 0 && (
                  <p className="dir-picker-empty">暂无已授权工作区</p>
                )}
                {dirPickerRoots.map((root) => (
                  <button
                    key={root.id}
                    type="button"
                    className={`dir-picker-root${
                      dirPickerValue === root.root ? " active" : ""
                    }`}
                    onClick={() => setDirPickerValue(root.root)}
                  >
                    <span className="dir-picker-root-name">{root.name}</span>
                    <span className="dir-picker-root-path">{root.root}</span>
                  </button>
                ))}
              </div>
              <p className="dir-picker-label">或输入目录路径：</p>
              <input
                type="text"
                className="dir-picker-input"
                value={dirPickerValue}
                onChange={(e) => setDirPickerValue(e.target.value)}
                placeholder="例如：E:\projects\my-app 或 ~/code/project"
              />
            </div>
            <div className="dir-picker-footer">
              <button
                type="button"
                className="dir-picker-cancel"
                onClick={() => setDirPickerOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="dir-picker-confirm"
                onClick={confirmDirPicker}
              >
                确认
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
