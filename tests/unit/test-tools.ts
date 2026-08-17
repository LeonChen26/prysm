/**
 * lib/tools.ts 单元测试 —— 纯函数/AsyncLocalStorage 上下文隔离验证。
 * 覆盖：toolCtx / workdir 上下文隔离、glob 转正则、换行统计、unified diff 构建。
 * 运行：npx tsx tests/unit/test-tools.ts
 */
import {
  runWithToolCtx,
  getToolCtx,
  runWithWorkdir,
  getSessionWorkdirOverride,
  getEffectiveWorkdirForTest,
  globToRegex,
  globPathToRegex,
  countNewlines,
  buildEditDiff,
} from "../../lib/tools";

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

function expectTrue(name: string, cond: boolean, detail?: string) {
  if (!cond) {
    fail(`${name}: 期望 true${detail ? `，${detail}` : ""}`);
  }
  console.log(`  ✓ ${name}`);
}

// ============================================================
// 1. runWithToolCtx() / getToolCtx() —— AsyncLocalStorage 上下文隔离
// ============================================================
console.log("== 1. runWithToolCtx / getToolCtx 基本读取 ==");

expectEq("无上下文时 getToolCtx 返回 undefined", getToolCtx(), undefined);

runWithToolCtx({ sessionId: "sess-1", surface: "coding", workdir: "/w/A" }, () => {
  const ctx = getToolCtx();
  expectEq("块内读取到 sessionId", ctx?.sessionId, "sess-1");
  expectEq("块内读取到 surface", ctx?.surface, "coding");
  expectEq("块内读取到 workdir", ctx?.workdir, "/w/A");
});

runWithToolCtx({ sessionId: "sess-2", surface: "work" }, () => {
  const ctx = getToolCtx();
  expectEq("另一个块内读取到不同 sessionId", ctx?.sessionId, "sess-2");
  expectEq("另一个块内读取到不同 surface", ctx?.surface, "work");
  expectEq("未设置 workdir 时为 undefined", ctx?.workdir, undefined);
});

console.log("\n== 1b. runWithToolCtx 嵌套上下文 ==");
runWithToolCtx({ sessionId: "outer", surface: "coding" }, () => {
  const outer = getToolCtx();
  expectEq("外层读到 outer sessionId", outer?.sessionId, "outer");

  runWithToolCtx({ sessionId: "inner", surface: "work" }, () => {
    const inner = getToolCtx();
    expectEq("内层读到 inner sessionId", inner?.sessionId, "inner");
    expectEq("内层读到 inner surface", inner?.surface, "work");
  });

  const after = getToolCtx();
  expectEq("内层退出后回到 outer", after?.sessionId, "outer");
});

console.log("\n== 1c. runWithToolCtx 并发隔离 ==");
(async () => {
  const [aResult, bResult] = await Promise.all([
    runWithToolCtx({ sessionId: "sess-A", surface: "coding" }, async () => {
      await new Promise((r) => setTimeout(r, 20));
      return getToolCtx();
    }),
    runWithToolCtx({ sessionId: "sess-B", surface: "work" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getToolCtx();
    }),
  ]);
  expectEq("并发 A 跨 await 仍读到 sess-A", aResult?.sessionId, "sess-A");
  expectEq("并发 A 跨 await 仍读到 coding", aResult?.surface, "coding");
  expectEq("并发 B 跨 await 仍读到 sess-B", bResult?.sessionId, "sess-B");
  expectEq("并发 B 跨 await 仍读到 work", bResult?.surface, "work");
})();

// ============================================================
// 2. runWithWorkdir() / getSessionWorkdirOverride() —— workdir 隔离
// ============================================================
console.log("\n== 2. runWithWorkdir / getSessionWorkdirOverride 基本读取 ==");

expectEq("无上下文时 getSessionWorkdirOverride 返回 undefined", getSessionWorkdirOverride(), undefined);

runWithWorkdir("/project/A", () => {
  expectEq("块内读取到 /project/A", getSessionWorkdirOverride(), "/project/A");
});

runWithWorkdir("/project/B", () => {
  expectEq("块内读取到 /project/B", getSessionWorkdirOverride(), "/project/B");
});

console.log("\n== 2b. runWithWorkdir 嵌套上下文 ==");
runWithWorkdir("/project/outer", () => {
  expectEq("外层读到 outer", getSessionWorkdirOverride(), "/project/outer");
  runWithWorkdir("/project/inner", () => {
    expectEq("内层读到 inner", getSessionWorkdirOverride(), "/project/inner");
  });
  expectEq("内层退出后回到 outer", getSessionWorkdirOverride(), "/project/outer");
});

