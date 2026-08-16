/**
 * 偏好记忆（lib/preference-memory.ts）验证脚本。
 * 覆盖：文件路径与工作目录编码、追加去重、关键词删除、清空、
 *      注入组装（全局+项目两级、无内容空串）、备份导出/恢复。
 * 运行：npx tsx tests/unit/test-preference-memory.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configure, resetConfig } from "../../lib/config";
import {
  globalMemoryPath,
  projectMemoryPath,
  encodeWorkdir,
  readPreferenceMemory,
  upsertPreference,
  removePreference,
  clearPreference,
  listPreferenceEntries,
  buildPreferencePrompt,
  dumpPreferenceMemory,
  restorePreferenceMemory,
} from "../../lib/preference-memory";

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
function expectTrue(name: string, cond: boolean) {
  if (!cond) fail(name);
  console.log(`  ✓ ${name}`);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-prefmem-"));
configure({ baseDir: base, env: process.env });

const WD = path.join("E:", "code", "dev"); // E:\code\dev

console.log("== 路径与编码 ==");
{
  expectEq("全局记忆文件", path.basename(globalMemoryPath()), "user_profile.md");
  expectEq("项目记忆文件（按工作区）", path.basename(projectMemoryPath(WD)), "project_memory.md");
  expectEq(
    "工作目录编码（盘符冒号/分隔符→_）",
    encodeWorkdir(WD),
    path.join("E", "code", "dev").replace(/\\/g, "_"),
  );
  expectTrue("项目文件位于 projects/<编码> 下", projectMemoryPath(WD).includes(path.join("projects", encodeWorkdir(WD))));
}

console.log("\n== 追加去重（upsert） ==");
{
  expectEq("首次追加 2 条", upsertPreference("global", "偏好使用中文回答\n- 偏好简洁", undefined), 2);
  expectEq("相同行去重不再新增", upsertPreference("global", "偏好使用中文回答", undefined), 0);
  expectEq("全局条目数", listPreferenceEntries("global").length, 2);
  // 空内容不写入
  expectEq("空内容返回 0", upsertPreference("global", "  ", undefined), 0);
}

console.log("\n== 项目记忆按工作区区分 ==");
{
  expectEq("项目（工作区A）首写", upsertPreference("project", "本项目用 pnpm", WD), 1);
  expectEq("项目（工作区A）读取", readPreferenceMemory("project", WD).includes("本项目用 pnpm"), true);
  expectEq("全局记忆不受项目写入影响", listPreferenceEntries("global").length, 2);
}

console.log("\n== 关键词删除（remove） ==");
{
  expectEq("删除包含关键词的条目", removePreference("global", "简洁", undefined), 1);
  expectEq("未命中返回 0", removePreference("global", "不存在的词", undefined), 0);
  expectEq("删除后剩余 1 条", listPreferenceEntries("global").length, 1);
  expectEq("空关键词返回 0", removePreference("global", "", undefined), 0);
}

console.log("\n== 注入组装（buildPreferencePrompt） ==");
{
  const p = buildPreferencePrompt(WD);
  expectTrue("包含引导说明", p.includes("remember_memory"));
  expectTrue("包含全局段", p.includes("全局：") && p.includes("偏好使用中文回答"));
  expectTrue("包含项目段", p.includes("项目（当前工作区") && p.includes("本项目用 pnpm"));
  // 无记忆时返回空串
  clearPreference("global");
  clearPreference("project", WD);
  expectEq("清空后注入为空串", buildPreferencePrompt(WD), "");
}

console.log("\n== 备份导出 / 恢复 ==");
{
  upsertPreference("global", "全局条目", undefined);
  upsertPreference("project", "项目条目", WD);
  const dump = dumpPreferenceMemory();
  expectTrue("导出含全局", dump.global.includes("全局条目"));
  expectTrue("导出含项目（按编码 key）", Object.values(dump.projects).some((c) => c.includes("项目条目")));

  clearPreference("global");
  clearPreference("project", WD);
  expectEq("清空后全局为空", listPreferenceEntries("global").length, 0);

  restorePreferenceMemory(dump);
  expectTrue("恢复后含全局", listPreferenceEntries("global").some((l) => l.includes("全局条目")));
  expectTrue("恢复后含项目", listPreferenceEntries("project", WD).some((l) => l.includes("项目条目")));

  // 非法 key 防御
  restorePreferenceMemory({ projects: { "..\\evil": "x" } });
  expectTrue("非法编码 key 被跳过", !fs.existsSync(path.join(base, "memory", "projects", "..\\evil")));
}

console.log("\n== 注入含 Markdown 标题过滤 ==");
{
  upsertPreference("global", "# 标题\n- 实际条目", undefined);
  const entries = listPreferenceEntries("global");
  expectTrue("标题行被过滤", !entries.includes("# 标题"));
  expectTrue("条目行保留", entries.includes("- 实际条目"));
}

resetConfig();
console.log("\n✓ 偏好记忆验证通过");
process.exit(0);
