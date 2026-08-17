/**
 * 路径解析与安全边界（paths.ts）验证脚本 —— 纯结构断言，无 LLM 调用。
 * 覆盖：getAgentWorkdir / getAllowedRoots、resolveInWorkdir 正常/越界/符号链接、
 *      resolveInWorkdirOrThrow 错误消息、自定义 root 参数。
 * 运行：npx tsx tests/unit/test-paths.ts
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

function expectEq(name: string, actual: unknown, want: unknown) {
  const ok =
    typeof actual === "object" && typeof want === "object"
      ? JSON.stringify(actual) === JSON.stringify(want)
      : actual === want;
  if (!ok) {
    fail(
      `${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`,
    );
  }
  console.log(`  ✓ ${name}`);
}

function expectTrue(name: string, cond: boolean) {
  if (!cond) fail(`${name}: 期望条件为 true`);
  console.log(`  ✓ ${name}`);
}

function expectThrows(name: string, fn: () => unknown, expectedMsg?: string) {
  try {
    fn();
    fail(`${name}: 期望抛错但未抛错`);
  } catch (e) {
    if (expectedMsg && !(e as Error).message.includes(expectedMsg)) {
      fail(
        `${name}: 期望错误消息包含 "${expectedMsg}"，实际 "${(e as Error).message}"`,
      );
    }
    console.log(`  ✓ ${name}${expectedMsg ? ` (包含 "${expectedMsg}")` : ""}`);
  }
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-paths-"));
  configure({ baseDir: base, env: process.env });

  const paths = await import("../../lib/paths");
  const workspace = await import("../../lib/workspace");

  const workdir = paths.getAgentWorkdir();
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(workdir, "hello.txt"), "hello world");
  fs.mkdirSync(path.join(workdir, "subdir"), { recursive: true });
  fs.writeFileSync(path.join(workdir, "subdir", "nested.txt"), "nested");

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-outside-"));
  fs.writeFileSync(path.join(outsideDir, "external.txt"), "external");

  // ── getAgentWorkdir / getAllowedRoots ──
  console.log("== getAgentWorkdir / getAllowedRoots ==");
  expectTrue(
    "getAgentWorkdir 以 baseDir 为基准",
    workdir.startsWith(base),
  );
  expectTrue("getAgentWorkdir 以 agent-workdir 结尾", workdir.endsWith("agent-workdir"));

  const allowedRoots = paths.getAllowedRoots();
  expectTrue("getAllowedRoots 至少包含默认工作区", allowedRoots.length >= 1);
  expectTrue(
    "getAllowedRoots 包含默认 agent-workdir",
    allowedRoots.includes(workdir),
  );
  console.log(`  getAllowedRoots → ${allowedRoots.length} 个根`);

  // ── resolveInWorkdir：正常路径 ──
  console.log("\n== resolveInWorkdir：正常路径解析 ==");
  {
    const r = paths.resolveInWorkdir("hello.txt");
    expectTrue("hello.txt 返回 ok=true", r.ok);
    if (r.ok) {
      expectTrue("hello.txt 路径在 workdir 下", r.path.startsWith(workdir));
      expectEq("hello.txt 文件名正确", path.basename(r.path), "hello.txt");
    }
  }
  {
    const r = paths.resolveInWorkdir("subdir/nested.txt");
    expectTrue("subdir/nested.txt 返回 ok=true", r.ok);
    if (r.ok) {
      expectTrue("嵌套路径在 workdir 下", r.path.startsWith(workdir));
      expectEq("nested.txt 文件名正确", path.basename(r.path), "nested.txt");
    }
  }
  {
    const r = paths.resolveInWorkdir(".");
    expectTrue("'.' 返回 ok=true", r.ok);
    if (r.ok) expectEq("'.' 解析为 workdir 根", r.path, workdir);
  }

  // ── resolveInWorkdir：越界 / outside ──
  console.log("\n== resolveInWorkdir：越界与 outside ==");
  {
    const r = paths.resolveInWorkdir(outsideDir);
    expectTrue("外部绝对路径 ok=false", !r.ok);
    if (!r.ok) expectEq("外部路径 reason=outside", r.reason, "outside");
  }
  {
    const r = paths.resolveInWorkdir("../../../etc/passwd");
    expectTrue("多级 ../ 越界 ok=false", !r.ok);
    if (!r.ok) expectEq("多级 ../ reason=outside", r.reason, "outside");
  }
  {
    const r = paths.resolveInWorkdir("..");
    expectTrue("'..' 越界 ok=false", !r.ok);
    if (!r.ok) expectEq("'..' reason=outside", r.reason, "outside");
  }
  {
    const r = paths.resolveInWorkdir("../hello.txt");
    expectTrue("'../hello.txt' 越界 ok=false", !r.ok);
    if (!r.ok) expectEq("'../hello.txt' reason=outside", r.reason, "outside");
  }

  // ── resolveInWorkdir：不存在的路径 ──
  console.log("\n== resolveInWorkdir：不存在的路径 ==");
  {
    const r = paths.resolveInWorkdir("nonexistent/file.txt");
    expectTrue("workdir 下不存在的路径 ok=true", r.ok);
  }
  {
    const r = paths.resolveInWorkdir("../../../nonexistent-outside/file.txt");
    expectTrue("越界且不存在的路径 ok=false", !r.ok);
  }

  // ── resolveInWorkdir：自定义 root 参数 ──
  console.log("\n== resolveInWorkdir：自定义 root 参数 ==");
  {
    const subdirRoot = path.join(workdir, "subdir");
    const r = paths.resolveInWorkdir("nested.txt", subdirRoot);
    expectTrue("root 为 workdir 内子目录时 ok=true", r.ok);
    if (r.ok) expectTrue("解析结果在 workdir 下", r.path.startsWith(workdir));
  }
  {
    const r = paths.resolveInWorkdir("external.txt", outsideDir);
    expectTrue("root 为外部目录时 ok=false", !r.ok);
    if (!r.ok) expectEq("外部 root reason=outside", r.reason, "outside");
  }

  // ── resolveInWorkdir：unauthorized 工作区 ──
  console.log("\n== resolveInWorkdir：unauthorized 工作区 ==");
  {
    const unauthorizedDir = path.join(base, "unauthorized-ws");
    fs.mkdirSync(unauthorizedDir, { recursive: true });
    fs.writeFileSync(path.join(unauthorizedDir, "secret.txt"), "UNAUTHORIZED");
    const ws = workspace.addWorkspace(unauthorizedDir, "未授权工作区");
    // addWorkspace 默认 authorized=0
    const r = paths.resolveInWorkdir("secret.txt", unauthorizedDir);
    expectTrue("未授权工作区 ok=false", !r.ok);
    if (!r.ok) {
      expectEq("未授权 reason=unauthorized", r.reason, "unauthorized");
      expectEq("unauthorized 携带 root", r.root, unauthorizedDir);
      expectTrue("unauthorized 携带 workspaceId", typeof r.workspaceId === "string");
    }
    workspace.removeWorkspace(ws.id);
  }

  // ── resolveInWorkdirOrThrow ──
  console.log("\n== resolveInWorkdirOrThrow ==");
  {
    const p = paths.resolveInWorkdirOrThrow("hello.txt");
    expectTrue("正常路径返回字符串", typeof p === "string");
    expectTrue("正常路径在 workdir 下", p.startsWith(workdir));
  }
  expectThrows(
    "越界路径抛错（路径越界）",
    () => paths.resolveInWorkdirOrThrow("../../../etc/passwd"),
    "路径越界",
  );
  expectThrows(
    "外部绝对路径抛错（路径越界）",
    () => paths.resolveInWorkdirOrThrow(outsideDir),
    "路径越界",
  );
  {
    const unauthorizedDir2 = path.join(base, "unauthorized-ws2");
    fs.mkdirSync(unauthorizedDir2, { recursive: true });
    const ws2 = workspace.addWorkspace(unauthorizedDir2, "未授权WS2");
    expectThrows(
      "未授权路径抛错（目录未授权）",
      () => paths.resolveInWorkdirOrThrow("x.txt", unauthorizedDir2),
      "目录未授权",
    );
    workspace.removeWorkspace(ws2.id);
  }

  // ── 符号链接沙箱绕过防护 ──
  console.log("\n== 符号链接沙箱绕过防护 ==");
  const symlinkInWorkdir = path.join(workdir, "link-to-outside");
  let symlinkCreated = false;
  try {
    fs.symlinkSync(outsideDir, symlinkInWorkdir, "junction");
    symlinkCreated = true;
  } catch {
    try {
      fs.symlinkSync(outsideDir, symlinkInWorkdir, "dir");
      symlinkCreated = true;
    } catch {
      console.log("  ⊘ 当前环境不支持创建目录符号链接，跳过 symlink 子测试");
    }
  }
  if (symlinkCreated) {
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "SECRET");
    const viaSymlink = paths.resolveInWorkdir("link-to-outside/secret.txt");
    expectTrue("符号链接→外部 ok=false", !viaSymlink.ok);
    if (!viaSymlink.ok)
      expectEq("符号链接 reason=outside", viaSymlink.reason, "outside");
    fs.rmSync(symlinkInWorkdir, { recursive: false, force: true });
  }

  {
    const fileSymlink = path.join(workdir, "secret-link.txt");
    let fileSymlinkCreated = false;
    try {
      fs.symlinkSync(path.join(outsideDir, "external.txt"), fileSymlink, "file");
      fileSymlinkCreated = true;
    } catch {
      /* symlink not supported */
    }
    if (fileSymlinkCreated) {
      const viaFileLink = paths.resolveInWorkdir("secret-link.txt");
      expectTrue("文件符号链接→外部 ok=false", !viaFileLink.ok);
      fs.rmSync(fileSymlink, { force: true });
    }
  }

  // ── resolveInWorkspace：读放开（Phase 1）与写语义 ──
  console.log("\n== resolveInWorkspace：读放开（任意本地路径）/ 写受限 ==");
  const readPolicy = { root: workdir, fullAccess: false };
  const writePolicy = { root: workdir, fullAccess: false };
  {
    // 读：外部目录普通文件放行
    const r = paths.resolveInWorkspace(outsideDir + "/external.txt", readPolicy, "read");
    expectTrue("读外部绝对路径 ok=true", r.ok);
    if (r.ok) expectTrue("读外部路径为绝对路径", path.isAbsolute(r.path));
  }
  {
    // 读：外部目录相对越界（../ 到达外部）也放行
    const r = paths.resolveInWorkspace("../../../../../" + path.basename(outsideDir) + "/external.txt", readPolicy, "read");
    expectTrue("读 ../ 越界到外部目录 ok=true（读放开）", r.ok);
  }
  {
    // 读：工作区内普通文件放行
    const r = paths.resolveInWorkspace("hello.txt", readPolicy, "read");
    expectTrue("读工作区内文件 ok=true", r.ok);
  }
  {
    // 读：受保护路径（.env）拒绝
    fs.writeFileSync(path.join(outsideDir, ".env"), "SECRET=1");
    const r = paths.resolveInWorkspace(outsideDir + "/.env", readPolicy, "read");
    expectTrue("读 .env ok=false", !r.ok);
    if (!r.ok) expectEq("读 .env reason=sensitive", r.reason, "sensitive");
  }
  {
    // 读：受保护路径（.ssh）拒绝
    const sshDir = path.join(outsideDir, ".ssh");
    fs.mkdirSync(sshDir, { recursive: true });
    fs.writeFileSync(path.join(sshDir, "id_rsa"), "PRIVATE KEY");
    const r = paths.resolveInWorkspace(sshDir + "/id_rsa", readPolicy, "read");
    expectTrue("读 .ssh/id_rsa ok=false", !r.ok);
    if (!r.ok) expectEq("读 .ssh 命中 label", r.label, "SSH 密钥");
  }
  {
    // 读：数据库文件拒绝
    fs.writeFileSync(path.join(outsideDir, "data.db"), "\u0000");
    const r = paths.resolveInWorkspace(outsideDir + "/data.db", readPolicy, "read");
    expectTrue("读 .db ok=false", !r.ok);
    if (!r.ok) expectEq("读 .db reason=sensitive", r.reason, "sensitive");
  }
  {
    // 写：外部路径仍拒绝（读放开不影响写）
    const r = paths.resolveInWorkspace(outsideDir + "/external.txt", writePolicy, "write");
    expectTrue("写外部绝对路径 ok=false", !r.ok);
    if (!r.ok) expectEq("写外部路径 reason=outside", r.reason, "outside");
  }
  {
    // 写：未授权工作区内仍拒绝（unauthorized 语义保留）
    const unauthorizedDir3 = path.join(base, "unauthorized-ws3");
    fs.mkdirSync(unauthorizedDir3, { recursive: true });
    const ws3 = workspace.addWorkspace(unauthorizedDir3, "未授权WS3");
    const r = paths.resolveInWorkspace("x.txt", { root: unauthorizedDir3, fullAccess: false }, "write");
    expectTrue("写未授权工作区 ok=false", !r.ok);
    if (!r.ok) expectEq("写未授权 reason=unauthorized", r.reason, "unauthorized");
    workspace.removeWorkspace(ws3.id);
  }
  {
    // fullAccess：读写全放行（跳过一切判定）
    const r = paths.resolveInWorkspace(outsideDir + "/external.txt", { root: workdir, fullAccess: true }, "write");
    expectTrue("full 模式写外部路径 ok=true", r.ok);
  }
  {
    // resolveReadInWorkdirOrThrow：外部文件返回字符串
    const p = paths.resolveReadInWorkdirOrThrow(outsideDir + "/external.txt");
    expectTrue("只读解析外部路径返回字符串", typeof p === "string");
  }
  expectThrows(
    "只读解析 .env 抛错（路径受保护）",
    () => paths.resolveReadInWorkdirOrThrow(outsideDir + "/.env"),
    "路径受保护",
  );
  expectThrows(
    "写解析外部路径抛错（路径越界）",
    () => paths.resolveWriteInWorkdirOrThrow(outsideDir + "/external.txt"),
    "路径越界",
  );

  // ── 清理 ──
  // Windows 下 SQLite 句柄仍打开会导致 base 目录 EPERM，与 test-workspace.ts 行为一致
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore: Windows SQLite 句柄未释放 */
  }
  fs.rmSync(outsideDir, { recursive: true, force: true });

  console.log("\n✓ 路径解析与安全边界验证通过");
  resetConfig();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});