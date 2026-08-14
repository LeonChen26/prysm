/**
 * Skill 机制（Phase 4）
 * Skill = 可复用能力包 = 提示词片段 + 可选工具声明（对齐 pi 的 SKILL.md）。
 *
 * - 目录：<baseDir>/skills/<name>/SKILL.md（可经 PrysmConfig.skillsDir 指定）
 * - frontmatter：name / description / version / tools（声明该技能所需/可选用的工具名单）
 * - 注入：enabled 技能的正文拼入系统提示词（agent.ts getAgent 构造时）
 * - 工具：SkillToolProvider 按 enabled 技能声明的 tools 从内置/MCP 工具集中筛选暴露（同名注册）
 * - 生命周期：启用/禁用（模块级 enabled 集合，会话级语义）；开发期 reload 热加载
 *
 * 本模块只依赖 Node 内置与 config，不依赖 Next.js / pi-agent-core。
 */
import fs from "node:fs";
import path from "node:path";
import { basePath, getConfig } from "./config";

/** 单个 Skill 定义（由 SKILL.md 解析而来） */
export interface SkillDef {
  name: string;
  version?: string;
  description?: string;
  /** 声明该技能所需/可选用的工具名单（引用已有工具，Phase 4 不定义新工具实现） */
  tools: string[];
  /** SKILL.md 正文（注入系统提示词的片段） */
  body: string;
  /** 目录路径（便于定位） */
  path: string;
}

/** SKILL.md frontmatter 的宽松解析结果 */
interface Frontmatter {
  name?: string;
  description?: string;
  version?: string;
  tools?: string[];
}

/**
 * 解析 SKILL.md：提取 `---` 包裹的 frontmatter 与正文。
 * frontmatter 缺失 / 非法时降级：name 取目录名，body 取全文，不抛错。
 */
export function parseSkillMd(
  text: string,
  fallbackName: string,
  dir: string,
): SkillDef {
  let name = fallbackName;
  let version: string | undefined;
  let description: string | undefined;
  let tools: string[] = [];
  let body = text;

  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    const fm = parseFrontmatter(m[1]);
    name = fm.name ?? fallbackName;
    version = fm.version;
    description = fm.description;
    tools = fm.tools ?? [];
    body = text.slice(m[0].length).trim();
  }

  return { name, version, description, tools, body, path: dir };
}

/** 解析 frontmatter 键值行：支持 `key: value` 与 `tools: [a, b]` */
function parseFrontmatter(block: string): Frontmatter {
  const out: Frontmatter = {};
  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (key === "tools") {
      const list = raw
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length > 0) out.tools = list;
      continue;
    }
    if (!raw) continue;
    if (key === "name") out.name = raw;
    else if (key === "description") out.description = raw;
    else if (key === "version") out.version = raw;
  }
  return out;
}

// ------------------------------------------------------------ 生命周期

const loaded = new Map<string, SkillDef>();
const enabled = new Set<string>();
let scanned = false;

/** 扫描 skills 目录（默认 <baseDir>/skills，可经 skillsDir 指定），返回全部 SkillDef（纯函数） */
export function loadSkills(dir?: string): SkillDef[] {
  const root = dir ?? getConfig().skillsDir ?? basePath("skills");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillDef[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillDir = path.join(root, e.name);
    const md = path.join(skillDir, "SKILL.md");
    let text: string;
    try {
      text = fs.readFileSync(md, "utf-8");
    } catch {
      continue; // 目录无 SKILL.md → 不算 skill
    }
    out.push(parseSkillMd(text, e.name, skillDir));
  }
  return out;
}

/** 幂等加载并登记全部 skill（新技能默认启用）；返回登记结果 */
export function initSkills(dir?: string): SkillDef[] {
  if (scanned) return [...loaded.values()];
  scanned = true;
  return reloadSkills(dir);
}

