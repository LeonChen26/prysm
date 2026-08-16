/**
 * 定时任务（自动化）管理面板
 * 三个页签：已配置 / 执行历史 / 任务模板；支持手动新建、编辑、启停、立即运行、删除，
 * 以及"在对话中创建"（预填输入框，由 AI 经 create_automation 工具完成创建）。
 */
"use client";

import { useCallback, useEffect, useState } from "react";

interface Automation {
  id: string;
  name: string;
  prompt: string;
  surface: "work" | "coding";
  workdir?: string;
  scheduleType: "interval" | "cron";
  intervalMinutes?: number;
  cronExpr?: string;
  scheduleDesc: string;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: "running" | "done" | "failed" | "skipped";
  lastSessionId?: string;
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

interface AutomationRun {
  id: number;
  automationId: string;
  automationName: string;
  sessionId?: string;
  status: "running" | "done" | "failed" | "skipped";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

interface AutomationPanelProps {
  surface: "work" | "coding";
  onSurfaceChange: (v: "work" | "coding") => void;
  /** 跳转执行记录对应会话（先切形态再选中会话） */
  onJumpSession: (sessionId: string, surface?: "work" | "coding") => void;
  /** 在对话中创建：预填输入框并聚焦 */
  onCreateInChat: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  running: "执行中",
  done: "完成",
  failed: "失败",
  skipped: "跳过",
};

const CRON_FREQ_LABELS: Record<string, string> = {
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
};

const DOW_LABELS: Record<string, string> = {
  "1": "一",
  "2": "二",
  "3": "三",
  "4": "四",
  "5": "五",
  "6": "六",
  "0": "日",
};

const AUTOMATION_TEMPLATES = [
  {
    name: "代码仓库周检",
    prompt:
      "对当前项目做一次代码健康检查：扫描安全风险、排查明显 bug、检查测试覆盖缺口，输出一份简明的问题清单与修复建议。",
    scheduleDesc: "每周一 09:00",
    cronExpr: "0 9 * * 1",
    surface: "coding" as const,
  },
  {
    name: "行业资讯周报",
    prompt:
      "检索最近一周我关注的行业动态与竞品新闻，整理成一份结构化周报：要点、影响分析、值得关注的事项。",
    scheduleDesc: "每周一 09:00",
    cronExpr: "0 9 * * 1",
    surface: "work" as const,
  },
  {
    name: "每日工作纪要",
    prompt: "回顾今天的会话与任务，整理当日工作纪要：完成事项、进行中事项、明日计划。",
    scheduleDesc: "每天 18:00",
    cronExpr: "0 18 * * *",
    surface: "work" as const,
  },
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

function fmtTime(ms?: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `今天 ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

interface FormState {
  id?: string;
  name: string;
  prompt: string;
  scheduleType: "interval" | "cron";
  intervalMinutes: string;
  cronFreq: "daily" | "weekly" | "monthly";
  cronDow: string;
  cronDom: string;
  cronTime: string;
  surface: "work" | "coding";
  workdir: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  prompt: "",
  scheduleType: "interval",
  intervalMinutes: "60",
  cronFreq: "daily",
  cronDow: "1",
  cronDom: "1",
  cronTime: "09:00",
  surface: "work",
  workdir: "",
};

export default function AutomationPanel({
  surface,
  onSurfaceChange,
  onJumpSession,
  onCreateInChat,
}: AutomationPanelProps) {
  const [tab, setTab] = useState<"configured" | "history" | "templates">("configured");
  const [list, setList] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [mutating, setMutating] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await apiFetch("/api/automations");
    if (ok && data) {
      setList(data.automations ?? []);
      setRuns(data.runs ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000); // 面板打开时每 30s 轮询刷新
    return () => clearInterval(t);
  }, [load]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const { ok, data } = await apiFetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!ok) throw new Error(data?.error ?? "操作失败");
    if (Array.isArray(data.automations)) setList(data.automations);
    if (Array.isArray(data.runs)) setRuns(data.runs);
    return data;
  }, []);

  const toggle = async (a: Automation) => {
    setMsg(null);
    try {
      await post({ action: "toggle", id: a.id, enabled: !a.enabled });
      setMsg({ type: "ok", text: a.enabled ? "已停用" : "已启用" });
    } catch (err) {
      setMsg({ type: "err", text: err instanceof Error ? err.message : "操作失败" });
    }
  };

  const runNow = async (a: Automation) => {
    setMutating(a.id);
    setMsg(null);
    try {
      const data = await post({ action: "run", id: a.id });
      const s = data?.status ?? "";
      setMsg({
        type: "ok",
        text: s === "failed" ? `执行失败：${data?.error ?? ""}` : `已触发执行（${s}）`,
      });
    } catch (err) {
      setMsg({ type: "err", text: err instanceof Error ? err.message : "操作失败" });
    } finally {
      setMutating(null);
    }
  };

  const remove = async (a: Automation) => {
    setMutating(a.id);
    setMsg(null);
    try {
      await post({ action: "delete", id: a.id });
      setMsg({ type: "ok", text: `已删除 ${a.name}` });
    } catch (err) {
      setMsg({ type: "err", text: err instanceof Error ? err.message : "操作失败" });
    } finally {
      setMutating(null);
    }
  };

  /** 表单 → 提交 body（cron 构建：每天/每周/每月 + 时:分） */
  const buildBody = (f: FormState) => {
    const body: Record<string, unknown> = {
      action: f.id ? "update" : "create",
      id: f.id,
      name: f.name,
      prompt: f.prompt,
      surface: f.surface,
    };
    if (f.workdir.trim()) body.workdir = f.workdir.trim();
    if (f.scheduleType === "interval") {
      const mins = parseInt(f.intervalMinutes, 10);
      if (!mins || mins < 1) throw new Error("间隔分钟数必须为正整数");
      body.interval_minutes = mins;
      body.schedule_desc = `每 ${mins} 分钟`;
    } else {
      const [h, m] = f.cronTime.split(":").map((x) => parseInt(x, 10));
      if (Number.isNaN(h) || Number.isNaN(m)) throw new Error("时间格式非法（HH:MM）");
      let expr: string;
      let desc: string;
      if (f.cronFreq === "daily") {
        expr = `${m} ${h} * * *`;
        desc = `每天 ${f.cronTime}`;
      } else if (f.cronFreq === "weekly") {
        expr = `${m} ${h} * * ${f.cronDow}`;
        desc = `每周${DOW_LABELS[f.cronDow] ?? f.cronDow} ${f.cronTime}`;
      } else {
        expr = `${m} ${h} ${f.cronDom} * *`;
        desc = `每月${f.cronDom}号 ${f.cronTime}`;
      }
      body.cron_expr = expr;
      body.schedule_desc = desc;
    }
    return body;
  };

  const openCreate = (preset?: Partial<FormState>) => {
    setForm({
      ...EMPTY_FORM,
      surface,
      ...preset,
      id: undefined,
    });
  };

  const openEdit = (a: Automation) => {
    const time =
      a.scheduleType === "cron" && a.cronExpr
        ? a.cronExpr.split(/\s+/).slice(0, 2).reverse().join(":").padStart(5, "0")
        : "09:00";
    const cronFreq =
      a.scheduleType === "cron" && a.cronExpr
        ? (() => {
            const p = a.cronExpr!.split(/\s+/);
            if (p[2] === "*" && p[3] === "*") return "weekly"; // 只有周限定
            if (p[2] === "*") return "weekly";
            if (p[3] === "*" && p[2] !== "*") return "monthly";
            return "daily";
          })()
        : "daily";
    setForm({
      id: a.id,
      name: a.name,
      prompt: a.prompt,
      scheduleType: a.scheduleType,
      intervalMinutes: String(a.intervalMinutes ?? 60),
      cronFreq,
      cronDow: a.cronExpr?.split(/\s+/)[4] ?? "1",
      cronDom: a.cronExpr?.split(/\s+/)[2] ?? "1",
      cronTime: time,
      surface: a.surface,
      workdir: a.workdir ?? "",
    });
  };

  const save = async () => {
    if (!form) return;
    if (!form.name.trim()) {
      setMsg({ type: "err", text: "任务名称不能为空" });
      return;
    }
    if (!form.prompt.trim()) {
      setMsg({ type: "err", text: "任务内容不能为空" });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const body = buildBody(form);
      await post(body);
      setForm(null);
      setMsg({ type: "ok", text: form.id ? "已更新" : "已创建" });
    } catch (err) {
      setMsg({ type: "err", text: err instanceof Error ? err.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  const jump = (run: AutomationRun) => {
    if (!run.sessionId) return;
    const a = list.find((x) => x.id === run.automationId);
    onJumpSession(run.sessionId, a?.surface);
  };

  return (
    <div className="automation-panel">
      <div className="automation-head">
        <span className="automation-title">自动化</span>
        <div className="automation-actions">
          <button className="settings-save" onClick={onCreateInChat} title="在对话中创建：预填创建提示，AI 会解析并完成创建">
            在对话中创建
          </button>
          <button className="settings-save" onClick={() => openCreate()}>
            手动新建
          </button>
        </div>
      </div>
      <div className="settings-tabs automation-tabs">
        {(
          [
            ["configured", "已配置"],
            ["history", "执行历史"],
            ["templates", "任务模板"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={`settings-tab${tab === id ? " settings-tab-active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="automation-scroll">
        {msg && (
          <div className={`settings-msg settings-msg-${msg.type}`}>{msg.text}</div>
        )}

        {tab === "configured" && (
          <div>
            {loading && <div className="settings-note">加载中…</div>}
            {!loading && list.length === 0 && (
              <div className="settings-note">（暂无定时任务，可手动新建、从模板创建或在对话中创建）</div>
            )}
            {list.map((a) => (
              <div key={a.id} className="automation-item">
                <div className="automation-item-main">
                  <span className={`automation-status automation-status-${a.lastStatus ?? "idle"}`}>
                    {a.lastStatus ? STATUS_LABELS[a.lastStatus] : "未运行"}
                  </span>
                  <span className="automation-item-text">{a.name}</span>
                  <button
                    className="automation-toggle"
                    title={a.enabled ? "点击停用" : "点击启用"}
                    onClick={() => toggle(a)}
                  >
                    {a.enabled ? "● 已启用" : "○ 已停用"}
                  </button>
                </div>
                <div className="automation-item-sub">
                  {a.scheduleDesc}
                  {a.nextRunAt && a.enabled && ` · 下次 ${fmtTime(a.nextRunAt)}`}
                  {a.lastRunAt && ` · 上次 ${fmtTime(a.lastRunAt)}`}
                  {a.runCount > 0 && ` · 共 ${a.runCount} 次`}
                </div>
                <div className="automation-item-actions">
                  <span className="settings-badge">{a.surface}</span>
                  <button className="automation-action" onClick={() => runNow(a)} disabled={mutating !== null}>
                    {mutating === a.id ? "…" : "立即运行"}
                  </button>
                  <button className="automation-action" onClick={() => openEdit(a)} disabled={mutating !== null}>
                    编辑
                  </button>
                  <button className="automation-action automation-action-danger" onClick={() => remove(a)} disabled={mutating !== null}>
                    {mutating === a.id ? "…" : "删除"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "history" && (
          <div>
            {runs.length === 0 && <div className="settings-note">（暂无执行记录）</div>}
            {runs.map((r) => (
              <div key={r.id} className="automation-item">
                <div className="automation-item-main">
                  <span className={`automation-status automation-status-${r.status}`}>
                    {STATUS_LABELS[r.status]}
                  </span>
                  <span className="automation-item-text">{r.automationName}</span>
                  <span className="automation-item-time">{fmtTime(r.startedAt)}</span>
                </div>
                {r.error && <div className="automation-item-sub automation-item-err">{r.error}</div>}
                {r.sessionId && (
                  <div className="automation-item-actions">
                    <button className="automation-action" onClick={() => jump(r)}>
                      跳转到对话流 →
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === "templates" && (
          <div>
            <div className="settings-note">内置常用任务模板，点击预填配置后按需修改创建。</div>
            {AUTOMATION_TEMPLATES.map((t) => (
              <div key={t.name} className="automation-item">
                <div className="automation-item-main">
                  <span className="settings-badge">{t.surface}</span>
                  <span className="automation-item-text">{t.name}</span>
                  <span className="automation-item-time">{t.scheduleDesc}</span>
                </div>
                <div className="automation-item-sub">{t.prompt}</div>
                <div className="automation-item-actions">
                  <button className="automation-action" onClick={() => openCreate(t)}>
                    使用此模板
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 新建 / 编辑弹窗 */}
      {form && (
        <div className="automation-modal-mask" onClick={() => setForm(null)}>
          <div className="automation-modal" onClick={(e) => e.stopPropagation()}>
            <div className="automation-modal-head">
              <span>{form.id ? "编辑定时任务" : "新建自动化任务"}</span>
              <button className="automation-action" onClick={() => setForm(null)}>
                ✕
              </button>
            </div>
            <label className="settings-sub-label">任务名称</label>
            <input
              className="settings-input"
              placeholder="如：每日行情摘要"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f!, name: e.target.value }))}
            />
            <label className="settings-sub-label">任务内容（到点自动执行时发给 AI 的指令）</label>
            <textarea
              className="settings-textarea"
              placeholder="如：检索今日行业新闻，整理一份摘要。"
              value={form.prompt}
              onChange={(e) => setForm((f) => ({ ...f!, prompt: e.target.value }))}
            />
            <label className="settings-sub-label">触发方式</label>
            <div className="settings-add">
              {(["interval", "cron"] as const).map((t) => (
                <button
                  key={t}
                  className={`settings-chip${form.scheduleType === t ? " settings-chip-active" : ""}`}
                  onClick={() => setForm((f) => ({ ...f!, scheduleType: t }))}
                >
                  {t === "interval" ? "间隔触发" : "固定时间"}
                </button>
              ))}
            </div>
            {form.scheduleType === "interval" ? (
              <div className="settings-add">
                <input
                  className="settings-input"
                  type="number"
                  min={1}
                  placeholder="间隔分钟数（如 30、60、1440=每天）"
                  value={form.intervalMinutes}
                  onChange={(e) => setForm((f) => ({ ...f!, intervalMinutes: e.target.value }))}
                />
                <span className="settings-sub-label">分钟</span>
              </div>
            ) : (
              <>
                <div className="settings-add">
                  {(["daily", "weekly", "monthly"] as const).map((fq) => (
                    <button
                      key={fq}
                      className={`settings-chip${form.cronFreq === fq ? " settings-chip-active" : ""}`}
                      onClick={() => setForm((f) => ({ ...f!, cronFreq: fq }))}
                    >
                      {CRON_FREQ_LABELS[fq]}
                    </button>
                  ))}
                </div>
                <div className="settings-add">
                  {form.cronFreq === "weekly" && (
                    <select
                      className="settings-input select-auto"
                      value={form.cronDow}
                      onChange={(e) => setForm((f) => ({ ...f!, cronDow: e.target.value }))}
                    >
                      {Object.entries(DOW_LABELS).map(([v, label]) => (
                        <option key={v} value={v}>
                          周{label}
                        </option>
                      ))}
                    </select>
                  )}
                  {form.cronFreq === "monthly" && (
                    <input
                      className="settings-input"
                      type="number"
                      min={1}
                      max={31}
                      placeholder="日期"
                      value={form.cronDom}
                      onChange={(e) => setForm((f) => ({ ...f!, cronDom: e.target.value }))}
                    />
                  )}
                  <input
                    className="settings-input"
                    type="time"
                    value={form.cronTime}
                    onChange={(e) => setForm((f) => ({ ...f!, cronTime: e.target.value }))}
                  />
                </div>
              </>
            )}
            {!form.id && (
              <>
                <label className="settings-sub-label">运行形态（创建后不可修改）</label>
                <div className="settings-add">
                  {(["work", "coding"] as const).map((s) => (
                    <button
                      key={s}
                      className={`settings-chip${form.surface === s ? " settings-chip-active" : ""}`}
                      onClick={() => {
                        setForm((f) => ({ ...f!, surface: s }));
                        onSurfaceChange(s);
                      }}
                    >
                      {s === "work" ? "Work" : "Coding"}
                    </button>
                  ))}
                </div>
                <label className="settings-sub-label">工作目录（可选，创建后不可修改）</label>
                <input
                  className="settings-input"
                  placeholder="如 E:\project，留空使用默认工作区"
                  value={form.workdir}
                  onChange={(e) => setForm((f) => ({ ...f!, workdir: e.target.value }))}
                />
              </>
            )}
            {form.id && (
              <div className="settings-note">运行形态与工作目录创建后不可修改。</div>
            )}
            <div className="settings-add">
              <button className="settings-save" disabled={saving} onClick={save}>
                {saving ? "保存中…" : form.id ? "保存修改" : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
