#!/usr/bin/env node
/**
 * 风格库导入 / 压缩 / 建索引，一条命令跑完。
 *
 *   npm run style:import   # 从源库把 341 个 md 复制进 server/skills/style-library/<用途>/
 *   npm run style:webp     # 静帧 jpg → webp（长边 720、q82），**不复制、不删除原图**
 *   npm run style:build    # 重建索引 data/style-library.json
 *   npm run style:all      # 上面三步
 *
 *   npx tsx scripts/style-library.mts all --src="D:/dsh/代码动画/风格提示词" --force
 *
 * 三个刻意的选择：
 *
 * 1. **md 逐字节复制，不改内容**。想加"用途/气质"这类派生信息就写进索引，别改原文——
 *    改过原文，下次重跑就分不清"这行是我加的"还是"作者写的"，增量判断（比 sha）也会失效。
 * 2. **原图不动**。用户的库是只读的母本，压完只往仓库里放 webp。删原图是不可逆操作，
 *    而收益只有几十 MB，不值得。
 * 3. **ffmpeg 必须自己找**。Remotion 自带的 `compositor-…/ffmpeg.exe` **没有 libwebp**
 *    （实测只有 mjpeg），用它转 webp 会静默失败或报 Unknown encoder。所以这里单独探测
 *    一个带 `--enable-libwebp` 的完整版，找不到就明确报错并指路，不偷偷降级成 jpg。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT as PROJECT_ROOT } from "../server/root";
import { LIB_REL, buildIndex } from "../server/styleLibrary.service";
import { STYLE_USES, type StyleUse } from "../shared/style-library";

const LIB_ROOT = path.join(PROJECT_ROOT, LIB_REL);

/** 源库的系列目录 → 我们这边的用途文件夹。**只用于导入**，索引以文件夹为准 */
const SERIES_TO_USE: Record<string, StyleUse> = {
  "M_动态风格": "structure",
  "A-G_代码样片": "technique",
  "O_奥斯卡98部": "texture",
  "R_照参考学来的": "texture",
  "K_卡通画风": "character",
  "Z_中国风": "character",
  "H_现成版式": "layout",
  "V_mg-styles-15": "layout",
  "L_Lemo-Opuscar": "kit",
  "X_code-video": "kit",
};

/** 源库默认位置：用户本机的 341 库。换机器用 --src 或环境变量覆盖 */
const DEFAULT_SRC =
  process.env.STYLE_LIB_SRC?.trim() || "D:/dsh/代码动画/风格提示词";

/** 已知的完整版 ffmpeg（带 libwebp）。找不到时会继续找 PATH，最后才报错 */
const KNOWN_FFMPEG = [
  process.env.RMS_FFMPEG?.trim(),
  "G:/共享/自动化/FFmpeg/bin/ffmpeg.exe",
].filter(Boolean) as string[];

const WEBP_MAX_EDGE = 720;
const WEBP_QUALITY = 82;

type Args = { cmd: string; src: string; force: boolean; only?: string; ffmpeg?: string };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith("-")) ?? "all";
  const pick = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3).replace(/^"|"$/g, "") : undefined;
  };
  return {
    cmd,
    src: pick("src") ?? DEFAULT_SRC,
    force: argv.includes("--force"),
    only: pick("only"),
    ffmpeg: pick("ffmpeg"),
  };
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

/** 找一个能编 webp 的 ffmpeg：先验编码器，再认路径 */
function findFfmpeg(cli?: string): string {
  const candidates: string[] = [...(cli ? [cli] : []), ...KNOWN_FFMPEG];
  // PATH 里的 ffmpeg（Windows 上带 .exe 后缀才找得到）
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    if (fs.existsSync(p)) candidates.push(p);
  }
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const enc = execFileSync(p, ["-hide_banner", "-encoders"], { encoding: "utf8" });
      if (/\blibwebp\b/.test(enc)) return p;
    } catch {
      /* 这个候选跑不起来，换下一个 */
    }
  }
  fail(
    [
      "找不到能编 webp 的 ffmpeg。",
      "",
      "Remotion 自带的那个不行：它只有 mjpeg 编码器（实测 `-encoders` 里没有 libwebp）。",
      "",
      "装一个完整版，然后任选一种方式告诉脚本：",
      "  1) npm run style:webp -- --ffmpeg=\"D:/ffmpeg/bin/ffmpeg.exe\"",
      "  2) 设环境变量 RMS_FFMPEG=D:\\ffmpeg\\bin\\ffmpeg.exe",
      "  3) 把 ffmpeg 加进 PATH",
      "",
      `试过这些位置：${candidates.length ? candidates.join("、") : "（无）"}`,
    ].join("\n"),
  );
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** 源库里每个系列目录下的 .md（不递归） */
function sourceEntries(src: string): { series: string; file: string; base: string }[] {
  const out: { series: string; file: string; base: string }[] = [];
  for (const series of fs.readdirSync(src)) {
    const dir = path.join(src, series);
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith(".md")) continue;
      out.push({ series, file: path.join(dir, f), base: f.replace(/\.md$/i, "") });
    }
  }
  return out;
}

