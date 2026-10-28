/**
 * 音频分析：BPM / 拍点（卡点用）。
 *
 * 为什么放服务端而不是渲染时算：拍点是**工程数据**（agent 要据此对齐转场/特效），
 * 渲染一次不代表能拿到帧号；而且每次渲染都重新解码一首歌太贵。
 *
 * 解码策略（项目铁律：不 spawn ffmpeg 之类的外部程序）：
 *  - wav：自己解析 RIFF（PCM 8/16/24/32 + IEEE float），转 Float32 单声道
 *  - mp3：mpg123-decoder（WASM，MIT，~190KB）
 *  - 其它格式：明确报错让用户转 mp3/wav，不猜
 *
 * 节拍检测：essentia.js 的 RhythmExtractor2013（多频段 onset + 梳状滤波）。
 * 信号先统一重采样到 22050 再喂（essentia WASM 按固定采样率处理，见下方常量注释）。
 * 置信度是**自己算的**（estimates 离散度）：essentia 的 confidence 输出基本恒 0 不可用。
 * 经验标度：有鼓素材 4–5，节拍器 ≈5，无鼓/纯氛围 <1.5 —— **2.5 以下明确告诉 agent 不可信**。
 */
import fs from "node:fs";
import path from "node:path";

import { ROOT } from "./root";
import { resolvePublicFile } from "./media.service";

export type BeatAnalysis = {
  src: string;
  /** 音频总时长（秒） */
  durationSec: number;
  /** 实际参与分析的长度（秒）——长音频只取前 N 秒，BPM 全曲一致 */
  analyzedSec: number;
  bpm: number;
  /** 自算置信度（0–5）：estimates 离散度为主、拍点规律性兜底。>2.5 可信，<2.5 建议让用户给 BPM */
  confidence: number;
  /** 拍点（秒） */
  beats: number[];
  /** 拍点（帧，按传入 fps 换算） */
  beatsFrames: number[];
  engine: "essentia";
  /** 命中缓存时不重复解码 */
  cached: boolean;
};

const CACHE_FILE = path.join(ROOT, "data", "audio-analysis.json");
/** 长音频只分析前 90 秒：3 分钟整曲要 11 秒，90 秒约 5 秒，且 BPM 极少中途变化 */
const DEFAULT_MAX_SECONDS = 90;
/**
 * essentia 的 WASM 版把信号按**固定采样率**处理，且 RhythmExtractor2013 没有采样率参数可传
 * （实测该值是 22050：24000Hz 的 90 BPM 鼓组被读成 82.7，120 BPM 节拍器读成 110.4，
 * 恰好都是 ×22050/24000；22050 的素材则分毫不差——测试清单 E3 实锤）。
 * 所以喂给 essentia 之前**统一线性重采样到 22050**，拍点时间轴才和真实时间一致。
 */
const ESSENTIA_SAMPLE_RATE = 22050;

/** 线性插值重采样。BPM 检测只要节奏包络，对精度要求不高，线性足够 */
function resampleLinear(pcm: Float32Array, from: number, to: number): Float32Array {
  if (from === to || !Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) {
    return pcm;
  }
  const ratio = from / to;
  const n = Math.max(1, Math.floor(pcm.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const f = pos - i0;
    out[i] = pcm[i0] * (1 - f) + pcm[i1] * f;
  }
  return out;
}

/**
 * 置信度：essentia 的 `confidence` 输出对 multifeature 方法基本恒 0（文档明说 degara 恒 0，
 * 实测 multifeature 也一样——连完美节拍器都返回 0），**不能用**。
 * 这里自己算：用 `estimates`（分段 BPM 估计）的离散度打分——
 * 有鼓/有节拍的音乐各窗口估计高度一致（CV 小 → 高分），无鼓素材估计乱跳（CV 大 → 低分）。
 * 标度 0–5：CV=0 → 5 分；0.1 → 2.5（正好在门限上）；0.2 → 1 分。
 */
function dispersionScore(xs: number[]): number {
  if (xs.length < 4) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (!(mean > 0)) return 0;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  const cv = Math.sqrt(variance) / mean;
  return 5 / (1 + 100 * cv * cv);
}

/** 兜底：estimates 不够时退回拍点间隔的规律性（ticks 等距 → 高分） */
function tickRegularityScore(beats: number[]): number {
  if (beats.length < 5) return 0;
  const ioi: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    const d = beats[i] - beats[i - 1];
    if (d > 0.05) ioi.push(d); // 滤掉贴脸的假拍（<50ms 不可能是人耳节拍）
  }
  return dispersionScore(ioi);
}

