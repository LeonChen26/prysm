/**
 * Markdown → 纯文本
 * 去掉语法标记、保留可读内容，供"复制"按钮使用。
 */

export function mdToPlainText(md: string): string {
  return md
    // 代码块（含 thinking 块）：保留内容，去掉围栏
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, "$1")
    // 行内代码
    .replace(/`([^`]+)`/g, "$1")
    // 图片：保留 alt
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 链接：保留文字
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 加粗 / 斜体 / 删除线
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    // 标题符
    .replace(/^#{1,6}\s+/gm, "")
    // 列表符号与引用
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    // 表格：分隔行删除；行首尾竖线及边距去掉，内部竖线转为空格
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "")
    .replace(/^[ \t]*\|/gm, "")
    .replace(/\|[ \t]*$/gm, "")
    .replace(/\s*\|\s*/g, "  ")
    // 行尾空白清理（表格转换等场景残留）
    .replace(/[ \t]+$/gm, "")
    // 残留 HTML 标签
    .replace(/<[^>]+>/g, "")
    // 压缩多余空行
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
