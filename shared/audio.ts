/**
 * 音频相关的纯函数：人声区间 / 避让增益 / 节拍网格。
 *
 * 全部无副作用、不依赖浏览器或 Node API —— 渲染端（Chromium）与服务端（Node）
 * 共用同一份实现，才不会出现「预览听着能闪避、成片不闪避」这种最难查的偏差。
 *
 * 一条贯穿本文件的原则：**这些函数都可能被 Remotion 按帧调用（一帧一次）**，
 * 所以不能在里面做 IO、不能分配大数组。
 */
import type { BeatGrid, DuckingConfig, GainCurve, Scene } from "./schema";
import { MAX_VOLUME, sceneSpans } from "./schema";

/* ─────────────────────────── 人声避让（ducking） ─────────────────────────── */

/**
 * 默认值刻意保守：短视频里 BGM 压到 30% 正合适；
 * attack 比 release 短，才跟得上开口的瞬间。
 */
export const DEFAULT_DUCKING: DuckingConfig = {
  enabled: true,
  depth: 0.3,
  attackMs: 120,
  releaseMs: 260,
  padMs: 60,
};

export type VoiceSpan = { start: number; end: number };

/**
 * 从场景列表里算「哪里有人在说话」（秒）。
 *
 * 优先级：场景内音频元素（真有人声文件）> 幕内字幕（有字幕 = 有旁白）。
 * 字幕按行切分并按字数分配幕内时长 —— 这一条和字幕渲染的分配规则一致，
 * 所以句间留出的空隙正好是旁白换气的停顿，BGM 能在那几拍回升，听起来才自然。
 *
 * 只收 `scenes`（不收整个 project）：渲染端手上只有 scenes，签名一致才不会两边各写一份。
 */
export function voiceSpans(scenes: Scene[], fps: number): VoiceSpan[] {
  const spans: VoiceSpan[] = [];
  const spanById = new Map(sceneSpans(scenes).map((s) => [s.id, s]));

  for (const scene of scenes) {
    const span = spanById.get(scene.id);
    if (!span) continue;
    const start = span.start / fps;
    const end = span.end / fps;
    if (end <= start) continue;

    // ① 场景内音频元素：有就直接用它的时间窗（这是真正的声音来源）
    const audioEls = (scene.elements ?? []).filter((e) => e.kind === "audio" && e.src);
    if (audioEls.length) {
      for (const el of audioEls) {
        const s = start + (el.from ?? 0) / fps;
        const len = el.durationInFrames && el.durationInFrames > 0 ? el.durationInFrames / fps : end - s;
        spans.push({ start: s, end: Math.min(end, s + len) });
      }
      continue;
    }

    // ② 幕内字幕：一行一句，按字数比例切幕内时长
    const lines = (scene.subtitle ?? "")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!lines.length) continue;

    const totalChars = lines.reduce((a, l) => a + l.length, 0);
    if (!totalChars) continue;
    const dur = end - start;
    let cursor = start;
    for (const line of lines) {
      const share = (line.length / totalChars) * dur;
      // 句间留一点空隙给 BGM 回升：行长的取 12%，但不超过 200ms
      const gap = Math.min(0.2, share * 0.12);
      spans.push({ start: cursor, end: cursor + share - gap });
      cursor += share;
    }
  }

  return spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
}

/**
 * 某一帧上 BGM 该乘多少（0..1）。multiple 人声区间重叠时取最小（谁要求压得狠听谁的）。
 *
 * @param frame 时间轴帧号
 * @param spans 人声区间（秒）
 * @param cfg   避让配置
 * @param fps   帧率
 */
export function duckGainAt(frame: number, spans: VoiceSpan[], cfg: DuckingConfig, fps: number): number {
  if (!cfg.enabled || !spans.length) return 1;
  const t = frame / fps;
  const pad = cfg.padMs / 1000;
  const attack = cfg.attackMs / 1000;
  const release = cfg.releaseMs / 1000;
  const depth = Math.max(0, Math.min(1, cfg.depth));

  let gain = 1;
  for (const s of spans) {
    const from = s.start - pad;
    const to = s.end + pad;
    if (t < from - attack || t > to + release) continue;

    // 三段：attack 斜坡 → 人声期间压到 depth → release 斜坡升回 1
    let g: number;
    if (t < from) {
      g = 1 + (depth - 1) * Math.min(1, (t - (from - attack)) / Math.max(1e-6, attack));
    } else if (t <= to) {
      g = depth;
    } else {
      g = depth + (1 - depth) * Math.min(1, (t - to) / Math.max(1e-6, release));
    }
    if (g < gain) gain = g;
  }
  return gain;
}

/* ─────────────────────────── 动态增益曲线（压缩） ─────────────────────────── */

/**
 * 某一时刻该乘多少增益（压缩曲线）：按 `stepMs` 采样点线性插值。
 *
 * 曲线端点之外沿用端点值（不做归 1 的淡出）——否则素材比曲线长时尾巴会突然变响。
 * 没有曲线时返回 1，保证旧工程逐像素/逐样本不变。
 */
