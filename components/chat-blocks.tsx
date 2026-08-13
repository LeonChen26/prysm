"use client";

import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

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

/** Markdown 代码块：hover 显示复制按钮；```thinking 语言渲染为折叠的思考块；```mermaid 渲染流程图 */
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
