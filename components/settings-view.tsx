"use client";

/**
 * 设置视图（左栏 activityView = "settings"）
 * 采用「分类 Tab」布局：通用 / 模型 / 审批 / 集成 / 数据，避免长列表堆叠。
 * 现有项：Surface 形态 / 主题 / 通知（由 ChatPanel 传入状态）。
 * 配置管理：
 *  1. 模型 / Provider 选择（/api/model-routes）
 *  2. 权限与审批：permission.json（权限模式 / 规则 / 资源授权 / 超时，/api/permission）
 *  3. MCP 服务器管理（/api/mcp）
 *  4. Skill 启用 / 禁用（/api/skills）
 *  5. 数据备份 / 恢复（由 ChatPanel 传入回调）
 */
import { useEffect, useState } from "react";

interface ModelRoute {
  provider: string;
  model: string;
}
interface ProviderInfo {
  id: string;
  name: string;
  apiKeyEnv: string;
  hasApiKey: boolean;
  models: { id: string; name: string }[];
}
interface RoleInfo {
  id: string;
  name: string;
  hint: string;
}
/** 权限与审批（permission.json，对齐 Trae 权限模型） */
type PermissionMode = "manual" | "auto" | "full" | "custom";
type Reviewer = "user" | "llm" | "always_deny";
type ApprovalAction = "allow" | "ask" | "deny";
interface SceneRules {
  commandAstDangerChecker: boolean;
  deleteToolApproval: boolean;
  mcpToolApproval: boolean;
}
interface CommandRuleValue {
  approval: ApprovalAction;
  execEnv?: string;
}
interface McpRuleValue {
  approval: ApprovalAction;
}
interface PermProfile {
  displayName?: string;
  approval: {
    reviewer: Reviewer;
    sceneRules: SceneRules;
    commandRules: Record<string, CommandRuleValue>;
    mcpRules: Record<string, McpRuleValue>;
  };
}
interface PermConfig {
  activeMode: PermissionMode;
  customProfiles: Record<string, PermProfile>;
  resourceAuthorization: {
    tools: { allow: string[]; deny: string[] };
    filesystem: { readWrite: string[]; readOnly: string[] };
    network: { allow: string[]; deny: string[] };
  };
  approvalTimeoutMs: number;
}
interface McpServer {
  name: string;
  status: "connected" | "connecting" | "error" | "disabled";
  error?: string;
  tools: number;
  resources: number;
  prompts: number;
  transport: "stdio" | "http" | "sse";
  command?: string;
  url?: string;
}
interface McpData {
  servers: McpServer[];
  tools: string[];
}
interface SkillDef {
  name: string;
  version?: string;
  description?: string;
  tools: string[];
  enabled: boolean;
  source: "project" | "global";
}

interface SettingsPanelProps {
  surface: "work" | "coding";
  setSurface: (v: "work" | "coding") => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  notifyOn: boolean;
  toggleNotify: () => void;
  onExportBackup: () => void;
  onRestoreBackup: (file: File) => void;
  /** 运行技能：由 ChatPanel 注入，新建会话并预设技能调用提示词 */
  onRunSkill?: (skill: SkillDef) => void;
  /** 当前会话绑定的工作目录（偏好记忆项目文件归属） */
  memoryWorkdir?: string;
}

type Msg = { type: "ok" | "err"; text: string };

const MCP_STATUS_LABELS: Record<McpServer["status"], string> = {
  connected: "已连接",
  connecting: "连接中",
  error: "异常",
  disabled: "已禁用",
};

/** 多行 "Key: value" / "KEY=value" → 字符串映射（供 env / headers 输入） */
function parseKvLines(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.search(/[:=]/);
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const val = trimmed.slice(sep + 1).trim();
    if (key) out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 权限模式选项 */
const PERM_MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: "manual", label: "手动审批", hint: "用户逐一确认" },
  { id: "auto", label: "自动审批", hint: "LLM Guardian 决策" },
  { id: "full", label: "完全访问", hint: "不审批" },
  { id: "custom", label: "自定义", hint: "细粒度配置" },
];

/** 决策方 reviewer 选项 */
const REVIEWERS: { id: Reviewer; label: string }[] = [
  { id: "user", label: "用户确认" },
  { id: "llm", label: "LLM Guardian" },
  { id: "always_deny", label: "一律拒绝" },
];

/** 场景开关（内置风险场景） */
const SCENE_TOGGLES: { key: keyof SceneRules; label: string }[] = [
  { key: "commandAstDangerChecker", label: "危险命令检测" },
  { key: "deleteToolApproval", label: "删除文件审批" },
  { key: "mcpToolApproval", label: "MCP 工具审批" },
];

const ACTION_LABELS: Record<ApprovalAction, string> = {
  allow: "放行",
  ask: "审批",
  deny: "拒绝",
};

/** 资源授权分组（白名单在前，黑名单在后；全局生效，存于 permission.json） */
const RA_GROUPS: { key: string; label: string; placeholder: string; hint: string }[] = [
  { key: "tools.allow", label: "工具白名单", placeholder: "如 append_file、mcp__*", hint: "命中自动放行" },
  { key: "tools.deny", label: "工具黑名单", placeholder: "如 delete_file、skill__*", hint: "命中强制拦截" },
  { key: "filesystem.readWrite", label: "路径白名单", placeholder: "如 notes/、*.md", hint: "命中路径自动放行" },
  { key: "filesystem.readOnly", label: "路径黑名单", placeholder: "如 .env、.git/", hint: "命中路径强制拦截" },
];

