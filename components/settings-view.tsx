"use client";

/**
 * 设置视图（左栏 activityView = "settings"）
 * 采用「分类 Tab」布局：通用 / 模型 / 审批 / 集成 / 数据，避免长列表堆叠。
 * 现有项：Surface 形态 / 主题 / 通知（由 ChatPanel 传入状态）。
 * 配置管理：
 *  1. 模型 / Provider 选择（/api/model-routes）
 *  2. 审批策略：白名单 / 黑名单 / 超时（/api/policy）
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
interface PolicyRule {
  id: number;
  kind: string;
  value: string;
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
}

type Msg = { type: "ok" | "err"; text: string };

const MCP_STATUS_LABELS: Record<McpServer["status"], string> = {
  connected: "已连接",
  connecting: "连接中",
  error: "异常",
  disabled: "已禁用",
};

/** 策略分组（白名单在前，黑名单在后；超时单列配置） */
const POLICY_GROUPS: { kind: string; label: string; placeholder: string }[] = [
  { kind: "allow_tools", label: "白名单 · 工具", placeholder: "如 write_file、mcp__*" },
  { kind: "allow_paths", label: "白名单 · 路径", placeholder: "如 docs/、*.md" },
  { kind: "allow_commands", label: "白名单 · 命令", placeholder: "如 git status" },
  { kind: "deny_tools", label: "黑名单 · 工具", placeholder: "如 delete_file" },
  { kind: "deny_paths", label: "黑名单 · 路径", placeholder: "如 secrets/、*.env" },
  { kind: "deny_commands", label: "黑名单 · 命令", placeholder: "如 rm -rf" },
];

/** 设置分类 Tab */
type SettingsTab = "general" | "models" | "approval" | "integrations" | "data";

