/**
 * 桌面壳（Electron）验证脚本 —— 静态一致性检查。
 * 覆盖：preload 暴露的 window.prysm 方法 ↔ 主进程 ipcMain.handle 注册的通道一一对应；
 *      渲染页引用的资源存在；构建产物可生成。
 * 运行：npx tsx tests/unit/test-electron.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
function expectEq(name: string, actual: unknown, want: unknown) {
  if (actual !== want) fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  console.log(`  ✓ ${name}`);
}

console.log("== renderer 页面资源自洽 ==");
const html = fs.readFileSync(path.join(root, "electron/renderer/index.html"), "utf8");
for (const asset of ["styles.css", "app.js"]) {
  expectEq(`${asset} 被 index.html 引用`, html.includes(asset), true);
  expectEq(`${asset} 文件存在`, fs.existsSync(path.join(root, "electron/renderer", asset)), true);
}

console.log("\n== preload ↔ main 的 IPC 通道一致 ==");
const preload = fs.readFileSync(path.join(root, "electron/preload.ts"), "utf8");
const main = fs.readFileSync(path.join(root, "electron/main.ts"), "utf8");

// 主进程注册的通道（prysm:xxx 字符串）
const handled = [...main.matchAll(/(prysm:[A-Za-z]+)/g)].map((m) => m[1]);
// preload 暴露的方法（以 ipcRenderer.invoke("CHANNEL") 形式调用）
const exposed = [...preload.matchAll(/(prysm:[A-Za-z]+)/g)].map((m) => m[1]);

// 每个主进程通道都应在 preload 中暴露
for (const ch of handled) {
  expectEq(`主进程通道 ${ch} 已在 preload 暴露`, exposed.includes(ch), true);
}
// 每个 preload 暴露的通道都应有主进程 handler（避免悬空调用）
for (const ch of exposed) {
  expectEq(`preload 暴露的 ${ch} 有主进程 handler`, handled.includes(ch), true);
}

console.log("\n== 事件通道存在 ==");
expectEq("preload 订阅 prysm:event", preload.includes('"prysm:event"'), true);
expectEq("主进程发 prysm:event", main.includes("prysm:event"), true);

console.log("\n== 核心 baseDir 注入 userData ==");
expectEq("createCore 使用 app.getPath('userData')", main.includes("app.getPath(\"userData\")"), true);

console.log("\n== 构建脚本存在 ==");
expectEq("electron/build.mjs 存在", fs.existsSync(path.join(root, "electron/build.mjs")), true);
for (const f of ["dist-electron/main.mjs", "dist-electron/preload.cjs", "dist-electron/renderer/index.html"]) {
  expectEq(`构建产物 ${path.basename(f)} 存在`, fs.existsSync(path.join(root, f)), true);
}

console.log("\n== 打包配置（electron-builder）存在 ==");
const ebYml = path.join(root, "electron-builder.yml");
expectEq("electron-builder.yml 存在", fs.existsSync(ebYml), true);
const eb = fs.readFileSync(ebYml, "utf8");
expectEq("配置含 appId", eb.includes("appId:"), true);
expectEq("配置含 productName", eb.includes("productName:"), true);
expectEq("配置含 nsis 目标", eb.includes("nsis:"), true);

console.log("\n== 自动更新（electron-updater）接线 ==");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
expectEq("依赖含 electron-updater", !!(pkg.dependencies && pkg.dependencies["electron-updater"]), true);
expectEq("devDependencies 含 electron-builder", !!(pkg.devDependencies && pkg.devDependencies["electron-builder"]), true);
expectEq("存在 dist:win 脚本", !!pkg.scripts["dist:win"], true);
expectEq("dist 脚本禁用发布(--publish never)", pkg.scripts["dist:win"].includes("--publish never"), true);
expectEq("存在 release:github 发布脚本", !!pkg.scripts["release:github"], true);
expectEq("release 脚本启用发布(--publish always)", pkg.scripts["release:github"].includes("--publish always"), true);
expectEq("main 已引用 electron-updater", main.includes("electron-updater"), true);
expectEq("自动更新受 PRYSM_AUTO_UPDATE 门控", main.includes("PRYSM_AUTO_UPDATE"), true);

console.log("\n== 发布源与分发文档 ==");
expectEq("publish 段配置 GitHub 发布源", eb.includes("provider: github"), true);
expectEq("发布源 owner 已配置", eb.includes("owner: LeonChen26"), true);
expectEq("发布源 repo 已配置", eb.includes("repo: prysm"), true);
expectEq("分发文档存在", fs.existsSync(path.join(root, "docs/distribution.md")), true);

console.log("\n✓ 桌面壳验证通过");