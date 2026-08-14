/**
 * Prysm 桌面壳 —— Electron 主进程（Phase 8）
 *
 * 架构：核心（lib/）迁入主进程，baseDir = app.getPath('userData')；
 *       渲染进程通过 preload 暴露的 window.prysm IPC 与主进程通信；
 *       核心直接 emit 的 AgentEventBus 经 webContents.send('prysm:event') 桥接给渲染进程。
 * 前端复用：本壳渲染进程为独立静态页面；Web（Next.js）前端组件形态可平移到该页面。
 */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./loadEnv";
import { createCore } from "../lib/core";
import { contentText } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { consumeStopped, generateTitle, logRun, markStopped, getRunLogs } from "../lib/agent";
import { rememberMessages } from "../lib/memory";
import { resolveApproval, listPendingApprovals } from "../lib/approval";
import {
  decidePlan,
  cancelPlan,
  listPendingPlans,
} from "../lib/plan";
import { toImageContents, extractImages } from "../lib/attachments";
import {
  deleteSession,
  getSession,
  renameSession,
  saveSessionMessages,
  type SessionInfo,
} from "../lib/session";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 加载模型 API Key 等：优先 project 根 .env.local，其次用户数据目录
loadEnvFile(path.join(app.getAppPath(), ".env.local"));
loadEnvFile(path.join(app.getPath("userData"), ".env.local"));

// 核心：baseDir = userData（DB / mcp.json / skills 均落于此）
const core = createCore({ baseDir: app.getPath("userData"), env: process.env });

let mainWindow: BrowserWindow | null = null;

function toUiMessage(m: AgentMessage) {
  if (m.role === "user" || m.role === "assistant") {
    return {
      role: m.role,
      text: contentText(m.content),
      timestamp: m.timestamp ?? 0,
      images: extractImages(m.content),
    };
  }
  return null;
}

function resolveSession(body: { sessionId?: unknown }): SessionInfo {
  if (typeof body.sessionId === "string" && body.sessionId) {
    const s = getSession(body.sessionId);
    if (s) return s;
  }
  return core.listSessions()[0] ?? core.createSession();
}

function broadcast(event: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("prysm:event", event);
  }
}

// 核心直接 emit 的 AgentEventBus → 渲染进程（IPC 适配）
core.eventBus.subscribe(broadcast);

async function runPrompt(
  sessionId: string,
  message: string,
  images?: { data: string; mimeType: string }[],
): Promise<{ sessionId: string }> {
  const session = getSession(sessionId) ?? core.createSession();
  const agent = await core.getAgent(session.id);
  if (agent.state.isStreaming) {
    throw new Error("agent 正在处理上一条消息，请稍候");
  }
  const imageContents = toImageContents(images ?? []);
  const runStartedAt = Date.now();
  const toolCalls: Record<string, number> = {};
  const unsub = core.eventBus.subscribe((e) => {
    const ev = e as { type?: string; toolName?: string; sessionId?: string };
    if (ev.type === "tool_end" && ev.sessionId === session.id && ev.toolName) {
      toolCalls[ev.toolName] = (toolCalls[ev.toolName] ?? 0) + 1;
    }
  });
  let aborted = false;
  let runError: unknown = undefined;
  try {
    await agent.prompt(message, imageContents.length > 0 ? imageContents : undefined);
    await agent.waitForIdle();
  } catch (err) {
    runError = err;
    aborted =
      (err instanceof Error &&
        (err.name === "AbortError" || /abort/i.test(err.message))) ||
      !!agent.signal?.aborted;
    if (!aborted) broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    unsub();
    const stopped = aborted || consumeStopped(session.id);
    const msgs = agent.state.messages;
    try {
      saveSessionMessages(session.id, msgs);
      if (session.title === "新会话") {
        const firstUser = msgs.find((m) => m.role === "user");
        if (firstUser) {
          const t = contentText(firstUser.content).trim().slice(0, 20);
          if (t) {
            renameSession(session.id, t);
            session.title = t;
          }
        }
      }
      const userMsgs = msgs.filter((m) => m.role === "user");
      const firstText = userMsgs.length ? contentText(userMsgs[0].content).trim() : "";
      const isDefault =
        session.title === "新会话" ||
        (!!firstText && session.title === firstText.slice(0, 20));
      if (isDefault && userMsgs.length >= 2 && !stopped && !aborted) {
        try {
          const better = await generateTitle(msgs);
          if (better && better !== session.title) {
            renameSession(session.id, better);
            console.log(`[title] 会话标题 → "${better}"`);
          }
        } catch (err) {
          console.error("[title] 自动标题生成失败:", err);
        }
      }
    } catch (err) {
      console.error("[session] 持久化失败:", err);
    }
    logRun({
      sessionId: session.id,
      title: session.title,
      startedAt: runStartedAt,
      durationMs: Date.now() - runStartedAt,
      messageCount: msgs.length,
      stopped,
      toolCalls,
      error:
        !aborted && runError
          ? runError instanceof Error ? runError.message : String(runError)
          : undefined,
    });
    try {
      const stored = rememberMessages(agent.state.messages);
      if (stored > 0) console.log(`[memory] 已写入 ${stored} 条情景记忆`);
    } catch (err) {
      console.error("[memory] 写入失败:", err);
    }
    broadcast(stopped ? { type: "stopped", sessionId } : { type: "done", sessionId });
  }
  return { sessionId: session.id };
}

