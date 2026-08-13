/**
 * Markdown → 纯文本单测（离线）
 */
import { mdToPlainText } from "./lib/plaintext";

let assertCount = 0;
let failCount = 0;

function assert(cond: boolean, name: string) {
  assertCount++;
  if (!cond) {
    failCount++;
    console.log(`  ✗ ${name}`);
  } else {
    console.log(`  ✓ ${name}`);
  }
}

console.log("== Markdown 转纯文本 ==");

assert(
  mdToPlainText("**加粗** 与 *斜体* 和 ~~删除~~") === "加粗 与 斜体 和 删除",
  "加粗/斜体/删除线",
);
assert(
  mdToPlainText("[链接文字](https://example.com)") === "链接文字",
  "链接保留文字",
);
assert(
  mdToPlainText("![图片说明](https://x/a.png)") === "图片说明",
  "图片保留 alt",
);
assert(mdToPlainText("`inline code` 内容") === "inline code 内容", "行内代码");
assert(
  mdToPlainText("```js\nconst a = 1;\n```") === "const a = 1;",
  "代码块保留内容",
);
assert(
  mdToPlainText("# 标题\n## 二级") === "标题\n二级",
  "标题符去除",
);
assert(
  mdToPlainText("- 项一\n- 项二") === "项一\n项二",
  "无序列表",
);
assert(
  mdToPlainText("1. 第一\n2. 第二") === "第一\n第二",
  "有序列表",
);
assert(
  mdToPlainText("> 引用内容") === "引用内容",
  "引用",
);
{
  const t = mdToPlainText("| A | B |\n|---|---|\n| 1 | 2 |");
  assert(
    !t.includes("|") && t.includes("A  B") && t.includes("1  2"),
    "表格去竖线与分隔行",
  );
}
assert(
  mdToPlainText("   ") === "",
  "纯空白 trim",
);

console.log(failCount === 0 ? "\n✓ Markdown 转纯文本验证通过" : `\n✗ ${failCount} 项断言失败`);
process.exit(failCount === 0 ? 0 : 1);
