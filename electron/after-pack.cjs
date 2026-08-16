/**
 * electron-builder afterPack 钩子 —— 复制 Next.js standalone 产物到安装目录。
 *
 * 为什么不用 extraResources：electron-builder 对目录拷贝硬编码排除 node_modules
 * （filter 也无法覆盖），而 standalone 产物依赖 next 等运行时包，缺失会导致
 * server.js 启动报 Cannot find module 'next'。
 *
 * 为什么不用 fs.cpSync：Next 16 standalone 的 .next/node_modules 使用 junction
 * 指向项目根 node_modules（trace 优化），Node 的 cpSync（含 dereference）复制
 * 时对这些 junction 报 ENOENT。此处用自定义递归复制：遇到 junction/symlink 时
 * realpathSync 解析为真实目录后按内容复制，得到自包含产物。
 *
 * 输出结构（win-unpacked/resources/web/server/）：
 *   server.js            standalone 入口
 *   node_modules/        standalone 精简依赖（含 next）
 *   .next/static/        Next 静态资源（standalone 默认不含，须单独复制）
 *   public/              静态资源（若存在）
 */
const fs = require("node:fs");
const path = require("node:path");

/** 递归复制目录；junction/symlink 解析为真实内容（防止悬空链接与 ENOENT）。 */
function copyDir(src, dest, depth = 0) {
  if (depth > 64) throw new Error(`复制目录过深：${src}`);
  // Node 对 Windows junction 的 lstat.isSymbolicLink() 返回 false，
  // 无法用 isSymbolicLink 判断；realpathSync 对普通目录返回自身、对链接返回目标，统一适用。
  let real;
  try {
    real = fs.realpathSync(src);
  } catch {
    real = src;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
    const s = path.join(real, entry.name);
    const d = path.join(dest, entry.name);
    // junction 的 Dirent.isDirectory() 返回 false，需用 statSync（跟随链接）判断真实类型
    let isDir = false;
    try {
      isDir = fs.statSync(s).isDirectory();
    } catch {
      continue; // 目标已被清空等情况，跳过
    }
    if (isDir) {
      copyDir(s, d, depth + 1);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const root = packager.projectDir;
  const dest = path.join(appOutDir, "resources", "web", "server");

  const standalone = path.join(root, ".next", "standalone");
  if (!fs.existsSync(standalone)) {
    throw new Error(`standalone 产物不存在：${standalone}（请先执行 next build）`);
  }

  copyDir(standalone, dest);

  const staticSrc = path.join(root, ".next", "static");
  if (fs.existsSync(staticSrc)) {
    copyDir(staticSrc, path.join(dest, ".next", "static"));
  }

  const publicSrc = path.join(root, "public");
  if (fs.existsSync(publicSrc)) {
    copyDir(publicSrc, path.join(dest, "public"));
  }

  console.log(`[after-pack] standalone → ${dest}`);
};