/** 第一步：md 按用途归档 */
function doImport(args: Args): void {
  if (!fs.existsSync(args.src)) {
    fail(`源库不存在：${args.src}\n用 --src="<你的 341 库路径>" 指定，或设环境变量 STYLE_LIB_SRC。`);
  }
  const entries = sourceEntries(args.src);
  if (!entries.length) fail(`源库里没有找到任何 .md：${args.src}`);

  let copied = 0;
  let skipped = 0;
  const unknown = new Set<string>();

  for (const e of entries) {
    const use = SERIES_TO_USE[e.series];
    if (!use) {
      unknown.add(e.series);
      continue;
    }
    const useDir = STYLE_USES.find((u) => u.id === use)!.dir;
    const targetDir = path.join(LIB_ROOT, useDir);
    ensureDir(targetDir);
    const target = path.join(targetDir, `${e.base}.md`);
    const body = fs.readFileSync(e.file);
    if (!args.force && fs.existsSync(target)) {
      // 内容一致就跳过：重跑不该产生一堆无意义的 mtime 变化
      const old = fs.readFileSync(target);
      if (old.equals(body)) {
        skipped++;
        continue;
      }
    }
    fs.writeFileSync(target, body);
    copied++;
  }

  console.log(`导入完成：复制 ${copied} 个、跳过 ${skipped} 个（内容未变），目标 ${path.relative(PROJECT_ROOT, LIB_ROOT)}`);
  if (unknown.size) {
    console.log(`\n⚠ 这些系列目录没有映射，已跳过：${[...unknown].join("、")}`);
    console.log("  新系列要先进 scripts/style-library.mts 的 SERIES_TO_USE，再决定落在哪个用途文件夹。");
  }
}

/**
 * 第二步：静帧转 webp。
 *
 * 从**源库**读 jpg、往**仓库**写 webp —— 不是原地转换。这样原图保留、可回滚，
 * 而且用户的库随时可以再加图，重跑只处理缺的那些。
 */
function doWebp(args: Args): void {
  if (!fs.existsSync(args.src)) fail(`源库不存在：${args.src}`);
  const ffmpeg = findFfmpeg(args.ffmpeg);
  const entries = sourceEntries(args.src);

  let made = 0;
  let skipped = 0;
  let failed = 0;

  for (const e of entries) {
    if (args.only && !e.base.startsWith(args.only)) continue;
    const use = SERIES_TO_USE[e.series];
    if (!use) continue;
    const jpg = path.join(path.dirname(e.file), `${e.base}.jpg`);
    if (!fs.existsSync(jpg)) continue; // 这一条本来就没静帧

    const useDir = STYLE_USES.find((u) => u.id === use)!.dir;
    const targetDir = path.join(LIB_ROOT, useDir);
    ensureDir(targetDir);
    const out = path.join(targetDir, `${e.base}.webp`);

    if (!args.force && fs.existsSync(out)) {
      const a = fs.statSync(jpg).mtimeMs;
      const b = fs.statSync(out).mtimeMs;
      if (b >= a) {
        skipped++;
        continue;
      }
    }
    try {
      execFileSync(
        ffmpeg,
        [
          "-y",
          "-v",
          "error",
          "-i",
          jpg,
          "-vf",
          `scale='min(${WEBP_MAX_EDGE},iw)':-2:flags=lanczos`,
          "-c:v",
          "libwebp",
          "-lossless",
          "0",
          "-q:v",
          String(WEBP_QUALITY),
          "-compression_level",
          "6",
          out,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      made++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error && "stderr" in err ? String((err as any).stderr).trim() : String(err);
      console.warn(`  ✗ ${e.base}：${msg.split("\n")[0]}`);
    }
  }

  const totalBytes = fs
    .readdirSync(LIB_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const dir = path.join(LIB_ROOT, d.name);
      return fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(".webp"))
        .map((f) => {
          try {
            return fs.statSync(path.join(dir, f)).size;
          } catch {
            return 0;
          }
        });
    })
    .reduce((a, b) => a + b, 0);

  console.log(
    `webp 完成：新压 ${made}、跳过 ${skipped}、失败 ${failed}；库内 webp 共 ${(totalBytes / 1048576).toFixed(1)} MB`,
  );
}

/** 第三步：建索引 */
function doBuild(): void {
  const idx = buildIndex(true);
  console.log(
    `索引完成：${idx.total} 条，有静帧 ${idx.withStill} 条（${Math.round((idx.withStill / Math.max(idx.total, 1)) * 100)}%）→ data/style-library.json`,
  );
  if (!idx.total) {
    console.log("  库是空的：先跑 npm run style:import。");
  }
}

const args = parseArgs();
switch (args.cmd) {
  case "import":
    doImport(args);
    break;
  case "webp":
    doWebp(args);
    break;
  case "build":
    doBuild();
    break;
  case "all":
    doImport(args);
    doWebp(args);
    doBuild();
    break;
  default:
    fail(`不认识的命令：${args.cmd}\n可用：import / webp / build / all`);
}

export type { StyleUse };
