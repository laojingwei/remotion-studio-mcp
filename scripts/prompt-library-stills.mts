/**
 * 提示词库缩略图：镜像里的预览片 → 与 md 同基名的 webp。
 *
 * 用法：
 *   npx tsx scripts/prompt-library-stills.mts            # 补齐缺失的
 *   npx tsx scripts/prompt-library-stills.mts --force    # 全部重出
 *   npx tsx scripts/prompt-library-stills.mts --only=PM002
 *
 * 为什么从**正片**抽帧而不是 `preview.*.mp4`：
 * 一开始用的预览片（源站剪的 4 秒、720×406），但实测有一部分预览本身就是"标题卡节选"
 * ——整段只有黑底片名（同一时间点的 PNG 只有 5KB，正片是 50KB 量级），
 * 抽出来当卡片图就是一张黑底小字。教训：**预览片的代表性不可信，正片才稳**。
 * 代价是每条要解一次 20 秒 1080p，用 `-ss` 前置（关键帧快seek）+ 缩到 720 后，
 * 单帧约 0.5–1 秒，全库几分钟跑得完，可以接受。
 *
 * 命名和规格跟随风格库的既有约定（见 docs/2026-11-08-风格库面板设计.md §7.2、§7.3）：
 * 与 md 同目录、同基名、`.webp`；长边 720、质量 0.82。这样"删 md 好回收"，
 * 也保证将来标签页的取图逻辑和风格库是同一套。
 *
 * ffmpeg 必须自己找：Remotion 自带的那个没有 libwebp（实测只有 mjpeg）。
 * 这里刻意复制了 scripts/style-library.mts 的探测逻辑而不是 import 它——
 * 那个脚本在 import 时就会执行 CLI 的 switch，import 会把它整条命令跑一遍。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../server/root";

const LIB_ROOT = path.join(ROOT, "server", "skills", "prompt-library");
const SOURCE = path.join(ROOT, "data", "prompt-motion", "source.json");
const MANIFEST = path.join(ROOT, "data", "prompt-motion", "manifest.json");

/** 已知的完整版 ffmpeg（带 libwebp） */
const KNOWN_FFMPEG = [
  "G:/共享/自动化/FFmpeg/bin/ffmpeg.exe",
  "D:/ffmpeg/bin/ffmpeg.exe",
  "C:/ffmpeg/bin/ffmpeg.exe",
];

type SourceItem = {
  slug: string;
  media: { video: string | null; preview: string | null };
};

/** 找一个**真的能编 webp** 的 ffmpeg：跑一次 -encoders 验过才用，不靠文件名猜 */
function findFfmpeg(cli?: string): string {
  const probe = (p: string): boolean => {
    try {
      const out = execFileSync(p, ["-hide_banner", "-encoders"], { encoding: "utf8" });
      return /\blibwebp\b/.test(out);
    } catch {
      return false;
    }
  };
  const candidates: string[] = [];
  if (cli) candidates.push(cli);
  if (process.env.RMS_FFMPEG) candidates.push(process.env.RMS_FFMPEG);
  candidates.push(...KNOWN_FFMPEG);
  // PATH 里的（Windows 带 .exe 才找得到）
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) candidates.push(path.join(d, exe));

  for (const c of candidates) {
    if (fs.existsSync(c) && probe(c)) return c;
  }
  throw new Error(
    [
      "找不到能编 webp 的 ffmpeg。",
      "Remotion 自带的那个不行：`-encoders` 里没有 libwebp（只有 mjpeg）。",
      "给一个完整版：",
      '  npx tsx scripts/prompt-library-stills.mts --ffmpeg="D:/ffmpeg/bin/ffmpeg.exe"',
      "  或设 RMS_FFMPEG=D:\\ffmpeg\\bin\\ffmpeg.exe",
    ].join("\n"),
  );
}

