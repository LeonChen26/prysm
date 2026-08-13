/**
 * 审批规则化（policy）验证脚本 —— 纯函数断言，无需 LLM。
 * 运行：npx tsx test-policy.ts
 */
import { isAutoApproved } from "../../lib/policy";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expect(name: string, actual: boolean, want: boolean) {
  if (actual !== want) {
    fail(`${name}: 期望 ${want}，实际 ${actual}`);
  }
  console.log(`  ✓ ${name} = ${actual}`);
}

// 注意：需在首次调用 isAutoApproved 前设置 env（policy 惰性解析）
process.env.APPROVAL_ALLOW_TOOLS = "append_file";
process.env.APPROVAL_ALLOW_PATHS = "notes/,*.md,sub/dir";

console.log("== 工具白名单 ==");
expect("append_file 任意路径", isAutoApproved("append_file", { path: "x.txt" }), true);
expect("write_file 不在白名单工具", isAutoApproved("write_file", { path: "notes/a.txt" }), true);

console.log("\n== 目录前缀 notes/ ==");
expect("notes/a.txt", isAutoApproved("write_file", { path: "notes/a.txt" }), true);
expect("notes/sub/b.txt", isAutoApproved("write_file", { path: "notes/sub/b.txt" }), true);
expect("src/a.txt", isAutoApproved("write_file", { path: "src/a.txt" }), false);
expect("./notes/a.txt（带 ./）", isAutoApproved("write_file", { path: "./notes/a.txt" }), true);
expect("notes（精确目录自身）", isAutoApproved("write_file", { path: "notes" }), true);

console.log("\n== 文件名通配 *.md ==");
expect("docs/x.md", isAutoApproved("write_file", { path: "docs/x.md" }), true);
expect("docs/sub/x.md", isAutoApproved("write_file", { path: "docs/sub/x.md" }), true);
expect("docs/x.txt", isAutoApproved("write_file", { path: "docs/x.txt" }), false);
expect("delete_file docs/y.md", isAutoApproved("delete_file", { path: "docs/y.md" }), true);
expect("delete_file docs/y.txt", isAutoApproved("delete_file", { path: "docs/y.txt" }), false);

console.log("\n== 普通路径前缀 sub/dir（边界） ==");
expect("sub/dir/f.txt", isAutoApproved("write_file", { path: "sub/dir/f.txt" }), true);
expect("sub/dirx/f.txt（不应误匹配）", isAutoApproved("write_file", { path: "sub/dirx/f.txt" }), false);

console.log("\n== 路径提取规则（move/copy 看目标 to） ==");
expect("move_file 目标在 notes/", isAutoApproved("move_file", { from: "a.txt", to: "notes/b.txt" }), true);
expect("move_file 目标在 src/", isAutoApproved("move_file", { from: "a.txt", to: "src/b.txt" }), false);

console.log("\n== 无路径参数的敏感工具 ==");
expect("write_file 缺 path（参数错误，走审批）", isAutoApproved("write_file", {}), false);
expect("todo_create 非敏感工具", isAutoApproved("todo_create", {}), false);

console.log("\n✓ 审批规则化验证通过");
