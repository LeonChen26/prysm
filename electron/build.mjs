/**
 * Electron 主进程构建：用 esbuild 把 main 打包进 dist-electron/（CJS）。
 * 前端与核心复用 Next.js 应用（next build → .next/standalone），
 * 不再有独立渲染页 / preload IPC 桥。
 * 注：输出 CJS（main.cjs）—— ESM 输出下 electron-updater 内部 require("child_process")
 * 会触发 "Dynamic require ... not supported"。
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "dist-electron");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  bundle: true,
  platform: "node",
  target: "node20",
  entryPoints: [path.join(root, "electron/main.ts")],
  outfile: path.join(outDir, "main.cjs"),
  format: "cjs",
  // electron 必须 external：esbuild 若把 electron npm 包 bundle 进来，
  // 主进程拿到的是「二进制路径字符串」而非 Electron API，导致运行时崩溃。
  // electron-updater 同理 external：其顶层副作用（注册 quit 钩子、spawn 检测）
  // 若被 bundle 会在模块加载时执行，开发模式即触发 spawn electron.exe 失败；
  // external 后仅 setupAutoUpdater() 动态 require 时才加载。
  external: ["electron", "electron-updater"],
  sourcemap: false,
  logLevel: "info",
});

console.log("✓ Electron 主进程构建完成 → dist-electron/main.cjs");
