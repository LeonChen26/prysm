# 06 · 桌面壳（Electron）

> 覆盖：`electron/main.ts`、`electron/build.mjs`、`electron/after-pack.cjs`、`electron/loadEnv.ts`、
> `electron-builder.yml`、`package.json` 的 electron/dist/release 脚本

## 1. 架构定位

**Electron 不承载业务逻辑，只做三件事**：

1. 拉起 / 复用本地 Next.js 服务（开发：`next dev`；打包版：standalone `server.js`）；
2. `BrowserWindow` 加载 `http://127.0.0.1:<port>`（REST + SSE 全走 HTTP，前端零改动）；
3. 桌面原生能力：自动更新、外部链接打开。

数据基准 `PRYSM_BASE_DIR=userData` 注入服务子进程环境，全部 DB / mcp.json / skills / memory 落于用户数据目录（见 [04-data.md](04-data.md) §1）。

```
┌────────────────────────────────┐
│ Electron 主进程 (main.cjs)      │
│  ├─ 拉起 Next.js 服务子进程      │  next dev / standalone server.js
│  │     env: PRYSM_BASE_DIR=userData, PORT, HOSTNAME
│  ├─ BrowserWindow → http://127.0.0.1:30123
│  └─ electron-updater（仅打包+PRYSM_AUTO_UPDATE=1）
└────────────────────────────────┘
```

## 2. 开发 / 打包判定（main.ts:19）

```ts
const isDev = process.defaultApp === true;
```

不用 `app.isPackaged`（部分环境误判 true 导致误走打包分支 spawn standalone 失败）。

## 3. 服务拉起（main.ts:108-131）

| 形态 | 方式 |
|---|---|
| 打包版 | `spawn(process.execPath, [serverJs], { env: { ELECTRON_RUN_AS_NODE: "1" } })` —— 以纯 Node 模式跑 standalone server.js |
| 开发版 | 先探测 `GET /api/health`，已有 `next dev` 则复用；否则 `node next dev -p 30123 -H 127.0.0.1` |

`waitForWeb`：每 500ms 轮询 health，60s 超时，超时弹错误框并退出。

## 4. 关键实现细节

- **禁用系统代理**：`app.commandLine.appendSwitch("no-proxy-server")` —— 本地服务必须直连 127.0.0.1，避免 Chromium 代理设置导致 ERR_PROXY（修过「桌面版按钮无响应」）。
- **dev userData 重定向**：开发模式 `userData` 指向项目内 `.electron-data`，避免沙箱/权限环境写 AppData 失败导致 SingletonLock 失败；打包版保持系统默认。
- **env 加载**：优先项目根 `.env.local`，其次 userData 下 `.env.local`（服务子进程继承 process.env）。
- **主进程日志**：GUI 程序 stdout 难捕获，`fileLog` 落盘 `main.log`（dev 在项目根、打包在 userData）。
- **崩溃捕获**：`uncaughtException` / `unhandledRejection` 落盘不弹框。
- **单实例锁**：`requestSingleInstanceLock`，二次启动聚焦已有窗口。
- **外链**：`setWindowOpenHandler` 一律 `shell.openExternal` + deny。
- **安全**：`contextIsolation: true`、`nodeIntegration: false`（渲染层纯 Web，无 preload/IPC）。

## 5. 自动更新（main.ts:139-161）

- 门控：`!isDev && process.env.PRYSM_AUTO_UPDATE === "1"`；
- 更新源：`PRYSM_UPDATE_URL`（generic 覆盖）> electron-builder.yml `publish`（GitHub Releases，嵌 app-update.yml）；
- 行为：发现新版本 → 自动下载（autoDownload=false 但 update-available 回调里手动 downloadUpdate）→ 退出时静默安装（autoInstallOnAppQuit）；
- 动态 import electron-updater：开发模式完全不加载（其顶层副作用会触发 spawn 崩溃）。

## 6. 构建与打包（electron/build.mjs + after-pack.cjs）

### 6.1 主进程构建

- esbuild 输出 **CJS**（`dist-electron/main.cjs`）——ESM 下 electron-updater 内部 `require("child_process")` 会触发 "Dynamic require" 崩溃；
- `external: ["electron", "electron-updater"]` —— bundle 进 electron 会拿到二进制路径字符串而非 API，electron-updater 顶层副作用触发 spawn 崩溃。

### 6.2 打包（electron-builder.yml + after-pack.cjs）

- `dist*` 系列：`next build` → 编译主进程 → 构建当前平台安装包（`--publish never`）；
- `release*` 系列：同上 + 发布 GitHub Releases（`--publish always`，需 GH_TOKEN；Windows 以 draft 发布）；
- standalone 产物经 `afterPack` 钩子复制到 `resources/web/server`（standalone + `.next/static` + `public`）；
  - 原因：electron-builder 的 `extraResources` 硬编码排除 node_modules，而 standalone 依赖 next 运行时包；
  - Next 16 standalone 的 `.next/node_modules` 是 junction，需 `realpathSync` 递归复制。
- 产物：`Prysm-Setup-<version>.exe` + `.blockmap` + `latest.yml` + `win-unpacked/`（绿色版）。

## 7. 已知注意点

| 级别 | 说明 |
|---|---|
| 中 | 退出时仅 `webServer.kill()` 杀服务子进程，Next dev 的孙进程（编译器等）可能残留（main.ts:236-238） |
| 低 | 若 dev 模式已有一个 `npm run dev` 在跑（非注入 userData 的），复用后数据基准可能不一致（仅开发场景） |
| 文档 | 完整打包/分发/签名/版本管理说明见 [distribution.md](../distribution.md) |
