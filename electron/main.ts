/**
 * Prysm 桌面壳 —— Electron 主进程
 *
 * 架构（复用 Web 前端）：核心（lib/）与前端（app/ + components/）均为 Next.js 应用，
 * 主进程只负责三件事：
 *   1. 拉起 / 连接 Next.js 服务（开发：next dev；打包版：standalone server.js）；
 *   2. 用 BrowserWindow 加载 http://127.0.0.1:<port>（REST + SSE 走 HTTP，前端零改动）；
 *   3. 桌面原生能力：自动更新、外部链接打开。
 * 数据基准：PRYSM_BASE_DIR=userData 注入服务进程环境，Web 后端数据全部落于用户数据目录。
 */
import { app, BrowserWindow, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { loadEnvFile } from "./loadEnv";

// 开发/打包判定：defaultApp=true 表示以 `electron <dir>` 方式运行（开发模式）。
// 不用 app.isPackaged：部分环境下其返回 true 导致误走打包分支（spawn standalone 失败）。
const isDev = process.defaultApp === true;

// 主进程文件日志：Windows GUI 程序 stdout 难以捕获，落盘便于诊断
function fileLog(msg: string): void {
  try {
    const dir = isDev ? app.getAppPath() : app.getPath("userData");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "main.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

// 本地 Web 服务必须直连 127.0.0.1：禁用系统代理，避免 Chromium 代理设置导致 ERR_PROXY 类加载失败
app.commandLine.appendSwitch("no-proxy-server");

// 捕获主进程异常：落盘便于诊断（不弹默认错误框）
process.on("uncaughtException", (err) => {
  fileLog(`[crash] ${err instanceof Error ? err.stack : String(err)}`);
});
process.on("unhandledRejection", (reason) => {
  fileLog(`[crash] [unhandledRejection] ${String(reason)}`);
});

// 开发模式：userData 指向项目内 .electron-data。避免在受限环境（沙箱/权限策略）
// 下无法写入系统 AppData 导致 SingletonLock 创建失败；打包版保持系统默认 userData。
if (isDev) {
  app.setPath("userData", path.join(app.getAppPath(), ".electron-data"));
}

// 加载模型 API Key 等：优先项目根 .env.local，其次用户数据目录（供服务子进程继承）
loadEnvFile(path.join(app.getAppPath(), ".env.local"));
loadEnvFile(path.join(app.getPath("userData"), ".env.local"));

// 桌面模式数据基准：所有 DB / mcp.json / skills / memory 落于 userData
process.env.PRYSM_BASE_DIR = app.getPath("userData");

const WEB_PORT = Number(process.env.PRYSM_WEB_PORT ?? 30123);
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const HEALTH_URL = `${WEB_URL}/api/health`;

let mainWindow: BrowserWindow | null = null;
let webServer: ChildProcess | null = null;

/** 轮询 /api/health 等待 Web 后端就绪 */
async function waitForWeb(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Web 后端未在 ${timeoutMs}ms 内就绪（${WEB_URL}）：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

function spawnServer(
  cmd: string,
  args: string[],
  cwd: string,
  extraEnv: Partial<NodeJS.ProcessEnv> = {},
): ChildProcess {
  const child = spawn(cmd, args, {
    cwd,
    env: {
      ...process.env,
      PRYSM_BASE_DIR: app.getPath("userData"),
      PORT: String(WEB_PORT),
      HOSTNAME: "127.0.0.1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => fileLog(`[web] ${d.toString().trimEnd()}`));
  child.stderr?.on("data", (d: Buffer) => fileLog(`[web] ${d.toString().trimEnd()}`));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      fileLog(`[web] 服务退出，code=${code}`);
    }
  });
  return child;
}

async function startWebServer(): Promise<void> {
  if (!isDev) {
    // 打包版：以纯 Node 模式运行 standalone server.js（.next/standalone 由 extraResources 放入 resources/web/server）
    const serverJs = path.join(process.resourcesPath, "web", "server", "server.js");
    webServer = spawnServer(process.execPath, [serverJs], path.dirname(serverJs), {
      ELECTRON_RUN_AS_NODE: "1",
    });
    await waitForWeb();
    return;
  }

  // 开发模式：若已有 next dev 在跑（npm run dev）则直接复用；否则自行拉起并注入 userData
  const alive = await fetch(HEALTH_URL)
    .then((res) => res.ok)
    .catch(() => false);
  if (alive) {
    fileLog(`[web] 复用已运行的开发服务器 ${WEB_URL}`);
    return;
  }
  const root = app.getAppPath();
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  webServer = spawnServer("node", [nextBin, "dev", "-p", String(WEB_PORT), "-H", "127.0.0.1"], root);
  await waitForWeb();
}

/**
 * 自动更新（electron-updater）：仅打包版且显式开启（PRYSM_AUTO_UPDATE=1）时启用。
 * 更新服务地址由 PRYSM_UPDATE_URL 或 electron-builder.yml 的 publish 提供；
 * 未配置更新源时静默跳过，不影响本地安装版使用。
 * 采用动态导入：开发模式下完全不加载 electron-updater（其顶层副作用会触发 spawn 失败）。
 */
async function setupAutoUpdater(): Promise<void> {
  if (isDev || process.env.PRYSM_AUTO_UPDATE !== "1") return;
  const { autoUpdater } = await import("electron-updater");
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
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(WEB_URL);
  // 启动诊断：页面加载失败 / 渲染进程异常时打印具体原因
  mainWindow.webContents.on("did-finish-load", () => {
    fileLog(`[win] did-finish-load ${mainWindow?.webContents.getURL()}`);
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    fileLog(`[win] did-fail-load code=${code} desc=${desc} url=${url}`);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    fileLog(`[win] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    fileLog("[app] whenReady");
    try {
      await startWebServer();
      fileLog("[app] web 服务就绪，创建窗口");
    } catch (err) {
      fileLog(`[app] web 启动失败: ${err instanceof Error ? err.message : String(err)}`);
      const { dialog } = await import("electron");
      dialog.showErrorBox(
        "Prysm 启动失败",
        `无法启动本地 Web 服务：${err instanceof Error ? err.message : String(err)}`,
      );
      app.quit();
      return;
    }
    setupAutoUpdater().catch(() => {
      /* 更新初始化失败不影响主流程 */
    });
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // 退出时回收服务子进程
  app.on("will-quit", () => {
    if (webServer && !webServer.killed) webServer.kill();
  });
}
