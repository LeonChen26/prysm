/**
 * 多模态附件（Phase 6）
 * 图片/附件作为消息输入：校验、落盘到当前会话所属工作区根目录（默认工作区根的 attachments/ 下），
 * 并构造 ImageContent 供 Agent.prompt 传入。
 * 依赖 Node 内置（fs/path/crypto），可单一测试。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentWorkdir } from "./paths";

/** 允许的图片 MIME 类型 → 扩展名 */
const ALLOWED_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** 单张图片最大字节数（默认 10MB） */
export function maxAttachmentBytes(): number {
  return 10 * 1024 * 1024;
}

export interface SavedImage {
  /** base64 数据（不含 data URL 前缀） */
  data: string;
  mimeType: string;
  /** 落盘后相对工作区根的路径（attachments/xxx.png），用于前端引用 */
  relPath: string;
  /** 落盘后的绝对路径 */
  absPath: string;
}

/** 归一化 MIME：拆分 data URL 前缀与 base64 */
function splitDataUrl(input: string): { mimeType?: string; data: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(input);
  if (m) return { mimeType: m[1], data: m[2] };
  return { data: input };
}

/**
 * 校验并保存一张图片到默认工作区根目录。
 * @param input base64（可含 data URL 前缀）
 * @param mimeType 显式 MIME（缺省时从 data URL 或内容推断）
 * @returns 保存后的图片信息（含 ImageContent 所需 base64/mimeType）
 */
export async function saveImage(
  input: string,
  mimeType?: string,
): Promise<SavedImage> {
  const { mimeType: fromPrefix, data } = splitDataUrl(input.trim());
  const mime = (mimeType ?? fromPrefix ?? "").toLowerCase();
  const ext = ALLOWED_MIME[mime];
  if (!ext) {
    throw new Error(`不支持的图片类型: "${mime || "未知"}"（仅支持 png/jpeg/gif/webp/svg）`);
  }
  if (!data) throw new Error("图片内容为空");
  // 严格 base64 校验（Node Buffer.from base64 宽松，不抛错）
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error("图片 base64 解码失败");
  }
  // 解码
  const buf = Buffer.from(data, "base64");
  if (buf.length === 0) throw new Error("图片内容为空");
  if (buf.length > maxAttachmentBytes()) {
    throw new Error(`图片超过大小上限`);
  }
  // 落盘到默认工作区根 attachments/
  const root = getAgentWorkdir();
  const dir = path.join(root, "attachments");
  await fs.mkdir(dir, { recursive: true });
  const name = `${Date.now()}_${randomUUID().slice(0, 8)}.${ext}`;
  const absPath = path.join(dir, name);
  await fs.writeFile(absPath, buf);
  return {
    data: data.trim(),
    mimeType: mime,
    relPath: `attachments/${name}`,
    absPath,
  };
}

/** 将若干已保存图片转为 ImageContent[]（供 Agent.prompt 传入模型） */
export function toImageContents(
  images: { data: string; mimeType: string }[],
): { type: "image"; data: string; mimeType: string }[] {
  return images.map((img) => ({
    type: "image" as const,
    data: img.data,
    mimeType: img.mimeType,
  }));
}

/** 从消息 content 中提取图片块（供前端渲染） */
export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export function extractImages(content: unknown): ImageBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is ImageBlock =>
      !!b && typeof b === "object" && (b as { type?: string }).type === "image",
  );
}