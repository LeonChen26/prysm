/**
 * 联网搜索能力验证（真实网络）
 * 运行: npx tsx test-web.ts
 */
import { fetchUrlAsText, webSearch } from "../../lib/web";

async function main() {
  console.log("== web_search（Bing）==");
  const results = await webSearch("Node.js 22 release", 5);
  if (results.length === 0) {
    console.log("✗ 未解析到任何搜索结果");
  } else {
    results.forEach((r, i) => {
      console.log(`${i + 1}. ${r.title}`);
      console.log(`   ${r.url}`);
      console.log(`   ${r.snippet.slice(0, 100)}`);
    });
    console.log(`✓ 解析到 ${results.length} 条结果`);
  }

  console.log("\n== fetch_url ==");
  const url = results[0]?.url;
  if (url) {
    const page = await fetchUrlAsText(url);
    console.log(`标题: ${page.title}`);
    console.log(`文本长度: ${page.text.length} 字符, 截断: ${page.truncated}`);
    console.log(`正文预览:\n${page.text.slice(0, 300)}`);
    if (page.text.length > 200 && page.title) {
      console.log("✓ 抓取网页成功（有标题 + 正文）");
    }
  } else {
    console.log("跳过 fetch_url（无可用搜索结果 URL）");
  }

  console.log("\n== 异常路径 ==");
  try {
    await fetchUrlAsText("file:///etc/passwd");
    console.log("✗ 未拦截非法协议");
  } catch (err) {
    console.log(`✓ 拦截非法协议: ${(err as Error).message}`);
  }
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
