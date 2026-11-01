#!/usr/bin/env node
/**
 * 把 anatomy（或任何等轴测 SVG）落成片子里能直接用的素材。
 *
 *   node scripts/iso-embed.mjs <输入.svg|.html> <projectId> <名字> [--fit]
 *
 * 做三件事，缺一不可：
 *
 * 1. **套主题**：注入 isoTheme()，让图的明暗跟着这一支片的主题走（否则在深底片子里
 *    只剩轮廓 —— 原版四档明暗只差 4%，静态图够用，进视频就糊）。
 * 2. **剥脚本**：SVG 是可以带 <script> 和 onload 的。内联进 Remotion 之后这些会真的执行，
 *    等于把第三方代码放进渲染进程。我们只要图，不要行为。
 * 3. **落盘到 assets**：产物必须进 public/assets/projects/<id>/iso/，
 *    这样 image / iso 场景用 `/assets/...` 就能引用（跟其它素材一致）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isoTheme } from "./iso-theme.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const [input, projectId, name] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!input || !projectId || !name) {
  console.error("用法: node scripts/iso-embed.mjs <输入.svg|.html> <projectId> <名字>");
  process.exit(1);
}

/** 从 html 里抠出第一个 <svg>…</svg>；给的就是 svg 就原样用 */
function pickSvg(source) {
  /** 页面里有好几个 svg（图例小图标、缩略图…），抠**最大的**那个才是主图 */
  const svgs = source.match(/<svg[\s\S]*?<\/svg>/g) ?? [];
  if (!svgs.length) throw new Error("输入里找不到 <svg>…</svg>（anatomy 的产物是 figureSvg 或 pageHtml）");
  return svgs.reduce((a, b) => (b.length > a.length ? b : a));
}

/** 去掉可执行内容：script、事件属性、外链 js */
function sanitize(svg) {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
}

/** 在已有 <style> 的末尾追加（同特异性、后写的赢）；没有 style 就紧跟开标签插一个 */
function injectStyles(svg, themeCss) {
  /*
   * 从范例 HTML 页里抠出来的 svg **只有结构没有样式**：anatomy 把 ISO_CSS 放在页面
   * `<head>` 里，svg 根也没有 `.iso` 类 —— 直接内联的话所有 class 都没有定义，画面是空的。
   * 所以这里把 kit/iso.css 整份带上（基础类 + 默认变量），主题覆盖写在它后面。
   * 自带 </style> 的 standalone svg 不需要 base，只补主题。
   */
  const pack = baseCss + themeCss;
  if (/<\/style>/i.test(svg)) return svg.replace(/<\/style>/i, `${themeCss}</style>`);
  let out = svg.replace(/(<svg[^>]*>)/i, `$1<style>${pack}</style>`);
  // 根节点补齐 .iso 类，否则变量组（.iso{--anatomy-…}）不生效。
  // 注意不能用 \biso\b —— "iso-svg" 里的 "iso" 也会命中（- 是非词字符），
  // desk-computer 第一版就是这么漏补的，整幕黑成剪影。
  if (!/class="[^"]*(^|\s)iso(\s|")/.test(out)) {
    out = out.replace(/class="iso-svg/, 'class="iso-svg iso');
  }
  if (!/data-theme=/.test(out)) {
    out = out.replace(/<svg/i, '<svg data-theme="dark"');
  }
  return out;
}

/**
 * anatomy 的基础样式：所有 iso-* 类的定义 + 默认变量组。
 * 从工具目录现读（不复制进仓库）——工具不存在时退化为主题-only，
 * 这时只有 standalone svg 能用（自带样式）。
 */
const ISO_CSS_PATH = join(ROOT, ".other_modules", "anatomy", "kit", "iso.css");
const baseCss = existsSync(ISO_CSS_PATH)
  ? readFileSync(ISO_CSS_PATH, "utf8").replace(/<\/?style>/gi, "")
  : "";

const projectFile = join(ROOT, "data", "projects", projectId, "project.json");
if (!existsSync(projectFile)) {
  console.error(`找不到工程：${projectFile}`);
  process.exit(1);
}
const project = JSON.parse(readFileSync(projectFile, "utf8"));
const palette = project.theme?.palette ?? {};

const raw = readFileSync(resolve(input), "utf8");
/* 覆盖块要同时命中 .iso 与 .iso[data-theme="light"]，否则浅色主题会被 anatomy 的
   light 变量组（特异性更高）赢回去。 */
const themeCss = isoTheme(palette).replace(".iso{", '.iso,.iso[data-theme="light"]{');
const themed = injectStyles(sanitize(pickSvg(raw)), themeCss);

const out = themed;

const dir = join(ROOT, "public", "assets", "projects", projectId, "iso");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${name}.svg`);
writeFileSync(file, out);

console.log(`✓ ${file.replace(ROOT, ".")}  (${(out.length / 1024).toFixed(0)} KB)`);
console.log(`  引用地址：/assets/projects/${projectId}/iso/${name}.svg`);
console.log(`  尺寸：${(out.match(/viewBox="([^"]+)"/)?.[1] ?? "?").split(" ").slice(2).join("×")}`);