export function curveGainAt(curve: GainCurve | undefined, tSec: number): number {
  const values = curve?.values;
  if (!curve || !values?.length) return 1;
  const step = Math.max(1, curve.stepMs) / 1000;
  const pos = tSec / step;
  const i = Math.floor(pos);
  if (i < 0) return values[0];
  if (i >= values.length - 1) return values[values.length - 1];
  return values[i] + (values[i + 1] - values[i]) * (pos - i);
}

/* ─────────────────────────── 响度 → 增益（配平 / 压缩） ─────────────────────────── */

/** 峰值上限：-1 dBFS 给编码留余量（AAC 编码后真峰会略微超出） */
export const DEFAULT_PEAK_CEILING_DB = -1;

export type GainDecision = {
  /** 线性增益（1 = 不动） */
  gain: number;
  /** 谁限制了它：目标响度 / 峰值上限 / 最大放大倍数 */
  limitedBy: "target" | "peak" | "max";
  /** 目标响度算出来的原始增益（倍数），便于解释"为什么没到目标" */
  rawGain: number;
};

/**
 * 让一段素材达到目标响度所需的线性增益，并受**峰值上限**与**最大倍率**约束。
 *
 * 为什么必须算峰值：把 -30 LUFS 的素材硬拉到 -16 等于 +14 dB，
 * 如果它峰值本来就在 -2 dBFS，放大 5 倍会把成片直接削爆 —— 宁可小声也不要爆音。
 */
export function gainForTarget(opts: {
  lufs: number;
  peakDb: number;
  targetLufs: number;
  peakCeilingDb?: number;
  maxGain?: number;
}): GainDecision {
  const maxGain = Math.max(1, opts.maxGain ?? MAX_VOLUME);
  // 静音素材（-Infinity）没有"响度"可言，不动它
  if (!Number.isFinite(opts.lufs)) return { gain: 1, rawGain: 1, limitedBy: "target" };

  const ceiling = opts.peakCeilingDb ?? DEFAULT_PEAK_CEILING_DB;
  const wantDb = opts.targetLufs - opts.lufs;
  const rawGain = Math.pow(10, wantDb / 20);
  const peakCapDb = ceiling - opts.peakDb;
  const peakCap = Math.pow(10, peakCapDb / 20);

  let gain = Math.min(rawGain, peakCap);
  let limitedBy: GainDecision["limitedBy"] = rawGain > peakCap ? "peak" : "target";
  if (gain > maxGain) {
    gain = maxGain;
    limitedBy = "max";
  }
  return { gain: Math.max(0, gain), rawGain, limitedBy };
}

export type CompressOptions = {
  /** 目标响度（LUFS） */
  targetLufs: number;
  /** 压缩比，1 = 只做整体增益不做动态压缩，4 = 4:1（默认 3） */
  ratio?: number;
  /** 超过这个响度才往下压；默认等于目标响度 */
  thresholdLufs?: number;
  /** 最多向上补多少 dB（默认 12） */
  maxGainDb?: number;
  /** 最多向下压多少 dB（默认 12） */
  maxCutDb?: number;
  /** 最大放大倍数（默认 MAX_VOLUME） */
  maxGain?: number;
  /** 平滑：向上变化用几个采样点走完（默认 2 = 200ms@100ms 步长） */
  attackSteps?: number;
  /** 平滑：向下变化用几个采样点（默认 4） */
  releaseSteps?: number;
  /**
   * 每个采样点的**样值峰值**（dBFS），与 lufsCurve 一一对应。
   * 有它就能逐点限幅：安静段放大 10dB 没问题，响段放大 1dB 就削波。
   */
  peakDbCurve?: number[];
  /** 允许的输出峰值上限（dBFS，默认 -1，留 1dB 余量） */
  ceilingDbfs?: number;
};

/** 压缩曲线 + 它被夹到哪儿了（夹取必须能回报，否则用户以为工具没生效） */
export type CompressResult = {
  values: number[];
  /** 因峰值上限被压低的采样点数 */
  peakLimited: number;
  /** 因 maxCutDb 被压到底的采样点数（ratio 再大也不会更平） */
  cutLimited: number;
  /** 因 maxGainDb 被抬到顶的采样点数 */
  gainLimited: number;
};

/**
 * 把「短时响度曲线」变成「增益曲线」——这就是压缩器。
 *
 * 思路：每个采样点算出"到目标响度还差多少 dB"，越过阈值的部分按 ratio 折算，
 * 再做一遍非对称平滑（增益上升比下降快，避免呼吸感），最后转线性倍数。
 *
 * 静音段（-Infinity）保持 1：否则会把底噪放大成"嘶——"。
 */