/**
 * 信号包络在「检测出的拍周期」上的自相关显著性（0–1）。
 * 这是防止"假拍点骗过高分"的关键一票：白噪声 / 稳态氛围音的 RMS 包络没有周期性，
 * 但 essentia 仍会输出一串均匀 ticks 和一致的 estimates —— 光看那两个会被骗成满分。
 * 节拍器 ≈1；真实鼓组 0.5–0.9；稳态噪声 ≈0。
 */
function envelopePeriodicity(signal: Float32Array, sampleRate: number, bpm: number): number {
  const hop = Math.max(1, Math.round(sampleRate * 0.02));
  const win = Math.max(hop, Math.round(sampleRate * 0.04));
  const env: number[] = [];
  for (let i = 0; i + win <= signal.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += signal[j] * signal[j];
    env.push(Math.sqrt(s / win));
  }
  if (env.length < 16) return 0;
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  if (!(mean > 1e-6)) return 0;
  let c0 = 0;
  for (const v of env) c0 += (v - mean) ** 2;
  if (c0 <= 0) return 0; // 包络恒定 = 根本没有节拍
  const lag = Math.max(1, Math.min(env.length - 1, Math.round((60 / bpm) * (sampleRate / hop))));
  let s = 0;
  let n = 0;
  for (let i = 0; i + lag < env.length; i++) {
    s += (env[i] - mean) * (env[i + lag] - mean);
    n++;
  }
  const r = s / n / (c0 / env.length);
  return Math.max(0, Math.min(1, r));
}

/**
 * 拍点对齐度：给定一组网格点，看每个点上是否有 onset（±60ms 内的包络峰）。
 * 正确层级的网格点能量**一致地高**；锁错层级的网格一半点落在空拍上（忽高忽低）。
 * 真实鼓组的 2 倍周期自相关天然更高（小节重音），单靠自相关会把正确答案拉到半速
 * （翻车实录：89.1 被拉到 44.6），所以对齐度与自相关要**取 max 互为补充**。
 */
function gridAlignmentScore(signal: Float32Array, sampleRate: number, points: number[]): number {
  if (points.length < 4) return 0;
  // RMS 包络，20ms 一帧
  const hop = Math.max(1, Math.round(sampleRate * 0.02));
  const win = Math.max(hop, Math.round(sampleRate * 0.04));
  const env: number[] = [];
  for (let i = 0; i + win <= signal.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += signal[j] * signal[j];
    env.push(Math.sqrt(s / win));
  }
  if (!env.length) return 0;
  // 每个网格点取 ±60ms 内的包络峰值（onset 可能有几毫秒的检测偏移）
  const envAt = (t: number) => {
    const idx = Math.round((t * sampleRate) / hop);
    let m = 0;
    for (let k = Math.max(0, idx - 3); k <= Math.min(env.length - 1, idx + 3); k++) {
      m = Math.max(m, env[k]);
    }
    return m;
  };
  const energies = points.map(envAt);
  const ref = Math.max(...energies);
  if (!(ref > 1e-6)) return 0;
  return Math.min(1, (energies.reduce((a, b) => a + b, 0) / energies.length) / ref);
}

/**
 * 从检测 ticks 推导候选层级的网格点。**锚定真实 ticks，不做等距假设**：
 * swing 素材的拍间隔交替（实测 0.337/0.325 交替），等距网格会逐渐漂进静音区，
 * 把正确的慢层误判成"全空拍"（翻车实录：90 BPM 鼓组的 89 层被判 0 分）。
 * 做法：在每对相邻 tick 之间按候选周期铺点，点始终锚定 tick 位置。
 */
function gridFromTicks(ticks: number[], bpm: number, candidate: number, durationSec: number): number[] {
  const period = 60 / candidate;
  const pts: number[] = [];
  for (let i = 0; i < ticks.length - 1; i++) {
    for (let t = ticks[i]; t < ticks[i + 1] - 1e-9; t += period) pts.push(t);
  }
  for (let t = ticks[ticks.length - 1]; t <= durationSec + 1e-9; t += period) pts.push(t);
  void bpm;
  return pts;
}

