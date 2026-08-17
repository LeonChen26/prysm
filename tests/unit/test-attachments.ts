/**
 * lib/attachments.ts 单元测试
 * 覆盖：maxAttachmentBytes / toImageContents / extractImages / saveImage
 * 运行：npx tsx tests/unit/test-attachments.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configure, resetConfig } from "../../lib/config";
import {
  maxAttachmentBytes,
  saveImage,
  toImageContents,
  extractImages,
} from "../../lib/attachments";

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
    fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${name}`);
}

function expectTrue(name: string, cond: boolean) {
  if (!cond) fail(`${name}: 期望条件为 true`);
  console.log(`  ✓ ${name}`);
}

// 1x1 PNG base64
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-attachments-"));
  configure({ baseDir: base, env: process.env });

  // ── 1. maxAttachmentBytes ──
  console.log("== maxAttachmentBytes ==");
  expectEq("返回 10 * 1024 * 1024", maxAttachmentBytes(), 10 * 1024 * 1024);

  // ── 2. toImageContents ──
  console.log("\n== toImageContents ==");
  {
    const result = toImageContents([]);
    expectEq("空数组 → 空数组", result, []);
  }
  {
    const result = toImageContents([{ data: "abc", mimeType: "image/png" }]);
    expectEq("单张图片 → 正确格式", result, [
      { type: "image" as const, data: "abc", mimeType: "image/png" },
    ]);
  }
  {
    const result = toImageContents([
      { data: "abc", mimeType: "image/png" },
      { data: "def", mimeType: "image/jpeg" },
    ]);
    expectEq("多张图片 → 数量正确", result.length, 2);
    expectEq("第一张 type=image", result[0].type, "image");
    expectEq("第一张 data 正确", result[0].data, "abc");
    expectEq("第一张 mimeType 正确", result[0].mimeType, "image/png");
    expectEq("第二张 type=image", result[1].type, "image");
    expectEq("第二张 data 正确", result[1].data, "def");
    expectEq("第二张 mimeType 正确", result[1].mimeType, "image/jpeg");
  }

  // ── 3. extractImages ──
  console.log("\n== extractImages ==");
  {
    expectEq("非数组字符串 → 空数组", extractImages("not an array"), []);
    expectEq("null → 空数组", extractImages(null), []);
    expectEq("undefined → 空数组", extractImages(undefined), []);
    expectEq("数字 → 空数组", extractImages(42), []);
    expectEq("对象 → 空数组", extractImages({}), []);
  }
  {
    expectEq("空数组 → 空数组", extractImages([]), []);
  }
  {
    const content = [
      { type: "text", text: "hello" },
      { type: "toolCall", id: "1", name: "test", arguments: {} },
    ];
    const result = extractImages(content);
    expectEq("无非图片元素 → 空数组", result, []);
  }
  {
    const content = [
      { type: "text", text: "看图" },
      { type: "image", data: "abc", mimeType: "image/png" },
      { type: "toolCall", id: "1", name: "test", arguments: {} },
      { type: "image", data: "def", mimeType: "image/jpeg" },
    ];
    const result = extractImages(content);
    expectEq("混合元素 → 只提取图片", result.length, 2);
    expectEq("第一张图片", result[0], {
      type: "image",
      data: "abc",
      mimeType: "image/png",
    });
    expectEq("第二张图片", result[1], {
      type: "image",
      data: "def",
      mimeType: "image/jpeg",
    });
  }
  {
    const content = [
      { type: "image", data: "a1", mimeType: "image/png" },
      { type: "image", data: "a2", mimeType: "image/gif" },
      { type: "image", data: "a3", mimeType: "image/webp" },
    ];
    const result = extractImages(content);
    expectEq("全部为图片块 → 全部返回", result.length, 3);
  }

  // ── 4. saveImage ──
  console.log("\n== saveImage ==");
  {
    let threw = false;
    try {
      await saveImage(PNG_B64, "text/plain");
    } catch {
      threw = true;
    }
    expectTrue("非法 MIME 抛错", threw);
  }
  {
    let threw = false;
    try {
      await saveImage("", "image/png");
    } catch {
      threw = true;
    }
    expectTrue("空数据抛错", threw);
  }
  {
    let threw = false;
    try {
      await saveImage("!!!not-base64!!!", "image/png");
    } catch {
      threw = true;
    }
    expectTrue("非法 base64 抛错", threw);
  }
  {
    const saved = await saveImage(`data:image/png;base64,${PNG_B64}`);
    expectEq("data URL 解析 → mimeType 正确", saved.mimeType, "image/png");
    expectTrue("data URL 解析 → 文件存在", fs.existsSync(saved.absPath));
  }
  {
    const saved = await saveImage(PNG_B64, "image/png");
    expectEq("mimeType 正确", saved.mimeType, "image/png");
    expectTrue("relPath 以 attachments/ 开头", saved.relPath.startsWith("attachments/"));
    expectTrue("relPath 以 .png 结尾", saved.relPath.endsWith(".png"));
    expectTrue("文件已落盘", fs.existsSync(saved.absPath));
    expectTrue("落盘路径在 baseDir 下", saved.absPath.startsWith(base));
    expectTrue("解码字节数 > 0", Buffer.from(saved.data, "base64").length > 0);
  }
  {
    const oversizedBuf = Buffer.alloc(maxAttachmentBytes() + 1, 0);
    const oversizedB64 = oversizedBuf.toString("base64");
    let threw = false;
    try {
      await saveImage(oversizedB64, "image/png");
    } catch {
      threw = true;
    }
    expectTrue("超过最大限制抛错", threw);
  }

  // ── 清理 ──
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  resetConfig();

  console.log("\n✓ lib/attachments.ts 单元测试通过");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});