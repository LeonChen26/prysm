/* Prysm 桌面壳 —— 渲染进程逻辑（经 preload 暴露的 window.prysm 与主进程通信） */
"use strict";

const prysm = window.prysm;
const $ = (sel) => document.querySelector(sel);

const state = {
  sessionId: null,
  surface: "coding",
  streaming: false,
};

// ---------- 会话侧栏 ----------
const sessionListEl = $("#session-list");

async function refreshSessions() {
  const sessions = await prysm.listSessions();
  sessionListEl.innerHTML = "";
  for (const s of sessions) {
    const li = document.createElement("li");
    li.className = "session-item" + (s.id === state.sessionId ? " active" : "");
    li.dataset.id = s.id;
    const title = document.createElement("span");
    title.className = "s-title";
    title.textContent = s.title;
    const del = document.createElement("button");
    del.className = "s-del";
    del.textContent = "×";
    del.title = "删除会话";
    del.onclick = async (e) => {
      e.stopPropagation();
      await prysm.deleteSession(s.id);
      if (state.sessionId === s.id) {
        state.sessionId = null;
        $("#messages").innerHTML = "";
        $("#session-title").textContent = "新会话";
      }
      refreshSessions();
    };
    li.onclick = () => selectSession(s.id);
    li.append(title, del);
    sessionListEl.append(li);
  }
}

async function selectSession(id) {
  state.sessionId = id;
  await refreshSessions();
  const data = await prysm.getMessages(id);
  renderMessages(data.messages || []);
  $("#session-title").textContent = data.session?.title || "新会话";
  refreshSessions();
}

$("#new-session").onclick = async () => {
  const s = await prysm.createSession();
  state.sessionId = s.id;
  state.surface = s.surface || "coding";
  $("#messages").innerHTML = "";
  $("#session-title").textContent = "新会话";
  refreshSessions();
};

// ---------- 消息渲染 ----------
const messagesEl = $("#messages");
let assistantTurn = null; // 当前正在流式构建的助手消息元素

function renderMessages(msgs) {
  messagesEl.innerHTML = "";
  for (const m of msgs) {
    appendMessage(m);
  }
  assistantTurn = null;
  scrollToBottom();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendMessage(m) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + m.role;
  const tag = document.createElement("div");
  tag.className = "role-tag";
  tag.textContent = m.role === "user" ? "你" : "Prysm";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = m.text || "";
  wrap.append(tag, bubble);
  messagesEl.append(wrap);
  scrollToBottom();
  return wrap;
}

function appendBlock(block) {
  messagesEl.append(block);
  scrollToBottom();
}

function addNotice(text) {
  const el = document.createElement("div");
  el.className = "notice";
  el.textContent = text;
  appendBlock(el);
}

// ---------- 工具卡片 ----------
function addToolCard(ev) {
  const card = document.createElement("div");
  card.className = "tool-card";
  card.dataset.id = ev.id;
  card.innerHTML = `
    <div class="tc-head">
      <span class="tc-name"></span>
      <span class="tc-state running">运行中</span>
    </div>
    <div class="tc-args"></div>
    <div class="tc-body" hidden></div>`;
  card.querySelector(".tc-name").textContent = ev.toolName;
  card.querySelector(".tc-args").textContent =
    ev.args && typeof ev.args === "object" ? JSON.stringify(ev.args, null, 2) : "";
  card.querySelector(".tc-head").onclick = () => {
    const body = card.querySelector(".tc-body");
    body.hidden = !body.hidden;
  };
  appendBlock(card);
  return card;
}

function updateToolCardEnd(ev) {
  const card = messagesEl.querySelector(`.tool-card[data-id="${ev.id}"]`);
  if (!card) return;
  const st = card.querySelector(".tc-state");
  if (ev.isError) {
    st.textContent = "失败";
    st.className = "tc-state error";
    card.querySelector(".tc-body").textContent = ev.result || "执行失败";
    card.querySelector(".tc-body").hidden = false;
  } else {
    st.textContent = ev.elapsedMs != null ? `完成 · ${ev.elapsedMs}ms` : "完成";
    st.className = "tc-state done";
    if (ev.result) {
      card.querySelector(".tc-body").textContent = ev.result;
      card.querySelector(".tc-body").hidden = false;
    }
  }
}

