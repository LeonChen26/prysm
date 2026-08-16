"use client";

import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { DiffView, isDiffText } from "./DiffView";

/** 工作区文件浏览器图标（SVG，随主题着色） */
export const WbFolderIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </svg>
);
export const WbFileIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
    <path d="M14 3v5h5" />
  </svg>
);
export const WbChevron = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/** 品牌火花图标（AI 标识：大星 + 小星，Claude 式双子星，随当前颜色着色） */
export const SparkleIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M12 2.5c.55 2.6 2.15 4.2 4.75 4.75C14.15 7.8 12.55 9.4 12 12c-.55-2.6-2.15-4.2-4.75-4.75C9.85 6.7 11.45 5.1 12 2.5z" />
    <path d="M19 12.5c.35 1.7 1.4 2.75 3.1 3.1-1.7.35-2.75 1.4-3.1 3.1-.35-1.7-1.4-2.75-3.1-3.1 1.7-.35 2.75-1.4 3.1-3.1z" />
  </svg>
);

/** 用户人形图标（消息角色标识） */
export const PersonIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="8" r="3.6" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </svg>
);

/** 品牌几何棱镜：呼应 Prysm（prism）命名，三角形棱镜 + 内部光线 */
export const PrismIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3 21 19 3 19Z" />
    <path d="M6.8 14.2 12 8l5.2 6.2" />
  </svg>
);

/** 会话操作图标（Lucide 风格描边，替代 emoji/unicode 字符，跨平台观感统一） */

