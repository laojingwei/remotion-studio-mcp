import fs from "node:fs";
import path from "node:path";
import { PUBLIC_DIR } from "./store";

/**
 * 量素材真实时长。
 *
 * 为什么需要：`tts_synthesize` 只返回地址，不返回时长；而幕长必须按配音长度倒推
 * （帧数 = ceil((秒数 + 0.7) × 30)）。同一段文字两次合成时长还不一样，
 * 所以改完旁白就得重新量一遍。
 *
 * 实现约束：**纯 Node，不 spawn 任何外部进程**（不依赖 ffprobe / ffmpeg 是否装了、
 * 装在哪、版本哪个）。用的都是格式本身写死的结构：
 *   wav    → RIFF 块里 data 长度 / byteRate
 *   mp3    → 逐帧走帧头累加采样数（ID3v2 跳过、首个合法帧靠"连续两帧都对"确认）
 *   ogg    → 末页 granule position / 采样率（vorbis 取 id 头，opus 固定 48k 且减 pre-skip）
 *   mp4/m4a→ moov.mvhd 的 duration / timescale
 * 其余容器（webm / flac / 裸 aac）不猜，直接报"不支持"，让调用方知道而不是给个错数。
 */

export type MediaProbe = {
  src: string;
  file: string;
  format: string;
  bytes: number;
  durationInSeconds: number;
  /** 素材本身的帧数 */
  frames: number;
  /** 建议的场景时长（含 0.7s 呼吸位），可直接喂 set_scene_timing */
  suggestedSceneFrames: number;
  sampleRate?: number;
  channels?: number;
  /** 时长是怎么算出来的，排查时能看懂 */
  method?: string;
  error?: string;
};

/** 站内地址 → public 下的绝对路径。挡住 ../ 这类穿越。 */
export function resolvePublicFile(src: string): string {
  const clean = decodeURIComponent(src.split("?")[0].split("#")[0]).replace(/^\/+/, "");
  if (!clean) throw new Error("src 不能为空");
  if (/^(https?:)?\/\//i.test(clean) || clean.startsWith("data:")) {
    throw new Error("只支持站内素材（/assets/xxx.wav），外链请先下载再上传");
  }
  const full = path.resolve(PUBLIC_DIR, clean);
  const root = path.resolve(PUBLIC_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`非法的素材路径：${src}`);
  }
  if (!fs.existsSync(full)) throw new Error(`素材不存在：/${clean}`);
  return full;
}

/* ──────────────────────────────── WAV ──────────────────────────────── */

export type ParsedMedia = { seconds: number; sampleRate: number; channels: number; method: string };

/** 解 RIFF/WAVE 头：时长 = data 块字节数 / byteRate */
export function parseWav(buf: Buffer): ParsedMedia | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let byteRate = 0;
  let sampleRate = 0;
  let channels = 0;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      byteRate = buf.readUInt32LE(body + 8);
    } else if (id === "data") {
      // size 可能是 0 或超出实际长度（流式写出的 wav），以文件实际剩余长度兜底
      dataSize = size > 0 && body + size <= buf.length ? size : buf.length - body;
      break;
    }
    // chunk 按 2 字节对齐
    offset = body + size + (size % 2);
  }

  if (!byteRate || !dataSize) return null;
  return { seconds: dataSize / byteRate, sampleRate, channels, method: "wav 头（data/byteRate）" };
}

/* ──────────────────────────────── MP3 ──────────────────────────────── */

// 位率表（kbps），下标 = 帧头里的 bitrate index
const MP3_BITRATE: Record<string, number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SAMPLE_RATE: Record<string, number[]> = {
  "1": [44100, 48000, 32000],
  "2": [22050, 24000, 16000],
  "25": [11025, 12000, 8000],
};

type Mp3Frame = { frameLength: number; samples: number; sampleRate: number };

