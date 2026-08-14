"use client";

import { useMemo } from "react";

/** unified diff 行类型 */
type DiffKind = "file-old" | "file-new" | "hunk" | "add" | "del" | "ctx";

interface DiffLine {
  kind: DiffKind;
  text: string;
}

/**
 * 检测文本是否为 unified diff（--- a/ + +++ b/ + @@ hunk）。
 * 用于区分 edit_file 等工具返回的 diff 与普通文本结果。
 */
export function isDiffText(text: string): boolean {
  return /(?:^|\n)--- a\/[^\n]*\n\+\+\+ b\/[^\n]*\n@@[^\n]*@@/.test(text);
}

/** 解析 unified diff 文本为带类型的行数组 */
function parseDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let inHunk = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const c = line[0] ?? "";
    if (!inHunk) {
      if (line.startsWith("--- ")) {
        out.push({ kind: "file-old", text: line });
      } else if (line.startsWith("+++ ")) {
        out.push({ kind: "file-new", text: line });
      } else if (line.startsWith("@@")) {
        inHunk = true;
        out.push({ kind: "hunk", text: line });
      } else {
        out.push({ kind: "ctx", text: line });
      }
      continue;
    }
    if (c === "+") out.push({ kind: "add", text: line });
    else if (c === "-") out.push({ kind: "del", text: line });
    else if (c === " ") out.push({ kind: "ctx", text: line.slice(1) });
    else if (c === "@") out.push({ kind: "hunk", text: line });
    else out.push({ kind: "ctx", text: line });
  }
  return out;
}

/** 行首符号列（::before 渲染） */
function lineMark(kind: DiffKind): string {
  switch (kind) {
    case "add":
      return "+";
    case "del":
      return "-";
    case "hunk":
      return "@";
    default:
      return "";
  }
}

/**
 * Diff 高亮视图：解析 unified diff 文本，按行渲染新增（绿）/删除（红）/
 * hunk 头（品牌色）/文件头（副标题），替代纯文本 <pre> 展示。
 */
export function DiffView({ text }: { text: string }) {
  const lines = useMemo(() => parseDiff(text), [text]);
  return (
    <div className="card-result diff-view" role="log">
      {lines.map((l, i) => (
        <div
          key={i}
          className={`diff-line diff-${l.kind}`}
          data-mark={lineMark(l.kind)}
        >
          {l.text}
        </div>
      ))}
    </div>
  );
}
