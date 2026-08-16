/**
 * 会话级工作目录上下文（lib/agent-context.ts）验证脚本
 * 覆盖：setSessionWorkdir / getSessionWorkdir / clearSessionWorkdir / listSessionWorkdirs
 *      —— 新增核心逻辑：会话可独立绑定工作目录，替代全局共享的 agent-workdir。
 *      —— 内存级 Map，进程生命周期内生效，重启后清空（与 SQLite 会话元数据解耦）。
 * 运行：npx tsx tests/unit/test-agent-context.ts
 */
import {
  setSessionWorkdir,
  getSessionWorkdir,
  clearSessionWorkdir,
  listSessionWorkdirs,
} from "../../lib/agent-context";

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

// 清理：确保测试开始前为空
for (const sid of Object.keys(listSessionWorkdirs())) clearSessionWorkdir(sid);

console.log("== 初始为空 ==");
expectEq("初始 getSessionWorkdir 返回 undefined", getSessionWorkdir("s1"), undefined);
expectEq("初始 listSessionWorkdirs 为空", Object.keys(listSessionWorkdirs()).length, 0);

console.log("\n== set / get / clear 基本语义 ==");
setSessionWorkdir("s1", "/project/a");
expectEq("set 后 get 命中", getSessionWorkdir("s1"), "/project/a");
expectEq("list 含 s1", listSessionWorkdirs()["s1"], "/project/a");

setSessionWorkdir("s2", "/project/b");
expectEq("第二个会话绑定独立", getSessionWorkdir("s2"), "/project/b");
expectEq("s1 仍保留", getSessionWorkdir("s1"), "/project/a");
expectEq("list 包含 2 个会话", Object.keys(listSessionWorkdirs()).length, 2);

console.log("\n== 覆盖更新 + 清理 ==");
setSessionWorkdir("s1", "/project/a-v2");
expectEq("同一会话覆盖更新生效", getSessionWorkdir("s1"), "/project/a-v2");
expectEq("list 不会重复", Object.keys(listSessionWorkdirs()).length, 2);

clearSessionWorkdir("s1");
expectEq("clear 后返回 undefined", getSessionWorkdir("s1"), undefined);
expectEq("list 减少一个", Object.keys(listSessionWorkdirs()).length, 1);
expectEq("s2 不受影响", getSessionWorkdir("s2"), "/project/b");

console.log("\n== 并发会话隔离（模拟多会话切换） ==");
setSessionWorkdir("sess-work", "/work/reports");
setSessionWorkdir("sess-coding", "/code/prysm");
setSessionWorkdir("sess-chat", "");
expectEq("空字符串 workdir 仍被视为绑定（非 undefined）", getSessionWorkdir("sess-chat"), "");
expectEq("工作形态会话隔离", getSessionWorkdir("sess-work"), "/work/reports");
expectEq("编码形态会话隔离", getSessionWorkdir("sess-coding"), "/code/prysm");

console.log("\n== listSessionWorkdirs 返回的是快照（非引用） ==");
const snapshot = listSessionWorkdirs();
clearSessionWorkdir("sess-work");
expectEq("快照不随 clear 变化", snapshot["sess-work"], "/work/reports");
expectEq("底层已删除", getSessionWorkdir("sess-work"), undefined);

console.log("\n== 空会话 id 与空 workdir 边界 ==");
setSessionWorkdir("", "/root");
expectEq("空字符串 sessionId 可正常存取", getSessionWorkdir(""), "/root");
clearSessionWorkdir("");

console.log("\n== 清理全部测试数据 ==");
for (const sid of Object.keys(listSessionWorkdirs())) clearSessionWorkdir(sid);
expectEq("清理后为空", Object.keys(listSessionWorkdirs()).length, 0);

console.log("\n✓ 会话级工作目录上下文验证通过");
process.exit(0);