/** 同目录下找 ffprobe（抽帧点要按真实时长算，不能写死） */
function ffprobeOf(ffmpeg: string): string | null {
  const p = path.join(path.dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  return fs.existsSync(p) ? p : null;
}

function durationOf(ffprobe: string | null, file: string): number {
  if (!ffprobe) return 4;
  try {
    const out = execFileSync(
      ffprobe,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0", file],
      { encoding: "utf8" },
    ).trim();
    const n = Number(out.split("\n")[0]);
    return Number.isFinite(n) && n > 0.5 ? n : 4;
  } catch {
    return 4;
  }
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs));
    else if (e.name.endsWith(".md")) out.push(abs);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const only = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
  // 只重做"已有图但太小"的（体积小 → 近乎纯色），用于修暗帧而不必全库重跑
  const redoSmall = Number(argv.find((a) => a.startsWith("--redo-small="))?.slice("--redo-small=".length) ?? 0);
  const cliFfmpeg = argv.find((a) => a.startsWith("--ffmpeg="))?.slice("--ffmpeg=".length);

  if (!fs.existsSync(SOURCE) || !fs.existsSync(MANIFEST)) {
    console.error("缺少 source.json / manifest.json，先跑 prompt:extract 和 prompt:build");
    process.exit(1);
  }
  const items = new Map(
    (JSON.parse(fs.readFileSync(SOURCE, "utf8")) as { items: SourceItem[] }).items.map((i) => [i.slug, i]),
  );
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as {
    items: { id: string; slug: string; file: string }[];
  };

  const ffmpeg = findFfmpeg(cliFfmpeg);
  const ffprobe = ffprobeOf(ffmpeg);

  let made = 0;
  let skipped = 0;
  let bytes = 0;
  const missing: { id: string; why: string }[] = [];

  for (const m of manifest.items) {
    if (only && m.id !== only) continue;
    const mdAbs = path.join(LIB_ROOT, m.file);
    if (!fs.existsSync(mdAbs)) {
      missing.push({ id: m.id, why: "md 不存在" });
      continue;
    }
    const out = mdAbs.replace(/\.md$/, ".webp");
    if (fs.existsSync(out) && !force) {
      if (!(redoSmall > 0 && fs.statSync(out).size < redoSmall)) {
        skipped++;
        continue;
      }
    }
    const src = items.get(m.slug);
    const clip = src?.media.video ?? src?.media.preview;
    if (!clip || !fs.existsSync(clip)) {
      missing.push({ id: m.id, why: "预览片没抓到" });
      continue;
    }
    const dur = durationOf(ffprobe, clip);
    // 正片多为 20 秒上下；1 秒以内直接放弃，别把片头黑场当内容
    // 正片多为 20 秒上下；1 秒以内直接放弃，别把片头黑场当内容
    // 抽三帧择优：单点容易抽到片尾字幕或转场黑场（当卡片图像坏图）。
    // 用**文件体积**当"信息量"的代理——黑场/纯色压出来的 webp 只有几 KB，
    // 有主体、有文字层次的帧明显更大。比引视觉模型或算熵便宜得多，且不需要额外依赖。
    // 五点采样：三点在"整条片子偏暗"的素材上经常全军覆没（有一张抽出来只有 1.7KB，
    // 基本是纯黑 + 角落小字）。多取两个点，让"按体积择优"有更大机会摸到有光的帧。
    const cands = [0.1, 0.3, 0.5, 0.7, 0.9].map((r) => Math.min(Math.max(dur * r, 0.3), Math.max(dur - 0.15, 0.3)));
    const tmpDir = path.join(ROOT, ".tmp-stills");
    fs.mkdirSync(tmpDir, { recursive: true });
    let best: { file: string; size: number } | null = null;
    try {
      for (const [i, at] of cands.entries()) {
        const tmp = path.join(tmpDir, `${m.id}-${i}.webp`);
        execFileSync(
          ffmpeg,
          [
            "-y",
            "-hide_banner",
            "-loglevel", "error",
            "-ss", at.toFixed(2),
            "-i", clip,
            "-frames:v", "1",
            "-vf",
            // 长边 720；不拉伸，再补一次偶数对齐（webp 编码器要求）
            "scale='min(720,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:v", "libwebp",
            "-quality", "82",
            "-compression_level", "6",
            tmp,
          ],
          { stdio: "pipe" },
        );
        const size = fs.statSync(tmp).size;
        if (!best || size > best.size) best = { file: tmp, size };
      }
      if (!best) {
        missing.push({ id: m.id, why: "三帧都没抽出来" });
        continue;
      }
      fs.copyFileSync(best.file, out);
      made++;
      bytes += best.size;
    } finally {
      for (const f of fs.readdirSync(tmpDir)) {
        if (f.startsWith(`${m.id}-`)) fs.unlinkSync(path.join(tmpDir, f));
      }
    }
  }

  console.log(
    `缩略图：新出 ${made} 张${skipped ? `，跳过已有 ${skipped} 张` : ""}${made ? `，合计 ${(bytes / 1048576).toFixed(2)} MB` : ""}`,
  );
  if (missing.length) {
    console.log(`⚠ ${missing.length} 条没出图：`);
    for (const x of missing.slice(0, 10)) console.log(`  ${x.id} — ${x.why}`);
    if (missing.length > 10) console.log(`  …还有 ${missing.length - 10} 条`);
  }
}

main();