/** 重新扫描（开发期热加载）：更新已登记技能，新增技能默认启用 */
export function reloadSkills(dir?: string): SkillDef[] {
  loaded.clear();
  for (const s of loadSkills(dir)) {
    loaded.set(s.name, s);
    if (!enabled.has(s.name)) enabled.add(s.name); // 新技能默认启用
  }
  return [...loaded.values()];
}

/** 全部已登记技能（含 enabled 状态） */
export function listSkills(): (SkillDef & { enabled: boolean })[] {
  return [...loaded.values()].map((s) => ({ ...s, enabled: enabled.has(s.name) }));
}

/** 启用某技能（未登记时自动扫描一次） */
export function enableSkill(name: string): boolean {
  if (!loaded.has(name)) initSkills();
  if (!loaded.has(name)) return false;
  enabled.add(name);
  return true;
}

/** 禁用某技能 */
export function disableSkill(name: string): boolean {
  if (!loaded.has(name)) return false;
  enabled.delete(name);
  return true;
}

// ------------------------------------------------------------ 可视化增删

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * 新建 Skill（界面可视化创建）：在 skills 目录创建 <name>/SKILL.md
 * （frontmatter 模板 + 正文），随后重扫登记（默认启用）。
 * 名称非法 / 已存在时抛错。
 */
export function createSkill(
  input: { name: string; description?: string; version?: string; tools?: string[]; body?: string },
  dir?: string,
): SkillDef {
  const name = input.name.trim();
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error("Skill 名称非法：仅允许字母/数字/下划线/连字符");
  }
  const root = dir ?? getConfig().skillsDir ?? basePath("skills");
  const skillDir = path.join(root, name);
  if (fs.existsSync(skillDir)) {
    throw new Error(`Skill "${name}" 已存在`);
  }
  const tools = (input.tools ?? []).map((t) => t.trim()).filter(Boolean);
  const fm: string[] = ["---", `name: ${name}`];
  const description = input.description?.trim();
  const version = input.version?.trim();
  if (description) fm.push(`description: ${description}`);
  if (version) fm.push(`version: ${version}`);
  if (tools.length > 0) fm.push(`tools: [${tools.join(", ")}]`);
  fm.push("---", "", input.body?.trim() ?? "");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), fm.join("\n") + "\n", "utf-8");
  reloadSkills(dir);
  const s = loaded.get(name);
  if (!s) throw new Error(`Skill "${name}" 创建后登记失败`);
  return s;
}

/** 删除 Skill（界面可视化删除）：删除 skills/<name> 目录并取消登记。不存在返回 false。 */
export function deleteSkill(name: string, dir?: string): boolean {
  const root = dir ?? getConfig().skillsDir ?? basePath("skills");
  const skillDir = path.join(root, name);
  if (!fs.existsSync(skillDir)) return false;
  fs.rmSync(skillDir, { recursive: true, force: true });
  enabled.delete(name);
  reloadSkills(dir);
  return true;
}

/** 已启用技能的名称列表 */
export function enabledSkillNames(): string[] {
  return [...loaded.keys()].filter((n) => enabled.has(n));
}

/** 已启用技能声明的工具名单（供 SkillToolProvider 筛选） */
export function enabledSkillTools(): string[] {
  const names = new Set<string>();
  for (const n of enabledSkillNames()) {
    const s = loaded.get(n);
    for (const t of s?.tools ?? []) names.add(t);
  }
  return [...names];
}

/** 已启用技能的正文拼装（注入系统提示词；无启用技能返回空串） */
export function buildSkillPrompt(): string {
  const bodies = enabledSkillNames()
    .map((n) => loaded.get(n))
    .filter((s): s is SkillDef => Boolean(s))
    .filter((s) => s.body.length > 0)
    .map((s) => `【技能 ${s.name}】\n${s.body}`);
  return bodies.join("\n\n");
}

/** 仅用于测试：重置扫描状态与启用集合 */
export function resetSkills(): void {
  loaded.clear();
  enabled.clear();
  scanned = false;
}
