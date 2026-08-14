/**
 * 目录级授权（Phase 2，默认拒绝）验证脚本 —— 纯结构断言，无 LLM 调用。
 * 覆盖：默认工作区恒授权、新增工作区默认拒绝、授权/撤销、越界拒绝、
 *      resolveInWorkdir 结构化结果与 OrThrow 抛错。
 * 注意：须在 configure 之后才导入 paths/workspace（避免以默认 cwd 播种 prysm.db）。
 * 运行：npx tsx tests/unit/test-auth.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configure, resetConfig } from "../../lib/config";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expect(name: string, actual: boolean, want = true) {
  if (actual !== want) {
    fail(`${name}: 期望 ${want}，实际 ${actual}`);
  }
  console.log(`  ✓ ${name}`);
}

async function main() {
  const base = path.join(os.tmpdir(), "prysm-test-auth");
  const extra = path.join(base, "proj-x");
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(extra, { recursive: true });

  // env 空对象：完全隔离 process.env，确保播种只有默认工作区
  configure({ baseDir: base, env: {} });

  const workspace = await import("../../lib/workspace");
  const paths = await import("../../lib/paths");

  console.log("== 默认工作区恒授权 ==");
  const seeded = workspace.listWorkspaces();
  if (!seeded.some((w) => w.id === "default")) fail("应有默认工作区");
  const r1 = paths.resolveInWorkdir("a.txt");
  if (!r1.ok) fail("默认工作区应可访问");
  expect("默认工作区可读文件", r1.ok && r1.path.endsWith(path.join("agent-workdir", "a.txt")));

  console.log("\n== 新增工作区默认拒绝（authorized=0） ==");
  const w = workspace.addWorkspace(extra, "项目X");
  if (w.authorized !== 0) fail("新增工作区应默认未授权");
  const r2 = paths.resolveInWorkdir("", extra);
  if (r2.ok) fail("未授权工作区应被拒绝");
  if (r2.reason !== "unauthorized") fail(`应为 unauthorized，实际 ${r2.reason}`);
  if (r2.workspaceId !== w.id) fail("应返回所属工作区 id");
  if (r2.root !== extra) fail("应返回所属工作区根");
  expect("未授权目录返回 unauthorized", true);
  expect("list 也不可访问", !paths.resolveInWorkdir("", extra).ok);

  console.log("\n== 授权后可访问 ==");
  workspace.grantWorkspaceAccess(w.id);
  const r3 = paths.resolveInWorkdir("", extra);
  if (!r3.ok) fail("授权后应可访问");
  expect("授权后 resolve ok", r3.ok);

  console.log("\n== 撤销后恢复拒绝 ==");
  workspace.revokeWorkspaceAccess(w.id);
  const r4 = paths.resolveInWorkdir("", extra);
  if (r4.ok || r4.reason !== "unauthorized") fail("撤销后应恢复拒绝");
  expect("撤销后恢复 unauthorized", true);

  console.log("\n== 越界（所有工作区根之外）拒绝 ==");
  const r5 = paths.resolveInWorkdir("../../../", base);
  if (r5.ok) fail("越界应被拒绝");
  if (r5.reason !== "outside") fail(`应为 outside，实际 ${r5.reason}`);
  expect("越界返回 outside", true);

  console.log("\n== resolveInWorkdirOrThrow 抛错 ==");
  try {
    paths.resolveInWorkdirOrThrow("", extra);
    fail("未授权目录 OrThrow 应抛错");
  } catch (err) {
    expect("未授权 OrThrow 抛错", (err as Error).message.includes("目录未授权"));
  }
  try {
    paths.resolveInWorkdirOrThrow("../../../", base);
    fail("越界 OrThrow 应抛错");
  } catch (err) {
    expect("越界 OrThrow 抛错", (err as Error).message.includes("路径越界"));
  }

  console.log("\n== 默认工作区不可撤销（恒授权） ==");
  workspace.revokeWorkspaceAccess("default");
  const r6 = paths.resolveInWorkdir("a.txt");
  expect("撤销默认工作区后仍可访问", r6.ok);

  console.log("\n✓ 目录授权（默认拒绝）验证通过");
  resetConfig();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