function refineMetricalLevel(
  signal: Float32Array,
  sampleRate: number,
  ticks: number[],
  bpm: number,
  minTempo = 40,
  maxTempo = 208,
): number {
  if (ticks.length < 3) return bpm;
  const durationSec = signal.length / sampleRate;
  const base = Math.max(
    gridAlignmentScore(signal, sampleRate, gridFromTicks(ticks, bpm, bpm, durationSec)),
    envelopePeriodicity(signal, sampleRate, bpm),
  );
  const scored: { bpm: number; score: number }[] = [{ bpm, score: base }];
  const candidates = [bpm * 2, bpm / 2, bpm * 3, bpm / 3, (bpm * 3) / 2, (bpm * 2) / 3];
  for (const c of candidates) {
    if (c < minTempo || c > maxTempo) continue;
    scored.push({
      bpm: c,
      score: Math.max(
        gridAlignmentScore(signal, sampleRate, gridFromTicks(ticks, bpm, c, durationSec)),
        envelopePeriodicity(signal, sampleRate, c),
      ),
    });
  }
  if (process.env.BEAT_DEBUG) {
    console.error(
      `[beat-debug] 检测 ${bpm.toFixed(1)} 候选 ${scored.map((s) => `${s.bpm.toFixed(1)}=${s.score.toFixed(3)}`).join(" ")}`,
    );
  }
  /**
   * 只翻**明显更好**的案（+0.15 滞后带）：对齐分只是辅助判据，
   * essentia 锁错的层级我们也未必看得清（真实鼓组的倍频层经常"看起来也对"），
   * 轻微优势就翻案会把正确答案改坏（第一版翻车：89.1 被拉到 44.6）。
   * 翻案后若多个候选并列（相差 ≤0.05，hi-hat 打满半拍时倍频层分数几乎一样高），
   * 选最接近 110 BPM 的——70–160 是人耳感知"主拍"的范围。
   */
  const top = Math.max(...scored.map((s) => s.score));
  if (top < base + 0.15) return bpm;
  const finalists = scored.filter((s) => s.score >= top - 0.05);
  finalists.sort((a, b) => Math.abs(a.bpm - 110) - Math.abs(b.bpm - 110));
  return Math.round(finalists[0].bpm * 10) / 10;
}

/* ─────────────────────────── 解码 ─────────────────────────── */

/** 解析 wav 成单声道 Float32（-1..1）。返回 null = 不是可解析的 PCM wav */
export function decodeWavToPcm(buf: Buffer): { pcm: Float32Array; sampleRate: number; peak: number } | null {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let offset = 12;
  let format = 1;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = -1;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE：真实格式藏在子格式 GUID 的前两字节
      if (format === 0xfffe && body + 26 <= buf.length) format = buf.readUInt16LE(body + 24);
    } else if (id === "data") {
      dataStart = body;
      dataSize = size > 0 && body + size <= buf.length ? size : buf.length - body;
      break;
    }
    offset = body + size + (size % 2);
  }

  if (dataStart < 0 || !channels || !sampleRate || !bits) return null;
  const bytesPer = bits / 8;
  const frames = Math.floor(dataSize / (bytesPer * channels));
  if (frames <= 0) return null;

  const pcm = new Float32Array(frames);
  const isFloat = format === 3;
  /**
   * 真峰必须在**下混之前**取：单声道下混会让左右相消，峰值被低估，
   * 于是"放大 2 倍也不报警"，成片却已经削波了。
   */
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = dataStart + (i * channels + c) * bytesPer;
      let v = 0;
      if (isFloat && bits === 32) v = buf.readFloatLE(at);
      else if (bits === 8) v = (buf.readUInt8(at) - 128) / 128;
      else if (bits === 16) v = buf.readInt16LE(at) / 32768;
      else if (bits === 24) {
        const b0 = buf.readUInt8(at);
        const b1 = buf.readUInt8(at + 1);
        const b2 = buf.readUInt8(at + 2);
        let n = b0 | (b1 << 8) | (b2 << 16);
        if (n & 0x800000) n |= ~0xffffff; // 符号扩展
        v = n / 8388608;
      } else if (bits === 32) v = buf.readInt32LE(at) / 2147483648;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v;
    }
    pcm[i] = sum / channels;
  }
  return { pcm, sampleRate, peak };
}

let mp3Decoder: any = null;