/** 解一个 mp3 帧头；不合法返回 null */
function parseMp3Frame(buf: Buffer, at: number): Mp3Frame | null {
  if (at + 4 > buf.length) return null;
  if (buf[at] !== 0xff || (buf[at + 1] & 0xe0) !== 0xe0) return null;

  const versionBits = (buf[at + 1] >> 3) & 0b11; // 0=2.5 1=保留 2=2 3=1
  const layerBits = (buf[at + 1] >> 1) & 0b11; // 0=保留 1=III 2=II 3=I
  const bitrateIndex = (buf[at + 2] >> 4) & 0b1111;
  const rateIndex = (buf[at + 2] >> 2) & 0b11;
  const padding = (buf[at + 2] >> 1) & 1;

  if (versionBits === 1 || layerBits === 0) return null;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;

  const version = versionBits === 3 ? "1" : versionBits === 2 ? "2" : "25";
  const layer = 4 - layerBits; // 1 / 2 / 3
  const tableKey = version === "1" ? `1-${layer}` : `2-${layer}`;
  const bitrate = MP3_BITRATE[tableKey][bitrateIndex] * 1000;
  const sampleRate = MP3_SAMPLE_RATE[version][rateIndex];
  if (!bitrate || !sampleRate) return null;

  const samples = layer === 1 ? 384 : layer === 2 ? 1152 : version === "1" ? 1152 : 576;
  const frameLength =
    layer === 1
      ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
      : Math.floor(((layer === 3 && version !== "1" ? 72 : 144) * bitrate) / sampleRate + padding);

  if (frameLength < 4) return null;
  return { frameLength, samples, sampleRate };
}

/**
 * 读第一帧里的 Xing/Info（VBR 头）与 LAME 扩展。
 *
 * LAME 编码会在素材前后各补一小段静音（编码器延迟 / padding），并把这两个值写进
 * Xing 帧的 LAME 扩展区。不减掉的话每个 mp3 会读数偏长约 30~50ms —— 对幕长来说不至于出事
 * （偏长是安全方向），但既然文件里写着，就没理由不算准。
 *
 * 标识有三种写法，都指向同一套结构：
 *   "LAME3.100"  真 LAME 命令行
 *   "Lavc58.29"  ffmpeg（libmp3lame）——实测 TTS 工具链大多是这条
 *   "Lavf60.16"  ffmpeg 新版
 * 只认 "LAME" 会让 ffmpeg 产的文件白读一遍扩展区（偏长 30~50ms）。
 */
function readXing(buf: Buffer, frameStart: number, mono: boolean, mpeg1: boolean) {
  const sideInfo = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const at = frameStart + 4 + sideInfo;
  if (at + 8 > buf.length) return null;
  const id = buf.toString("ascii", at, at + 4);
  if (id !== "Xing" && id !== "Info") return null;

  const flags = buf.readUInt32BE(at + 4);
  let cursor = at + 8;
  let frames = 0;
  if (flags & 1) {
    if (cursor + 4 > buf.length) return null;
    frames = buf.readUInt32BE(cursor);
    cursor += 4;
  }
  if (flags & 2) cursor += 4;
  if (flags & 4) cursor += 100;
  if (flags & 8) cursor += 4;

  let delay = 0;
  let padding = 0;
  if (cursor + 24 <= buf.length) {
    const ident = buf.toString("ascii", cursor, cursor + 4);
    if (ident === "LAME" || ident === "Lavc" || ident === "Lavf") {
      const packed = buf.readUIntBE(cursor + 21, 3);
      delay = packed >> 12;
      padding = packed & 0xfff;
      // 合理性校验：延迟不该超过一帧，padding 不该超过大半秒。
      // 认错了标识时宁可不算，也不要给出离谱的时长
      if (delay > 2000 || padding > 24000) {
        delay = 0;
        padding = 0;
      }
    }
  }
  return { frames, delay, padding };
}

