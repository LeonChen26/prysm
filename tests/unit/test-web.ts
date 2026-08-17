/**
 * web.ts 纯函数单元验证 —— 无需网络访问。
 * 覆盖：decodeEntities / stripTags / htmlToText / parseBing / parseDuckDuckGo / isBlockedIp
 *       以及 fetchUrlAsText 的协议校验路径（在发起网络请求前即抛错）。
 * 运行：npx tsx tests/unit/test-web.ts
 */
import {
  decodeEntities,
  stripTags,
  htmlToText,
  parseBing,
  parseDuckDuckGo,
  isBlockedIp,
  fetchUrlAsText,
} from "../../lib/web";

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

function expectThrows(name: string, fn: () => unknown, expectedMsg?: string) {
  let threw = false;
  let msg = "";
  try {
    fn();
  } catch (e) {
    threw = true;
    msg = (e as Error).message;
  }
  if (!threw) fail(`${name}: 期望抛错但未抛错`);
  if (expectedMsg && !msg.includes(expectedMsg)) {
    fail(`${name}: 期望错误信息包含 "${expectedMsg}"，实际为 "${msg}"`);
  }
  console.log(`  ✓ ${name}`);
}

async function main() {
  // =========================================================================
  // 1. decodeEntities —— HTML 实体解码
  // =========================================================================
  console.log("== decodeEntities: 基础实体 ==");
  expectEq("&amp; → &", decodeEntities("a &amp; b"), "a & b");
  expectEq("&lt; → <", decodeEntities("a &lt; b"), "a < b");
  expectEq("&gt; → >", decodeEntities("a &gt; b"), "a > b");
  expectEq("&quot; → \"", decodeEntities(`a &quot; b`), `a " b`);
  expectEq("&#039; → '", decodeEntities("a &#039; b"), "a ' b");
  expectEq("&#39; → '", decodeEntities("a &#39; b"), "a ' b");
  expectEq("&nbsp; → 空格", decodeEntities("a&nbsp;b"), "a b");

  console.log("\n== decodeEntities: 数字实体（十进制） ==");
  expectEq("&#65; → A", decodeEntities("&#65;"), "A");
  expectEq("&#97; → a", decodeEntities("&#97;"), "a");
  expectEq("&#48; → 0", decodeEntities("&#48;"), "0");
  expectEq("&#8364; → €", decodeEntities("&#8364;"), "€");

  console.log("\n== decodeEntities: 混合实体 ==");
  expectEq(
    "混合句子",
    decodeEntities("Tom &amp; Jerry &lt; <foo> &gt; \"bar\" &#039;s"),
    `Tom & Jerry < <foo> > "bar" 's`,
  );

  console.log("\n== decodeEntities: 边界情况 ==");
  expectEq("空字符串", decodeEntities(""), "");
  expectEq("无实体", decodeEntities("hello world"), "hello world");
  expectEq(
    "多次出现相同实体",
    decodeEntities("&amp;&amp;&amp;"),
    "&&&",
  );

  // =========================================================================
  // 2. stripTags —— HTML 标签剥离
  // =========================================================================
  console.log("\n== stripTags ==");
  expectEq("基础标签", stripTags("<p>hello</p>"), "hello");
  expectEq("嵌套标签", stripTags("<div><p>text</p></div>"), "text");
  expectEq("含属性标签", stripTags('<a href="x">link</a>'), "link");
  expectEq("自闭合标签", stripTags("<br/>text"), "text");
  expectEq("无标签", stripTags("plain text"), "plain text");
  expectEq("空字符串", stripTags(""), "");

  // =========================================================================
  // 3. htmlToText —— HTML 转纯文本
  // =========================================================================
  console.log("\n== htmlToText: 基础 ==");
  expectEq("简单段落", htmlToText("<p>hello world</p>"), "hello world");
  expectEq("保留文本", htmlToText("<div>keep <strong>bold</strong> text</div>"), "keep bold text");

  console.log("\n== htmlToText: <br> 转换行 ==");
  expectEq("单 br", htmlToText("line1<br>line2"), "line1\nline2");
  expectEq("br/ 和 br />", htmlToText("a<br/>b<br />c"), "a\nb\nc");

  console.log("\n== htmlToText: <li> 转 - 前缀 ==");
  expectEq(
    "列表项",
    htmlToText("<ul><li>item1</li><li>item2</li></ul>"),
    "- item1\n\n- item2",
  );

  console.log("\n== htmlToText: <h1>–<h6> 转 markdown 标题 ==");
  expectEq("h1", htmlToText("<h1>Title</h1>"), "# Title");
  expectEq("h2", htmlToText("<h2>Sub</h2>"), "## Sub");
  expectEq(
    "h3-h6",
    htmlToText("<h3>A</h3><h4>B</h4><h5>C</h5><h6>D</h6>"),
    "### A\n\n#### B\n\n##### C\n\n###### D",
  );

  console.log("\n== htmlToText: 块级元素换行 ==");
  expectEq(
    "多段落",
    htmlToText("<p>p1</p><div>d1</div>"),
    "p1\nd1",
  );

  console.log("\n== htmlToText: 剥离 script/style/noscript/svg/iframe/head 内容 ==");
  expectEq(
    "script 标签",
    htmlToText("<p>before</p><script>alert('x')</script><p>after</p>"),
    "before\n after",
  );
  expectEq(
    "style 标签",
    htmlToText("<style>body{}</style><p>text</p>"),
    "text",
  );
  expectEq(
    "noscript 标签",
    htmlToText("<noscript>enable js</noscript><p>ok</p>"),
    "ok",
  );
  expectEq(
    "svg 标签",
    htmlToText("<svg><path/></svg><p>hello</p>"),
    "hello",
  );
  expectEq(
    "iframe 标签",
    htmlToText("<iframe src='x'></iframe><p>world</p>"),
    "world",
  );
  expectEq(
    "head 标签(含 title) 被剥离",
    htmlToText("<head><title>t</title></head><p>body</p>"),
    "body",
  );

  console.log("\n== htmlToText: 多空行折叠 ==");
  expectEq(
    "段落间单换行",
    htmlToText("<p>a</p><p>b</p><p>c</p>"),
    "a\nb\nc",
  );
  expectEq(
    "br 与块混合折叠",
    htmlToText("<p>a</p><br><br><p>b</p>"),
    "a\n\nb",
  );
  expectEq(
    "三以上空行折叠为两空行",
    htmlToText("<div>a</div><br><br><br><div>b</div>"),
    "a\n\nb",
  );

  console.log("\n== htmlToText: 综合示例 ==");
  const sampleHtml = `
<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
  <h1>Main Title</h1>
  <p>First paragraph with <strong>bold</strong> text.</p>
  <h2>Sub Title</h2>
  <ul>
    <li>First item</li>
    <li>Second item</li>
  </ul>
  <p>Text with<br>line break.</p>
  <script>console.log("evil")</script>
  <p>Final paragraph.</p>
</body>
</html>`;
  const sampleResult = htmlToText(sampleHtml);
  if (!sampleResult.includes("# Main Title")) fail("综合示例应包含 h1 标题");
  if (!sampleResult.includes("## Sub Title")) fail("综合示例应包含 h2 标题");
  if (!sampleResult.includes("- First item")) fail("综合示例应包含列表项");
  if (!sampleResult.includes("Final paragraph")) fail("综合示例应包含末尾段落");
  if (sampleResult.includes("console.log")) fail("综合示例不应包含 script 内容");
  console.log("  ✓ 综合示例解析正确");

  // =========================================================================
  // 4. parseBing —— Bing 搜索结果解析
  // =========================================================================
  console.log("\n== parseBing: 基础解析 ==");
  const bingHtml = `
<li class="b_algo">
  <h2><a href="https://www.example.com/docs">Example Documentation</a></h2>
  <p>This is the snippet description for example.com documentation.</p>
</li>
<li class="b_algo">
  <h2><a href="https://news.example.com/article">News Article</a></h2>
  <p>Latest news about technology and more.</p>
</li>
<li class="b_algo">
  <h2><a href="/relative/url">Skip This</a></h2>
  <p>Should be skipped because URL is not http.</p>
</li>`;

  const bingResults = parseBing(bingHtml, 5);
  expectEq("解析条数", bingResults.length, 2);
  expectEq("第一条标题", bingResults[0].title, "Example Documentation");
  expectEq("第一条 URL", bingResults[0].url, "https://www.example.com/docs");
  expectEq("第一条摘要包含 snippet", bingResults[0].snippet.includes("snippet description"), true);
  expectEq("第二条标题", bingResults[1].title, "News Article");
  expectEq("第二条 URL", bingResults[1].url, "https://news.example.com/article");
  expectEq("跳过非 http URL", bingResults.length, 2);

  console.log("\n== parseBing: 限制条数 ==");
  const bingMany = Array.from({ length: 10 }, (_, i) => `
<li class="b_algo">
  <h2><a href="https://site${i}.com">Site ${i}</a></h2>
  <p>Snippet ${i}</p>
</li>`).join("");
  expectEq("limit=3 只返回 3 条", parseBing(bingMany, 3).length, 3);
  expectEq("limit=1 返回 1 条", parseBing(bingMany, 1).length, 1);

  console.log("\n== parseBing: HTML 实体解码 ==");
  const bingEntityHtml = `
<li class="b_algo">
  <h2><a href="https://example.com">&quot;Quoted&quot; &amp; More</a></h2>
  <p>Snippet with &amp; entity.</p>
</li>`;
  const entityResult = parseBing(bingEntityHtml, 1);
  expectEq("标题实体解码", entityResult[0].title, `"Quoted" & More`);
  expectEq("摘要实体解码", entityResult[0].snippet, "Snippet with & entity.");

  console.log("\n== parseBing: bing.com/ck/a 跳转解码 ==");
  const realUrl = "https://www.real-site.com/page";
  const b64 = Buffer.from(realUrl, "utf-8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_");
  const bingRedirectHtml = `
<li class="b_algo">
  <h2><a href="https://www.bing.com/ck/a?u=a1${b64}">Redirect Title</a></h2>
  <p>Redirect snippet.</p>
</li>`;
  const redirectResults = parseBing(bingRedirectHtml, 1);
  expectEq("bing ck/a 解码跳转 URL", redirectResults[0].url, realUrl);
  expectEq("跳转标题保留", redirectResults[0].title, "Redirect Title");

  console.log("\n== parseBing: 空 HTML / 无结果 ==");
  expectEq("空 HTML 返回空数组", parseBing("", 5).length, 0);
  expectEq("无 b_algo 块返回空", parseBing("<html><p>no results</p></html>", 5).length, 0);

  // =========================================================================
  // 5. parseDuckDuckGo —— DDG 搜索结果解析
  // =========================================================================
  console.log("\n== parseDuckDuckGo: 基础解析 ==");
  const ddgHtml = `
<a class="result__a" href="https://duckduckgo.com/">DuckDuckGo</a>
<a class="result__snippet">The official DuckDuckGo website.</a>
<a class="result__a" href="https://example.com/">Example</a>
<a class="result__snippet">Example domain for testing.</a>
<a class="result__a" href="/local">Skip</a>
<a class="result__snippet">Should be skipped.</a>`;

  const ddgResults = parseDuckDuckGo(ddgHtml, 5);
  expectEq("DDG 解析条数", ddgResults.length, 3);
  expectEq("DDG 第一条标题", ddgResults[0].title, "DuckDuckGo");
  expectEq("DDG 第一条 URL", ddgResults[0].url, "https://duckduckgo.com/");
  expectEq("DDG 第一条摘要", ddgResults[0].snippet, "The official DuckDuckGo website.");

  console.log("\n== parseDuckDuckGo: 限制条数 ==");
  const ddgMany = Array.from({ length: 8 }, (_, i) => `
<a class="result__a" href="https://ddg${i}.com">DDG ${i}</a>
<a class="result__snippet">Snippet ${i}</a>`).join("");
  expectEq("DDG limit=2", parseDuckDuckGo(ddgMany, 2).length, 2);

  console.log("\n== parseDuckDuckGo: HTML 实体解码 ==");
  const ddgEntityHtml = `
<a class="result__a" href="https://example.com">&amp; &quot;test&quot;</a>
<a class="result__snippet">Has &amp; ampersand.</a>`;
  const ddgEntityResult = parseDuckDuckGo(ddgEntityHtml, 1);
  expectEq("DDG 标题实体解码", ddgEntityResult[0].title, `& "test"`);

  console.log("\n== parseDuckDuckGo: 空 HTML ==");
  expectEq("DDG 空 HTML 返回空", parseDuckDuckGo("", 5).length, 0);

  // =========================================================================
  // 6. isBlockedIp —— SSRF 防护 IP 检测
  // =========================================================================
  console.log("\n== isBlockedIp: IPv4 私网/环回/保留 ==");
  expectEq("127.0.0.1 环回", isBlockedIp("127.0.0.1"), true);
  expectEq("127.255.255.255 环回", isBlockedIp("127.255.255.255"), true);
  expectEq("10.0.0.1 私网", isBlockedIp("10.0.0.1"), true);
  expectEq("10.255.255.255 私网", isBlockedIp("10.255.255.255"), true);
  expectEq("172.16.0.1 私网", isBlockedIp("172.16.0.1"), true);
  expectEq("172.31.255.255 私网", isBlockedIp("172.31.255.255"), true);
  expectEq("172.32.0.1 公网(不在 16-31)", isBlockedIp("172.32.0.1"), false);
  expectEq("192.168.0.1 私网", isBlockedIp("192.168.0.1"), true);
  expectEq("192.168.255.255 私网", isBlockedIp("192.168.255.255"), true);
  expectEq("0.0.0.1 未指定", isBlockedIp("0.0.0.1"), true);
  expectEq("0.255.255.255 未指定", isBlockedIp("0.255.255.255"), true);
  expectEq("169.254.0.1 链路本地", isBlockedIp("169.254.0.1"), true);
  expectEq("169.254.169.254 云元数据", isBlockedIp("169.254.169.254"), true);
  expectEq("100.64.0.1 CGNAT", isBlockedIp("100.64.0.1"), true);
  expectEq("100.127.255.255 CGNAT", isBlockedIp("100.127.255.255"), true);
  expectEq("100.128.0.1 公网(不在 64-127)", isBlockedIp("100.128.0.1"), false);
  expectEq("224.0.0.1 组播", isBlockedIp("224.0.0.1"), true);
  expectEq("255.255.255.255 保留", isBlockedIp("255.255.255.255"), true);

  console.log("\n== isBlockedIp: IPv4 公网 ==");
  expectEq("8.8.8.8 公网", isBlockedIp("8.8.8.8"), false);
  expectEq("1.1.1.1 公网", isBlockedIp("1.1.1.1"), false);
  expectEq("93.184.216.34 公网", isBlockedIp("93.184.216.34"), false);
  expectEq("203.0.113.5 公网(TEST-NET-3)", isBlockedIp("203.0.113.5"), false);

  console.log("\n== isBlockedIp: IPv6 私网/环回/保留 ==");
  expectEq(":: 未指定", isBlockedIp("::"), true);
  expectEq("::1 环回", isBlockedIp("::1"), true);
  expectEq("fc00::1 ULA", isBlockedIp("fc00::1"), true);
  expectEq("fd00::1 ULA", isBlockedIp("fd00::1"), true);
  expectEq("fe80::1 链路本地", isBlockedIp("fe80::1"), true);
  expectEq("fe80::1234 链路本地", isBlockedIp("fe80::1234"), true);
  expectEq("fe90::1 链路本地", isBlockedIp("fe90::1"), true);
  expectEq("fea0::1 链路本地", isBlockedIp("fea0::1"), true);
  expectEq("feb0::1 链路本地", isBlockedIp("feb0::1"), true);

  console.log("\n== isBlockedIp: IPv4-mapped IPv6 ==");
  expectEq("::ffff:127.0.0.1 → 内网", isBlockedIp("::ffff:127.0.0.1"), true);
  expectEq("::ffff:10.0.0.1 → 内网", isBlockedIp("::ffff:10.0.0.1"), true);
  expectEq("::ffff:192.168.0.1 → 内网", isBlockedIp("::ffff:192.168.0.1"), true);
  expectEq("::ffff:8.8.8.8 → 公网", isBlockedIp("::ffff:8.8.8.8"), false);

  console.log("\n== isBlockedIp: IPv6 公网 ==");
  expectEq("2001:4860:4860::8888 公网", isBlockedIp("2001:4860:4860::8888"), false);
  expectEq("2606:4700:4700::1111 公网", isBlockedIp("2606:4700:4700::1111"), false);

  console.log("\n== isBlockedIp: 非法输入 ==");
  expectEq("空字符串", isBlockedIp(""), true);
  expectEq("随机文本", isBlockedIp("hello"), true);
  expectEq("部分 IP", isBlockedIp("192.168"), true);

  // =========================================================================
  // 7. fetchUrlAsText: 协议校验（无需网络）
  // =========================================================================
  console.log("\n== fetchUrlAsText: 非 http/https 协议拦截 ==");
  {
    const cases: [string, string][] = [
      ["file:///etc/passwd", "file://"],
      ["ftp://example.com", "ftp://"],
      ["gopher://example.com", "gopher://"],
      ["data:text/html,<h1>x</h1>", "data:"],
    ];
    for (const [url, label] of cases) {
      let threw = false;
      let msg = "";
      try {
        await fetchUrlAsText(url);
      } catch (e) {
        threw = true;
        msg = (e as Error).message;
      }
      if (!threw) fail(`${label} 协议应被拦截`);
      if (!msg.includes("仅支持 http/https")) {
        fail(`${label}: 期望协议错误，实际: ${msg}`);
      }
      console.log(`  ✓ ${label} 协议被拦截`);
    }
  }

  console.log("\n✓ web.ts 纯函数单元验证通过");
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});