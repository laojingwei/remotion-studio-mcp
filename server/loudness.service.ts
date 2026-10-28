/**
 * 响度测量（配平与压缩的依据）。
 *
 * 用 ITU-R BS.1770 / EBU R128 的口径算 **LUFS**，不是简单 RMS：
 *  - K 加权（高架 +4dB @1500Hz + 38Hz 高通）：模拟人耳对中高频更敏感
 *  - 400ms 块 / 100ms 步进（75% 重叠），再做绝对门限(-70) + 相对门限(-10) 两级门控
 * 这样"响度"才和观众的感受对得上；直接拿 RMS 当依据会让低频多的曲子被压得过狠。
 *
 * 为什么自己写而不是加 LUFS 库：只有几十行（两个 biquad + 分块），
 * 少一个依赖、也不用担心它的算法口径与我们的解码链路不一致。
 *
 * 缓存按「文件 size + mtime」为指纹：换文件自动失效，同一个文件反复调不重复解码。
 */
import fs from "node:fs";
import path from "node:path";

import { ROOT } from "./root";
import { decodeAudioFile } from "./audio-analysis.service";
import { resolvePublicFile } from "./media.service";

export type LoudnessInfo = {
  src: string;
  durationSec: number;
  /** 积分响度（LUFS，整段）；静音素材会是 -Infinity，调用方要处理 */
  lufs: number;
  /** 采样峰值（dBFS，0 = 满刻度）；>0 说明已削波 */
  peakDb: number;
  /** RMS（dBFS），只作参考 */
  rmsDb: number;
  /** 按 stepMs 采样的短时响度曲线（LUFS），压缩的输入 */
  curve: number[];
  /**
   * 与 curve 逐点对齐的**窗口峰值**（dBFS）：压缩时用它逐点限幅，
   * 否则「安静段补 10dB」和「响段补 10dB」会被一视同仁地算进去，成片就削波。
   */
  peakCurve: number[];
  stepMs: number;
  cached: boolean;
};

const CACHE_FILE = path.join(ROOT, "data", "audio-loudness.json");
/** 曲线分辨率：200ms 足够跟上人耳的音量变化，3 分钟也只有 900 个数 */
const CURVE_STEP_MS = 200;
/** 短时响度窗口：与 LUFS 的分块口径一致（400ms），再短就受瞬态影响 */
const CURVE_WINDOW_MS = 400;

export const dbToLinear = (db: number): number => Math.pow(10, db / 20);
export const linearToDb = (x: number): number => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/* ─────────────────────────── K 加权 ─────────────────────────── */

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

/** RBJ cookbook：highShelf / highPass（系数已按 a0 归一） */
function biquadCoeffs(
  type: "highShelf" | "highPass",
  fc: number,
  q: number,
  fs: number,
  gainDb = 0,
): Biquad {
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * q);

  if (type === "highPass") {
    const a0 = 1 + alpha;
    return {
      b0: (1 + cosw) / 2 / a0,
      b1: -(1 + cosw) / a0,
      b2: (1 + cosw) / 2 / a0,
      a1: (-2 * cosw) / a0,
      a2: (1 - alpha) / a0,
    };
  }

  const A = Math.pow(10, gainDb / 40);
  const beta = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 - (A - 1) * cosw + beta;
  return {
    b0: (A * (A + 1 + (A - 1) * cosw + beta)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * cosw)) / a0,
    b2: (A * (A + 1 + (A - 1) * cosw - beta)) / a0,
    a1: (2 * (A - 1 - (A + 1) * cosw)) / a0,
    a2: (A + 1 - (A - 1) * cosw - beta) / a0,
  };
}

function applyBiquad(input: Float32Array, c: Biquad): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/** BS.1770 K 加权（两级：高架 + 高通）。系数按实际采样率推导，44.1k/48k 都准 */
export function kWeight(pcm: Float32Array, sampleRate: number): Float32Array {
  const shelf = biquadCoeffs("highShelf", 1500, 1 / Math.SQRT2, sampleRate, 4);
  const hp = biquadCoeffs("highPass", 38, 0.5, sampleRate);
  return applyBiquad(applyBiquad(pcm, shelf), hp);
}

/* ─────────────────────────── 分块响度 ─────────────────────────── */

const blockLufs = (meanSquare: number): number =>
  meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity;

/** 积分响度（整段）：400ms 块 + 两级门控 */
export function integratedLufs(weighted: Float32Array, sampleRate: number): number {
  const block = Math.max(1, Math.round(0.4 * sampleRate));
  const hop = Math.max(1, Math.round(0.1 * sampleRate));
  const squares: number[] = [];

  for (let start = 0; start + block <= weighted.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + block; i++) sum += weighted[i] * weighted[i];
    squares.push(sum / block);
  }
  // 比一个块还短：整段当一个块，别返回 -Infinity
  if (!squares.length) {
    if (!weighted.length) return -Infinity;
    let sum = 0;
    for (let i = 0; i < weighted.length; i++) sum += weighted[i] * weighted[i];
    return blockLufs(sum / weighted.length);
  }

  const above70 = squares.filter((ms) => blockLufs(ms) > -70);
  if (!above70.length) return -Infinity;
  const mean70 = above70.reduce((a, b) => a + b, 0) / above70.length;
  const relative = blockLufs(mean70) - 10;
  const aboveRel = above70.filter((ms) => blockLufs(ms) > relative);
  const use = aboveRel.length ? aboveRel : above70;
  return blockLufs(use.reduce((a, b) => a + b, 0) / use.length);
}

