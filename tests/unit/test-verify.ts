/**
 * verify_file 工具验证脚本 —— 直接调用工具 execute，无需 LLM。
 * 覆盖：存在/无 expect、expect 命中、expect 未命中、文件不存在、越界拦截。
 * 运行：npx tsx test-verify.ts
 */
import { tools, AGENT_WORKDIR } from "../../lib/tools";
import fs from "node:fs/promises";
import path from "node:path";

interface Details {
  exists?: boolean;
  size?: number;
  matched?: boolean;
  isFile?: boolean;
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

async function main() {
  const testDir = path.join(AGENT_WORKDIR, "testverify");
  await fs.rm(testDir, { recursive: true, force: true });
  await fs.mkdir(testDir, { recursive: true });
  await fs.writeFile(path.join(testDir, "ok.txt"), "hello world 校验内容", "utf-8");

  const verify = tools.find((t) => t.name === "verify_file");
  if (!verify) fail("工具集中未找到 verify_file");

  const call = async (id: string, args: unknown) => {
    const r = await verify.execute(id, args);
    return r.details as Details;
  };

  console.log("== 存在，无 expect ==");
  const d1 = await call("v1", { path: "testverify/ok.txt" });
  if (d1.exists !== true || typeof d1.size !== "number" || d1.size <= 0) {
    fail(`存在性/大小异常: ${JSON.stringify(d1)}`);
  }
  console.log(`  ✓ exists=${d1.exists} size=${d1.size}`);

  console.log("== expect 命中 ==");
  const d2 = await call("v2", { path: "testverify/ok.txt", expect: "校验内容" });
  if (d2.matched !== true) fail(`expect 命中应 matched=true: ${JSON.stringify(d2)}`);
  console.log(`  ✓ matched=${d2.matched}`);

  console.log("== expect 未命中 ==");
  const d3 = await call("v3", { path: "testverify/ok.txt", expect: "不存在的片段" });
  if (d3.matched !== false) fail(`expect 未命中应 matched=false: ${JSON.stringify(d3)}`);
  console.log(`  ✓ matched=${d3.matched}`);

  console.log("== 文件不存在 ==");
  const d4 = await call("v4", { path: "testverify/missing.txt" });
  if (d4.exists !== false) fail(`不存在文件应 exists=false: ${JSON.stringify(d4)}`);
  console.log(`  ✓ exists=${d4.exists}`);

  console.log("== 越界拦截 ==");
  let escaped = false;
  try {
    await call("v5", { path: "../escape-verify.txt" });
  } catch {
    escaped = true;
  }
  if (!escaped) fail("越界路径应抛错");
  console.log("  ✓ 越界被拦截");

  console.log("\n✓ verify_file 验证通过");
  await fs.rm(testDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
