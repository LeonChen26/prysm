/**
 * 工作区文件浏览器模块验证脚本 —— 无需真实 LLM。
 * 验证：
 * 1. 列出目录（条目类型 / 排序）
 * 2. 新建文件 / 目录
 * 3. 读取文件内容（文本）
 * 4. 写入（上传）文件
 * 5. 路径越界拦截
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  createWorkdirEntry,
  listWorkdir,
  readWorkdirFile,
  writeWorkdirFile,
} from "../../lib/workdir";
import { AGENT_WORKDIR } from "../../lib/paths";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

async function main() {
  console.log("== 工作区文件浏览器 ==");

  // 新建目录与文件
  await createWorkdirEntry("testwb/sub", "dir", "");
  await createWorkdirEntry("testwb/hello.md", "file", "# 你好\n测试内容");
  console.log("✓ 新建目录与文件");

  // 列出
  const sub = await listWorkdir("testwb");
  const names = sub.entries.map((e) => `${e.name}(${e.isDir ? "dir" : "file"})`);
  console.log("testwb 条目:", names.join(", "));
  if (!sub.entries.some((e) => e.isDir && e.name === "sub")) {
    fail("应包含目录 sub");
  }
  if (!sub.entries.some((e) => !e.isDir && e.name === "hello.md")) {
    fail("应包含文件 hello.md");
  }
  // 目录优先排序
  if (sub.entries[0]?.name !== "sub") fail("目录应排在文件前");

  // 读取
  const content = await readWorkdirFile("testwb/hello.md");
  console.log("读取内容:", JSON.stringify(content.content), "| size:", content.size);
  if (!content.content.includes("你好")) fail("读取内容不符");

  // 写入（上传）
  const bytes = await writeWorkdirFile("testwb/upload.txt", Buffer.from("上传数据"));
  const up = await readWorkdirFile("testwb/upload.txt");
  console.log("写入字节:", bytes, "| 读回:", JSON.stringify(up.content));
  if (up.content !== "上传数据") fail("写入读回不一致");

  // 越界拦截
  for (const bad of ["../..", "../../etc/passwd"]) {
    try {
      await listWorkdir(bad);
      fail(`越界未拦截: ${bad}`);
    } catch (e) {
      console.log(`越界已拦截: ${bad} → ${(e as Error).message}`);
    }
  }
  try {
    await readWorkdirFile("../../sessions.db");
    fail("读取越界未拦截");
  } catch (e) {
    console.log("读取越界已拦截");
  }

  // 清理
  await fs.rm(path.join(AGENT_WORKDIR, "testwb"), { recursive: true, force: true });
  console.log("测试目录已清理");

  console.log("\n✓ 工作区文件浏览器验证通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
