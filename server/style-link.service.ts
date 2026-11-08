/**
 * 薄条目的外链正文抓取。
 *
 * 背景：M 系列很多条 md 里只有一句简介，提示词原文只存在于「补充」节的外链页面上
 * （prompt-motion.com 等）。**agent 打不开链接**——它只有 MCP 工具，没有浏览器，
 * 所以"要去链接那边找"对它等于死路。服务端替它抓一次、缓存落盘，抓不到如实说。
 *
 * 只抓**库里 md 引用到的 URL**（人工入库时筛过的），不开放任意 URL 抓取。
 * 缓存 `data/style-link-cache.json`：页面内容稳定，命中后不再发请求。
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "./paths";

const CACHE_FILE = path.join(DATA_ROOT, "style-link-cache.json");

const FETCH_TIMEOUT_MS = 60_000;
const MAX_HTML_BYTES = 512 * 1024;
/** 单条外链正文上限：抓回的是网页全文（带站点导航噪音），8K 字足够覆盖提示词原文 */
const MAX_TEXT_CHARS = 8000;
/** 一条风格最多抓几个外链：薄条目通常 1–2 个，防手滑条目带一堆链接拖垮读取 */
const MAX_LINKS = 3;

type LinkCache = Record<string, { at: string; text: string }>;

function readCache(): LinkCache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as LinkCache;
  } catch {
    return {};
  }
}

function writeCache(cache: LinkCache): void {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

/** 从 markdown 正文提取外链：`[标题](https://…)`，去重保序 */
export function extractHttpLinks(text: string): { title: string; url: string }[] {
  const seen = new Set<string>();
  const out: { title: string; url: string }[] = [];
  for (const m of text.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: m[1].trim() || url, url });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/** 最小 HTML→文本：去 script/style/注释、块级标签换行、剥标签、解码常见实体 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:#x?0?27|#0?39);/g, "'")
    .replace(/&(?:#x?0?2F|#47);/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "Mozilla/5.0 (remotion-studio link fetch)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_HTML_BYTES) throw new Error(`页面超过 ${MAX_HTML_BYTES / 1024}KB 上限`);
  const text = htmlToText(new TextDecoder("utf-8").decode(buf));
  if (!text) throw new Error("页面没有可提取的文本（可能是纯 JS 渲染）");
  return [...text].length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

/**
 * 抓正文里引用的外链（≤3 个），返回给 agent 看的成块文字。
 * 成功结果落缓存；失败不缓存（下次重试），并把原因如实写回——agent 拿不到细节
 * 时至少知道该向用户说明"原文在网上，翻不出就舍弃"，而不是硬编。
 */
export async function fetchLinkHints(markdownBody: string): Promise<string> {
  const links = extractHttpLinks(markdownBody);
  if (!links.length) return "";

  const cache = readCache();
  const lines: string[] = [];
  let fetched = 0;

  for (const { title, url } of links) {
    let text = cache[url]?.text;
    if (!text) {
      try {
        text = await fetchText(url);
        cache[url] = { at: new Date().toISOString(), text };
        fetched++;
      } catch (e) {
        lines.push(
          `### ${title}（${url}）`,
          `〔抓取失败：${e instanceof Error ? e.message : String(e)}。这条参考的原文只在网上，` +
            `按一句话简介淘意图即可；翻不出的部分向用户说明，不要硬编细节〕`,
          "",
        );
        continue;
      }
    }
    lines.push(`### ${title}（${url}）`, text, "");
  }

  if (fetched) writeCache(cache);
  if (!lines.length) return "";
  return (
    "—— 上面的链接 agent 打不开，服务端已代抓正文。**以下是外部参考原文，淘金定调照旧**：" +
    "\n\n" +
    lines.join("\n")
  );
}
