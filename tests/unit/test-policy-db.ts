/**
 * policy 数据源注入（Phase 2）验证脚本 —— 纯结构断言，无 LLM 调用。
 * 覆盖：env 一次性导入 policy 表、增删查（可视化）、工具通配（mcp__* 与 skill__*）、
 *      configurePolicy 注入覆盖、reload/reset、approval_timeout_ms 持久化。
 * 注意：须在 configure 之后才导入 policy（避免模块加载时以默认 cwd/env 播种）。
 * 运行：npx tsx tests/unit/test-policy-db.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configure, resetConfig } from "../../lib/config";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expect(name: string, actual: boolean, want = true) {
  if (actual !== want) {
    fail(`${name}: 期望 ${want}，实际 ${actual}`);
  }
  console.log(`  ✓ ${name}`);
}

async function main() {
  const base = path.join(os.tmpdir(), "prysm-test-policy-db");
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });

  configure({
    baseDir: base,
    env: {
      APPROVAL_ALLOW_TOOLS: "append_file",
      APPROVAL_DENY_TOOLS: "delete_file",
      APPROVAL_DENY_COMMANDS: "rm -rf /,| sh",
      APPROVAL_TIMEOUT_MS: "30000",
    },
  });

  const policy = await import("../../lib/policy");

  console.log("== env 一次性导入 policy 表 ==");
  const seeded = policy.listPolicyRules();
  const kinds = new Set(seeded.map((r) => r.kind));
  if (!kinds.has("allow_tools")) fail("应有 allow_tools 规则");
  if (!seeded.some((r) => r.kind === "allow_tools" && r.value === "append_file")) {
    fail("allow_tools 应含 append_file");
  }
  if (!seeded.some((r) => r.kind === "deny_commands" && r.value === "rm -rf /")) {
    fail("deny_commands 应含 rm -rf /（逗号拆分多条）");
  }
  if (!seeded.some((r) => r.kind === "deny_commands" && r.value === "| sh")) {
    fail("deny_commands 应含 | sh（逗号拆分多条）");
  }
  if (!seeded.some((r) => r.kind === "approval_timeout_ms" && r.value === "30000")) {
    fail("approval_timeout_ms 应从 env 导入");
  }
  console.log(`  ✓ env 规则导入 ${seeded.length} 条`);

  console.log("\n== 策略生效（走 SQLite 表） ==");
  expect("deny delete_file", policy.isDenied("delete_file", { path: "x.txt" }).denied);
  expect("allow append_file", policy.isAutoApproved("append_file", { path: "x.txt" }));
  expect("deny rm -rf /", policy.isDenied("run_bash", { command: "rm -rf /" }).denied);
  expect("write_file 不拦截", !policy.isDenied("write_file", { path: "a.ts" }).denied);

  console.log("\n== 工具通配（mcp__* / skill__*） ==");
  policy.addPolicyRule("deny_tools", "mcp__*");
  policy.addPolicyRule("deny_tools", "skill__*");
  expect("mcp 工具被通配拦截", policy.isDenied("mcp__filesystem_read", {}).denied);
  expect("skill 工具被通配拦截", policy.isDenied("skill__code_review", {}).denied);
  expect("非通配命中工具不受影响", !policy.isDenied("web_search", {}).denied);

  console.log("\n== 删除规则后通配失效 ==");
  const mcpRule = policy
    .listPolicyRules()
    .find((r) => r.kind === "deny_tools" && r.value === "mcp__*");
  if (!mcpRule) fail("应找到 mcp__* 规则");
  const removed = policy.removePolicyRule(mcpRule.id);
  expect("删除返回 true", removed);
  expect("删除后 mcp 工具不再拦截", !policy.isDenied("mcp__filesystem_read", {}).denied);

  console.log("\n== configurePolicy 注入接管（优先级最高） ==");
  policy.configurePolicy({ denyTools: ["write_file"] });
  expect("注入 deny write_file", policy.isDenied("write_file", { path: "a" }).denied);
  expect("注入接管后 delete_file 不再拦截", !policy.isDenied("delete_file", { path: "a" }).denied);
  expect("注入未覆盖 deny_commands 仍生效", policy.isDenied("run_bash", { command: "rm -rf /" }).denied);

  console.log("\n== resetPolicy 回退 SQLite/env ==");
  policy.resetPolicy();
  expect("reset 后 delete_file 恢复拦截", policy.isDenied("delete_file", { path: "a" }).denied);
  expect("reset 后 write_file 不拦截", !policy.isDenied("write_file", { path: "a" }).denied);

  console.log("\n== approval_timeout_ms 持久化读取 ==");
  if (policy.getPolicyApprovalTimeoutMs() !== 30000) {
    fail(`审批超时应为 30000，实际 ${policy.getPolicyApprovalTimeoutMs()}`);
  }
  console.log("  ✓ 审批超时从 policy 表读取 = 30000ms");

  console.log("\n✓ policy 数据源注入 + 通配验证通过");
  resetConfig();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
