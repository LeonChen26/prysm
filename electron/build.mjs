/**
 * Electron 主进程构建：用 esbuild 把 main/preload 打包进 dist-electron/，
 * 并把静态渲染页复制过去。Node 内置与 node_modules 均参与打包（输出 self-contained ESM）。
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "dist-electron");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: false,
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: [path.join(root, "electron/main.ts")],
  outfile: path.join(outDir, "main.mjs"),
  format: "esm",
});

await build({
  ...shared,
  entryPoints: [path.join(root, "electron/preload.ts")],
  outfile: path.join(outDir, "preload.cjs"),
  format: "cjs",
});

// 复制渲染页静态资源
fs.cpSync(
  path.join(root, "electron/renderer"),
  path.join(outDir, "renderer"),
  { recursive: true },
);

console.log("✓ Electron 构建完成 → dist-electron/");