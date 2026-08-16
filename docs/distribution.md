# Prysm 打包与分发说明

本文档说明 Prysm 桌面应用的构建、安装、发布与自动更新流程。
打包基于 **electron-builder**，自动更新基于 **electron-updater**。

---

## 1. 构建产物

在项目根目录执行 `npm run dist:win` 后，产物输出到 `release-build/`：

| 文件 | 说明 |
|------|------|
| `Prysm-Setup-<version>.exe` | Windows NSIS 安装包（可选安装目录，支持桌面/开始菜单快捷方式） |
| `Prysm-Setup-<version>.exe.blockmap` | 增量更新块映射（自动更新差分下载用） |
| `latest.yml` | 自动更新元数据（版本号、sha512、下载地址） |
| `win-unpacked/` | 免安装绿色版（解压即用，用于直接分发/内部测试） |

> 构建时设置缓存与镜像环境变量可避免下载失败（离线/沙箱环境）：
> ```powershell
> $env:ELECTRON_BUILDER_CACHE="$PWD\.electron-cache"
> $env:ELECTRON_CACHE="$PWD\.electron-cache"
> $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
> ```

---

## 2. 构建命令

| 命令 | 作用 |
|------|------|
| `npm run electron:build` | 仅编译主进程（esbuild → `dist-electron/main.cjs`） |
| `npm run dist` | `next build` + 编译主进程 + 构建当前平台安装包（不发布） |
| `npm run dist:win` / `dist:mac` / `dist:linux` | 同 dist，构建指定平台安装包（不发布） |
| `npm run release` | `next build` + 编译主进程 + 构建并发布到 GitHub Releases（当前平台，需 `GH_TOKEN`） |
| `npm run release:github` | 同 release，发布 Windows 安装包到 GitHub Releases（需 `GH_TOKEN`） |

> `dist*` 系列带 `--publish never`，只生成本地产物，不会触发任何网络发布。
> 跨平台限制：NSIS/AppImage/dmg 只能在对应系统上构建（或使用 CI）。
>
> **桌面版复用 Web 前端**：`dist*` / `release*` 均先执行 `next build` 产出
> `.next/standalone`，再由 `afterPack` 钩子（`electron/after-pack.cjs`）复制进
> `resources/web/server`（standalone 产物 + `.next/static` + `public`）。
> 说明：electron-builder 的 `extraResources` 会硬编码排除 node_modules，
> 而 standalone 依赖 next 等运行时包，故改用 afterPack 自定义递归复制
> （Next 16 standalone 的 `.next/node_modules` 为 junction，需 `realpathSync` 解析）。
> 运行时主进程以纯 Node 模式（`ELECTRON_RUN_AS_NODE=1`）启动该 `server.js`
> 作为本地 Web 服务，BrowserWindow 加载 `http://127.0.0.1:30123`。

---

## 3. 安装与卸载

- **安装**：双击 `Prysm-Setup-<version>.exe`，按向导选择安装目录。
- **卸载**：通过「设置 → 应用」或开始菜单中的卸载入口移除。
- **绿色版**：解压 `win-unpacked/` 后直接运行 `Prysm.exe`（免安装）。

> 未做代码签名时，Windows SmartScreen 会提示「未知发布者」。
> 选择「更多信息 → 仍要运行」即可。正式分发建议配置代码签名证书（见第 6 节）。

---

## 4. 自动更新机制

- 运行时只有**打包版（非开发模式）**且设置 `PRYSM_AUTO_UPDATE=1` 才启用自动更新；
  未开启时静默跳过，不影响本地安装版。
- 更新源优先级：
  1. `PRYSM_UPDATE_URL` 环境变量（运行时覆盖，指向自建静态服务器）；
  2. 打包时嵌入的 `resources/app-update.yml`（来自 electron-builder.yml 的 `publish` 段）。
- 行为：发现新版本 → 后台下载 → 退出时静默安装。差分下载依赖 `.blockmap`。

---

## 5. 发布流程

### 5.1 GitHub Releases（默认，已配置）

`electron-builder.yml` 中 `publish` 段已指向 `github.com/LeonChen26/prysm`，
构建时会把该配置嵌入 `app-update.yml`。发布步骤：

1. 生成 GitHub 个人访问令牌（需要 `repo` 权限）：
   `GitHub → Settings → Developer settings → Personal access tokens → Generate new token`
2. 执行发布（Windows 安装包会以 **draft**（草稿）发布，确认后手动点「Publish release」）：
   ```powershell
   $env:GH_TOKEN="ghp_xxxxxxxx"
   npm run release:github
   ```
3. electron-builder 自动创建 GitHub Release 并上传：
   `Prysm-Setup-<version>.exe`、`.blockmap`、`latest.yml`（`latest.yml` 为 electron-updater 更新入口）。
4. 已安装用户开启自动更新后即可检查到该版本。

> 注意事项：
> - GitHub 未认证下载有速率限制；如需稳定可配 `GH_TOKEN` 或改用自建服务器。
> - 国内网络访问 GitHub Releases 可能较慢，可用代理或镜像；正式面向国内用户建议用自建服务器。

### 5.2 自建静态服务器（备选）

不依赖 GitHub，把更新文件放到你自己的 Nginx/静态目录：

1. 修改 `electron-builder.yml` 的 `publish` 段为 generic：
   ```yaml
   publish:
     provider: generic
     url: https://your-update-server.example.com/prysm
   ```
2. 重新执行 `npm run dist:win`，把 `release-build/` 下三个文件上传到该 URL 对应目录：
   ```
   Prysm-Setup-0.1.0.exe
   Prysm-Setup-0.1.0.exe.blockmap
   latest.yml
   ```
3. 服务器需允许 GET 与 Range 请求（electron-updater 使用差分/断点下载）。

> 不需要修改代码即可切换：运行时设置 `PRYSM_UPDATE_URL` 环境变量也可覆盖更新源。

---

## 6. 代码签名

Windows 安装包默认无签名。正式对外分发建议购买代码签名证书（如 OV/EV 证书）并配置：

- 在 `electron-builder.yml` 增加 `win.certificateFile` / `win.certificatePassword`，
  或用环境变量 `CSC_LINK`（证书路径）与 `CSC_KEY_PASSWORD`。
- 签名后可消除 SmartScreen「未知发布者」提示。

---

## 7. 版本管理

- 升级版本：修改 `package.json` 的 `version` 字段后重新 `dist`/`release`。
- electron-updater 只升级**同安装来源**（安装版→安装版），绿色版不参与自动更新。
- 旧 `release/` 目录为历史产物，可删除（`.gitignore` 已忽略 `release/` 与 `release-build/`）。
