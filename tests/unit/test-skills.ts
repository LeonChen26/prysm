/**
 * Skill 机制（lib/skills.ts + lib/tools/skill.ts + registry 集成）验证脚本。
 * 覆盖：SKILL.md 解析（frontmatter/正文/frontmatter 缺失降级）、生命周期（加载/启用/禁用/热重载）、
 *      项目/全局双目录（source 标记 + 同名项目优先）、索引注入（buildSkillIndex）、
 *      SkillToolProvider 工具筛选、registry 集成（同名由 builtin 兜底）。
 * 运行：npx tsx tests/unit/test-skills.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configure, resetConfig } from "../../lib/config";
import { resetSkills, loadSkills, parseSkillMd, initSkills, reloadSkills, listSkills, enableSkill, disableSkill, enabledSkillNames, enabledSkillTools, buildSkillIndex, getSkillByName, isSkillEnabled, getGlobalSkillsDir, ensureGlobalSkillsDir, skillRoot, createSkill, deleteSkill, type SkillDef } from "../../lib/skills";
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

  // getSkillByName / isSkillEnabled（use_skill 工具依赖）
  expectEq("getSkillByName 命中", getSkillByName("fmt")?.name, "fmt");
  expectEq("getSkillByName 未命中", getSkillByName("ghost"), undefined);
  expectTrue("isSkillEnabled 启用态", isSkillEnabled("fmt"));
  disableSkill("fmt");
  expectTrue("isSkillEnabled 禁用态", !isSkillEnabled("fmt"));
  enableSkill("fmt");
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

console.log("\n== 可视化增删：createSkill / deleteSkill ==");
{
  resetSkills();
  const dir = makeSkillsDir({});
  const s = createSkill({ name: "new-skill", description: "测试技能" }, dir);
  expectEq("创建后登记 name", s.name, "new-skill");
  expectEq("创建后登记 description", s.description, "测试技能");
  expectTrue("SKILL.md 文件已生成", fs.existsSync(path.join(dir, "new-skill", "SKILL.md")));
  expectEq("新技能默认启用", listSkills().find((x) => x.name === "new-skill")?.enabled, true);

  // 重名 → 抛错
  let dupErr = "";
  try {
    createSkill({ name: "new-skill" }, dir);
  } catch (e) {
    dupErr = (e as Error).message;
  }
  expectTrue("重名创建被拒绝", dupErr.includes("已存在"));

  // 非法名称（目录穿越）→ 抛错
  let badErr = "";
  try {
    createSkill({ name: "../evil" }, dir);
  } catch (e) {
    badErr = (e as Error).message;
  }
  expectTrue("非法名称被拒绝", badErr.includes("名称非法"));

  // 删除
  expectTrue("deleteSkill 成功", deleteSkill("new-skill", dir));
  expectEq("删除后不再登记", listSkills().some((x) => x.name === "new-skill"), false);
  expectEq("目录已删除", fs.existsSync(path.join(dir, "new-skill")), false);
  expectEq("删除不存在的返回 false", deleteSkill("ghost", dir), false);
}

console.log("\n== buildSkillIndex 索引注入（名称+描述，不含正文） ==");
{
  resetSkills();
  const dir = makeSkillsDir({
    "s1/SKILL.md": "---\ndescription: 技能一描述\n---\ns1 正文",
    "s2/SKILL.md": "s2 正文",
  });
  initSkills(dir);
  const index = buildSkillIndex();
  expectTrue("包含 s1 名称+描述", index.includes("- s1: 技能一描述"));
  expectTrue("包含 s2 名称（无描述）", index.includes("- s2"));
  expectTrue("不含技能正文", !index.includes("s1 正文") && !index.includes("s2 正文"));
  expectTrue("含按需加载指引（use_skill）", index.includes("use_skill"));
}

console.log("\n== buildSkillIndex 空（无启用技能） ==");
{
  resetSkills();
  const dir = makeSkillsDir({ "s/SKILL.md": "正文" });
  initSkills(dir);
  disableSkill("s");
  expectEq("禁用后索引为空串", buildSkillIndex(), "");
}

console.log("\n== 项目/全局双目录：source 标记 + 同名项目优先 ==");
{
  resetSkills();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-skillbase-"));
  const projDir = path.join(base, "project", "skills");
  const globalDir = path.join(base, "global", "skills");
  const writeSkill = (root: string, name: string, content: string) => {
    const p = path.join(root, name, "SKILL.md");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf-8");
  };
  writeSkill(projDir, "shared", "---\ndescription: 项目版 shared\n---\n项目正文\n");
  writeSkill(globalDir, "shared", "---\ndescription: 全局版 shared\n---\n全局正文\n");
  writeSkill(globalDir, "gonly", "---\ndescription: 仅全局\n---\n全局专属正文\n");
  configure({ baseDir: base, env: process.env, skillsDir: projDir, globalSkillsDir: globalDir });

  const skills = loadSkills();
  expectEq("登记名称（项目+全局）", skills.map((s) => s.name).sort(), ["gonly", "shared"]);
  const shared = skills.find((s) => s.name === "shared");
  expectEq("同名项目优先（source）", shared?.source, "project");
  expectEq("同名项目优先（正文取项目）", shared?.body, "项目正文");
  const gonly = skills.find((s) => s.name === "gonly");
  expectEq("全局技能 source", gonly?.source, "global");
  expectEq("全局技能正文", gonly?.body, "全局专属正文");

  expectEq("getGlobalSkillsDir", getGlobalSkillsDir(), globalDir);
  expectEq("skillRoot(global)", skillRoot("global"), globalDir);
  expectEq("skillRoot(project)", skillRoot("project"), projDir);

  // 全局目录 create/delete
  const g = createSkill({ name: "gnew", description: "全局新建" }, globalDir);
  expectEq("创建全局技能 source", g.source, "global");
  expectTrue("文件生成于全局目录", fs.existsSync(path.join(globalDir, "gnew", "SKILL.md")));
  expectTrue("删除全局技能", deleteSkill("gnew", globalDir));
  expectEq("全局目录已删除", fs.existsSync(path.join(globalDir, "gnew")), false);

  resetConfig();
}

console.log("\n== 全局目录不可写 → 自动回退到 baseDir/global-skills 并持久化 ==");
{
  resetSkills();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-skillfallback-"));
  // 用"父路径是文件"构造不可写目录（mkdir recursive 必然失败）
  const blockFile = path.join(base, "blocker");
  fs.writeFileSync(blockFile, "x", "utf-8");
  const badGlobal = path.join(blockFile, "skills");
  configure({ baseDir: base, env: process.env, globalSkillsDir: badGlobal });

  const dir = ensureGlobalSkillsDir();
  const fallback = path.join(base, "global-skills");
  expectEq("回退到 baseDir/global-skills", dir, fallback);
  expectTrue("回退目录已创建", fs.existsSync(fallback));
  expectEq("持久化记住回退（getGlobalSkillsDir 读持久化）", getGlobalSkillsDir(), fallback);
  // 回退后经 skillRoot 创建全局技能，source 仍为 global
  const s = createSkill({ name: "gb", description: "回退后全局技能" }, skillRoot("global"));
  expectEq("回退后创建全局技能 source", s.source, "global");
  expectTrue("技能文件落在回退目录", fs.existsSync(path.join(fallback, "gb", "SKILL.md")));

  resetConfig();
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