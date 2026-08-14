/**
 * 配置注入（config.ts）验证脚本 —— 纯函数断言，无外部依赖。
 * 覆盖：configure 注入、getConfig 默认回退、resetConfig 清理、envValue 优先级、basePath 拼接。
 * 运行：npx tsx tests/unit/test-config.ts
 */
import path from "node:path";
import {
  basePath,
  configure,
  envValue,
  getApprovalTimeoutMs,
  getConfig,
  getDefaultModel,
  getDefaultProvider,
  resetConfig,
} from "../../lib/config";

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

console.log("== 默认回退（未 configure） ==");
resetConfig();
const d = getConfig();
expectEq("默认 baseDir = process.cwd()", d.baseDir, process.cwd());
if (!d.env) fail("默认 env 应存在（回退 process.env）");
console.log("  ✓ 默认 env 存在");

console.log("\n== configure 注入自定义 baseDir 与 env ==");
const customDir = "/tmp/prysm-test-config";
const customEnv = { MY_APP_KEY: "abc", PORT: "3001" };
configure({ baseDir: customDir, env: customEnv });
const c1 = getConfig();
expectEq("注入后 baseDir 生效", c1.baseDir, customDir);
expectEq("注入后 env 生效", c1.env, customEnv);

console.log("\n== envValue 读取优先级 ==");
process.env.TEST_INJECTED_KEY = "from-process";
expectEq("未注入 env 时回退 process.env", (() => {
  resetConfig();
  return envValue("TEST_INJECTED_KEY");
})(), "from-process");
configure({ baseDir: customDir, env: { TEST_INJECTED_KEY: "from-injected" } });
expectEq(
  "注入 env 时优先注入值",
  envValue("TEST_INJECTED_KEY"),
  "from-injected",
);
expectEq(
  "注入 env 不存在时回退 process.env",
  envValue("TEST_INJECTED_KEY_NOT_IN_ENV"),
  undefined,
);
delete process.env.TEST_INJECTED_KEY;

console.log("\n== basePath 路径拼接 ==");
resetConfig();
const cwd = process.cwd();
expectEq("basePath() 无参数 = baseDir", basePath(), cwd);
expectEq(
  "basePath('a','b','c.txt') 拼接",
  basePath("a", "b", "c.txt"),
  path.resolve(cwd, "a", "b", "c.txt"),
);
configure({ baseDir: customDir });
expectEq(
  "注入后 basePath 使用自定义 baseDir",
  basePath("data", "x.json"),
  path.resolve(customDir, "data", "x.json"),
);

console.log("\n== resetConfig 可重现 ==");
configure({ baseDir: "/x" });
resetConfig();
const afterReset = getConfig();
if (afterReset.baseDir === "/x") fail("resetConfig 应清理注入");
expectEq("reset 后回到 process.cwd()", afterReset.baseDir, process.cwd());

console.log("\n== 模型/审批默认值访问器 ==");
resetConfig();
expectEq("默认 provider 兜底 anthropic", getDefaultProvider(), "anthropic");
expectEq("默认 model 兜底 claude-sonnet-4-5", getDefaultModel(), "claude-sonnet-4-5");
expectEq("默认审批超时兜底 120000", getApprovalTimeoutMs(), 120000);
process.env.MODEL_PROVIDER = "deepseek";
process.env.MODEL_ID = "deepseek-chat";
expectEq("env MODEL_PROVIDER 生效", getDefaultProvider(), "deepseek");
expectEq("env MODEL_ID 生效", getDefaultModel(), "deepseek-chat");
expectEq("env APPROVAL_TIMEOUT_MS 生效", (() => {
  process.env.APPROVAL_TIMEOUT_MS = "5000";
  return getApprovalTimeoutMs();
})(), 5000);
delete process.env.MODEL_PROVIDER;
delete process.env.MODEL_ID;
delete process.env.APPROVAL_TIMEOUT_MS;
expectEq("注入 defaultProvider 优先于 env", (() => {
  process.env.MODEL_PROVIDER = "openai";
  const v = getDefaultProvider();
  delete process.env.MODEL_PROVIDER;
  return v;
})(), "openai");
configure({ baseDir: customDir, defaultProvider: "google", defaultModel: "gemini-x", approvalTimeoutMs: 9999 });
expectEq("注入 defaultProvider 覆盖 env", getDefaultProvider(), "google");
expectEq("注入 defaultModel 覆盖 env", getDefaultModel(), "gemini-x");
expectEq("注入 approvalTimeoutMs 覆盖 env", getApprovalTimeoutMs(), 9999);

console.log("\n✓ 配置注入验证通过");
resetConfig();
process.exit(0);