console.log("\n== 2c. runWithWorkdir 并发隔离 ==");
(async () => {
  const [aWd, bWd] = await Promise.all([
    runWithWorkdir("/wd/A", async () => {
      await new Promise((r) => setTimeout(r, 15));
      return getSessionWorkdirOverride();
    }),
    runWithWorkdir("/wd/B", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getSessionWorkdirOverride();
    }),
  ]);
  expectEq("并发 A 跨 await 仍读到 /wd/A", aWd, "/wd/A");
  expectEq("并发 B 跨 await 仍读到 /wd/B", bWd, "/wd/B");
})();

console.log("\n== 2d. runWithWorkdir 块结束后清空 ==");
runWithWorkdir("/temp", () => {});
expectEq("块结束后回到 undefined", getSessionWorkdirOverride(), undefined);

// ============================================================
// 3. globToRegex() —— 文件名 glob 转正则
// ============================================================
console.log("\n== 3. globToRegex 基本匹配 ==");

(function () {
  const re = globToRegex("*.ts");
  if (!re) fail("globToRegex('*.ts') 不应返回 null");
  expectTrue("'*.ts' 匹配 'foo.ts'", re!.test("foo.ts"));
  expectTrue("'*.ts' 匹配 'bar.ts'", re!.test("bar.ts"));
  expectTrue("'*.ts' 不匹配 'foo.js'", !re!.test("foo.js"));
  expectTrue("'*.ts' 不匹配 'foo.tsx'", !re!.test("foo.tsx"));
})();

console.log("\n== 3b. globToRegex 大小写不敏感 ==");
(function () {
  const re = globToRegex("*.ts");
  if (!re) fail("globToRegex('*.ts') 不应返回 null");
  expectTrue("'*.ts' 匹配 'foo.Bar.Ts' (大写)", re!.test("foo.Bar.Ts"));
  expectTrue("'*.ts' 匹配 'FOO.TS' (全大写)", re!.test("FOO.TS"));
  expectTrue("'*.ts' 匹配 'foo.Ts' (混合大小写)", re!.test("foo.Ts"));
})();

console.log("\n== 3c. globToRegex 问号匹配 ==");
(function () {
  const re = globToRegex("foo?");
  if (!re) fail("globToRegex('foo?') 不应返回 null");
  expectTrue("'foo?' 匹配 'foob' (单字符)", re!.test("foob"));
  expectTrue("'foo?' 匹配 'foo1' (数字)", re!.test("foo1"));
  expectTrue("'foo?' 不匹配 'foo' (零字符)", !re!.test("foo"));
  expectTrue("'foo?' 不匹配 'foobar' (多字符)", !re!.test("foobar"));
})();

console.log("\n== 3d. globToRegex 特殊字符转义 ==");
(function () {
  const re = globToRegex("foo.bar");
  if (!re) fail("globToRegex('foo.bar') 不应返回 null");
  expectTrue("'foo.bar' 字面匹配 'foo.bar'", re!.test("foo.bar"));
  expectTrue("'foo.bar' 不匹配 'fooXbar' (. 不是通配)", !re!.test("fooXbar"));
})();

console.log("\n== 3e. globToRegex 星号匹配零或多字符 ==");
(function () {
  const re = globToRegex("a*z");
  if (!re) fail("globToRegex('a*z') 不应返回 null");
  expectTrue("'a*z' 匹配 'az' (零字符)", re!.test("az"));
  expectTrue("'a*z' 匹配 'abcz' (多字符)", re!.test("abcz"));
  expectTrue("'a*z' 不匹配 'az1' (末尾有多余字符)", !re!.test("az1"));
})();

// ============================================================
// 4. globPathToRegex() —— 路径级 glob 转正则
// ============================================================
console.log("\n== 4. globPathToRegex 自动补 **/ 前缀 ==");

(function () {
  const re = globPathToRegex("*.ts");
  if (!re) fail("globPathToRegex('*.ts') 不应返回 null");
  // **/ 前缀要求路径中至少包含一个 /
  expectTrue("'*.ts' 匹配 'src/foo.ts' (嵌套路径)", re!.test("src/foo.ts"));
  expectTrue("'*.ts' 匹配 'a/b/c/foo.ts' (深层嵌套)", re!.test("a/b/c/foo.ts"));
  expectTrue("'*.ts' 不匹配 'foo.js'", !re!.test("foo.js"));
  expectTrue("'*.ts' 不匹配 'lib/foo.js' (扩展名不同)", !re!.test("lib/foo.js"));
})();

