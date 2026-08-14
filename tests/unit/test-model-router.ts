/**
 * 多模型路由（lib/model-router.ts + config/prysm-db 集成）验证脚本。
 * 覆盖：路由优先级（注入 > 表 > 默认）、setModelRoute 持久化、listModelRoutes 合并、
 *      subagent 默认小模型、主模型跟随 defaultProvider/defaultModel。
 * 不触发真实 LLM 调用（不调 resolveModel，避免依赖 API Key）。
 * 运行：npx tsx tests/unit/test-model-router.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configure, resetConfig } from "../../lib/config";
import { resetPrysmDb } from "../../lib/prysm-db";
import {
  getModelRoute,
  listModelRoutes,
  resetModelRouter,
  resetModelRouterDb,
  setModelRoute,
} from "../../lib/model-router";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expectEq(name: string, actual: unknown, want: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${name}`);
}

function resetAll() {
  resetConfig();
  resetPrysmDb();
  resetModelRouterDb();
  resetModelRouter();
}

/** baseDir 目录 + configure（prysm.db 打开前需目录存在） */
function cfg(dir: string, extra?: Parameters<typeof configure>[0] extends infer C ? C : never) {
  fs.mkdirSync(dir, { recursive: true });
  configure({ baseDir: dir, env: { MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus" }, ...extra });
}

const ROLE_LIST = ["orchestrator", "subagent", "summarize", "title"];

console.log("== 默认路由（无注入、无表） ==");
{
  resetAll();
  cfg(path.join(os.tmpdir(), "prysm-model-router-a"), { env: { MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-chat" } });
  const r = getModelRoute("orchestrator");
  expectEq("orchestrator 跟随 defaultProvider", r, { provider: "deepseek", model: "deepseek-chat" });
  const sub = getModelRoute("subagent");
  expectEq("subagent 默认小模型", sub, { provider: "deepseek", model: "deepseek-chat" });
  const t = getModelRoute("title");
  expectEq("title 跟随主模型", t, { provider: "deepseek", model: "deepseek-chat" });
}

console.log("\n== 注入优先于表与默认 ==");
{
  resetAll();
  const dir = path.join(os.tmpdir(), "prysm-model-router-b");
  cfg(dir, { modelRoutes: { subagent: { provider: "openai", model: "gpt-4o" } } });
  expectEq("注入 subagent 覆盖", getModelRoute("subagent"), { provider: "openai", model: "gpt-4o" });
  expectEq("未注入 summarize 走默认", getModelRoute("summarize"), { provider: "anthropic", model: "claude-opus" });
}

console.log("\n== setModelRoute 持久化到表（表优先于默认，低于注入） ==");
{
  resetAll();
  const dir = path.join(os.tmpdir(), "prysm-model-router-c");
  cfg(dir);
  const written = setModelRoute("subagent", "google", "gemini-pro");
  expectEq("setModelRoute 返回写入值", written, { provider: "google", model: "gemini-pro" });
  expectEq("表写入后 getModelRoute 命中", getModelRoute("subagent"), { provider: "google", model: "gemini-pro" });
  // 注入仍最高优先级
  cfg(dir, { modelRoutes: { subagent: { provider: "deepseek", model: "deepseek-chat" } } });
  expectEq("注入覆盖表", getModelRoute("subagent"), { provider: "deepseek", model: "deepseek-chat" });
}

console.log("\n== listModelRoutes 合并全部角色 ==");
{
  resetAll();
  const dir = path.join(os.tmpdir(), "prysm-model-router-d");
  cfg(dir);
  const all = listModelRoutes();
  expectEq("含全部 4 个角色", Object.keys(all).sort(), ROLE_LIST);
  for (const role of ROLE_LIST) {
    if (!all[role as keyof typeof all]?.provider) fail(`${role} 应有 provider`);
    if (!all[role as keyof typeof all]?.model) fail(`${role} 应有 model`);
  }
  expectEq("orchestrator 目标", all.orchestrator, { provider: "anthropic", model: "claude-opus" });
}

console.log("\n== 表持久化跨实例（重新打开连接仍读到） ==");
{
  resetAll();
  const dir = path.join(os.tmpdir(), "prysm-model-router-e");
  cfg(dir);
  setModelRoute("summarize", "openai", "gpt-4o-mini");
  // 模拟重启：重置模块级连接缓存，重新读
  resetModelRouterDb();
  cfg(dir);
  expectEq("重启后仍读到 summarize 路由", getModelRoute("summarize"), { provider: "openai", model: "gpt-4o-mini" });
}

resetAll();
console.log("\n✓ 多模型路由验证通过");
process.exit(0);