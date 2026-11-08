/**
 * 缩略图版本戳：给「内容会变但 URL 不变」的图片破浏览器缓存。
 *
 * 两类缩略图共用一个戳：
 * · `server/styles/stills/*.webp`              内置风格样张（77 张）
 * · `server/skills/prompt-library/**\/*.webp`  提示词缩略图（153 源站 + 26 技法）
 *
 * 为什么合并：任何一张图重出，戳都要变。分开维护两个戳就得改两处前端、两处路由，
 * 漏一处就回到「磁盘是新的、浏览器还是旧的」。
 *
 * 戳由每张图的「相对路径 + size + 内容 sha1」汇总 sha1 前 12 位。
 * 不能用 mtime：git 克隆不保留修改时间，CI 全新 checkout 后 mtime 全变，
 * 戳必然对不上（test-styles 在 CI 必红的根因）。内容进 git，跨克隆稳定。
 * 由出图脚本在成功写入后调用 `refreshStillVersion()` 自动刷新，勿手改生成的文件。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ROOT } from "../server/root";

const STYLE_STILLS = path.join(ROOT, "server", "styles", "stills");
const PROMPT_LIB = path.join(ROOT, "server", "skills", "prompt-library");
export const STILL_VERSION_FILE = path.join(ROOT, "shared", "still-version.ts");

type Entry = { key: string; abs: string };

function collect(): Entry[] {
  const out: Entry[] = [];
  if (fs.existsSync(STYLE_STILLS)) {
    for (const f of fs.readdirSync(STYLE_STILLS).filter((x) => x.endsWith(".webp")).sort()) {
      out.push({ key: `styles/${f}`, abs: path.join(STYLE_STILLS, f) });
    }
  }
  const walk = (dir: string, prefix: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, `${prefix}${e.name}/`);
      else if (e.name.endsWith(".webp")) out.push({ key: `${prefix}${e.name}`, abs });
    }
  };
  walk(PROMPT_LIB, "prompt/");
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** 按当前磁盘上的图算出应有的版本戳；一张图都没有时返回 null（新克隆还没出过图） */
export function computeStillVersion(): string | null {
  const entries = collect();
  if (!entries.length) return null;
  const hash = createHash("sha1");
  for (const { key, abs } of entries) {
    const st = fs.statSync(abs);
    const content = createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
    hash.update(`${key}:${st.size}:${content};`);
  }
  return hash.digest("hex").slice(0, 12);
}

/** 把戳写进 shared/still-version.ts（内容不变就不写，免得白白触发一次前端重建） */
export function refreshStillVersion(): string | null {
  const v = computeStillVersion();
  if (!v) return null;
  if (fs.existsSync(STILL_VERSION_FILE) && fs.readFileSync(STILL_VERSION_FILE, "utf8").includes(`STILL_VERSION = "${v}"`)) {
    return v;
  }
  fs.writeFileSync(
    STILL_VERSION_FILE,
    `/**\n` +
      ` * 缩略图版本戳 —— **由出图脚本自动刷新，勿手改**。\n` +
      ` *\n` +
      ` * 图片 URL 原本是 /api/.../still/<id>，永远不变，而响应给过 max-age=604800；\n` +
      ` * 重出图后浏览器 7 天内连条件请求都不发，用户看到的仍是旧图。\n` +
      ` * 现在 URL 带 ?v=<这个戳>：内容一变戳就变，URL 就变，浏览器必然重新取。\n` +
      ` * 戳汇总了内置风格样张与提示词缩略图两类资源，算法见 scripts/still-version.mts。\n` +
      ` */\n` +
      `export const STILL_VERSION = "${v}";\n`,
    "utf8",
  );
  return v;
}
