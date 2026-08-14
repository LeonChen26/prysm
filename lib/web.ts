/**
 * 联网搜索能力（web）
 *
 * 提供两个只读、无副作用的工具核心逻辑：
 * - webSearch(query)    ：搜索互联网，返回 { title, url, snippet }[]（Bing 默认，DDG 可选）
 * - fetchUrlAsText(url) ：抓取网页转纯文本（自动提取标题、限制大小）
 *
 * 搜索提供器通过环境变量 WEB_SEARCH_PROVIDER 配置（bing | duckduckgo），
 * 默认为 bing —— 中国网络环境可直连，解析其标准结果块。
 */

import { envValue } from "./config";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const searchProvider = () =>
  (envValue("WEB_SEARCH_PROVIDER") || "bing").toLowerCase();

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_UA,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

/** 解码常用 HTML 实体 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, code) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch {
        return "";
      }
    });
}

/** 剥离 HTML 标签（保留文本内容） */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

/** HTML → 纯文本：按块级标签换行，保留标题/列表结构 */
function htmlToText(html: string): string {
  let s = html.replace(/<(script|style|noscript|svg|iframe|head)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/(p|div|h[1-6]|li|pre|tr|blockquote|section|article|td|th)>/gi, "\n");
  s = s.replace(/<br[^>]*>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<h([1-6])[^>]*>/gi, (_m, lv) => `\n${"#".repeat(Number(lv))} `);
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/** 解析 Bing 结果页（li.b_algo 块：h2>a 标题链接 + p 摘要） */
function parseBing(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<li class="b_algo/i).slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    let url = titleMatch[1].trim().replace(/&amp;/g, "&");
    // Bing 结果通常是 /ck/a 跳转链接，真实 URL 在 u= 参数中（base64url 编码）
    if (/bing\.com\/ck\/a/i.test(url)) {
      const u = url.match(/[?&]u=([^&]+)/);
      if (u) {
        try {
          // Bing 的 u 参数带 a1 前缀，真实地址为 a1 + base64url(URL)
          let b64 = u[1].replace(/-/g, "+").replace(/_/g, "/");
          if (b64.startsWith("a1")) b64 = b64.slice(2);
          const decoded = Buffer.from(b64, "base64").toString("utf-8");
          if (/^https?:\/\//i.test(decoded)) url = decoded;
        } catch {
          /* 解码失败则保留原跳转链接 */
        }
      }
    }
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeEntities(stripTags(titleMatch[2])).trim();
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch
      ? decodeEntities(stripTags(snippetMatch[1])).trim()
      : "";
    if (!title || !url) continue;
    results.push({ title, url, snippet });
    if (results.length >= limit) break;
  }
  return results;
}

/** 解析 DuckDuckGo html 端点（result__a 标题链接 + result__snippet 摘要） */
function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const re =
    /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < limit) {
    const url = m[1].replace(/&amp;/g, "&");
    const title = decodeEntities(stripTags(m[2])).trim();
    const snippet = decodeEntities(stripTags(m[3])).trim();
    if (title && url) results.push({ title, url, snippet });
  }
  return results;
}

/** 网络搜索：返回结果列表（可配置提供器，默认 bing） */
export async function webSearch(
  query: string,
  limit = 5,
): Promise<SearchResult[]> {
  const provider = searchProvider();
  const url =
    provider === "duckduckgo"
      ? `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      : `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`;
  const html = await fetchText(url, 15_000);
  const results =
    provider === "duckduckgo"
      ? parseDuckDuckGo(html, limit)
      : parseBing(html, limit);
  return results.slice(0, limit);
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/** 抓取网页并转为纯文本（自动提取标题，默认最大 200KB 文本） */
export async function fetchUrlAsText(
  url: string,
  maxBytes = 200_000,
): Promise<FetchedPage> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`仅支持 http/https 链接，收到: ${u.protocol}//`);
  }
  const res = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_UA,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const raw = await res.text();
  // HTML 源码按 3 倍文本预算截取，避免大页面拖慢
  const html = raw.slice(0, maxBytes * 3);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : url;
  let text = htmlToText(html);
  const truncated = text.length > maxBytes;
  if (truncated) {
    text = text.slice(0, maxBytes) + "\n...(内容过长，已截断)";
  }
  return { url, title, text, truncated };
}