/** mp3 → 单声道 Float32。解码器实例复用（WASM 编译一次就够） */
export async function decodeMp3ToPcm(
  buf: Buffer,
): Promise<{ pcm: Float32Array; sampleRate: number; peak: number }> {
  if (!mp3Decoder) {
    const mod: any = await import("mpg123-decoder");
    const Decoder = mod.MPEGDecoder ?? mod.default?.MPEGDecoder;
    mp3Decoder = new Decoder();
    await mp3Decoder.ready;
  }
  const r = mp3Decoder.decode(new Uint8Array(buf));
  const channels: Float32Array[] = r.channelData ?? [];
  if (!channels.length || !r.samplesDecoded) {
    throw new Error("mp3 解码失败（文件可能不是有效音频）");
  }
  const n = r.samplesDecoded;
  const pcm = new Float32Array(n);
  let peak = 0;
  if (channels.length === 1) {
    pcm.set(channels[0].subarray(0, n));
    for (let i = 0; i < n; i++) {
      const a = Math.abs(pcm[i]);
      if (a > peak) peak = a;
    }
  } else {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const ch of channels) {
        const v = ch[i] ?? 0;
        const a = Math.abs(v);
        if (a > peak) peak = a;
        s += v;
      }
      pcm[i] = s / channels.length;
    }
  }
  // 解码是有状态的，复位后才能解下一个文件
  await mp3Decoder.reset();
  return { pcm, sampleRate: r.sampleRate || 44100, peak };
}

/** 按扩展名解码。不认识的格式直接报错（不猜、不 spawn 外部工具） */
export async function decodeAudioFile(
  src: string,
): Promise<{ pcm: Float32Array; sampleRate: number; peak: number }> {
  // 存在性/路径校验在 resolvePublicFile 里（缺失会抛「素材不存在：/assets/xxx」）
  const file = resolvePublicFile(src);
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();

  if (ext === ".wav") {
    const wav = decodeWavToPcm(buf);
    if (!wav) throw new Error("这个 wav 不是可解析的 PCM 格式（可能被压缩过），请换标准 wav");
    return wav;
  }
  if (ext === ".mp3") return await decodeMp3ToPcm(buf);
  throw new Error(
    `不支持的音频格式 ${ext || "(无扩展名)"}：目前只解析 wav / mp3。` +
      `其它格式（m4a/aac/ogg）请在外部转成 mp3 再上传`,
  );
}

/* ─────────────────────────── 节拍检测 ─────────────────────────── */

let essInstance: any = null;

/** essentia 实例懒加载：WASM 编译约 70ms，但不该拖慢服务启动 */
async function getEssentia(): Promise<any> {
  if (essInstance) return essInstance;
  const mod: any = await import("essentia.js");
  const Essentia = mod.Essentia ?? mod.default?.Essentia;
  const EssentiaWASM = mod.EssentiaWASM ?? mod.default?.EssentiaWASM;
  essInstance = new Essentia(EssentiaWASM);
  return essInstance;
}

type CacheEntry = { key: string; at: number; data: BeatAnalysis };

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
    // 只留最近 100 条，别让缓存文件无限长
    const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 100);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(entries), null, 2), "utf8");
  } catch {
    /* 缓存写失败不影响分析 */
  }
}