// ---------- 审批卡片 ----------
function addApprovalCard(ev) {
  const card = document.createElement("div");
  card.className = "approval-card";
  card.dataset.id = ev.id;
  const riskLabel = { low: "低", medium: "中", high: "高", critical: "严重" }[ev.risk] || "";
  card.innerHTML = `
    <div class="ac-title">审批请求：${escapeHtml(ev.toolName)}</div>
    <div class="ac-risk ${ev.risk || ""}">风险等级：${riskLabel || "未知"}${ev.riskReason ? "（" + escapeHtml(ev.riskReason) + "）" : ""}</div>
    <div class="ac-args"></div>
    <div class="ac-btns">
      <button class="allow">允许</button>
      <button class="deny">拒绝</button>
    </div>`;
  card.querySelector(".ac-args").textContent =
    ev.args && typeof ev.args === "object" ? JSON.stringify(ev.args, null, 2) : String(ev.args ?? "");
  card.querySelector(".allow").onclick = () => {
    prysm.approve(ev.id, true);
    card.querySelector(".ac-btns").innerHTML = "<div style='color:var(--success)'>已允许</div>";
  };
  card.querySelector(".deny").onclick = () => {
    prysm.approve(ev.id, false);
    card.querySelector(".ac-btns").innerHTML = "<div style='color:var(--danger)'>已拒绝</div>";
  };
  appendBlock(card);
}

function resolveApprovalCard(ev) {
  const card = messagesEl.querySelector(`.approval-card[data-id="${ev.id}"]`);
  if (!card) return;
  const label = ev.approve ? "已允许" : "已拒绝";
  const color = ev.approve ? "var(--success)" : "var(--danger)";
  card.querySelector(".ac-btns").innerHTML = `<div style="color:${color}">${label}</div>`;
}

function expireApprovalCard(ev) {
  const card = messagesEl.querySelector(`.approval-card[data-id="${ev.id}"]`);
  if (!card) return;
  card.querySelector(".ac-btns").innerHTML = "<div style='color:var(--warning)'>已超时（视为拒绝）</div>";
}

// ---------- 计划卡片 ----------
function addPlanCard(ev) {
  const card = document.createElement("div");
  card.className = "plan-card";
  card.dataset.id = ev.id;
  const steps = (ev.steps || [])
    .map((s, i) => `<li>${escapeHtml(s.title)}${s.tool ? ` <span class="pc-tool">（${escapeHtml(s.tool)}）</span>` : ""}</li>`)
    .join("");
  card.innerHTML = `
    <div class="pc-summary">待确认计划${ev.surface ? ` <span class="pc-surface">· ${escapeHtml(ev.surface)}</span>` : ""}</div>
    ${ev.summary ? `<div style="margin-bottom:6px">${escapeHtml(ev.summary)}</div>` : ""}
    <ol>${steps}</ol>
    <div class="pc-btns">
      <button class="approve">批准执行</button>
      <button class="reject">拒绝</button>
    </div>`;
  card.querySelector(".approve").onclick = () => {
    prysm.decidePlan(ev.id, true);
    card.querySelector(".pc-btns").innerHTML = "<div style='color:var(--success)'>已批准，开始执行</div>";
  };
  card.querySelector(".reject").onclick = () => {
    prysm.decidePlan(ev.id, false);
    card.querySelector(".pc-btns").innerHTML = "<div style='color:var(--danger)'>已拒绝</div>";
  };
  appendBlock(card);
}

function resolvePlanCard(ev) {
  const card = messagesEl.querySelector(`.plan-card[data-id="${ev.id}"]`);
  if (!card) return;
  const label = ev.approve ? "已批准，开始执行" : "已拒绝";
  const color = ev.approve ? "var(--success)" : "var(--danger)";
  card.querySelector(".pc-btns").innerHTML = `<div style="color:${color}">${label}</div>`;
}

// ---------- 事件流 ----------
prysm.onEvent((ev) => {
  if (!ev || typeof ev !== "object") return;
  const e = ev;
  // 会话隔离：只处理当前会话的事件
  if (e.sessionId && state.sessionId && e.sessionId !== state.sessionId) return;

  switch (e.type) {
    case "turn_start":
      assistantTurn = null;
      break;
    case "delta": {
      if (!assistantTurn) {
        assistantTurn = appendMessage({ role: "assistant", text: "" });
        assistantTurn.turn = true;
      }
      const bubble = assistantTurn.querySelector(".bubble");
      bubble.textContent += e.delta;
      scrollToBottom();
      break;
    }
    case "tool_start":
      addToolCard(e);
      break;
    case "tool_end":
      updateToolCardEnd({ ...e, elapsedMs: e.args?.elapsedMs });
      break;
    case "turn_end":
      assistantTurn = null;
      break;
    case "agent_end":
      assistantTurn = null;
      break;
    case "approval_required":
      addApprovalCard(e);
      break;
    case "approval_resolved":
      resolveApprovalCard(e);
      break;
    case "approval_expired":
      expireApprovalCard(e);
      break;
    case "policy_notice":
      addNotice(`策略拦截：${e.toolName} 被 ${e.action}（${e.reason || ""}）`);
      break;
    case "plan_proposed":
      addPlanCard(e);
      break;
    case "plan_decided":
      resolvePlanCard(e);
      break;
    case "plan_cancelled":
      resolvePlanCard({ ...e, approve: false });
      break;
    case "error":
      addNotice("错误：" + (e.message || "未知错误"));
      break;
    case "stopped":
      state.streaming = false;
      setStreaming(false);
      addNotice(e.message || "任务已停止");
      break;
    case "done":
      state.streaming = false;
      setStreaming(false);
      break;
  }
});