/** 逐帧累加采样数。TTS 出来的 mp3 几百 KB，全扫一遍是毫秒级，比"按码率估算"准。 */export function parseMp3(buf: Buffer): ParsedMedia | null {
  let offset = 0;
  // 跳过 ID3v2 标签（大小是 synchsafe 的 7 位/字节）
  if (buf.length > 10 && buf.toString("ascii", 0, 3) === "ID3") {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    offset = 10 + size + (buf[5] & 0x10 ? 10 : 0); // 有 footer 再加 10
  }

  // 找第一个合法帧：要求"下一帧也能解出来"，避免把数据里的伪同步字当成帧头
  let start = -1;
  for (let i = offset; i + 4 <= buf.length; i++) {
    const head = parseMp3Frame(buf, i);
    if (!head) continue;
    const after = i + head.frameLength;
    if (after + 4 > buf.length || parseMp3Frame(buf, after)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const first = parseMp3Frame(buf, start);
  if (!first) return null;
  const mono = ((buf[start + 3] >> 6) & 0b11) === 3;
  const mpeg1 = ((buf[start + 1] >> 3) & 0b11) === 3;

  // 有 Xing/Info：第一帧是元数据帧，帧数写在头里，直接按它算（并扣掉编码器延迟）
  const xing = readXing(buf, start, mono, mpeg1);
  if (xing && xing.frames > 0) {
    const samples = xing.frames * first.samples - xing.delay - xing.padding;
    if (samples > 0) {
      return {
        seconds: samples / first.sampleRate,
        sampleRate: first.sampleRate,
        channels: mono ? 1 : 2,
        method:
          xing.delay || xing.padding
            ? `mp3 Xing（${xing.frames} 帧，已扣编码延迟）`
            : `mp3 Xing（${xing.frames} 帧，含编码器补齐的静音）`,
      };
    }
  }

  let pos = start;
  let frames = 0;
  let samples = 0;
  let sampleRate = 0;
  let channels = 0;
  while (pos + 4 <= buf.length) {
    const head = parseMp3Frame(buf, pos);
    if (!head) break;
    if (!sampleRate) {
      sampleRate = head.sampleRate;
      channels = ((buf[pos + 3] >> 6) & 0b11) === 3 ? 1 : 2; // 11=单声道
    }
    samples += head.samples;
    frames++;
    pos += head.frameLength;
  }
  if (!frames) return null;
  return {
    seconds: samples / sampleRate,
    sampleRate,
    channels,
    method: `mp3 逐帧（${frames} 帧）`,
  };
}

/* ──────────────────────────────── OGG ──────────────────────────────── */

/**
 * Ogg 页结构：OggS + 版本(1) + 类型(1) + granule(8 LE) + 流号(4) + 序号(4) + CRC(4) + 段数(1) + 段表
 * granule position = 到该页结束为止的总采样数（vorbis/opus 都是），所以取末页即可。
 */
export function parseOgg(buf: Buffer): ParsedMedia | null {
  let pos = 0;
  let sampleRate = 0;
  let channels = 0;
  let preSkip = 0;
  let lastGranule = 0;
  let codec = "";
  let sawHeader = false;

  while (pos + 27 <= buf.length) {
    if (buf.toString("ascii", pos, pos + 4) !== "OggS") {
      const next = buf.indexOf("OggS", pos + 1, "ascii");
      if (next < 0) break;
      pos = next;
      continue;
    }

    const granuleRaw = buf.readBigUInt64LE(pos + 6);
    const segmentCount = buf[pos + 26];
    const tableStart = pos + 27;
    if (tableStart + segmentCount > buf.length) break;
    let bodyLength = 0;
    for (let i = 0; i < segmentCount; i++) bodyLength += buf[tableStart + i];
    const bodyStart = tableStart + segmentCount;
    if (bodyStart + bodyLength > buf.length) break;

    // 第一页的第一个包是编码器识别头
    if (!sawHeader && bodyLength > 7) {
      const body = buf.subarray(bodyStart, bodyStart + bodyLength);
      const magic = body.toString("ascii", 0, 7);
      if (magic === "\x01vorbis") {
        codec = "vorbis";
        channels = body[11];
        sampleRate = body.readUInt32LE(12);
        sawHeader = true;
      } else if (body.toString("ascii", 0, 8) === "OpusHead") {
        codec = "opus";
        channels = body[9];
        preSkip = body.readUInt16LE(10);
        // opus 解码固定 48kHz，granule 也按 48k 计（与原始采样率无关）
        sampleRate = 48000;
        sawHeader = true;
      }
    }

    // granule 全 1 表示"这页没有结束任何包"，不能当时间用
    const NONE = 0xffffffffffffffffn;
    if (granuleRaw !== NONE) lastGranule = Number(granuleRaw);

    pos = bodyStart + bodyLength;
  }

  if (!sampleRate || lastGranule <= 0) return null;
  const samples = Math.max(0, lastGranule - preSkip);
  return {
    seconds: samples / sampleRate,
    sampleRate,
    channels,
    // opus 的 pre-skip 是编码器垫在头部的静音（通常 312 样本 = 6.5ms）。
    // 我们减掉了它，报的是**真正解出来的时长**；ffprobe 报的 format.duration
    // 包含这段静音，会比这里大 6~7ms
    method: codec === "opus" ? `ogg opus granule（已扣 ${preSkip} 样本 pre-skip）` : `ogg ${codec} granule`,
  };
}

/* ──────────────────────────────── MP4 / M4A ──────────────────────────────── */

type Box = { type: string; start: number; end: number };

/** 列出 [start, end) 区间内的同级 box（size=1 走 64 位长度，size=0 表示到父级末尾） */
function* boxes(buf: Buffer, start: number, end: number): Generator<Box> {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header) return;
    yield { type, start: pos + header, end: Math.min(pos + size, end) };
    pos += size;
  }
}

