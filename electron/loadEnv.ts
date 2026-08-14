/**
 * 极简 .env / .env.local 加载器（Electron 主进程用）。
 * Next.js 的 dev/build 会自动加载 project 根 .env.local，而 Electron 主进程不会，
 * 这里在启动时手动读取，把模型 API Key 等注入 process.env（不覆盖已存在的变量）。
 */
import fs from "node:fs";

export function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // key = value（value 可带引号，去掉首尾引号）
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (process.env[key] === undefined) {
      process.env[key] = value.trim().replace(/^["']|["']$/g, "");
    }
  }
}