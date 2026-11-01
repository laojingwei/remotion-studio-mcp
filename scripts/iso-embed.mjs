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
  const svg = source.match(/<svg[\s\S]*?<\/svg>/);
  if (!svg) throw new Error("输入里找不到 <svg>…</svg>（anatomy 的产物是 figureSvg 或 pageHtml）");
  return svg[0];
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
function injectTheme(svg, css) {
  if (/<\/style>/i.test(svg)) return svg.replace(/<\/style>/i, `${css}</style>`);
  return svg.replace(/(<svg[^>]*>)/i, `$1<style>${css}</style>`);
}

const projectFile = join(ROOT, "data", "projects", projectId, "project.json");
if (!existsSync(projectFile)) {
  console.error(`找不到工程：${projectFile}`);
  process.exit(1);
}
const project = JSON.parse(readFileSync(projectFile, "utf8"));
const palette = project.theme?.palette ?? {};

const raw = readFileSync(resolve(input), "utf8");
const themed = injectTheme(sanitize(pickSvg(raw)), isoTheme(palette));

// 兜底：主题里没有 background 时至少别让页面底色和片子打架
const out = /data-theme=/.test(themed) ? themed : themed.replace(/<svg/i, '<svg data-theme="dark"');

const dir = join(ROOT, "public", "assets", "projects", projectId, "iso");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${name}.svg`);
writeFileSync(file, out);

console.log(`✓ ${file.replace(ROOT, ".")}  (${(out.length / 1024).toFixed(0)} KB)`);
console.log(`  引用地址：/assets/projects/${projectId}/iso/${name}.svg`);
console.log(`  尺寸：${(out.match(/viewBox="([^"]+)"/)?.[1] ?? "?").split(" ").slice(2).join("×")}`);