export async function analyzeBeats(
  src: string,
  opts: { maxSeconds?: number; fps?: number; force?: boolean } = {},
): Promise<BeatAnalysis> {
  const fps = opts.fps ?? 30;
  const maxSeconds = Math.max(10, Math.min(600, opts.maxSeconds ?? DEFAULT_MAX_SECONDS));
  // resolvePublicFile 已经做了存在性/路径穿越校验，抛的是「素材不存在：/assets/xxx」
  const file = resolvePublicFile(src);
  const st = fs.statSync(file);
  // 缓存 key 含文件指纹与参数：换文件/换 fps 都会重算；算法版本变更也要重算（v2 = 采样率修复 + 自算置信度）
  const key = `v2|${src}|${st.size}|${Math.round(st.mtimeMs)}|${maxSeconds}`;

  const cache = readCache();
  const hit = cache[key];
  if (hit && !opts.force) {
    const beatsFrames = hit.data.beats.map((s) => Math.round(s * fps));
    return { ...hit.data, beatsFrames, cached: true };
  }

  const { pcm, sampleRate } = await decodeAudioFile(src);
  const durationSec = pcm.length / sampleRate;
  const takeFrames = Math.min(pcm.length, Math.round(maxSeconds * sampleRate));
  const slice = pcm.subarray(0, takeFrames);

  const ess = await getEssentia();
  // 关键：先统一重采样（见 ESSENTIA_SAMPLE_RATE 注释），否则非 22050 的文件 BPM 全错
  const signal = resampleLinear(slice, sampleRate, ESSENTIA_SAMPLE_RATE);
  const vec = ess.arrayToVector(signal);
  let raw: any;
  try {
    raw = ess.RhythmExtractor2013(vec, 208, "multifeature", 40);
  } finally {
    vec.delete?.();
  }

  const bpm = Number(raw?.bpm ?? 0);
  if (!Number.isFinite(bpm) || bpm <= 0) throw new Error("节拍检测失败（这段音频没有可识别的节拍）");

  // ticks 是 VectorFloat：size() / get(i) 取值，或用 vectorToArray 一次性拿
  let beats: number[] = [];
  try {
    beats = Array.from(ess.vectorToArray(raw.ticks) as Float32Array).map((x) => Number(x));
  } catch {
    const ticks = raw?.ticks;
    const n = typeof ticks?.size === "function" ? ticks.size() : 0;
    for (let i = 0; i < n; i++) beats.push(Number(ticks.get(i)));
  }
  // 重采样后的时间轴 = 真实时间轴（线性插值不改变时序），ticks 秒数直接可用
  beats = beats
    .filter((b) => Number.isFinite(b) && b >= 0 && b <= durationSec + 0.05)
    .map((b) => Math.round(b * 1000) / 1000);

  // 节拍层级校正（先修 BPM，后面的置信度/拍点都基于修过的值）
  const refinedBpm = refineMetricalLevel(signal, ESSENTIA_SAMPLE_RATE, beats, bpm);
  let finalBeats = beats;
  if (Math.abs(refinedBpm - bpm) / bpm > 0.01) {
    // 检测锁错了层级：拍点按修正后的周期重建（从第一个拍点起铺满全曲）
    const period = 60 / refinedBpm;
    const start = beats[0] ?? 0;
    finalBeats = [];
    for (let t = start; t <= durationSec + 0.05; t += period) {
      finalBeats.push(Math.round(t * 1000) / 1000);
    }
  }

  // 置信度自己算（essentia 的恒 0，见 dispersionScore 注释），三票取最小（保守）：
  // ① estimates 离散度（各窗口 BPM 估计是否一致）② ticks 规律性 ③ 包络在拍周期上的自相关
  let estimates: number[] = [];
  try {
    estimates = Array.from(ess.vectorToArray(raw.estimates) as Float32Array).map((x) => Number(x));
  } catch {
    /* 有的版本没有 estimates 字段，走 ticks 兜底 */
  }
  estimates = estimates.filter((x) => Number.isFinite(x) && x > 20 && x < 300);
  const scores: number[] = [];
  const estScore = dispersionScore(estimates);
  if (estScore > 0) scores.push(estScore);
  const tickScore = tickRegularityScore(finalBeats);
  if (tickScore > 0) scores.push(tickScore);
  // 包络周期性必须按**修正后**的 BPM 量，否则错层级会把自己的低相关带进置信度
  const envScore = envelopePeriodicity(signal, ESSENTIA_SAMPLE_RATE, refinedBpm) * 5;
  scores.push(envScore);
  const confidence = Math.min(...scores);

  const analysis: BeatAnalysis = {
    src,
    durationSec: Math.round(durationSec * 1000) / 1000,
    analyzedSec: Math.round((takeFrames / sampleRate) * 1000) / 1000,
    /**
     * BPM 统一到 1 位小数：以前有一条路径返回 89.1029052734375（float 直接进字符串），
     * 缓存命中那次又变成 89.1 —— 同一个素材两个精度，回执看起来像两首歌。
     * 0.1 BPM 对卡点没有意义（1 拍的位置误差 < 0.3ms），但读数必须稳定。
     */
    bpm: Math.round(refinedBpm * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    beats: finalBeats,
    beatsFrames: finalBeats.map((s) => Math.round(s * fps)),
    engine: "essentia",
    cached: false,
  };

  cache[key] = { key, at: Date.now(), data: analysis };
  writeCache(cache);
  return analysis;
}

/** 置信度门限：低于它就别自动应用，去问用户要 BPM */
export const BEAT_CONFIDENCE_MIN = 2.5;
