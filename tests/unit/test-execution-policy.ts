/**
 * 执行策略解析层（execution-policy.ts）验证脚本 —— 纯函数断言。
 * 覆盖：resolveExecutionPolicy 返回 root + fullAccess（跟随 isFullAccessMode）。
 * 运行：npx tsx tests/unit/test-execution-policy.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configure } from "../../lib/config";
import { getPermission, reloadPermission, setActiveMode } from "../../lib/permission";
import { resolveExecutionPolicy } from "../../lib/execution-policy";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expectEq(name: string, actual: unknown, want: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${name} = ${JSON.stringify(actual)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-exec-pol-"));
configure({ baseDir: tmp });

console.log("== resolveExecutionPolicy：默认模式（非 full） ==");
reloadPermission();
const p1 = resolveExecutionPolicy("/workspace/project");
expectEq("root 为注入值", p1.root, "/workspace/project");
expectEq("fullAccess 默认 false", p1.fullAccess, false);

console.log("\n== resolveExecutionPolicy：full 模式 ==");
setActiveMode("full");
reloadPermission();
const p2 = resolveExecutionPolicy("/any/path");
expectEq("full 模式下 fullAccess=true", p2.fullAccess, true);
expectEq("root 仍保留", p2.root, "/any/path");

console.log("\n== resolveExecutionPolicy：manual 模式 ==");
setActiveMode("manual");
reloadPermission();
const p3 = resolveExecutionPolicy("/some/root");
expectEq("manual 模式 fullAccess=false", p3.fullAccess, false);
expectEq("root 正确传递", p3.root, "/some/root");

console.log("\n== resolveExecutionPolicy：auto 模式 ==");
setActiveMode("auto");
reloadPermission();
const p4 = resolveExecutionPolicy("/auto/root");
expectEq("auto 模式 fullAccess=false", p4.fullAccess, false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n✓ 执行策略验证通过");