console.log("\n== 4b. globPathToRegex ** 跨层级匹配 ==");
(function () {
  const re = globPathToRegex("src/**/*.ts");
  if (!re) fail("globPathToRegex('src/**/*.ts') 不应返回 null");
  // ** 匹配跨目录层级，pattern 中的 / 分隔符要求至少一级子目录
  expectTrue("'src/**/*.ts' 匹配 'src/a/foo.ts'", re!.test("src/a/foo.ts"));
  expectTrue("'src/**/*.ts' 匹配 'src/a/b/foo.ts'", re!.test("src/a/b/foo.ts"));
  expectTrue("'src/**/*.ts' 匹配 'src/a/b/c/d/foo.ts'", re!.test("src/a/b/c/d/foo.ts"));
  expectTrue("'src/**/*.ts' 不匹配 'lib/foo.ts' (前缀不同)", !re!.test("lib/foo.ts"));
})();

console.log("\n== 4c. globPathToRegex * 匹配单段 ==");
(function () {
  const re = globPathToRegex("src/*");
  if (!re) fail("globPathToRegex('src/*') 不应返回 null");
  expectTrue("'src/*' 匹配 'src/foo.ts'", re!.test("src/foo.ts"));
  expectTrue("'src/*' 匹配 'src/bar.js'", re!.test("src/bar.js"));
  expectTrue("'src/*' 不匹配 'src/a/foo.ts' (多一层)", !re!.test("src/a/foo.ts"));
})();

console.log("\n== 4d. globPathToRegex ? 匹配单字符 ==");
(function () {
  const re = globPathToRegex("src/?.ts");
  if (!re) fail("globPathToRegex('src/?.ts') 不应返回 null");
  expectTrue("'src/?.ts' 匹配 'src/a.ts'", re!.test("src/a.ts"));
  expectTrue("'src/?.ts' 匹配 'src/1.ts'", re!.test("src/1.ts"));
  expectTrue("'src/?.ts' 不匹配 'src/foo.ts' (多字符)", !re!.test("src/foo.ts"));
  expectTrue("'src/?.ts' 不匹配 'src/.ts' (零字符)", !re!.test("src/.ts"));
})();

console.log("\n== 4e. globPathToRegex 特殊字符转义 ==");
(function () {
  const re = globPathToRegex("src/foo.bar");
  if (!re) fail("globPathToRegex('src/foo.bar') 不应返回 null");
  expectTrue("'src/foo.bar' 字面匹配 'src/foo.bar'", re!.test("src/foo.bar"));
  expectTrue("'src/foo.bar' 不匹配 'src/fooXbar' (. 不是通配)", !re!.test("src/fooXbar"));
})();

// ============================================================
// 5. countNewlines() —— 统计换行数
// ============================================================
console.log("\n== 5. countNewlines 基本 ==");

expectEq("空字符串返回 0", countNewlines(""), 0);
expectEq("无换行返回 0", countNewlines("hello world"), 0);
expectEq("一个换行", countNewlines("a\nb"), 1);
expectEq("两个换行", countNewlines("a\nb\nc"), 2);
expectEq("末尾换行", countNewlines("a\n"), 1);
expectEq("连续换行", countNewlines("\n\n\n"), 3);
expectEq("中文换行", countNewlines("你\n好\n世\n界"), 3);

// ============================================================
// 6. buildEditDiff() —— 构建 unified diff
// ============================================================
console.log("\n== 6. buildEditDiff 基本替换 ==");