const SETTINGS_TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: "general", label: "通用", hint: "形态 / 主题 / 通知" },
  { id: "models", label: "模型", hint: "角色路由" },
  { id: "approval", label: "审批", hint: "白名单 / 黑名单" },
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

  // ---------------- 审批策略 ----------------
  const [policyRules, setPolicyRules] = useState<PolicyRule[]>([]);
  const [policyDrafts, setPolicyDrafts] = useState<Record<string, string>>({});
  const [timeoutDraft, setTimeoutDraft] = useState("");
  const [policyMsg, setPolicyMsg] = useState<Msg | null>(null);

  const loadPolicy = async () => {
    const { ok, data } = await apiFetch("/api/policy");
    if (!ok) return;
    const rules = (data.rules ?? []) as PolicyRule[];
    setPolicyRules(rules);
    const timeout = rules.find((r) => r.kind === "approval_timeout_ms");
    setTimeoutDraft(timeout ? String(Math.round(Number(timeout.value) / 1000)) : "");
  };

  useEffect(() => {
    loadPolicy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addRule = async (kind: string) => {
    const value = (policyDrafts[kind] ?? "").trim();
    if (!value) return;
    setPolicyMsg(null);
    try {
      const { ok, data } = await apiFetch("/api/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, value }),
      });
      if (!ok) throw new Error(data?.error ?? "添加失败");
      setPolicyRules((r) => [...r, data.rule as PolicyRule]);
      setPolicyDrafts((d) => ({ ...d, [kind]: "" }));
      setPolicyMsg({ type: "ok", text: `已添加 ${value}` });
    } catch (err) {
      setPolicyMsg({ type: "err", text: err instanceof Error ? err.message : "添加失败" });
    }
  };

  const deleteRule = async (rule: PolicyRule) => {
    setPolicyMsg(null);
    try {
      const { ok, data } = await apiFetch(`/api/policy?id=${rule.id}`, { method: "DELETE" });
      if (!ok) throw new Error(data?.error ?? "删除失败");
      setPolicyRules((r) => r.filter((x) => x.id !== rule.id));
    } catch (err) {
      setPolicyMsg({ type: "err", text: err instanceof Error ? err.message : "删除失败" });
    }
  };

  const saveTimeout = async () => {
    const secs = Number(timeoutDraft);
    if (!Number.isFinite(secs) || secs <= 0) return;
    setPolicyMsg(null);
    try {
      for (const r of policyRules.filter((x) => x.kind === "approval_timeout_ms")) {
        await apiFetch(`/api/policy?id=${r.id}`, { method: "DELETE" });
      }
      const { ok, data } = await apiFetch("/api/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "approval_timeout_ms", value: String(Math.round(secs * 1000)) }),
      });
      if (!ok) throw new Error(data?.error ?? "保存失败");
      await loadPolicy();
      setPolicyMsg({ type: "ok", text: `审批超时已设为 ${secs} 秒` });
    } catch (err) {
      setPolicyMsg({ type: "err", text: err instanceof Error ? err.message : "保存失败" });
    }
  };

  const clearTimeout = async () => {
    setPolicyMsg(null);
    for (const r of policyRules.filter((x) => x.kind === "approval_timeout_ms")) {
      await apiFetch(`/api/policy?id=${r.id}`, { method: "DELETE" });
    }
    await loadPolicy();
    setPolicyMsg({ type: "ok", text: "已恢复默认审批超时" });
  };

  // ---------------- MCP 服务器 ----------------
  const [mcpData, setMcpData] = useState<McpData | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpForm, setMcpForm] = useState({ name: "", command: "", args: "" });
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
    const command = mcpForm.command.trim();
    if (!name || !command) {
      setMcpMsg({ type: "err", text: "服务器名与 command 不能为空" });
      return;
    }
    const args = mcpForm.args
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    setMcpMutating("add");
    setMcpMsg(null);
    try {
      const { ok, data } = await apiFetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, command, args }),
      });
      if (!ok) throw new Error(data?.error ?? "添加失败");
      setMcpData({ servers: data.servers, tools: data.tools });
      setMcpForm({ name: "", command: "", args: "" });
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
  const [skillForm, setSkillForm] = useState({ name: "", description: "" });
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
          description: skillForm.description.trim() || undefined,
        }),
      });
      if (!ok) throw new Error(data?.error ?? "创建失败");
      setSkills((list) => [...list, data.skill as SkillDef]);
      setSkillForm({ name: "", description: "" });
      setSkillMsg({ type: "ok", text: `已创建并启用 ${name}（可编辑 skills/${name}/SKILL.md）` });
    } catch (err) {
      setSkillMsg({ type: "err", text: err instanceof Error ? err.message : "创建失败" });
    } finally {
      setSkillMutating(null);
    }
  };

  const deleteSkill = async (skill: SkillDef) => {
    if (!window.confirm(`确定删除 Skill "${skill.name}"？将删除 skills/${skill.name}/ 目录。`)) return;
    setSkillMutating(skill.name);
    setSkillMsg(null);
    try {
      const { ok, data } = await apiFetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", name: skill.name }),
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

        {/* ---------- 审批策略 ---------- */}
        {tab === "approval" && (
          <>
            <div className="settings-section">
              <div className="settings-label">审批策略</div>
              <div className="settings-note">
                白名单命中自动放行；黑名单命中强制拦截（优先级高于白名单）；其余敏感操作进入人工审批。
              </div>
              {POLICY_GROUPS.map((g) => {
                const rules = policyRules.filter((r) => r.kind === g.kind);
                return (
                  <div key={g.kind} className="settings-policy-group">
                    <div className="settings-policy-label">{g.label}</div>
                    {rules.length > 0 && (
                      <div className="settings-list">
                        {rules.map((r) => (
                          <div key={r.id} className="settings-item">
                            <span className="settings-item-text">{r.value}</span>
                            <button
                              className="settings-item-del"
                              title="删除"
                              onClick={() => deleteRule(r)}
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
                        value={policyDrafts[g.kind] ?? ""}
                        onChange={(e) => setPolicyDrafts((d) => ({ ...d, [g.kind]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addRule(g.kind);
                        }}
                      />
                      <button className="settings-save" onClick={() => addRule(g.kind)}>
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
                {policyRules.some((r) => r.kind === "approval_timeout_ms") && (
                  <button className="settings-chip" onClick={clearTimeout}>
                    恢复默认
                  </button>
                )}
              </div>
              <StatusMsg msg={policyMsg} />
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
                读取 mcp.json 中的 stdio 服务器；连接异常时自动重试。可在界面新增/删除服务器，自动写回 mcp.json。
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
                    {s.transport === "stdio" ? `stdio · ${s.command ?? ""}` : s.url ?? ""}
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
                  placeholder="服务器名（如 filesystem）"
                  value={mcpForm.name}
                  onChange={(e) => setMcpForm((f) => ({ ...f, name: e.target.value }))}
                />
                <input
                  className="settings-input"
                  placeholder="command（如 npx / uvx）"
                  value={mcpForm.command}
                  onChange={(e) => setMcpForm((f) => ({ ...f, command: e.target.value }))}
                />
              </div>
              <div className="settings-add">
                <input
                  className="settings-input"
                  placeholder="args（空格分隔，可选）"
                  value={mcpForm.args}
                  onChange={(e) => setMcpForm((f) => ({ ...f, args: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addMcpServer();
                  }}
                />
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
              <div className="settings-note">已启用的 Skill 会注入系统提示词与工具声明。可在界面新建/删除。</div>
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
                    <button
                      className="settings-item-action"
                      title="删除技能（删除 skills/<name>/ 目录）"
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
          </>
        )}
      </div>
    </div>
  );
}