/** moov.mvhd：duration / timescale */
export function parseMp4(buf: Buffer): ParsedMedia | null {
  for (const top of boxes(buf, 0, buf.length)) {
    if (top.type !== "moov") continue;
    for (const child of boxes(buf, top.start, top.end)) {
      if (child.type !== "mvhd" || child.start + 4 > child.end) continue;
      const version = buf[child.start];
      let timescale = 0;
      let duration = 0;
      if (version === 1) {
        if (child.start + 32 > child.end) continue;
        timescale = buf.readUInt32BE(child.start + 20);
        duration = Number(buf.readBigUInt64BE(child.start + 24));
      } else {
        if (child.start + 20 > child.end) continue;
        timescale = buf.readUInt32BE(child.start + 12);
        duration = buf.readUInt32BE(child.start + 16);
      }
      if (!timescale || duration === 0xffffffff || !duration) return null;
      return { seconds: duration / timescale, sampleRate: 0, channels: 0, method: "mp4 mvhd" };
    }
  }
  return null;
}

/* ──────────────────────────────── 入口 ──────────────────────────────── */

const PARSERS: Record<string, { parse: (buf: Buffer) => ParsedMedia | null; label: string }> = {
  wav: { parse: parseWav, label: "wav" },
  mp3: { parse: parseMp3, label: "mp3" },
  ogg: { parse: parseOgg, label: "ogg" },
  oga: { parse: parseOgg, label: "ogg" },
  opus: { parse: parseOgg, label: "opus" },
  mp4: { parse: parseMp4, label: "mp4" },
  m4a: { parse: parseMp4, label: "m4a" },
};

export const SUPPORTED_FORMATS = Object.keys(PARSERS);

/** 单个素材量时长。失败不抛，把原因放在 error 里，方便批量时不中断 */
export async function probeMedia(src: string, fps = 30): Promise<MediaProbe> {
  const ext = path.extname(src.split("?")[0]).replace(".", "").toLowerCase();
  const base: MediaProbe = {
    src,
    file: path.basename(src.split("?")[0]),
    format: ext || "unknown",
    bytes: 0,
    durationInSeconds: 0,
    frames: 0,
    suggestedSceneFrames: 0,
  };

  let full: string;
  try {
    full = resolvePublicFile(src);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  const parser = PARSERS[ext];
  if (!parser) {
    return { ...base, error: `不支持 .${ext} 的时长解析（支持 ${SUPPORTED_FORMATS.join(" / ")}）` };
  }

  try {
    const buf = fs.readFileSync(full);
    base.bytes = buf.length;
    const info = parser.parse(buf);
    if (!info || !Number.isFinite(info.seconds) || info.seconds <= 0) {
      return { ...base, error: `${parser.label} 文件头读不出时长（文件可能坏了或被截断）` };
    }
    return {
      ...base,
      durationInSeconds: Math.round(info.seconds * 1000) / 1000,
      frames: Math.round(info.seconds * fps),
      suggestedSceneFrames: Math.max(1, Math.ceil((info.seconds + 0.7) * fps)),
      sampleRate: info.sampleRate || undefined,
      channels: info.channels || undefined,
      method: info.method,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function probeMany(srcs: string[], fps = 30): Promise<MediaProbe[]> {
  const out: MediaProbe[] = [];
  for (const src of srcs) out.push(await probeMedia(src, fps));
  return out;
}
