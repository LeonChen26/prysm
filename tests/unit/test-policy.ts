/**
 * 审批资源授权（policy.ts）验证脚本 —— 文件后端（permission.json）纯函数断言。
 * 覆盖：工具白/黑名单（含 mcp__* / skill__* 通配）、路径白/黑名单（目录前缀 / 文件名通配 /
 *      ./ 前缀去除 / .env 隐藏文件宽松匹配）、move/copy 目标路径提取、配置热更新。
 * 命令规则（allow/ask/deny）由决策链 ruleHit 处理（见 test-approval-policy / test-permission）。
 * 运行：npx tsx tests/unit/test-policy.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configure } from "../../lib/config";
import { savePermission } from "../../lib/permission";
import { isAutoApproved, isDenied } from "../../lib/policy";

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

function expectDeny(name: string, denied: boolean, reason?: string) {
  if (denied !== true) {
    fail(`${name}: 期望拦截，实际未拦截`);
  }
  console.log(`  ✓ ${name}（${reason ?? ""}）`);
}

function expectAllow(name: string, denied: boolean) {
  if (denied !== false) {
    fail(`${name}: 期望放行，实际拦截`);
  }
  console.log(`  ✓ ${name} = 放行`);
}

// 隔离 baseDir：写入临时目录，不污染项目（配置源：permission/global.json）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-policy-"));
configure({ baseDir: tmp });

savePermission({
  activeMode: "manual",
  customProfiles: {},
  resourceAuthorization: {
    tools: { allow: ["append_file"], deny: ["delete_file", "mcp__*", "skill__*"] },
    filesystem: { readWrite: ["notes/", "*.md", "sub/dir"], readOnly: [".env", ".git/"] },
    network: { allow: [], deny: [] },
  },
  approvalTimeoutMs: 120000,
});

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
// isAutoApproved 只判白名单一侧；黑名单优先级由决策链 policyDeny 保证（见 test-approval-policy）
expect("delete_file docs/y.md（白名单路径但工具黑名单）", isAutoApproved("delete_file", { path: "docs/y.md" }), true);

console.log("\n== 普通路径前缀 sub/dir（边界） ==");
expect("sub/dir/f.txt", isAutoApproved("write_file", { path: "sub/dir/f.txt" }), true);
expect("sub/dirx/f.txt（不应误匹配）", isAutoApproved("write_file", { path: "sub/dirx/f.txt" }), false);

console.log("\n== 路径提取规则（move/copy 看目标 to） ==");
expect("move_file 目标在 notes/", isAutoApproved("move_file", { from: "a.txt", to: "notes/b.txt" }), true);
expect("move_file 目标在 src/", isAutoApproved("move_file", { from: "a.txt", to: "src/b.txt" }), false);

console.log("\n== 无路径参数的敏感工具 ==");
expect("write_file 缺 path（参数错误，走审批）", isAutoApproved("write_file", {}), false);
expect("todo_create 非敏感工具", isAutoApproved("todo_create", {}), false);

console.log("\n== 强制拦截：工具黑名单 ==");
const d1 = isDenied("delete_file", { path: "x.txt" });
if (!d1.denied) fail("delete_file 应被工具黑名单拦截");
console.log(`  ✓ delete_file 被拦截（${d1.reason}）`);
expectDeny("mcp__filesystem_read 被通配拦截", isDenied("mcp__filesystem_read", {}).denied, isDenied("mcp__filesystem_read", {}).reason);
expectDeny("skill__code_review 被通配拦截", isDenied("skill__code_review", {}).denied, isDenied("skill__code_review", {}).reason);
expectAllow("web_search 不在黑名单", isDenied("web_search", {}).denied);

console.log("\n== 强制拦截：路径黑名单 ==");
expectDeny("write_file .env", isDenied("write_file", { path: ".env" }).denied, isDenied("write_file", { path: ".env" }).reason);
expectDeny("write_file .git/config", isDenied("write_file", { path: ".git/config" }).denied, isDenied("write_file", { path: ".git/config" }).reason);
expectDeny("write_file .env.local（前缀+点匹配）", isDenied("write_file", { path: ".env.local" }).denied, isDenied("write_file", { path: ".env.local" }).reason);
expectAllow("write_file src/a.ts 不在黑名单", isDenied("write_file", { path: "src/a.ts" }).denied);

console.log("\n== 配置热更新（savePermission 后立即生效） ==");
savePermission({
  activeMode: "manual",
  customProfiles: {},
  resourceAuthorization: {
    tools: { allow: [], deny: [] },
    filesystem: { readWrite: [], readOnly: [] },
    network: { allow: [], deny: [] },
  },
  approvalTimeoutMs: 120000,
});
expectAllow("清空后 delete_file 不再拦截", isDenied("delete_file", { path: "x.txt" }).denied);
expect("清空后 notes/ 不再自动放行", isAutoApproved("write_file", { path: "notes/a.txt" }), false);

// 清理临时目录
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n✓ 审批资源授权（文件后端）验证通过");
