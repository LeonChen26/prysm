/**
 * 权限与审批配置（permission.ts）验证脚本 —— 纯函数断言。
 * 覆盖：默认配置、模式→决策方映射、commandRules 匹配（精确/前缀/正则/优先级）、
 *      mcpRules 匹配（精确/通配/裸 server）、场景开关、保存/加载往返、
 *      LLM Guardian 输出解析（guardian.ts 纯函数）。
 * 运行：npx tsx test-permission.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configure } from "../../lib/config";
import {
  getPermission,
  savePermission,
  reloadPermission,
  setActiveMode,
  getReviewer,
  getSceneRules,
  isFullAccessMode,
  matchCommandRule,
  matchMcpRule,
  ensurePermissionFile,
  getFileApprovalTimeoutMs,
  type PermissionConfig,
} from "../../lib/permission";
import { parseGuardianOutput } from "../../lib/guardian";

// 隔离 baseDir：写入临时目录，不污染项目
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-perm-"));
configure({ baseDir: tmp });

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expectEq(name: string, actual: unknown, want: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${name} = ${JSON.stringify(actual)}`);
}

console.log("== 默认配置 ==");
expectEq("默认模式", getPermission().activeMode, "manual");
expectEq("默认决策方", getReviewer(), "user");
expectEq(
  "默认场景开关",
  getSceneRules(),
  { commandAstDangerChecker: true, deleteToolApproval: true, mcpToolApproval: true },
);
expectEq("默认工具白名单", getPermission().resourceAuthorization.tools.allow, ["append_file"]);
expectEq("默认工具黑名单", getPermission().resourceAuthorization.tools.deny, ["delete_file"]);
expectEq("默认路径白名单", getPermission().resourceAuthorization.filesystem.readWrite, ["notes/", "*.md", "sub/dir"]);
expectEq("默认审批超时", getFileApprovalTimeoutMs(), 120000);

console.log("\n== 模式 → 决策方映射 ==");
setActiveMode("auto");
expectEq("auto → reviewer=llm", getReviewer(), "llm");
setActiveMode("manual");
expectEq("manual → reviewer=user", getReviewer(), "user");
setActiveMode("full");
expectEq("full → 完全访问", isFullAccessMode(), true);

console.log("\n== 自定义 profile（custom 模式生效） ==");
setActiveMode("custom");
const custom: PermissionConfig = getPermission();
custom.customProfiles.default.approval.reviewer = "always_deny";
custom.customProfiles.default.approval.sceneRules.deleteToolApproval = true;
custom.customProfiles.default.approval.commandRules = {
  "git status": { approval: "ask" },
  "git add *": { approval: "allow" },
  "r/rm\\s+-rf/": { approval: "deny" },
};
custom.customProfiles.default.approval.mcpRules = {
  github__create_issue: { approval: "allow" },
  "github__*": { approval: "ask" },
  "internal-admin": { approval: "deny" },
};
savePermission(custom);
reloadPermission();
expectEq("custom 决策方持久化", getReviewer(), "always_deny");
expectEq("custom 场景开关持久化", getSceneRules().deleteToolApproval, true);

console.log("\n== commandRules 匹配 ==");
expectEq("精确 git status → ask", matchCommandRule("git status")?.action, "ask");
expectEq("精确带尾随空格", matchCommandRule("  git status  ")?.action, "ask");
expectEq("前缀 git add * → allow", matchCommandRule("git add src/a.ts")?.action, "allow");
expectEq("前缀 git add *（.）", matchCommandRule("git add .")?.action, "allow");
expectEq("正则 rm -rf / → deny", matchCommandRule("rm -rf /")?.action, "deny");
expectEq("正则 rm -rf 目录 → deny", matchCommandRule("rm -rf node_modules")?.action, "deny");
expectEq("未命中 npm i → undefined", matchCommandRule("npm i lodash"), undefined);
expectEq("未命中精确（git add 无 * 语义）", matchCommandRule("git statusx"), undefined);

console.log("\n== mcpRules 匹配 ==");
expectEq(
  "精确 github__create_issue → allow",
  matchMcpRule("mcp__github__create_issue")?.action,
  "allow",
);
expectEq(
  "通配 github__*（未配置工具）→ ask",
  matchMcpRule("mcp__github__delete_issue")?.action,
  "ask",
);
expectEq(
  "裸 server internal-admin → deny",
  matchMcpRule("mcp__internal-admin__run")?.action,
  "deny",
);
expectEq("未命中 server → undefined", matchMcpRule("mcp__unknown__x"), undefined);

console.log("\n== 文件落盘 ==");
ensurePermissionFile();
expectEq("配置文件已生成", fs.existsSync(path.join(tmp, "permission", "global.json")), true);
// 超时支持数字或字符串（normalizeConfig 解析后统一为数字）
savePermission({
  ...getPermission(),
  approvalTimeoutMs: "90000" as unknown as number,
});
reloadPermission();
expectEq("字符串超时解析为数字", getFileApprovalTimeoutMs(), 90000);

console.log("\n== LLM Guardian 输出解析 ==");
expectEq(
  "allow 解析",
  parseGuardianOutput('{"allow":true,"reason":"常规操作"}'),
  { allow: true, reason: "常规操作" },
);
expectEq("deny 解析", parseGuardianOutput('{"allow":false}')?.allow, false);
expectEq("非法 JSON → null", parseGuardianOutput("无法解析"), null);
expectEq("allow 非布尔 → null", parseGuardianOutput('{"allow":"yes"}'), null);

// 清理临时目录
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n✓ 权限配置验证通过");
