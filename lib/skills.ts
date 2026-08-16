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
import os from "node:os";
import path from "node:path";
import { basePath, getConfig } from "./config";

/** 技能来源：项目技能（<baseDir>/skills）/ 全局技能（~/.prysm/skills） */
export type SkillSource = "project" | "global";

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
  /** 技能来源：项目 / 全局 */
  source: SkillSource;
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
  source: SkillSource = "project",
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

  return { name, version, description, tools, body, path: dir, source };
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

/** 持久化 Skill 相关设置（<baseDir>/skill-settings.json，如全局目录回退选择） */
interface SkillSettings {
  globalSkillsDir?: string;
}

function skillSettingsPath(): string {
  return basePath("skill-settings.json");
}

function readSkillSettings(): SkillSettings {
  try {
    return JSON.parse(fs.readFileSync(skillSettingsPath(), "utf-8")) as SkillSettings;
  } catch {
    return {};
  }
}

function writeSkillSettings(s: SkillSettings): void {
  fs.mkdirSync(path.dirname(skillSettingsPath()), { recursive: true });
  fs.writeFileSync(skillSettingsPath(), JSON.stringify(s, null, 2), "utf-8");
}

/**
 * 全局技能目录（优先级：PrysmConfig.globalSkillsDir > 持久化回退选择 > ~/.prysm/skills）。
 * 只读扫描用此函数；写操作前应调用 ensureGlobalSkillsDir() 完成可写性探测与回退。
 */
export function getGlobalSkillsDir(): string {
  if (resolvedGlobalDir) return resolvedGlobalDir;
  const cfg = getConfig();
  if (cfg.globalSkillsDir) return cfg.globalSkillsDir;
  const saved = readSkillSettings().globalSkillsDir;
  if (saved) return saved;
  return path.join(os.homedir(), ".prysm", "skills");
}

/** 探测目录可写性：创建目录并写删探针文件 */
function ensureDirWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, "ok", "utf-8");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** ensure 后生效的全局目录（模块级缓存：一次写操作探测后固定，避免每次扫描重复探测） */
let resolvedGlobalDir: string | undefined;

/**
 * 确保全局技能目录可写（写操作前调用，幂等）：
 * 目标目录（getGlobalSkillsDir）不可写时（如受控文件夹访问/安全软件按进程拦截），
 * 自动回退到 <baseDir>/global-skills（Electron 下即 userData，Web 下为项目目录），并持久化回退选择。
 * 返回实际生效的全局目录。
 */
export function ensureGlobalSkillsDir(): string {
  const target = getGlobalSkillsDir();
  if (ensureDirWritable(target)) {
    resolvedGlobalDir = target;
    return target;
  }
  const fallback = basePath("global-skills");
  if (!ensureDirWritable(fallback)) {
    throw new Error(
      `全局技能目录不可写（${target}），且回退目录（${fallback}）也不可写。请检查目录权限或通过设置指定可写的全局技能目录。`,
    );
  }
  resolvedGlobalDir = fallback;
  writeSkillSettings({ globalSkillsDir: fallback });
  console.log(`[skills] 全局技能目录 ${target} 不可写，已回退到 ${fallback}`);
  return fallback;
}

/** 按来源取技能根目录（create/delete 与 API 路由用；全局目录先做可写性探测与回退） */
export function skillRoot(scope: SkillSource): string {
  return scope === "global"
    ? ensureGlobalSkillsDir()
    : getConfig().skillsDir ?? basePath("skills");
}

const loaded = new Map<string, SkillDef>();
const enabled = new Set<string>();
let scanned = false;

/**
 * 扫描技能目录（项目 + 全局两级；同名冲突时项目优先），返回全部 SkillDef（纯函数）。
 * 显式传入 dir 时仅扫描该目录，source 按"是否等于全局目录"推断（测试与 API 路由用）。
 */
export function loadSkills(dir?: string): SkillDef[] {
  const roots: { dir: string; source: SkillSource }[] = dir
    ? [{ dir, source: dir === getGlobalSkillsDir() ? "global" : "project" }]
    : [
        { dir: getConfig().skillsDir ?? basePath("skills"), source: "project" },
        { dir: getGlobalSkillsDir(), source: "global" },
      ];
  const out: SkillDef[] = [];
  const seen = new Set<string>();
  for (const { dir: root, source } of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // 目录不存在（如全局目录尚未创建）则跳过
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (seen.has(e.name)) continue; // 同名：项目技能优先，跳过全局
      const skillDir = path.join(root, e.name);
      const md = path.join(skillDir, "SKILL.md");
      let text: string;
      try {
        text = fs.readFileSync(md, "utf-8");
      } catch {
        continue; // 目录无 SKILL.md → 不算 skill
      }
      out.push(parseSkillMd(text, e.name, skillDir, source));
      seen.add(e.name);
    }
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
  const trimmed = name.trim();
  // 与 createSkill 同一名称白名单，防路径穿越（../ 等递归删除任意目录）
  if (!SKILL_NAME_RE.test(trimmed)) {
    throw new Error("Skill 名称非法：仅允许字母/数字/下划线/连字符");
  }
  const root = dir ?? getConfig().skillsDir ?? basePath("skills");
  const skillDir = path.join(root, trimmed);
  if (!fs.existsSync(skillDir)) return false;
  fs.rmSync(skillDir, { recursive: true, force: true });
  enabled.delete(trimmed);
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

/** 按名称取已登记技能（未登记时自动扫描一次；供 use_skill 工具加载） */
export function getSkillByName(name: string): SkillDef | undefined {
  if (!loaded.has(name)) initSkills();
  return loaded.get(name);
}

/** 技能是否已启用（供 use_skill 工具校验） */
export function isSkillEnabled(name: string): boolean {
  if (!loaded.has(name)) initSkills();
  return enabled.has(name);
}

/**
 * 已启用技能的"名称+描述"索引（注入系统提示词；按需加载入口，无启用技能返回空串）。
 * 模型据此判断任务相关性，需要时调用 use_skill 工具加载完整正文。
 */
export function buildSkillIndex(): string {
  const lines = enabledSkillNames()
    .map((n) => loaded.get(n))
    .filter((s): s is SkillDef => Boolean(s))
    .map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`);
  if (lines.length === 0) return "";
  return (
    "以下技能提供特定任务的专用指令。当任务与某个技能的描述匹配时，调用 use_skill 工具加载该技能的完整说明并按其执行：\n" +
    lines.join("\n")
  );
}

/** 仅用于测试：重置扫描状态与启用集合 */
export function resetSkills(): void {
  loaded.clear();
  enabled.clear();
  scanned = false;
  resolvedGlobalDir = undefined;
}
