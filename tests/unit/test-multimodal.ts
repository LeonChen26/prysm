/**
 * 多模态附件（lib/attachments.ts）验证脚本。
 * 覆盖：图片落盘、MIME 校验、base64 校验、ImageContent 构造、从消息 content 提取图片、
 *      会话消息持久化往返保留图片块。
 * 运行：npx tsx tests/unit/test-multimodal.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configure, resetConfig } from "../../lib/config";
import {
  extractImages,
  saveImage,
  toImageContents,
  type SavedImage,
} from "../../lib/attachments";
import { saveSessionMessages, getSessionMessages } from "../../lib/session";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expectEq(name: string, actual: unknown, want: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${name}`);
}

function expectTrue(name: string, actual: unknown) {
  if (!actual) fail(`${name}: 期望为真，实际 ${JSON.stringify(actual)}`);
  console.log(`  ✓ ${name}`);
}

// 1x1 透明 PNG 的 base64
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const dir = path.join(os.tmpdir(), "prysm-multimodal");

function resetAll() {
  resetConfig();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* SQLite 句柄占用时跳过清理（Windows） */
  }
  fs.mkdirSync(dir, { recursive: true });
  configure({ baseDir: dir, env: {} });
}

console.log("== 图片落盘：合法 PNG 保存到工作区根 attachments/ ==");
{
  resetAll();
  const saved: SavedImage = await saveImage(PNG_B64, "image/png");
  expectEq("mimeType", saved.mimeType, "image/png");
  expectTrue("relPath 以 attachments/ 开头", saved.relPath.startsWith("attachments/"));
  expectTrue("relPath 以 .png 结尾", saved.relPath.endsWith(".png"));
  expectTrue("文件已落盘", fs.existsSync(saved.absPath));
  expectTrue("落盘路径在工作区内", saved.absPath.startsWith(dir));
  // 解码回写与原文一致（base64 规范化后）
  expectTrue("落盘字节可解码", Buffer.from(saved.data, "base64").length > 0);
}

console.log("\n== 支持 data URL 前缀 ==");
{
  const saved = await saveImage(`data:image/png;base64,${PNG_B64}`);
  expectEq("从 data URL 推断 mimeType", saved.mimeType, "image/png");
}

console.log("\n== 非法 MIME 拒绝 ==");
{
  let threw = false;
  try {
    await saveImage(PNG_B64, "text/plain");
  } catch {
    threw = true;
  }
  expectTrue("text/plain 被拒绝", threw);
}

console.log("\n== 空内容 / 非法 base64 拒绝 ==");
{
  let threw1 = false;
  try {
    await saveImage("", "image/png");
  } catch {
    threw1 = true;
  }
  expectTrue("空内容被拒绝", threw1);
  let threw2 = false;
  try {
    await saveImage("!!!not-base64!!!", "image/png");
  } catch {
    threw2 = true;
  }
  expectTrue("非法 base64 被拒绝", threw2);
}

console.log("\n== toImageContents 构造 ==");
{
  const blocks = toImageContents([
    { data: "abc", mimeType: "image/jpeg" },
    { data: "def", mimeType: "image/webp" },
  ]);
  expectEq("块数与输入一致", blocks.length, 2);
  expectEq("首块 type=image", blocks[0].type, "image");
  expectEq("首块 mimeType", blocks[0].mimeType, "image/jpeg");
}

console.log("\n== extractImages 从消息 content 提取 ==");
{
  const content = [
    { type: "text", text: "看图说话" },
    { type: "image", data: "abc", mimeType: "image/png" },
    { type: "toolCall", id: "1", name: "x", arguments: {} },
  ];
  const imgs = extractImages(content);
  expectEq("提取到 1 张图片", imgs.length, 1);
  expectEq("图片块保留 data/mimeType", imgs[0], { type: "image", data: "abc", mimeType: "image/png" });
  expectEq("非数组返回空", extractImages("no"), []);
}

console.log("\n== 会话持久化往返：图片块不丢失 ==");
{
  const sessionId = "mm-session-1";
  const msg: AgentMessage = {
    role: "user",
    content: [
      { type: "text", text: "请分析这张图片" },
      { type: "image", data: PNG_B64, mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  } as AgentMessage;
  saveSessionMessages(sessionId, [msg]);
  const restored = getSessionMessages(sessionId);
  expectEq("恢复 1 条消息", restored.length, 1);
  const imgs = extractImages(restored[0].content);
  expectEq("恢复后图片块仍在", imgs.length, 1);
  expectEq("图片 mimeType 保留", imgs[0].mimeType, "image/png");
}

resetAll();
console.log("\n✓ 多模态附件验证通过");
process.exit(0);