/** 短时响度曲线：每 stepMs 一个值（取以该点为中心的 windowMs 窗口） */
export function shortTermLufs(
  weighted: Float32Array,
  sampleRate: number,
  stepMs = CURVE_STEP_MS,
  windowMs = CURVE_WINDOW_MS,
): number[] {
  const step = Math.max(1, Math.round((stepMs / 1000) * sampleRate));
  const win = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const out: number[] = [];
  for (let center = 0; center < weighted.length; center += step) {
    const start = Math.max(0, center - Math.floor(win / 2));
    const end = Math.min(weighted.length, start + win);
    let sum = 0;
    for (let i = start; i < end; i++) sum += weighted[i] * weighted[i];
    out.push(blockLufs(sum / Math.max(1, end - start)));
  }
  return out;
}

/* ─────────────────────────── 对外：带缓存 ─────────────────────────── */

/** 短时峰值曲线：与 shortTermLufs 同一个窗口，取窗口内的最大样值（dBFS） */
export function shortTermPeakDb(
  pcm: Float32Array,
  sampleRate: number,
  stepMs = CURVE_STEP_MS,
  windowMs = CURVE_WINDOW_MS,
): number[] {
  const step = Math.max(1, Math.round((stepMs / 1000) * sampleRate));
  const win = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const out: number[] = [];
  for (let center = 0; center < pcm.length; center += step) {
    const start = Math.max(0, center - Math.floor(win / 2));
    const end = Math.min(pcm.length, start + win);
    let max = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(pcm[i]);
      if (v > max) max = v;
    }
    out.push(linearToDb(max));
  }
  return out;
}

type CacheEntry = { key: string; at: number; data: LoudnessInfo };

function readCache(): Record<string, CacheEntry> {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

function writeCache(all: Record<string, CacheEntry>): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const entries = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, 60);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(entries)), "utf8");
  } catch {
    /* 缓存写失败不影响分析 */
  }
}

export async function measureLoudness(src: string, opts: { force?: boolean } = {}): Promise<LoudnessInfo> {
  const file = src;
  const abs = resolvePublicFile(file);
  const st = fs.statSync(abs);
  // v2：多了 peakCurve，旧缓存没有这个字段 → 换版本号让它自动失效
  const key = `${file}|${st.size}|${Math.round(st.mtimeMs)}|v2`;

  const cache = readCache();
  const hit = cache[key];
  if (hit && !opts.force && Array.isArray(hit.data.peakCurve)) return { ...hit.data, cached: true };

  const { pcm, sampleRate, peak } = await decodeAudioFile(file);
  const weighted = kWeight(pcm, sampleRate);

  let sumSq = 0;
  for (let i = 0; i < pcm.length; i++) sumSq += pcm[i] * pcm[i];

  /**
   * 窗口峰值是在**下混后**的 pcm 上取的（解码器只给单声道），左右相消会让峰值偏小；
   * 用解码时算的真实峰值（各声道单独取过）把整条曲线抬到同一基准，宁可高估不可低估。
   */
  const rawPeaks = shortTermPeakDb(pcm, sampleRate);
  const truePeakDb = linearToDb(peak);
  const maxRaw = rawPeaks.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), -Infinity);
  const lift = Number.isFinite(truePeakDb) && Number.isFinite(maxRaw) ? Math.max(0, truePeakDb - maxRaw) : 0;

  const info: LoudnessInfo = {
    src: file,
    durationSec: Math.round((pcm.length / sampleRate) * 1000) / 1000,
    lufs: round1(integratedLufs(weighted, sampleRate)),
    peakDb: round1(truePeakDb),
    rmsDb: round1(linearToDb(Math.sqrt(sumSq / Math.max(1, pcm.length)))),
    curve: shortTermLufs(weighted, sampleRate).map((x) => round1(x)),
    peakCurve: rawPeaks.map((x) => (Number.isFinite(x) ? round1(x + lift) : x)),
    stepMs: CURVE_STEP_MS,
    cached: false,
  };

  cache[key] = { key, at: Date.now(), data: info };
  writeCache(cache);
  return info;
}

const round1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x);

/** 常用目标响度（LUFS）：短视频平台普遍按 -14 ~ -16 归一化 */
export const LOUDNESS_TARGETS = {
  /** 人声口播：主角，按平台标准 */
  voice: -16,
  /** BGM：垫在下面，比人声低 6~8 dB 才不会抢 */
  bgm: -23,
  /** 音效：点缀，可以更响一点但不该盖住人声 */
  sfx: -18,
} as const;
