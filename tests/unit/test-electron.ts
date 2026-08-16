/**
 * 桌面壳（Electron）验证脚本 —— 静态一致性检查（复用 Web 前端架构）。
 * 覆盖：主进程拉起 Web 服务（dev next dev / 打包 standalone + ELECTRON_RUN_AS_NODE）；
 *      数据基准 PRYSM_BASE_DIR=userData；自动更新门控；打包配置含 standalone extraResources。
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

console.log("\n== 主进程（electron/main.ts）结构 ==");
const main = fs.readFileSync(path.join(root, "electron/main.ts"), "utf8");
expectEq("主进程通过 loadURL 加载本地 Web 服务", main.includes("loadURL(WEB_URL)"), true);
expectEq("主进程轮询 /api/health 等待就绪", main.includes("/api/health"), true);
expectEq("打包版以 ELECTRON_RUN_AS_NODE 运行 standalone server.js", main.includes("ELECTRON_RUN_AS_NODE"), true);
expectEq("主进程注入 PRYSM_BASE_DIR=userData", main.includes("PRYSM_BASE_DIR"), true);
expectEq("开发模式复用/拉起 next dev", main.includes("next dev"), true);
expectEq("主进程引用 electron-updater", main.includes("electron-updater"), true);
expectEq("自动更新受 PRYSM_AUTO_UPDATE 门控", main.includes("PRYSM_AUTO_UPDATE"), true);
expectEq("外链经 shell.openExternal 打开", main.includes("openExternal"), true);

console.log("\n== 独立渲染页已废弃（复用 Web 前端）==");
expectEq("不再有 electron/renderer", !fs.existsSync(path.join(root, "electron/renderer")), true);
expectEq("不再有 electron/preload.ts", !fs.existsSync(path.join(root, "electron/preload.ts")), true);

console.log("\n== 构建脚本（electron/build.mjs）==");
expectEq("electron/build.mjs 存在", fs.existsSync(path.join(root, "electron/build.mjs")), true);
const buildMjs = fs.readFileSync(path.join(root, "electron/build.mjs"), "utf8");
expectEq("构建产物为 dist-electron/main.cjs", buildMjs.includes("main.cjs"), true);

console.log("\n== 打包配置（electron-builder.yml）==");
const ebYml = path.join(root, "electron-builder.yml");
expectEq("electron-builder.yml 存在", fs.existsSync(ebYml), true);
const eb = fs.readFileSync(ebYml, "utf8");
expectEq("配置含 appId", eb.includes("appId:"), true);
expectEq("配置含 productName", eb.includes("productName:"), true);
expectEq("配置含 nsis 目标", eb.includes("nsis:"), true);
expectEq("standalone 经 afterPack 钩子打包（避免 node_modules 被排除）", eb.includes("afterPack:"), true);
expectEq("after-pack.cjs 存在", fs.existsSync(path.join(root, "electron/after-pack.cjs")), true);

console.log("\n== 核心 baseDir 注入（lib/core.ts）==");
const core = fs.readFileSync(path.join(root, "lib/core.ts"), "utf8");
expectEq("createCore 支持 PRYSM_BASE_DIR 环境注入", core.includes("PRYSM_BASE_DIR"), true);

console.log("\n== 健康检查路由存在 ==");
expectEq(
  "/api/health 路由存在",
  fs.existsSync(path.join(root, "app/api/health/route.ts")),
  true,
);

console.log("\n== 脚本与自动更新 ==");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
expectEq("依赖含 electron-updater", !!(pkg.dependencies && pkg.dependencies["electron-updater"]), true);
expectEq("devDependencies 含 electron-builder", !!(pkg.devDependencies && pkg.devDependencies["electron-builder"]), true);
expectEq("存在 dist:win 脚本", !!pkg.scripts["dist:win"], true);
expectEq("dist 脚本先执行 next build", pkg.scripts["dist:win"].includes("next build"), true);
expectEq("dist 脚本禁用发布(--publish never)", pkg.scripts["dist:win"].includes("--publish never"), true);
expectEq("存在 release:github 发布脚本", !!pkg.scripts["release:github"], true);
expectEq("release 脚本启用发布(--publish always)", pkg.scripts["release:github"].includes("--publish always"), true);

console.log("\n== 发布源与分发文档 ==");
expectEq("publish 段配置 GitHub 发布源", eb.includes("provider: github"), true);
expectEq("发布源 owner 已配置", eb.includes("owner: LeonChen26"), true);
expectEq("发布源 repo 已配置", eb.includes("repo: prysm"), true);
expectEq("分发文档存在", fs.existsSync(path.join(root, "docs/distribution.md")), true);

console.log("\n✓ 桌面壳验证通过");