/** 按分组 key 取资源授权数组 */
function resolveRaList(ra: PermConfig["resourceAuthorization"], key: string): string[] {
  if (key === "tools.allow") return ra.tools.allow;
  if (key === "tools.deny") return ra.tools.deny;
  if (key === "filesystem.readWrite") return ra.filesystem.readWrite;
  return ra.filesystem.readOnly;
}

/** 设置分类 Tab */
type SettingsTab = "general" | "models" | "approval" | "integrations" | "data";

const SETTINGS_TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: "general", label: "通用", hint: "形态 / 主题 / 通知" },
  { id: "models", label: "模型", hint: "角色路由" },
  { id: "approval", label: "审批", hint: "模式 / 规则 / 资源" },
  { id: "integrations", label: "集成", hint: "MCP / Skill" },
  { id: "data", label: "数据", hint: "备份 / 恢复" },
];

async function apiFetch(url: string, init?: RequestInit): Promise<{ ok: boolean; data: any }> {
  const res = await fetch(url, init);
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* 忽略解析失败 */
  }
  return { ok: res.ok, data };
}

function StatusMsg({ msg }: { msg: Msg | null }) {
  if (!msg) return null;
  return <div className={`settings-msg ${msg.type === "ok" ? "settings-msg-ok" : "settings-msg-err"}`}>{msg.text}</div>;
}