(function () {
  const oldLines = ["line1", "line2", "line3", "line4", "line5"];
  const newLines = ["line1", "line2", "REPLACED", "line4", "line5"];
  const diff = buildEditDiff("test.ts", oldLines, newLines, 2, 2, 2);

  const lines = diff.split("\n");
  expectTrue("第一行是 --- 头", lines[0] === "--- a/test.ts");
  expectTrue("第二行是 +++ 头", lines[1] === "+++ b/test.ts");
  expectTrue("第三行包含 @@ 且有行号", lines[2].startsWith("@@ -"));
  expectTrue("第三行包含 +", lines[2].includes(" +"));

  const hdr = lines[2];
  const m = hdr.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
  if (!m) fail("hunk 头格式不正确");
  expectEq("hunk old 起始行", Number(m[1]), 1);
  expectEq("hunk old 行数", Number(m[2]), 5);
  expectEq("hunk new 起始行", Number(m[3]), 1);
  expectEq("hunk new 行数", Number(m[4]), 5);

  const ctxLines = lines.slice(3);
  expectTrue("包含上下文行 (空格开头)", ctxLines.some((l) => l.startsWith(" ")));
  expectTrue("包含删除行 (- 开头)", ctxLines.some((l) => l.startsWith("-")));
  expectTrue("包含新增行 (+ 开头)", ctxLines.some((l) => l.startsWith("+")));
  expectTrue("删除行是 -line3", ctxLines.some((l) => l === "-line3"));
  expectTrue("新增行是 +REPLACED", ctxLines.some((l) => l === "+REPLACED"));
})();

console.log("\n== 6b. buildEditDiff 多行替换 ==");
(function () {
  const oldLines = ["a", "b", "c", "d", "e"];
  const newLines = ["a", "X", "Y", "d", "e"];
  const diff = buildEditDiff("f.ts", oldLines, newLines, 1, 2, 2);

  const lines = diff.split("\n");
  expectTrue("正确 --- 头", lines[0] === "--- a/f.ts");
  expectTrue("正确 +++ 头", lines[1] === "+++ b/f.ts");

  const m = lines[2].match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
  if (!m) fail("hunk 头格式不正确");
  expectEq("old 起始 (含上下文)", Number(m[1]), 1);

  const body = lines.slice(3).join("\n");
  expectTrue("包含 -b", body.includes("-b"));
  expectTrue("包含 -c", body.includes("-c"));
  expectTrue("包含 +X", body.includes("+X"));
  expectTrue("包含 +Y", body.includes("+Y"));
  expectTrue("上下文行 a 存在", body.includes(" a"));
  expectTrue("上下文行 d 存在", body.includes(" d"));
})();

console.log("\n== 6c. buildEditDiff 空替换（删除） ==");
(function () {
  const oldLines = ["keep", "remove", "also_keep"];
  const newLines = ["keep", "also_keep"];
  const diff = buildEditDiff("x.ts", oldLines, newLines, 1, 1, 0);

  const lines = diff.split("\n");
  expectTrue("正确 --- 头", lines[0] === "--- a/x.ts");
  expectTrue("正确 +++ 头", lines[1] === "+++ b/x.ts");

  const body = lines.slice(3).join("\n");
  expectTrue("删除行 -remove", body.includes("-remove"));
  expectTrue("无新增行 +remove", !body.includes("+remove"));
  expectTrue("上下文 keep", body.includes(" keep"));
  expectTrue("上下文 also_keep", body.includes(" also_keep"));
})();

console.log("\n== 6d. buildEditDiff 空 diff 路径 ==");
(function () {
  const oldLines = ["same"];
  const newLines = ["same"];
  const diff = buildEditDiff("empty.ts", oldLines, newLines, 0, 0, 0);

  const lines = diff.split("\n");
  expectTrue("头正确", lines[0] === "--- a/empty.ts");
  expectTrue("头正确", lines[1] === "+++ b/empty.ts");
  expectTrue("包含 @@ hunk", lines[2].startsWith("@@"));
})();

// ============================================================
// 7. getEffectiveWorkdirForTest() —— 返回当前生效工作目录
// ============================================================
console.log("\n== 7. getEffectiveWorkdirForTest ==");

(function () {
  const wd = getEffectiveWorkdirForTest();
  expectTrue("默认工作目录非空", wd.length > 0);
  expectTrue("默认工作目录是绝对路径", wd.startsWith("/") || /^[A-Za-z]:/.test(wd));
})();

(function () {
  const wd = getEffectiveWorkdirForTest();
  runWithWorkdir("/custom/path", () => {
    const inner = getEffectiveWorkdirForTest();
    const norm = (p: string) => p.replace(/\\/g, "/");
    expectEq("runWithWorkdir 内 effectiveWorkdir 等于绑定目录", norm(inner), norm("/custom/path"));
  });
  const after = getEffectiveWorkdirForTest();
  expectEq("退出后回到默认工作目录", after, wd);
})();

// ============================================================
// 全部通过
// ============================================================
console.log("\n✓ lib/tools.ts 全部测试通过");
process.exit(0);