/**
 * 工作区数据模型（workspace.ts）验证脚本 —— 纯结构断言，无 LLM 调用。
 * 覆盖：默认工作区播种、env AGENT_ALLOWED_PATHS 一次性导入（仅一次）、
 *      增删/去重/查询、默认工作区保护、resolveInWorkdir 多根解析与越界拦截、workdir 多根浏览。
 * 注意：须在 configure 之后才导入 paths/workdir（避免模块加载时以默认 cwd 播种 prysm.db）。
 * 运行：npx tsx tests/unit/test-workspace.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configure, resetConfig } from "../../lib/config";
import * as workspace from "../../lib/workspace";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

async function main() {
  const base = path.join(os.tmpdir(), "prysm-test-workspace");
  const extra1 = path.join(base, "proj-a");
  const extra2 = path.join(base, "proj-b");
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(extra1, { recursive: true });
  fs.mkdirSync(extra2, { recursive: true });

  configure({ baseDir: base, env: { AGENT_ALLOWED_PATHS: `${extra1}, ${extra2}` } });

  console.log("== 播种：默认工作区 + env 一次性导入 ==");
  const seeded = workspace.listWorkspaces();
  if (seeded.length !== 3) fail(`播种后应有 3 个工作区，实际 ${seeded.length}`);
  if (seeded[0].id !== "default") fail("默认工作区应排最前");
  if (!seeded[0].root.endsWith("agent-workdir")) fail("默认工作区根应为 agent-workdir");
  const roots = seeded.map((w) => w.root);
  if (!roots.includes(extra1) || !roots.includes(extra2)) fail("env 一次性导入失败");
  console.log(`  ✓ 默认工作区 + env 导入 ${seeded.length} 个`);
  if (workspace.listWorkspaces().length !== 3) fail("二次 list 不应重复导入");
  console.log("  ✓ 表非空时不再重复导入");

  console.log("== 增删工作区 ==");
  const added = workspace.addWorkspace(path.join(base, "proj-c"), "项目C");
  if (!added.id || added.name !== "项目C") fail("addWorkspace 返回异常");
  const afterAdd = workspace.listWorkspaces();
  if (afterAdd.length !== 4) fail(`新增后应有 4 个，实际 ${afterAdd.length}`);
  const dup = workspace.addWorkspace(path.join(base, "proj-c"));
  if (dup.id !== added.id) fail("重复 root 应返回现有记录");
  if (workspace.listWorkspaces().length !== 4) fail("重复 root 不应新增");
  const byRoot = workspace.getWorkspaceByRoot(extra1);
  if (!byRoot || byRoot.root !== extra1) fail("按 root 查询失败");
  const byId = workspace.getWorkspace(added.id);
  if (!byId || byId.id !== added.id) fail("按 id 查询失败");
  workspace.removeWorkspace(added.id);
  if (workspace.getWorkspace(added.id)) fail("删除后仍可查询");
  workspace.removeWorkspace("default");
  if (!workspace.getWorkspace("default")) fail("默认工作区不应被删除");
  console.log("  ✓ 新增/去重/查询/删除均生效，默认工作区受保护");

  console.log("== resolveInWorkdir 多根 ==");
  // Phase 2：env 导入的工作区默认未授权，解析/浏览前先授权
  for (const r of [extra1, extra2]) {
    const w = workspace.getWorkspaceByRoot(r);
    if (w) workspace.grantWorkspaceAccess(w.id);
  }
  const paths = await import("../../lib/paths");
  const inExtra1 = paths.resolveInWorkdir("README.md", extra1);
  if (!inExtra1.ok) fail("指定 root 解析失败");
  if (!inExtra1.path.startsWith(extra1 + path.sep)) fail("指定 root 解析应落在该根内");
  const inDefault = paths.resolveInWorkdir("notes/a.txt");
  if (!inDefault.ok) fail("缺省 root 解析失败");
  if (!inDefault.path.startsWith(paths.AGENT_WORKDIR + path.sep)) fail("缺省 root 应落在默认工作区");
  const escaped = paths.resolveInWorkdir("../..", extra2);
  if (escaped.ok || escaped.reason !== "outside") fail("越界未拦截");
  console.log("  ✓ 多根解析 + 越界拦截正常");

  console.log("== workdir 多根浏览 ==");
  const workdir = await import("../../lib/workdir");
  await fs.promises.writeFile(path.join(extra1, "hello.md"), "# hi");
  const listed = await workdir.listWorkdir("", extra1);
  if (!listed.entries.some((e) => e.name === "hello.md")) fail("指定根浏览未命中");
  if (listed.root !== extra1) fail("返回的 root 应为实际浏览绝对路径");
  console.log("  ✓ 指定工作区根浏览可用");

  // 不删除 base 目录：Windows 下 SQLite 句柄仍打开会导致 EPERM；
  // 测试数据在系统临时目录，下次运行开头会先清理。

  console.log("== buildSystemPrompt 动态注入工作区根 ==");
  const { buildSystemPrompt } = await import("../../lib/agent");
  const prompt = buildSystemPrompt([extra1, extra2]);
  if (!prompt.includes(extra1) || !prompt.includes(extra2)) {
    fail("提示词应包含实际工作区根");
  }
  if (!prompt.includes("可访问的工作区根目录")) fail("提示词应动态描述可访问根");
  console.log("  ✓ 提示词含实际工作区路径");

  console.log("\n✓ 工作区数据模型验证通过");
  resetConfig();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