export function SettingsPanel({
  surface,
  setSurface,
  theme,
  toggleTheme,
  notifyOn,
  toggleNotify,
  onExportBackup,
  onRestoreBackup,
  onRunSkill,
  memoryWorkdir,
}: SettingsPanelProps) {
  /** 当前分类 Tab */
  const [tab, setTab] = useState<SettingsTab>("general");

  // ---------------- 模型 / Provider ----------------
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [routes, setRoutes] = useState<Record<string, ModelRoute>>({});
  const [drafts, setDrafts] = useState<Record<string, ModelRoute>>({});
  const [savingRole, setSavingRole] = useState<string | null>(null);
  const [modelMsg, setModelMsg] = useState<Msg | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { ok, data } = await apiFetch("/api/model-routes");
      if (!alive) return;
      if (!ok) {
        setModelMsg({ type: "err", text: data?.error ?? "模型路由加载失败" });
        return;
      }
      setRoles(data.roles ?? []);
      setProviders(data.providers ?? []);
      setRoutes(data.routes ?? {});
      setDrafts(data.routes ?? {});
    })();
    return () => {
      alive = false;
    };
  }, []);

  const providerModels = (providerId: string): string[] =>
    providers.find((p) => p.id === providerId)?.models.map((m) => m.id) ?? [];

  const changeDraft = (role: string, field: "provider" | "model", value: string) => {
    setDrafts((d) => {
      const cur = d[role] ?? { provider: "", model: "" };
      if (field === "provider") {
        const models = providerModels(value);
        return { ...d, [role]: { provider: value, model: models[0] ?? "" } };
      }
      return { ...d, [role]: { ...cur, model: value } };
    });
  };

  const saveRoute = async (role: string) => {
    const d = drafts[role];
    if (!d?.provider || !d?.model) return;
    setSavingRole(role);
    setModelMsg(null);
    try {
      const { ok, data } = await apiFetch("/api/model-routes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, provider: d.provider, model: d.model }),
      });
      if (!ok) throw new Error(data?.error ?? "保存失败");
      setRoutes((r) => ({ ...r, [role]: d }));
      setModelMsg({ type: "ok", text: `已保存 ${d.provider} / ${d.model}` });
    } catch (err) {
      setModelMsg({ type: "err", text: err instanceof Error ? err.message : "保存失败" });
    } finally {
      setSavingRole(null);
    }
  };

  // ---------------- 权限与审批（permission.json，对齐 Trae 权限模型） ----------------
  const [perm, setPerm] = useState<PermConfig | null>(null);
  const [permPath, setPermPath] = useState("");
  const [permMsg, setPermMsg] = useState<Msg | null>(null);
  const [cmdDraft, setCmdDraft] = useState("");
  const [cmdAction, setCmdAction] = useState<ApprovalAction>("allow");
  const [mcpDraft, setMcpDraft] = useState("");
  const [mcpAction, setMcpAction] = useState<ApprovalAction>("ask");
  const [raDrafts, setRaDrafts] = useState<Record<string, string>>({});
  const [timeoutDraft, setTimeoutDraft] = useState("");

  const loadPerm = async () => {
    const { ok, data } = await apiFetch("/api/permission");
    if (!ok) return;
    setPerm(data.config);
    setPermPath(data.path ?? "");
    setTimeoutDraft(String(Math.round((data.config.approvalTimeoutMs ?? 120000) / 1000)));
  };

  useEffect(() => {
    loadPerm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const savePerm = async (cfg: PermConfig): Promise<PermConfig> => {
    const { ok, data } = await apiFetch("/api/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: cfg }),
    });
    if (!ok) throw new Error(data?.error ?? "保存失败");
    setPerm(data.config);
    return data.config as PermConfig;
  };

  /** 修改自定义 profile 并持久化（custom 模式生效的 reviewer / 场景开关 / 规则） */
  const patchCustom = async (fn: (p: PermProfile) => void) => {
    if (!perm) return;
    setPermMsg(null);
    const next: PermConfig = {
      ...perm,
      customProfiles: {
        ...perm.customProfiles,
        default: JSON.parse(JSON.stringify(perm.customProfiles.default ?? {})) as PermProfile,
      },
    };
    fn(next.customProfiles.default);
    try {
      await savePerm(next);
    } catch (err) {
      setPermMsg({ type: "err", text: err instanceof Error ? err.message : "保存失败" });
    }
  };

  const setMode = async (mode: PermissionMode) => {
    if (!perm || perm.activeMode === mode) return;
    setPermMsg(null);
    try {
      await savePerm({ ...perm, activeMode: mode });
    } catch (err) {
      setPermMsg({ type: "err", text: err instanceof Error ? err.message : "保存失败" });
    }
  };

  const setReviewer = (r: Reviewer) =>
    void patchCustom((p) => {
      p.approval.reviewer = r;
    });

  const addCmdRule = async () => {
    const key = cmdDraft.trim();
    if (!key) return;
    await patchCustom((p) => {
      p.approval.commandRules[key] = { approval: cmdAction };
    });
    setCmdDraft("");
  };

  const removeCmdRule = (key: string) =>
    void patchCustom((p) => {
      delete p.approval.commandRules[key];
    });

  const addMcpRule = async () => {
    const key = mcpDraft.trim();
    if (!key) return;
    await patchCustom((p) => {
      p.approval.mcpRules[key] = { approval: mcpAction };
    });
    setMcpDraft("");
  };

  const removeMcpRule = (key: string) =>
    void patchCustom((p) => {
      delete p.approval.mcpRules[key];
    });

  const openPermPath = async () => {
    const p = (window as unknown as { prysm?: { openPath?: (p: string) => void } }).prysm;
    if (p?.openPath && permPath) {
      p.openPath(permPath);
      return;
    }
    try {
      await navigator.clipboard.writeText(permPath);
      setPermMsg({ type: "ok", text: "已复制配置文件路径" });
    } catch {
      setPermMsg({ type: "err", text: permPath });
    }
  };

  /** 修改资源授权并持久化（全局生效，不随权限模式切换） */
  const patchResourceAuth = async (
    fn: (ra: PermConfig["resourceAuthorization"]) => void,
  ) => {
    if (!perm) return;
    setPermMsg(null);
    const next: PermConfig = {
      ...perm,
      resourceAuthorization: JSON.parse(
        JSON.stringify(perm.resourceAuthorization),
      ) as PermConfig["resourceAuthorization"],
    };
    fn(next.resourceAuthorization);
    try {
      await savePerm(next);
    } catch (err) {
      setPermMsg({ type: "err", text: err instanceof Error ? err.message : "保存失败" });
    }
  };

  const addRaItem = async (key: string) => {
    const value = (raDrafts[key] ?? "").trim();
    if (!value) return;
    await patchResourceAuth((ra) => {
      const list = resolveRaList(ra, key);
      if (!list.includes(value)) list.push(value);
    });
    setRaDrafts((d) => ({ ...d, [key]: "" }));
  };

  const removeRaItem = (key: string, value: string) =>
    void patchResourceAuth((ra) => {
      const list = resolveRaList(ra, key);
      const idx = list.indexOf(value);
      if (idx >= 0) list.splice(idx, 1);
    });

  const saveTimeout = async () => {
    if (!perm) return;
    const secs = Number(timeoutDraft);
    if (!Number.isFinite(secs) || secs <= 0) return;
    setPermMsg(null);
    try {
      await savePerm({ ...perm, approvalTimeoutMs: Math.round(secs * 1000) });
      setPermMsg({ type: "ok", text: `审批超时已设为 ${secs} 秒` });
    } catch (err) {
      setPermMsg({ type: "err", text: err instanceof Error ? err.message : "保存失败" });
    }
  };

  const resetTimeout = async () => {
    if (!perm) return;
    setPermMsg(null);
    try {
      await savePerm({ ...perm, approvalTimeoutMs: 120000 });
      setTimeoutDraft("120");
      setPermMsg({ type: "ok", text: "已恢复默认审批超时（120 秒）" });
    } catch (err) {
      setPermMsg({ type: "err", text: err instanceof Error ? err.message : "保存失败" });
    }
  };

  // ---------------- MCP 服务器 ----------------
  const [mcpData, setMcpData] = useState<McpData | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpForm, setMcpForm] = useState({
    name: "",
    type: "stdio" as "stdio" | "http" | "sse",
    command: "",
    args: "",
    env: "",
    url: "",
    headers: "",
  });
  const [mcpMutating, setMcpMutating] = useState<string | null>(null); // "add" 或正在删除的服务器名
  const [mcpMsg, setMcpMsg] = useState<Msg | null>(null);

  const loadMcp = async () => {
    setMcpLoading(true);
    setMcpError(null);
    try {
      const { ok, data } = await apiFetch("/api/mcp");
      if (!ok) throw new Error(data?.error ?? "加载失败");
      setMcpData(data as McpData);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setMcpLoading(false);
    }
  };

  useEffect(() => {
    loadMcp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addMcpServer = async () => {
    const name = mcpForm.name.trim();
    if (!name) {
      setMcpMsg({ type: "err", text: "服务器名不能为空" });
      return;
    }
    const body: Record<string, unknown> = { name, type: mcpForm.type };
    if (mcpForm.type === "stdio") {
      const command = mcpForm.command.trim();
      if (!command) {
        setMcpMsg({ type: "err", text: "stdio 服务器需填写 command（如 npx / uvx）" });
        return;
      }
      body.command = command;
      body.args = mcpForm.args
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      body.env = parseKvLines(mcpForm.env);
    } else {
      const url = mcpForm.url.trim();
      if (!url) {
        setMcpMsg({ type: "err", text: "远程服务器需填写 url（http/https）" });
        return;
      }
      body.url = url;
      body.headers = parseKvLines(mcpForm.headers);
    }
    setMcpMutating("add");
    setMcpMsg(null);
    try {
      const { ok, data } = await apiFetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!ok) throw new Error(data?.error ?? "添加失败");
      setMcpData({ servers: data.servers, tools: data.tools });
      setMcpForm({
        name: "",
        type: mcpForm.type,
        command: "",
        args: "",
        env: "",
        url: "",
        headers: "",
      });
      setMcpMsg({ type: "ok", text: `已添加并连接 ${name}` });
    } catch (err) {
      setMcpMsg({ type: "err", text: err instanceof Error ? err.message : "添加失败" });
    } finally {
      setMcpMutating(null);
    }
  };

  const deleteMcpServer = async (name: string) => {
    setMcpMutating(name);
    setMcpMsg(null);
    try {
      const { ok, data } = await apiFetch(
        `/api/mcp?name=${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
      if (!ok) throw new Error(data?.error ?? "删除失败");
      setMcpData({ servers: data.servers, tools: data.tools });
      setMcpMsg({ type: "ok", text: `已删除 ${name}` });
    } catch (err) {
      setMcpMsg({ type: "err", text: err instanceof Error ? err.message : "删除失败" });
    } finally {
      setMcpMutating(null);
    }
  };

  // ---------------- Skill ----------------
  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [skillMsg, setSkillMsg] = useState<Msg | null>(null);
  const [skillForm, setSkillForm] = useState({
    name: "",
    description: "",
    scope: "project" as "project" | "global",
  });
  const [skillMutating, setSkillMutating] = useState<string | null>(null); // "create" 或正在删除的技能名

  const loadSkills = async () => {
    const { ok, data } = await apiFetch("/api/skills");
    if (ok) setSkills((data.skills ?? []) as SkillDef[]);
  };

  useEffect(() => {
    loadSkills();
  }, []);

  const toggleSkill = async (skill: SkillDef) => {
    const action = skill.enabled ? "disable" : "enable";
    setSkillMsg(null);
    try {
      const { ok, data } = await apiFetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: skill.name, action }),
      });
      if (!ok) throw new Error(data?.error ?? "操作失败");
      setSkills((list) =>
        list.map((s) => (s.name === skill.name ? { ...s, enabled: action === "enable" } : s)),
      );
    } catch (err) {
      setSkillMsg({ type: "err", text: err instanceof Error ? err.message : "操作失败" });
    }
  };

  const reloadSkills = async () => {
    setSkillMsg(null);
    try {
      const { ok, data } = await apiFetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reload" }),
      });
      if (!ok) throw new Error(data?.error ?? "重载失败");
      setSkills((data.skills ?? []) as SkillDef[]);
      setSkillMsg({ type: "ok", text: "已重新扫描技能目录" });
    } catch (err) {
      setSkillMsg({ type: "err", text: err instanceof Error ? err.message : "重载失败" });
    }
  };

  const createNewSkill = async () => {
    const name = skillForm.name.trim();
    if (!name) {
      setSkillMsg({ type: "err", text: "Skill 名称不能为空" });
      return;
    }
    setSkillMutating("create");
    setSkillMsg(null);
    try {
      const { ok, data } = await apiFetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name,
          scope: skillForm.scope,
          description: skillForm.description.trim() || undefined,
        }),
      });
      if (!ok) throw new Error(data?.error ?? "创建失败");
      setSkills((list) => [...list, data.skill as SkillDef]);
      setSkillForm({ name: "", description: "", scope: skillForm.scope });
      setSkillMsg({
        type: "ok",
        text: `已创建并启用 ${name}（${skillForm.scope === "global" ? "全局" : "项目"}技能，可编辑对应 skills/${name}/SKILL.md）`,
      });
    } catch (err) {
      setSkillMsg({ type: "err", text: err instanceof Error ? err.message : "创建失败" });
    } finally {
      setSkillMutating(null);
    }
  };

  const deleteSkill = async (skill: SkillDef) => {
    if (
      !window.confirm(
        `确定删除 Skill "${skill.name}"？将删除${skill.source === "global" ? "全局（~/.prysm/skills）" : "项目"}的 ${skill.name}/ 目录。`,
      )
    )
      return;
    setSkillMutating(skill.name);
    setSkillMsg(null);
    try {
      const { ok, data } = await apiFetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", name: skill.name, scope: skill.source }),
      });
      if (!ok) throw new Error(data?.error ?? "删除失败");
      setSkills((list) => list.filter((s) => s.name !== skill.name));
      setSkillMsg({ type: "ok", text: `已删除 ${skill.name}` });
    } catch (err) {
      setSkillMsg({ type: "err", text: err instanceof Error ? err.message : "删除失败" });
    } finally {
      setSkillMutating(null);
    }
  };

  // ---------------- 偏好记忆（全局 + 项目 markdown 文件） ----------------
  const [memoryDraft, setMemoryDraft] = useState({ global: "", project: "" });
  const [memoryFileInfo, setMemoryFileInfo] = useState({ global: "", project: "" });
  const [memoryMsg, setMemoryMsg] = useState<Msg | null>(null);
  const [memorySaving, setMemorySaving] = useState<"global" | "project" | null>(null);

  const loadMemoryFiles = async () => {
    const qs = memoryWorkdir ? `?workdir=${encodeURIComponent(memoryWorkdir)}` : "";
    const { ok, data } = await apiFetch(`/api/memory-files${qs}`);
    if (!ok) return;
    setMemoryDraft({
      global: data.global?.content ?? "",
      project: data.project?.content ?? "",
    });
    setMemoryFileInfo({
      global: data.global?.file ?? "",
      project: data.project?.file ?? "",
    });
  };

  useEffect(() => {
    loadMemoryFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryWorkdir]);

  const saveMemoryFile = async (scope: "global" | "project") => {
    setMemorySaving(scope);
    setMemoryMsg(null);
    try {
      const body: Record<string, unknown> = {
        action: "save",
        scope,
        content: memoryDraft[scope],
      };
      if (memoryWorkdir) body.workdir = memoryWorkdir;
      const { ok, data } = await apiFetch("/api/memory-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!ok) throw new Error(data?.error ?? "保存失败");
      setMemoryMsg({ type: "ok", text: `已保存${scope === "global" ? "全局" : "项目"}记忆` });
    } catch (err) {
      setMemoryMsg({ type: "err", text: err instanceof Error ? err.message : "保存失败" });
    } finally {
      setMemorySaving(null);
    }
  };

  return (
    <div className="settings">
      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`settings-tab ${tab === t.id ? "settings-tab-active" : ""}`}
            onClick={() => setTab(t.id)}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="settings-body">
        {/* ---------- 通用：形态 / 主题 / 通知 ---------- */}
        {tab === "general" && (
          <>
            <div className="settings-section">
              <div className="settings-label">Surface 形态</div>
              <div className="settings-row">
                <button
                  className={`settings-chip ${surface === "work" ? "settings-chip-active" : ""}`}
                  onClick={() => setSurface("work")}
                >
                  Work（办公自动化）
                </button>
                <button
                  className={`settings-chip ${surface === "coding" ? "settings-chip-active" : ""}`}
                  onClick={() => setSurface("coding")}
                >
                  Coding（编码）
                </button>
              </div>
              <p className="settings-hint">
                {surface === "work"
                  ? "Work 形态：专注文档、调研、数据整理与报告。联网检索（网页搜索/抓取网页）可用；不含命令执行/环境调试类工具。会话与 Coding 形态相互独立。"
                  : "Coding 形态：专注代码编写、调试与命令执行。命令执行/环境/端口调试类工具可用；不含联网检索工具。会话与 Work 形态相互独立。"}
              </p>
            </div>

            <div className="settings-section">
              <div className="settings-label">主题</div>
              <div className="settings-row">
                <button
                  className={`settings-chip ${theme === "light" ? "settings-chip-active" : ""}`}
                  onClick={toggleTheme}
                >
                  {theme === "light" ? "✓ 浅色" : "浅色"}
                </button>
                <button
                  className={`settings-chip ${theme === "dark" ? "settings-chip-active" : ""}`}
                  onClick={toggleTheme}
                >
                  {theme === "dark" ? "✓ 深色" : "深色"}
                </button>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-label">通知</div>
              <div className="settings-row">
                <button
                  className={`settings-chip ${notifyOn ? "settings-chip-active" : ""}`}
                  onClick={toggleNotify}
                >
                  {notifyOn ? "✓ 已开启" : "任务完成通知"}
                </button>
              </div>
            </div>
          </>
        )}

        {/* ---------- 模型 / Provider ---------- */}
        {tab === "models" && (
          <>
            <div className="settings-section">
              <div className="settings-label">模型 / Provider</div>
              <div className="settings-note">
                为各角色指定模型提供商与模型；Provider 需在环境变量配置 API Key。
              </div>
              <div className="settings-legend">
                {providers.map((p) => (
                  <span key={p.id} className={`settings-dot ${p.hasApiKey ? "settings-dot-ok" : "settings-dot-err"}`}>
                    {p.name} {p.hasApiKey ? "已配置" : `缺 ${p.apiKeyEnv}`}
                  </span>
                ))}
              </div>
              {roles.map((role) => {
                const d = drafts[role.id] ?? { provider: "", model: "" };
                const dirty = routes[role.id] && (routes[role.id].provider !== d.provider || routes[role.id].model !== d.model);
                return (
                  <div key={role.id} className="settings-role">
                    <div className="settings-role-head">
                      <span className="settings-role-name">
                        {role.name}
                        <span className="settings-role-hint">{role.hint}</span>
                      </span>
                      <button
                        className="settings-save"
                        disabled={savingRole === role.id || !d.provider || !d.model || !dirty}
                        onClick={() => saveRoute(role.id)}
                      >
                        {savingRole === role.id ? "保存中…" : dirty ? "保存" : "已保存"}
                      </button>
                    </div>
                    <div className="settings-role-fields">
                      <select
                        className="settings-select"
                        value={d.provider}
                        onChange={(e) => changeDraft(role.id, "provider", e.target.value)}
                      >
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <select
                        className="settings-select"
                        value={d.model}
                        disabled={!d.provider}
                        onChange={(e) => changeDraft(role.id, "model", e.target.value)}
                      >
                        {/* 目录外当前值兜底：避免已配置模型（如 deepseek-chat）显示为空 */}
                        {d.model && !providerModels(d.provider).includes(d.model) && (
                          <option value={d.model}>{d.model}</option>
                        )}
                        {providerModels(d.provider).map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
              <StatusMsg msg={modelMsg} />
            </div>
          </>
        )}

        {/* ---------- 权限模式 / 决策方（permission.json，对齐 Trae） ---------- */}
        {tab === "approval" && (
          <>
            <div className="settings-section">
              <div className="settings-label">权限模式</div>
              <div className="settings-note">
                手动审批需用户逐一确认；自动审批由 LLM Guardian 决策（拒绝回退用户）；完全访问不审批；自定义可细粒度配置。
              </div>
              <div className="settings-mode-group">
                {PERM_MODES.map((m) => (
                  <button
                    key={m.id}
                    className={`settings-mode-btn${perm?.activeMode === m.id ? " active" : ""}`}
                    onClick={() => setMode(m.id)}
                  >
                    <span className="settings-mode-label">{m.label}</span>
                    <span className="settings-mode-hint">{m.hint}</span>
                  </button>
                ))}
              </div>

              {perm && perm.activeMode !== "full" && (
                <>
                  <div className="settings-policy-label">决策方 reviewer</div>
                  <div className="settings-mode-group compact">
                    {REVIEWERS.map((r) => (
                      <button
                        key={r.id}
                        className={`settings-mode-btn${
                          perm.customProfiles.default?.approval.reviewer === r.id ? " active" : ""
                        }`}
                        disabled={perm.activeMode !== "custom"}
                        title={perm.activeMode === "custom" ? "" : "仅自定义模式下可修改"}
                        onClick={() => setReviewer(r.id)}
                      >
                        <span className="settings-mode-label">{r.label}</span>
                      </button>
                    ))}
                  </div>

                  <div className="settings-policy-label">场景开关</div>
                  <div className="settings-scene">
                    {SCENE_TOGGLES.map((s) => (
                      <label
                        key={s.key}
                        className={`settings-check${perm.activeMode !== "custom" ? " disabled" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={perm.customProfiles.default?.approval.sceneRules[s.key] ?? true}
                          disabled={perm.activeMode !== "custom"}
                          onChange={(e) =>
                            void patchCustom((p) => {
                              p.approval.sceneRules[s.key] = e.target.checked;
                            })
                          }
                        />
                        <span>{s.label}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              {perm && perm.activeMode !== "full" && (
                <>
                  <div className="settings-policy-label">命令规则（run_bash）</div>
                  <div className="settings-note">
                    精确匹配 / 前缀（git add *）/ 正则（r/rm\s+-rf/）；deny 优先于 allow，且优先于危险命令检测。规则全局生效，不随权限模式切换。
                  </div>
                  <div className="settings-list">
                    {Object.entries(perm.customProfiles.default?.approval.commandRules ?? {}).map(
                      ([k, v]) => (
                        <div key={k} className="settings-item">
                          <span className="settings-item-text">{k}</span>
                          <span className={`settings-badge ${v.approval}`}>
                            {ACTION_LABELS[v.approval]}
                          </span>
                          <button
                            className="settings-item-del"
                            title="删除"
                            onClick={() => removeCmdRule(k)}
                          >
                            ×
                          </button>
                        </div>
                      ),
                    )}
                  </div>
                  <div className="settings-add">
                    <input
                      className="settings-input"
                      placeholder="如 git add * 或 r/rm\s+-rf/"
                      value={cmdDraft}
                      onChange={(e) => setCmdDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addCmdRule();
                      }}
                    />
                    <select
                      className="settings-select select-auto"
                      value={cmdAction}
                      onChange={(e) => setCmdAction(e.target.value as ApprovalAction)}
                    >
                      <option value="allow">放行</option>
                      <option value="ask">审批</option>
                      <option value="deny">拒绝</option>
                    </select>
                    <button className="settings-save" onClick={addCmdRule}>
                      添加
                    </button>
                  </div>

                  <div className="settings-policy-label">MCP 规则</div>
                  <div className="settings-note">
                    键为 server__tool（精确）或 server__*（通配），如 github__*、internal-admin。
                  </div>
                  <div className="settings-list">
                    {Object.entries(perm.customProfiles.default?.approval.mcpRules ?? {}).map(
                      ([k, v]) => (
                        <div key={k} className="settings-item">
                          <span className="settings-item-text">{k}</span>
                          <span className={`settings-badge ${v.approval}`}>
                            {ACTION_LABELS[v.approval]}
                          </span>
                          <button
                            className="settings-item-del"
                            title="删除"
                            onClick={() => removeMcpRule(k)}
                          >
                            ×
                          </button>
                        </div>
                      ),
                    )}
                  </div>
                  <div className="settings-add">
                    <input
                      className="settings-input"
                      placeholder="如 github__*"
                      value={mcpDraft}
                      onChange={(e) => setMcpDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addMcpRule();
                      }}
                    />
                    <select
                      className="settings-select select-auto"
                      value={mcpAction}
                      onChange={(e) => setMcpAction(e.target.value as ApprovalAction)}
                    >
                      <option value="allow">放行</option>
                      <option value="ask">审批</option>
                      <option value="deny">拒绝</option>
                    </select>
                    <button className="settings-save" onClick={addMcpRule}>
                      添加
                    </button>
                  </div>
                </>
              )}

              <div className="settings-policy-label">配置文件</div>
              <div className="settings-note">
                配置存于{" "}
                {permPath ? <code className="settings-code">{permPath}</code> : "…"}，可直接编辑文件
                （自定义规则优先级最高）。
              </div>
              <div className="settings-add">
                <button className="settings-save" onClick={openPermPath}>
                  打开配置
                </button>
                <button className="settings-chip" onClick={loadPerm}>
                  重新加载
                </button>
              </div>
              <StatusMsg msg={permMsg} />
            </div>

            {/* ---------- 资源授权（工具 / 路径，全局生效，存于 permission.json） ---------- */}
            <div className="settings-section">
              <div className="settings-label">资源授权</div>
              <div className="settings-note">
                白名单命中自动放行；黑名单命中强制拦截（优先级高于白名单）。工具支持通配（mcp__* /
                skill__*）；路径支持目录前缀（notes/）与文件名通配（*.md）。此配置全局生效，不随权限模式切换。
              </div>
              {RA_GROUPS.map((g) => {
                const items = perm ? resolveRaList(perm.resourceAuthorization, g.key) : [];
                return (
                  <div key={g.key} className="settings-policy-group">
                    <div className="settings-policy-label">
                      {g.label}
                      <span className="settings-role-hint">{g.hint}</span>
                    </div>
                    {items.length > 0 && (
                      <div className="settings-list">
                        {items.map((v) => (
                          <div key={v} className="settings-item">
                            <span className="settings-item-text">{v}</span>
                            <button
                              className="settings-item-del"
                              title="删除"
                              onClick={() => removeRaItem(g.key, v)}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="settings-add">
                      <input
                        className="settings-input"
                        placeholder={g.placeholder}
                        value={raDrafts[g.key] ?? ""}
                        onChange={(e) => setRaDrafts((d) => ({ ...d, [g.key]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addRaItem(g.key);
                        }}
                      />
                      <button className="settings-save" onClick={() => addRaItem(g.key)}>
                        添加
                      </button>
                    </div>
                  </div>
                );
              })}
              <div className="settings-policy-label">审批超时</div>
              <div className="settings-add">
                <input
                  className="settings-input"
                  type="number"
                  min={1}
                  placeholder="秒（默认 120）"
                  value={timeoutDraft}
                  onChange={(e) => setTimeoutDraft(e.target.value)}
                />
                <button className="settings-save" onClick={saveTimeout}>
                  保存
                </button>
                {perm && perm.approvalTimeoutMs !== 120000 && (
                  <button className="settings-chip" onClick={resetTimeout}>
                    恢复默认
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {/* ---------- 集成：MCP / Skill ---------- */}
        {tab === "integrations" && (
          <>
            <div className="settings-section">
              <div className="settings-section-head">
                <span className="settings-label">MCP 服务器</span>
                <button className="settings-save" onClick={loadMcp} disabled={mcpLoading}>
                  {mcpLoading ? "刷新中…" : "刷新"}
                </button>
              </div>
              <div className="settings-note">
                支持 stdio（本地子进程）与 http / sse（远程）服务器，读取 mcp.json 配置；连接异常时自动重试。可在界面新增/删除服务器，自动写回 mcp.json。
              </div>
              {mcpError && <div className="settings-msg settings-msg-err">{mcpError}</div>}
              {!mcpData && !mcpError && <div className="settings-note">加载中…</div>}
              {mcpData && mcpData.servers.length === 0 && (
                <div className="settings-note">（未配置 MCP 服务器，可在下方添加）</div>
              )}
              {mcpData?.servers.map((s) => (
                <div key={s.name} className="settings-item">
                  <div className="settings-item-main">
                    <span className={`settings-badge settings-badge-${s.status}`}>
                      {MCP_STATUS_LABELS[s.status]}
                    </span>
                    <span className="settings-item-text">{s.name}</span>
                    <button
                      className="settings-item-action"
                      title="删除服务器（从 mcp.json 移除并断开）"
                      disabled={mcpMutating !== null}
                      onClick={() => deleteMcpServer(s.name)}
                    >
                      {mcpMutating === s.name ? "…" : "删除"}
                    </button>
                  </div>
                  <div className="settings-item-sub">
                    <span className="settings-badge">{s.transport}</span>{" "}
                    {s.transport === "stdio" ? s.command ?? "" : s.url ?? ""}
                    {s.tools > 0 && ` · ${s.tools} 工具`}
                    {s.resources > 0 && ` · ${s.resources} 资源`}
                    {s.prompts > 0 && ` · ${s.prompts} 提示`}
                    {s.error && ` · ${s.error}`}
                  </div>
                </div>
              ))}
              <div className="settings-add">
                <input
                  className="settings-input"
                  placeholder="服务器名（如 filesystem / github）"
                  value={mcpForm.name}
                  onChange={(e) => setMcpForm((f) => ({ ...f, name: e.target.value }))}
                />
                <div className="settings-mcp-types">
                  {(["stdio", "http", "sse"] as const).map((t) => (
                    <button
                      key={t}
                      className={`settings-chip${mcpForm.type === t ? " settings-chip-active" : ""}`}
                      onClick={() => setMcpForm((f) => ({ ...f, type: t }))}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              {mcpForm.type === "stdio" ? (
                <>
                  <div className="settings-add">
                    <input
                      className="settings-input"
                      placeholder="command（如 npx / uvx）"
                      value={mcpForm.command}
                      onChange={(e) => setMcpForm((f) => ({ ...f, command: e.target.value }))}
                    />
                    <input
                      className="settings-input"
                      placeholder="args（空格分隔，可选）"
                      value={mcpForm.args}
                      onChange={(e) => setMcpForm((f) => ({ ...f, args: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addMcpServer();
                      }}
                    />
                  </div>
                  <div className="settings-sub-label">
                    env（每行 KEY=value，可选；支持 START_MCP_TIMEOUT_MS / RUN_MCP_TIMEOUT_MS）
                  </div>
                  <textarea
                    className="settings-textarea"
                    placeholder={"API_KEY=sk-xxx\nSTART_MCP_TIMEOUT_MS=60000"}
                    value={mcpForm.env}
                    onChange={(e) => setMcpForm((f) => ({ ...f, env: e.target.value }))}
                  />
                </>
              ) : (
                <>
                  <div className="settings-add">
                    <input
                      className="settings-input"
                      placeholder="url（如 https://example.com/mcp）"
                      value={mcpForm.url}
                      onChange={(e) => setMcpForm((f) => ({ ...f, url: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addMcpServer();
                      }}
                    />
                  </div>
                  <div className="settings-sub-label">
                    headers（每行 Key: value，可选；如 Authorization: Bearer xxx）
                  </div>
                  <textarea
                    className="settings-textarea"
                    placeholder={"Authorization: Bearer xxxx\nRUN_MCP_TIMEOUT_MS=60000"}
                    value={mcpForm.headers}
                    onChange={(e) => setMcpForm((f) => ({ ...f, headers: e.target.value }))}
                  />
                </>
              )}
              <div className="settings-add">
                <button
                  className="settings-save"
                  disabled={mcpMutating !== null}
                  onClick={addMcpServer}
                >
                  {mcpMutating === "add" ? "添加中…" : "添加服务器"}
                </button>
              </div>
              <StatusMsg msg={mcpMsg} />
            </div>

            <div className="settings-section">
              <div className="settings-section-head">
                <span className="settings-label">Skill</span>
                <button className="settings-save" onClick={reloadSkills}>
                  重新扫描
                </button>
              </div>
              <div className="settings-note">已启用的 Skill 以名称+描述进入系统提示词索引，模型按需通过 use_skill 工具加载完整说明。可在界面新建/删除（项目 / 全局）。</div>
              {skills.length === 0 && <div className="settings-note">（skills/ 目录无 Skill，可在下方新建）</div>}
              <div className="settings-add">
                <input
                  className="settings-input"
                  placeholder="Skill 名称（如 pdf）"
                  value={skillForm.name}
                  onChange={(e) => setSkillForm((f) => ({ ...f, name: e.target.value }))}
                />
                <input
                  className="settings-input"
                  placeholder="描述（可选）"
                  value={skillForm.description}
                  onChange={(e) => setSkillForm((f) => ({ ...f, description: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createNewSkill();
                  }}
                />
                <select
                  className="settings-input"
                  value={skillForm.scope}
                  title="新建位置：项目（当前应用目录）或全局（~/.prysm/skills）"
                  onChange={(e) =>
                    setSkillForm((f) => ({ ...f, scope: e.target.value as "project" | "global" }))
                  }
                >
                  <option value="project">项目</option>
                  <option value="global">全局</option>
                </select>
                <button
                  className="settings-save"
                  disabled={skillMutating !== null}
                  onClick={createNewSkill}
                >
                  {skillMutating === "create" ? "创建中…" : "新建 Skill"}
                </button>
              </div>
              {skills.map((s) => (
                <div key={s.name} className="settings-item">
                  <div className="settings-item-main">
                    <button
                      className={`settings-toggle ${s.enabled ? "settings-toggle-on" : ""}`}
                      title={s.enabled ? "点击禁用" : "点击启用"}
                      onClick={() => toggleSkill(s)}
                    >
                      <span className="settings-toggle-knob" />
                    </button>
                    <span className="settings-item-text">{s.name}</span>
                    {s.version && <span className="settings-item-meta">v{s.version}</span>}
                    <span
                      className={`settings-item-meta skill-source-badge ${s.source === "global" ? "skill-source-global" : ""}`}
                      title={s.source === "global" ? "全局技能（~/.prysm/skills）" : "项目技能（当前应用 skills/ 目录）"}
                    >
                      {s.source === "global" ? "全局" : "项目"}
                    </span>
                    <button
                      className="settings-item-action settings-item-action-run"
                      title="新建会话并运行该技能"
                      disabled={skillMutating !== null}
                      onClick={() => onRunSkill?.(s)}
                    >
                      运行
                    </button>
                    <button
                      className="settings-item-action"
                      title="删除技能（删除对应 skills/<name>/ 目录）"
                      disabled={skillMutating !== null}
                      onClick={() => deleteSkill(s)}
                    >
                      {skillMutating === s.name ? "…" : "删除"}
                    </button>
                  </div>
                  {(s.description || s.tools.length > 0) && (
                    <div className="settings-item-sub">
                      {s.description}
                      {s.tools.length > 0 && ` · ${s.tools.join(", ")}`}
                    </div>
                  )}
                </div>
              ))}
              <StatusMsg msg={skillMsg} />
            </div>
          </>
        )}

        {/* ---------- 数据：备份 / 恢复 ---------- */}
        {tab === "data" && (
          <>
            <div className="settings-section">
              <div className="settings-label">数据备份 / 恢复</div>
              <div className="settings-note">
                备份导出全部会话、记忆与任务计划为 JSON；恢复会覆盖当前数据，建议恢复前先备份。
              </div>
              <div className="settings-row">
                <button className="settings-chip" onClick={onExportBackup}>
                  ⬇ 备份
                </button>
                <label className="settings-chip" title="从备份 JSON 恢复（会覆盖当前数据）">
                  ⬆ 恢复
                  <input
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onRestoreBackup(f);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-label">偏好记忆</div>
              <div className="settings-note">
                每行一条偏好/规则，内容会注入系统提示词跨会话生效。全局记忆对所有工作区生效；项目记忆仅对当前绑定工作区（{memoryWorkdir ? memoryWorkdir : "默认工作区"}）生效。也可在对话中让 AI 用 remember_memory / forget_memory 管理。
              </div>
              <div className="settings-sub-label">全局记忆（{memoryFileInfo.global || "memory/user_profile.md"}）</div>
              <textarea
                className="settings-textarea"
                rows={5}
                value={memoryDraft.global}
                placeholder={"# 全局偏好\n- 偏好使用中文回答"}
                onChange={(e) => setMemoryDraft((d) => ({ ...d, global: e.target.value }))}
              />
              <button
                className="settings-save"
                disabled={memorySaving !== null}
                onClick={() => saveMemoryFile("global")}
              >
                {memorySaving === "global" ? "保存中…" : "保存全局记忆"}
              </button>
              <div className="settings-sub-label">项目记忆（{memoryFileInfo.project || "memory/projects/<工作区>/project_memory.md"}）</div>
              <textarea
                className="settings-textarea"
                rows={5}
                value={memoryDraft.project}
                placeholder={"# 项目偏好\n- 本项目的代码风格约定"}
                onChange={(e) => setMemoryDraft((d) => ({ ...d, project: e.target.value }))}
              />
              <button
                className="settings-save"
                disabled={memorySaving !== null}
                onClick={() => saveMemoryFile("project")}
              >
                {memorySaving === "project" ? "保存中…" : "保存项目记忆"}
              </button>
              <StatusMsg msg={memoryMsg} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
