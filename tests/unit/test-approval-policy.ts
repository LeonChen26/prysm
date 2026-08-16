/**
 * 审批决策链纯函数（approval-policy.ts）验证脚本 —— 无副作用断言。
 * 覆盖：完全访问、规则裁决（命令/MCP deny|allow|ask）、资源授权白/黑名单优先级、
 *      场景开关（删除审批/MCP 审批）、决策方（user/llm/always_deny）与全部分支组合。
 * 运行：npx tsx test-approval-policy.ts
 */
import {
  decideApproval,
  type ApprovalPolicyInput,
} from "../../lib/approval-policy";
import type { Reviewer, SceneRules } from "../../lib/permission";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expect(name: string, cond: boolean, detail?: unknown) {
  if (!cond) fail(`${name}${detail !== undefined ? `（实际: ${JSON.stringify(detail)}）` : ""}`);
  console.log(`  ✓ ${name}`);
}

function expectAction(name: string, input: Partial<ApprovalPolicyInput>, want: string) {
  const d = decideApproval(buildInput(input));
  expect(`${name} → ${want}`, d.action === want, d);
}

/** 默认场景（与 permission.ts 默认一致：删除审批/MCP 审批默认开启） */
const DEFAULT_SCENE: SceneRules = {
  commandAstDangerChecker: true,
  deleteToolApproval: true,
  mcpToolApproval: true,
};

function buildInput(p: Partial<ApprovalPolicyInput>): ApprovalPolicyInput {
  return {
    toolName: "write_file",
    args: { path: "x.txt" },
    fullAccess: false,
    isMcp: false,
    ruleHit: undefined,
    policyDeny: { denied: false },
    policyAllow: false,
    scene: DEFAULT_SCENE,
    reviewer: "user",
    ...p,
  };
}

console.log("== 完全访问 ==");
const full = decideApproval(buildInput({ fullAccess: true, reviewer: "always_deny" }));
expect("即使命中 always_deny 也放行", full.action === "allow", full);
expect("原因含 完全访问", (full.reason ?? "").includes("完全访问"), full.reason);

console.log("\n== 规则裁决：命令规则 ==");
expectAction("命中 deny → deny", { ruleHit: { key: "r/rm\\s+-rf/", action: "deny" } }, "deny");
const cmdDeny = decideApproval(
  buildInput({ ruleHit: { key: "r/rm\\s+-rf/", action: "deny" }, policyAllow: true }),
);
expect("规则 deny 优先于白名单", cmdDeny.action === "deny", cmdDeny);
expectAction("命中 allow → allow", { ruleHit: { key: "git add *", action: "allow" } }, "allow");
expectAction("命中 ask → ask", { ruleHit: { key: "kill *", action: "ask" } }, "ask");
const askWithDeny = decideApproval(
  buildInput({ ruleHit: { key: "kill *", action: "ask" }, policyDeny: { denied: true, reason: "黑名单命令" } }),
);
expect("ask 不短路，资源授权黑名单仍拦截", askWithDeny.action === "deny", askWithDeny);

console.log("\n== 规则裁决：MCP 规则 ==");
expectAction("MCP 命中 deny → deny", { isMcp: true, toolName: "mcp__github__delete", ruleHit: { key: "github__*", action: "deny" } }, "deny");
expectAction("MCP 命中 allow → allow", { isMcp: true, toolName: "mcp__github__create", ruleHit: { key: "github__create", action: "allow" } }, "allow");
expectAction("MCP 命中 ask → ask", { isMcp: true, toolName: "mcp__github__x", ruleHit: { key: "github__*", action: "ask" } }, "ask");

console.log("\n== 资源授权白/黑名单 ==");
const bl = decideApproval(buildInput({ policyDeny: { denied: true, reason: "命中受保护路径" } }));
expect("黑名单 → deny 且原因透传", bl.action === "deny" && bl.reason === "命中受保护路径", bl);
expectAction("黑名单 + 白名单同时命中 → deny（黑名单优先）", { policyDeny: { denied: true }, policyAllow: true }, "deny");
const wl = decideApproval(buildInput({ policyAllow: true }));
expect("白名单 → allow", wl.action === "allow" && (wl.reason ?? "").includes("自动放行"), wl);
const ruleAllowBeatsBlacklist = decideApproval(
  buildInput({ ruleHit: { key: "git *", action: "allow" }, policyDeny: { denied: true } }),
);
expect("规则 allow 优先于资源授权黑名单", ruleAllowBeatsBlacklist.action === "allow", ruleAllowBeatsBlacklist);

console.log("\n== 场景开关：删除审批 ==");
const delOff = decideApproval(
  buildInput({ toolName: "delete_file", scene: { ...DEFAULT_SCENE, deleteToolApproval: false } }),
);
expect("deleteToolApproval=false → 直接放行", delOff.action === "allow", delOff);
const delOn = decideApproval(
  buildInput({ toolName: "delete_file", scene: { ...DEFAULT_SCENE, deleteToolApproval: true } }),
);
expect("deleteToolApproval=true → 仍走审批", delOn.action === "ask", delOn);

console.log("\n== 场景开关：MCP 审批 ==");
const mcpOffNoRule = decideApproval(
  buildInput({ isMcp: true, toolName: "mcp__srv__x", scene: { ...DEFAULT_SCENE, mcpToolApproval: false } }),
);
expect("mcpToolApproval=false 且无规则 → 放行", mcpOffNoRule.action === "allow", mcpOffNoRule);
const mcpOffWithRule = decideApproval(
  buildInput({ isMcp: true, toolName: "mcp__srv__x", ruleHit: { key: "srv__*", action: "ask" }, scene: { ...DEFAULT_SCENE, mcpToolApproval: false } }),
);
expect("mcpToolApproval=false 但有规则 → 按规则 ask", mcpOffWithRule.action === "ask", mcpOffWithRule);
const mcpOn = decideApproval(
  buildInput({ isMcp: true, toolName: "mcp__srv__x", scene: { ...DEFAULT_SCENE, mcpToolApproval: true } }),
);
expect("mcpToolApproval=true 且无规则 → ask", mcpOn.action === "ask", mcpOn);
const nonMcpUnaffected = decideApproval(
  buildInput({ toolName: "write_file", scene: { ...DEFAULT_SCENE, mcpToolApproval: false } }),
);
expect("非 MCP 工具不受 mcpToolApproval 影响", nonMcpUnaffected.action === "ask", nonMcpUnaffected);

console.log("\n== 决策方 reviewer ==");
const denyAlways = decideApproval(buildInput({ reviewer: "always_deny" }));
expect("always_deny → deny", denyAlways.action === "deny", denyAlways);
expect("always_deny 原因含 一律拒绝", (denyAlways.reason ?? "").includes("一律拒绝"), denyAlways.reason);
expectAction("user → ask", { reviewer: "user" }, "ask");
expectAction("llm → ask（Guardian 由调用方执行）", { reviewer: "llm" }, "ask");
const denyAlwaysBeatsScene = decideApproval(
  buildInput({ toolName: "delete_file", scene: { ...DEFAULT_SCENE, deleteToolApproval: false }, reviewer: "always_deny" }),
);
expect("场景开关放行优先于 always_deny", denyAlwaysBeatsScene.action === "allow", denyAlwaysBeatsScene);

console.log("\n== 默认路径（未命中一切 + user） ==");
const plain = decideApproval(buildInput({}));
expect("普通敏感操作 → ask", plain.action === "ask", plain);
expect("ask 不携带 reason", plain.reason === undefined, plain);

console.log("\n✓ 审批决策链验证通过");