function registerIpc(): void {
  // 会话
  ipcMain.handle("prysm:listSessions", () => core.listSessions());
  ipcMain.handle("prysm:createSession", (_e, opts?: { title?: string; surface?: string }) =>
    core.createSession({
      title: opts?.title,
      surface: (opts?.surface === "work" || opts?.surface === "coding" ? opts.surface : undefined),
    }),
  );
  ipcMain.handle("prysm:renameSession", (_e, id: string, title: string) =>
    renameSession(id, title),
  );
  ipcMain.handle("prysm:deleteSession", (_e, id: string) => {
    deleteSession(id);
  });
  ipcMain.handle("prysm:getMessages", async (_e, sessionId: string) => {
    const session = getSession(sessionId) ?? core.listSessions()[0];
    if (!session) return { messages: [], session: null };
    const agent = await core.getAgent(session.id);
    return {
      messages: agent.state.messages.map(toUiMessage).filter(Boolean),
      session: { id: session.id, title: session.title },
    };
  });

  // 对话（事件经 prysm:event 推送）
  ipcMain.handle(
    "prysm:prompt",
    async (_e, opts: { sessionId?: string; message?: string; images?: { data: string; mimeType: string }[] }) => {
      const message = String(opts?.message ?? "").trim();
      if (!message) throw new Error("message 不能为空");
      const images = (Array.isArray(opts?.images) ? opts.images : [])
        .filter((img) => img && typeof img.data === "string" && img.data && typeof img.mimeType === "string");
      const session = resolveSession(opts);
      return runPrompt(session.id, message, images);
    },
  );
  ipcMain.handle("prysm:stop", (_e, sessionId: string) => {
    markStopped(sessionId);
    core.getAgent(sessionId).then((ag) => ag.abort());
  });

  // 审批
  ipcMain.handle("prysm:listPendingApprovals", () => listPendingApprovals());
  ipcMain.handle("prysm:approve", (_e, id: string, approve: boolean) =>
    resolveApproval(id, approve),
  );

  // Plan mode
  ipcMain.handle("prysm:listPendingPlans", () => listPendingPlans());
  ipcMain.handle("prysm:decidePlan", (_e, id: string, approve: boolean) => {
    if (approve) return decidePlan(id, true);
    cancelPlan(id, "用户在桌面端拒绝");
    return true;
  });

  // 工作区 / 技能 / 策略 / 运行日志 / 模型路由
  ipcMain.handle("prysm:listWorkspaces", () => core.listWorkspaces());
  ipcMain.handle("prysm:addWorkspace", (_e, root: string, name?: string) =>
    core.addWorkspace(root, name),
  );
  ipcMain.handle("prysm:removeWorkspace", (_e, id: string) => core.removeWorkspace(id));
  ipcMain.handle("prysm:grantWorkspaceAccess", (_e, id: string) =>
    core.grantWorkspaceAccess(id),
  );
  ipcMain.handle("prysm:revokeWorkspaceAccess", (_e, id: string) =>
    core.revokeWorkspaceAccess(id),
  );
  ipcMain.handle("prysm:listSkills", () => core.listSkills());
  ipcMain.handle("prysm:enableSkill", (_e, name: string) => core.enableSkill(name));
  ipcMain.handle("prysm:disableSkill", (_e, name: string) => core.disableSkill(name));
  ipcMain.handle("prysm:listPolicyRules", () => core.listPolicyRules());
  ipcMain.handle("prysm:addPolicyRule", (_e, kind: string, value: string) =>
    core.addPolicyRule(kind as never, value),
  );
  ipcMain.handle("prysm:removePolicyRule", (_e, id: number) => core.removePolicyRule(id));
  ipcMain.handle("prysm:listRunLogs", () => getRunLogs());
  ipcMain.handle("prysm:listModelRoutes", () => core.listModelRoutes());
  ipcMain.handle("prysm:setModelRoute", (_e, role: string, provider: string, model: string) =>
    core.setModelRoute(role as never, provider, model),
  );
}

/**
 * 自动更新（electron-updater）：仅打包版且显式开启（PRYSM_AUTO_UPDATE=1）时启用。
 * 更新服务地址由 PRYSM_UPDATE_URL 或 electron-builder.yml 的 publish 提供；
 * 未配置更新源时静默跳过，不影响本地安装版使用。
 */
function setupAutoUpdater(): void {
  if (!app.isPackaged || process.env.PRYSM_AUTO_UPDATE !== "1") return;
  const url = process.env.PRYSM_UPDATE_URL;
  if (url) {
    autoUpdater.setFeedURL({ provider: "generic", url });
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] 发现新版本 ${info.version}`);
    autoUpdater.downloadUpdate().catch((err) => console.error("[updater] 下载失败:", err));
  });
  autoUpdater.on("update-downloaded", () => {
    console.log("[updater] 更新已就绪，退出时安装");
  });
  autoUpdater.on("error", (err) => {
    console.error("[updater] 检查更新失败:", err?.message ?? err);
  });
  autoUpdater.checkForUpdates().catch(() => {
    /* 无更新源时静默 */
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Prysm",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer/index.html"));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpc();
  setupAutoUpdater();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});