export function buildCompressCurve(lufsCurve: number[], opts: CompressOptions): CompressResult {
  const ratio = Math.max(1, opts.ratio ?? 3);
  const threshold = opts.thresholdLufs ?? opts.targetLufs;
  const maxGainDb = opts.maxGainDb ?? 12;
  const maxCutDb = opts.maxCutDb ?? 12;
  const maxGain = Math.max(1, opts.maxGain ?? MAX_VOLUME);
  const attack = Math.max(1, opts.attackSteps ?? 2);
  const release = Math.max(1, opts.releaseSteps ?? 4);
  const targetLufs = opts.targetLufs ?? threshold ?? -23;
  const ceiling = opts.ceilingDbfs ?? -1;

  /**
   * 两件事要分开（测试清单 F15 的教训：混在一起 ratio 语义就反了）：
   *  1. **整体增益**（make-up）：把全曲平均响度拉到目标——这是"配平"，不受 ratio 影响；
   *  2. **动态压缩**：相对目标的偏差，上方压、下方补，都按 (1 - 1/ratio) 打折——
   *     ratio=1 → 折扣为 0，只剩整体增益（文档说的"只补不压"）；
   *     ratio 越大折扣越接近 1，压得越狠；轻响差被压到约 1/ratio。
   * 旧实现"补"的分支不打折（全额补到目标），ratio=1 时轻段照样被拉满——
   * 名义上"只补不压"，实际把动态全平了，与文档完全相反。
   */
  const finite = lufsCurve.filter(Number.isFinite);
  const avgLufs = finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : targetLufs;
  const makeUpDb = targetLufs - avgLufs;

  const out: number[] = [];
  let prevDb = 0;
  let peakLimited = 0;
  let cutLimited = 0;
  let gainLimited = 0;
  for (let i = 0; i < lufsCurve.length; i++) {
    const lufs = lufsCurve[i];
    let wantDb: number;
    if (!Number.isFinite(lufs)) {
      // 静音：保持上一个增益，不要突然补一大口（否则底噪被放大成嘶声）
      wantDb = prevDb;
    } else {
      const dev = lufs + makeUpDb - threshold;
      wantDb = makeUpDb - dev * (1 - 1 / ratio);
    }
    if (wantDb <= -maxCutDb + 1e-9) cutLimited++;
    if (wantDb >= maxGainDb - 1e-9) gainLimited++;
    wantDb = Math.max(-maxCutDb, Math.min(maxGainDb, wantDb));

    // 非对称平滑：增益变大（更响）走得快，变小走得慢
    const steps = wantDb > prevDb ? attack : release;
    const db = prevDb + (wantDb - prevDb) / steps;
    prevDb = db;
    let g = Math.min(maxGain, Math.max(0, Math.pow(10, db / 20)));
    /**
     * 逐点峰值限幅（复验 N-F）：平滑是**跨点**的，响段开头那一点可能还带着轻段的高增益
     * （实测 dynamics.wav 台阶处冲到 1.243，−0.9dBFS × 1.243 = +1.9dBFS 削波，而且不报警）。
     * 这里按该点自己的峰值卡住，让它最多到 ceiling，并把被夹的采样点数回报给调用方。
     */
    const peakDb = opts.peakDbCurve?.[i];
    if (Number.isFinite(peakDb)) {
      const cap = Math.pow(10, (ceiling - (peakDb as number)) / 20);
      if (g > cap) {
        g = Math.max(0, cap);
        peakLimited++;
      }
    }
    out.push(g);
  }
  return {
    values: out.map((g) => Math.round(g * 1000) / 1000),
    peakLimited,
    cutLimited,
    gainLimited,
  };
}

/** 曲线统计（给 summary 用）：最小/最大/平均增益与"改动幅度" */
export function summarizeCurve(values: number[]): { min: number; max: number; avg: number } {
  if (!values.length) return { min: 1, max: 1, avg: 1 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, avg: sum / values.length };
}

/* ─────────────────────────── 节拍网格（卡点） ─────────────────────────── */

/**
 * 按网格生成拍点时间（秒），只保留落在 [0, durationSec] 内的。
 * 用 BPM 而不是存死每一拍：改 BPM 后整条卡点线自动跟着变，数据也小得多。
 */
export function beatTimes(grid: BeatGrid, durationSec: number): number[] {
  const interval = 60 / grid.bpm;
  // bpm 为 0/负数会得到 Infinity/负间隔：直接返回空，别生成 [0] 这种假拍点
  if (!Number.isFinite(interval) || interval <= 0) return [];
  const out: number[] = [];
  // 从「第一个 >= 0 的拍」开始（offset 可负）
  let k = Math.ceil((0 - grid.offsetSec) / interval);
  for (let i = 0; i < 100000; i++) {
    const t = grid.offsetSec + (k + i) * interval;
    if (t > durationSec + 1e-6) break;
    if (t >= -1e-6) out.push(Math.round(t * 1000) / 1000);
  }
  return out;
}

/** 拍点 → 帧号（去重，因为取整后相邻拍可能落到同一帧） */
export function beatFrames(grid: BeatGrid, durationSec: number, fps: number): number[] {
  const frames = beatTimes(grid, durationSec).map((t) => Math.round(t * fps));
  return [...new Set(frames)];
}

/** 离某一帧最近的拍（卡点用：把转场/特效对齐到它） */
export function nearestBeat(grid: BeatGrid, durationSec: number, fps: number, frame: number): number | null {
  const frames = beatFrames(grid, durationSec, fps);
  if (!frames.length) return null;
  let best = frames[0];
  for (const f of frames) {
    if (Math.abs(f - frame) < Math.abs(best - frame)) best = f;
  }
  return best;
}