function setStreaming(on) {
  state.streaming = on;
  $("#streaming-dot").hidden = !on;
  $("#send").disabled = on;
  $("#send").textContent = on ? "…" : "发送";
}

// ---------- 发送 ----------
const input = $("#input");
$("#send").onclick = doSend;
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
});

async function doSend() {
  const text = input.value.trim();
  if (!text || state.streaming) return;
  input.value = "";
  input.style.height = "auto";
  setStreaming(true);
  appendMessage({ role: "user", text });
  try {
    const res = await prysm.streaming
      ? prysm.prompt({ sessionId: state.sessionId, message: text })
      : prysm.prompt({ sessionId: state.sessionId, message: text });
    if (res && res.sessionId && !state.sessionId) {
      state.sessionId = res.sessionId;
      refreshSessions();
    }
  } catch (err) {
    addNotice("发送失败：" + (err && err.message ? err.message : String(err)));
  } finally {
    setStreaming(false);
  }
}

// ---------- 侧栏 Tab ----------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $("#tab-" + tab.dataset.tab).classList.add("active");
    // 切换时刷新对应内容
    if (tab.dataset.tab === "workspaces") refreshWorkspaces();
    if (tab.dataset.tab === "skills") refreshSkills();
    if (tab.dataset.tab === "logs") refreshLogs();
  };
});

// ---------- 工作区 ----------
async function refreshWorkspaces() {
  const ws = await prysm.listWorkspaces();
  const list = $("#ws-list");
  list.innerHTML = "";
  for (const w of ws) {
    const li = document.createElement("li");
    li.className = "ws-item";
    li.innerHTML = `
      <div class="ws-name"></div>
      <div class="ws-root"></div>
      <span class="ws-auth ${w.authorized ? "ok" : "no"}">${w.authorized ? "已授权" : "未授权"}</span>`;
    li.querySelector(".ws-name").textContent = w.name;
    li.querySelector(".ws-root").textContent = w.root;
    if (!w.authorized) {
      const grant = document.createElement("button");
      grant.className = "sm-btn";
      grant.style.marginLeft = "8px";
      grant.textContent = "授权";
      grant.onclick = async () => {
        await prysm.grantWorkspaceAccess(w.id);
        refreshWorkspaces();
      };
      li.append(grant);
    }
    list.append(li);
  }
}
$("#ws-add").onclick = async () => {
  const root = $("#ws-root").value.trim();
  if (!root) return;
  await prysm.addWorkspace(root);
  $("#ws-root").value = "";
  refreshWorkspaces();
};

// ---------- 技能 ----------
async function refreshSkills() {
  const skills = await prysm.listSkills();
  const list = $("#skill-list");
  list.innerHTML = "";
  for (const s of skills) {
    const li = document.createElement("li");
    li.className = "skill-item";
    li.innerHTML = `<span class="sk-name"></span>`;
    li.querySelector(".sk-name").textContent = s.name;
    const toggle = document.createElement("div");
    toggle.className = "toggle" + (s.enabled ? " on" : "");
    toggle.onclick = async () => {
      if (s.enabled) await prysm.disableSkill(s.name);
      else await prysm.enableSkill(s.name);
      refreshSkills();
    };
    li.append(toggle);
    list.append(li);
  }
}

// ---------- 运行日志 ----------
async function refreshLogs() {
  const logs = await prysm.listRunLogs();
  const list = $("#run-log-list");
  list.innerHTML = "";
  for (const l of logs) {
    const li = document.createElement("li");
    li.className = "run-log-item";
    li.innerHTML = `<div class="rl-title"></div><div class="rl-meta"></div>${l.error ? `<div style="color:var(--danger)">` + escapeHtml(l.error) + `</div>` : ""}`;
    li.querySelector(".rl-title").textContent = `${l.title} · ${l.durationMs}ms${l.stopped ? " · 已停止" : ""}`;
    li.querySelector(".rl-meta").textContent = new Date(l.startedAt).toLocaleString();
    list.append(li);
  }
}

// ---------- 工具 ----------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- 初始化 ----------
async function init() {
  await refreshSessions();
  const sessions = await prysm.listSessions();
  if (sessions.length > 0) {
    await selectSession(sessions[0].id);
  }
  // 恢复未决的审批/计划卡片
  const approvals = await prysm.listPendingApprovals();
  for (const a of approvals) {
    if (!a.sessionId || a.sessionId === state.sessionId) addApprovalCard(a);
  }
  const plans = await prysm.listPendingPlans();
  for (const p of plans) {
    if (p.sessionId === state.sessionId)
      addPlanCard({ id: p.id, surface: p.surface, summary: p.summary, steps: p.steps });
  }
}
init();