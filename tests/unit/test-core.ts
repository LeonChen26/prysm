/**
 * Core 工厂（core.ts）验证脚本 —— 纯结构断言，无 LLM 调用。
 * 覆盖：createCore 返回 PrysmCore 接口、configure 注入生效（baseDir/env）、
 *      listWorkspaces/resolveWorkspace 形状、eventBus 可用。
 * 运行：npx tsx tests/unit/test-core.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCore } from "../../lib/core";
import { configure, getConfig } from "../../lib/config";
import { requestApproval, resolveApproval } from "../../lib/approval";
import { proposePlan, decidePlan, listPendingPlans } from "../../lib/plan";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expectEq(name: string, actual: unknown, want: unknown) {
  const ok =
    typeof actual === "object" && typeof want === "object"
      ? JSON.stringify(actual) === JSON.stringify(want)
      : actual === want;
  if (!ok) {
    fail(
      `${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`,
    );
  }
  console.log(`  ✓ ${name}`);
}

console.log("== createCore 返回完整接口 ==");
const customDir = path.join(os.tmpdir(), "prysm-test-core");
fs.mkdirSync(customDir, { recursive: true });
const core = createCore({ baseDir: customDir, env: { FOO: "bar" } });
for (const method of ["getAgent", "listSessions", "createSession", "listWorkspaces", "resolveWorkspace"]) {
  if (typeof (core as unknown as Record<string, unknown>)[method] !== "function") {
    fail(`core.${method} 应为函数`);
  }
}
for (const m of ["emit", "subscribe"]) {
  if (typeof (core.eventBus as unknown as Record<string, unknown>)[m] !== "function") {
    fail(`core.eventBus.${m} 应为函数`);
  }
}
console.log("  ✓ getAgent/listSessions/createSession/listWorkspaces/resolveWorkspace 为函数，eventBus 具备 emit/subscribe");

console.log("\n== configure 注入 baseDir/env 生效 ==");
expectEq("baseDir 注入到 config 上下文", getConfig().baseDir, customDir);
const list = core.listSessions();
expectEq("listSessions 为数组", Array.isArray(list), true);

console.log("\n== listWorkspaces / resolveWorkspace 形状 ==");
const ws = core.listWorkspaces();
expectEq("listWorkspaces 返回数组", Array.isArray(ws), true);
for (const w of ws) {
  if (!w.id || !w.name || !w.root) fail("WorkspaceInfo 应含 id/name/root");
}
const def = core.resolveWorkspace("any-session");
expectEq("resolveWorkspace 返回默认主工作区", def.id, "default");
expectEq("resolveWorkspace 主工作区路径含 agent-workdir", def.root.includes("agent-workdir"), true);

console.log("\n== createSession 支持 surface ==");
const sWork = core.createSession({ title: "surface-work", surface: "work" });
expectEq("createSession({surface:'work'}) 返回 work", sWork.surface, "work");
const sCoding = core.createSession({ title: "surface-coding" });
expectEq("createSession 缺省 surface 为 coding", sCoding.surface, "coding");

console.log("\n== eventBus 收发 ==");
const received: string[] = [];
const unsub = core.eventBus.subscribe((e) => received.push((e as { type: string }).type));
core.eventBus.emit({ type: "turn_start" } as never);
unsub();
core.eventBus.emit({ type: "turn_end" } as never);
expectEq("订阅收到 turn_start", received.join(","), "turn_start");

console.log("\n== Phase 7.5：核心层直接 emit —— 审批/计划事件注入共享 bus（带 sessionId） ==");
{
  const busEvents: { type: string; sessionId?: string; approve?: boolean }[] = [];
  const unsub75 = core.eventBus.subscribe((e) => {
    const ev = e as { type: string; sessionId?: string; approve?: boolean };
    busEvents.push({ type: ev.type, sessionId: ev.sessionId, approve: ev.approve });
  });
  // 审批事件：requestApproval → approval_required，resolveApproval → approval_resolved
  const p = requestApproval({
    id: "appr-75",
    toolName: "run_bash",
    args: { command: "whoami" },
    sessionId: "sess-75",
  });
  const req = busEvents.find((e) => e.type === "approval_required");
  expectEq("approval_required 已注入 bus", req?.type, "approval_required");
  expectEq("审批事件带 sessionId", req?.sessionId, "sess-75");
  resolveApproval("appr-75", true);
  const res = busEvents.find((e) => e.type === "approval_resolved");
  expectEq("approval_resolved 已注入 bus", res?.type, "approval_resolved");
  expectEq("resolved 携带 approve=true", res?.approve, true);
  expectEq("resolved 带 sessionId", res?.sessionId, "sess-75");
  await p;
  // 计划事件：proposePlan → plan_proposed，decidePlan → plan_decided
  const pp = proposePlan({
    sessionId: "sess-75",
    surface: "coding",
    summary: "测试计划",
    steps: [{ title: "步骤1", tool: "write_file", expected: "写入文件" }],
  });
  const prop = busEvents.find((e) => e.type === "plan_proposed");
  expectEq("plan_proposed 已注入 bus", prop?.type, "plan_proposed");
  expectEq("proposed 带 sessionId", prop?.sessionId, "sess-75");
  const pid = listPendingPlans("sess-75")[0].id;
  decidePlan(pid, true);
  const dec = busEvents.find((e) => e.type === "plan_decided");
  expectEq("plan_decided 已注入 bus", dec?.type, "plan_decided");
  expectEq("decided 带 sessionId", dec?.sessionId, "sess-75");
  await pp;
  unsub75();
}

console.log("\n✓ Core 工厂验证通过");
configure({ baseDir: process.cwd(), env: process.env });
process.exit(0);