/** 置顶（图钉） */
export const PinIcon = ({ size = 13 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
  </svg>
);

/** 取消置顶（图钉 + 斜杠） */
export const PinOffIcon = ({ size = 13 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
    <line x1="2" x2="22" y1="2" y2="22" />
  </svg>
);

/** 下载 */
export const DownloadIcon = ({ size = 13 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </svg>
);

/** 导出 Markdown（带向下箭头的文件） */
export const FileDownIcon = ({ size = 13 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M12 18v-6" />
    <path d="m9 15 3 3 3-3" />
  </svg>
);

/** 导出 JSON（花括号） */
export const BracesIcon = ({ size = 13 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" />
    <path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
  </svg>
);

/** 清空消息（垃圾桶） */
export const TrashIcon = ({ size = 13 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

/** 重命名（铅笔） */
export const PencilIcon = ({ size = 13 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
);

/** 上传文件（工作区） */
export const UploadIcon = ({ size = 14 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m17 8-5-5-5 5" />
    <path d="M12 3v12" />
  </svg>
);

/** 风险等级图标：按 level 返回对应语义图形（审批卡徽章用） */
export const RiskIcon = ({ level, size = 11 }: { level: string; size?: number }) => {
  switch (level) {
    case "low":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "high":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
        </svg>
      );
    case "critical":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      );
  }
};

/** 倒计时时钟 */
export const ClockIcon = ({ size = 11 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

/** 允许（对勾） */
export const CheckIcon = ({ size = 13 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

/** 拒绝（叉） */
export const XIcon = ({ size = 13 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

/** 工具（扳手，审批标题工具名前缀） */
export const WrenchIcon = ({ size = 11, className }: { size?: number; className?: string }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

/** 计划（清单） */
export const PlanIcon = ({ size = 11 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 6h13" />
    <path d="M8 12h13" />
    <path d="M8 18h13" />
    <path d="M3 6h.01" />
    <path d="M3 12h.01" />
    <path d="M3 18h.01" />
  </svg>
);

/** 工具类型图标：按 TOOL_META.type 分类（文件/任务/网络/系统），审批卡头部类型圆用 */
export const ToolTypeIcon = ({ type, size = 16 }: { type?: string; size?: number }) => {
  switch (type) {
    case "任务":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 11 3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      );
    case "网络":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
          <path d="M2 12h20" />
        </svg>
      );
    case "系统":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" x2="20" y1="19" y2="19" />
        </svg>
      );
    case "文件":
    default:
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M16 13H8" />
          <path d="M16 17H8" />
          <path d="M10 9H8" />
        </svg>
      );
  }
};

/** 递归提取 React 节点文本（用于代码块语言内容） */
export function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (isValidElement(node)) {
    const props = (node as ReactElement<{ children?: ReactNode }>).props;
    return nodeToText(props?.children);
  }
  return "";
}

/** 从消息文本中提取独立的 wb:// 文件引用行（跳过围栏代码块），并从正文移除 */
export function extractFileRefs(
  text: string,
): { cleaned: string; refs: { path: string }[] } {
  const refs: { path: string }[] = [];
  let inFence = false;
  const cleaned = text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const m = /^wb:\/\/(\S+)\s*$/.exec(line.trim());
      if (m) {
        refs.push({ path: m[1] });
        return "";
      }
      return line;
    })
    .join("\n");
  return { cleaned, refs };
}

/** 思考块：默认折叠，点击展开（模型以 ```thinking 包裹的中间推理过程） */
export function ThinkingBlock({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`thinking-block ${open ? "thinking-block-open" : ""}`}>
      <button
        type="button"
        className="thinking-block-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="thinking-block-icon" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        {open ? "收起思考过程" : "查看思考过程"}
      </button>
      {open && <pre className="thinking-block-body">{children}</pre>}
    </div>
  );
}

/** Mermaid 流程图：客户端懒加载渲染 ```mermaid 代码块，跟随全局主题并在切换时自动重渲染 */
export function MermaidDiagram({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading");
  const [errText, setErrText] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // 监听 html[data-theme] 变化（主题切换时触发重新渲染）
  useEffect(() => {
    const read = () =>
      setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "default",
        });
        const id = `m-${Math.random().toString(36).slice(2, 10)}`;
        const { svg } = await mermaid.render(id, code);
        if (cancelled) return;
        if (ref.current) ref.current.innerHTML = svg;
        setStatus("done");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setErrText(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, theme]);

  if (status === "error") {
    return (
      <div className="mermaid-block mermaid-error">
        <pre>{code}</pre>
        <p className="mermaid-err">图表解析失败：{errText.slice(0, 140)}</p>
      </div>
    );
  }
  return (
    <div className="mermaid-block">
      {status === "loading" && <span className="mermaid-loading">渲染图表中…</span>}
      <div ref={ref} className="mermaid-svg" />
    </div>
  );
}

/** Markdown 代码块：hover 显示复制按钮；```thinking 语言渲染为折叠的思考块；```mermaid 渲染流程图；unified diff 内容渲染为高亮 DiffView */
export function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  // 检测语言标签：react-markdown 把 ```thinking 渲染为 code.language-thinking
  const childProps = (
    typeof children === "object" && children !== null
      ? (children as ReactElement).props
      : undefined
  ) as { className?: string } | undefined;
  const isThinking =
    !!childProps && /language-thinking/i.test(String(childProps.className ?? ""));
  if (isThinking) return <ThinkingBlock>{children}</ThinkingBlock>;
  const isMermaid =
    !!childProps && /language-mermaid/i.test(String(childProps.className ?? ""));
  if (isMermaid) return <MermaidDiagram code={nodeToText(children)} />;
  // 正文代码块若为 unified diff，渲染为高亮视图（新增绿/删除红/hunk 蓝）
  // 注意：rehype-highlight 会自动给 diff 内容加 language-diff/hljs 类（但未加载主题 CSS，仍是黑底白字），
  // 故按内容而非语言类判断，命中即用 DiffView 接管。
  if (isDiffText(nodeToText(children).replace(/\n$/, ""))) {
    return <DiffView text={nodeToText(children)} />;
  }
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

/** 消息内工作区文件引用卡片（wb:// 路径），点击调起预览 */
export function FileRefCards({
  refs,
  onOpen,
}: {
  refs: { path: string }[];
  onOpen: (path: string) => void;
}) {
  if (refs.length === 0) return null;
  return (
    <div className="fileref-cards">
      {refs.map((r, ri) => (
        <button
          key={ri}
          type="button"
          className="fileref-card"
          title={`点击预览 ${r.path}`}
          onClick={() => onOpen(r.path)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
          </svg>
          <span className="fileref-path">{r.path}</span>
          <span className="fileref-open">预览</span>
        </button>
      ))}
    </div>
  );
}
