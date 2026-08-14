/**
 * Skill 机制（lib/skills.ts + lib/tools/skill.ts + registry 集成）验证脚本。
 * 覆盖：SKILL.md 解析（frontmatter/正文/frontmatter 缺失降级）、生命周期（加载/启用/禁用/热重载）、
 *      提示词注入、SkillToolProvider 工具筛选、registry 集成（同名由 builtin 兜底）。
 * 运行：npx tsx tests/unit/test-skills.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configure, resetConfig } from "../../lib/config";
import { resetSkills, loadSkills, parseSkillMd, initSkills, reloadSkills, listSkills, enableSkill, disableSkill, enabledSkillNames, enabledSkillTools, buildSkillPrompt, type SkillDef } from "../../lib/skills";
import { skillToolProvider } from "../../lib/tools/skill";

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

// 构造一个临时 skills 目录
function makeSkillsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-skills-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf-8");
  }
  return dir;
}

const CODE_REVIEW_MD = `---
name: code-review
description: 代码评审助手
version: 1.0.0
tools: [read_file, list_dir, search_files]
---
你是资深代码评审专家。
评审时请检查：命名、边界条件、错误处理与可维护性。
`;

console.log("== SKILL.md 解析 ==");
{
  const s = parseSkillMd(CODE_REVIEW_MD, "fallback", "/tmp/skills/code-review");
  expectEq("name", s.name, "code-review");
  expectEq("version", s.version, "1.0.0");
  expectEq("description", s.description, "代码评审助手");
  expectEq("tools", s.tools, ["read_file", "list_dir", "search_files"]);
  expectTrue("正文包含指令", s.body.includes("资深代码评审专家"));
}

console.log("\n== frontmatter 缺失降级 ==");
{
  const s = parseSkillMd("没有 frontmatter 的正文。", "my-skill", "/tmp/skills/my-skill");
  expectEq("name 用目录名兜底", s.name, "my-skill");
  expectEq("tools 为空", s.tools, []);
  expectEq("body 取全文", s.body, "没有 frontmatter 的正文。");
}

console.log("\n== loadSkills 扫描目录（无 SKILL.md 的目录被忽略） ==");
{
  const dir = makeSkillsDir({
    "code-review/SKILL.md": CODE_REVIEW_MD,
    "empty-dir/README.md": "不是 skill",
    // 无 SKILL.md 的目录不算 skill
  });
  const skills = loadSkills(dir);
  expectEq("仅扫描到 code-review", skills.map((s) => s.name), ["code-review"]);
}

console.log("\n== 生命周期：init/reload 新技能默认启用，enable/disable 切换 ==");
{
  resetSkills();
  const dir = makeSkillsDir({ "fmt/SKILL.md": "---\ntools: [write_file]\n---\n格式化工具\n" });
  const skills = initSkills(dir);
  expectEq("initSkills 登记数量", skills.length, 1);
  expectEq("新技能默认启用", listSkills()[0].enabled, true);
  expectEq("enabledSkillNames", enabledSkillNames(), ["fmt"]);

  expectTrue("disableSkill 成功", disableSkill("fmt"));
  expectEq("禁用后 enabled 为空", enabledSkillNames(), []);
  expectEq("禁用后工具名单为空", enabledSkillTools(), []);

  expectTrue("enableSkill 重新启用", enableSkill("fmt"));
  expectEq("重新启用后工具名单", enabledSkillTools(), ["write_file"]);
}

console.log("\n== reload 热加载：新增技能默认启用，移除技能被清理 ==");
{
  resetSkills();
  const dir = makeSkillsDir({ "a/SKILL.md": "AA\n" });
  initSkills(dir);
  expectEq("初始登记", listSkills().map((s) => s.name), ["a"]);

  // 新增 b + 移除 a
  fs.mkdirSync(path.join(dir, "b"), { recursive: true });
  fs.writeFileSync(path.join(dir, "b", "SKILL.md"), "---\ntools: [web_search]\n---\nBB\n", "utf-8");
  fs.rmSync(path.join(dir, "a"), { recursive: true });
  const after = reloadSkills(dir);
  expectEq("reload 后仅剩 b", after.map((s) => s.name), ["b"]);
  expectEq("b 默认启用", listSkills()[0].enabled, true);
  expectEq("b 工具名单", enabledSkillTools(), ["web_search"]);
}

console.log("\n== buildSkillPrompt 注入 ==");
{
  resetSkills();
  const dir = makeSkillsDir({
    "s1/SKILL.md": "s1 正文",
    "s2/SKILL.md": "s2 正文",
  });
  initSkills(dir);
  const prompt = buildSkillPrompt();
  expectTrue("包含 s1", prompt.includes("【技能 s1】"));
  expectTrue("包含 s2", prompt.includes("【技能 s2】"));
  expectTrue("包含 s1 正文", prompt.includes("s1 正文"));
  expectTrue("包含 s2 正文", prompt.includes("s2 正文"));
}

console.log("\n== buildSkillPrompt 空（无启用技能） ==");
{
  resetSkills();
  const dir = makeSkillsDir({ "s/SKILL.md": "正文" });
  initSkills(dir);
  disableSkill("s");
  expectEq("禁用后 prompt 为空串", buildSkillPrompt(), "");
}

console.log("\n== SkillToolProvider 工具筛选 ==");
{
  resetSkills();
  const dir = makeSkillsDir({ "fmt/SKILL.md": "---\ntools: [read_file, common_missing]\n---\n格式化\n" });
  initSkills(dir);
  const provider = await skillToolProvider();
  const tools = await provider.load();
  // read_file 来自 builtin 工具集；common_missing 不在内置/MCP 中 → 被过滤
  const names = tools.map((t) => t.name).sort();
  expectEq("仅暴露存在的工具", names, ["read_file"]);
  expectEq("skill provider id", provider.id, "skill");
}

// 清理
resetConfig();
resetSkills();
console.log("\n✓ Skill 机制验证通过");
process.exit(0);