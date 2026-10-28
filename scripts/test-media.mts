/**
 * 素材时长解析单测（纯函数，喂内存里的 Buffer，不读磁盘、不调外部程序）。
 *
 *   npm test
 *
 * 为什么要自己解析：项目是纯 Node 工程，不能依赖 ffprobe 装没装、装在哪。
 * 这里用**手写的合成文件头**当输入（wav 头 / mp3 帧头 / ogg 页 / mp4 box），
 * 期望值都由格式规范直接推出来，不依赖任何编码器。
 */
import assert from "node:assert/strict";
import { parseMp4, parseMp3, parseOgg, parseWav } from "../server/media.service";

let passed = 0;
const failures: string[] = [];

const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  [fail] ${name}`);
    const detail = err instanceof Error ? err.message : String(err);
    for (const line of detail.split("\n")) console.error(`    ${line}`);
  }
};

/* ────────────────────────────── 合成 wav ────────────────────────────── */

/** 44 字节标准头 + 指定长度的 data */
const makeWav = (seconds: number, sampleRate = 44100, channels = 1, bits = 16) => {
  const byteRate = (sampleRate * channels * bits) / 8;
  const dataSize = Math.round(byteRate * seconds);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE((channels * bits) / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
};

/* ────────────────────────────── 合成 mp3 ────────────────────────────── */

/** MPEG1 LayerIII / 128kbps / 44100 → 每帧 144*128000/44100 = 417 字节、1152 采样 */
const makeMp3Frames = (frameCount: number, withId3 = false) => {
  const frameLength = Math.floor((144 * 128000) / 44100); // 417
  const frame = Buffer.alloc(frameLength);
  frame[0] = 0xff;
  frame[1] = 0xfb; // MPEG1 / LayerIII / 有 CRC 校验位关闭
  frame[2] = 0x90; // bitrate=128k(1001) sampleRate=44100(00) padding=0
  frame[3] = 0x00; // 立体声
  const parts: Buffer[] = [];
  if (withId3) {
    // ID3v2.3，标签体 100 字节
    const tag = Buffer.alloc(10 + 100);
    tag.write("ID3", 0, "ascii");
    tag[3] = 3;
    tag[6] = 0;
    tag[7] = 0;
    tag[8] = 0;
    tag[9] = 100; // synchsafe：100 < 128，单字节即可
    parts.push(tag);
  }
  for (let i = 0; i < frameCount; i++) parts.push(frame);
  return Buffer.concat(parts);
};

/* ────────────────────────────── 合成 mp3（带 Xing 扩展） ────────────────────────────── */

/**
 * 造一个带 Xing 头 + LAME 扩展区的 mp3。
 *
 * Xing 帧结构：帧头(4) + side info(32，MPEG1 立体声) + "Xing"(4) + flags(4) + 帧数(4) + LAME 扩展(36)
 * LAME 扩展区：标识 9 字节 + … + 偏移 21 起 3 字节打包 delay(12bit) / padding(12bit)
 */
const makeMp3WithXing = (
  frameCount: number,
  opts: { ident?: string; delay?: number; padding?: number } = {},
) => {
  const frameLength = Math.floor((144 * 128000) / 44100); // 417
  const ident = opts.ident ?? "LAME3.100";
  const delay = opts.delay ?? 576;
  const padding = opts.padding ?? 0;

  const xing = Buffer.alloc(frameLength);
  xing[0] = 0xff;
  xing[1] = 0xfb;
  xing[2] = 0x90;
  xing[3] = 0x00;
  const at = 4 + 32;
  xing.write("Xing", at, "ascii");
  xing.writeUInt32BE(1, at + 4); // flags：只有 frames 字段
  xing.writeUInt32BE(frameCount, at + 8);
  // LAME 扩展区：起始 at + 12
  const ext = at + 12;
  xing.write(ident.padEnd(9, "\0").slice(0, 9), ext, "ascii");
  // delay(12bit) | padding(12bit) 打包进 3 字节
  const packed = ((delay & 0xfff) << 12) | (padding & 0xfff);
  xing.writeUIntBE(packed, ext + 21, 3);

  // 后面跟真正的音频帧
  const audio = Buffer.alloc(frameLength);
  audio[0] = 0xff;
  audio[1] = 0xfb;
  audio[2] = 0x90;
  audio[3] = 0x00;
  return Buffer.concat([xing, audio]);
};

/* ────────────────────────────── 合成 ogg ────────────────────────────── */

/** 造一个 vorbis 流的 ogg：第 1 页 id 头，第 2 页带 granule */
const makeOgg = (totalSamples: number, sampleRate = 44100, channels = 1) => {
  const id = Buffer.alloc(30);
  id.write("\x01vorbis", 0, "ascii"); // 7 字节
  id.writeUInt32LE(0, 7); // version
  id[11] = channels;
  id.writeUInt32LE(sampleRate, 12);

  const page = (granule: bigint, body: Buffer, headerType: number) => {
    const segments = [body.length];
    const head = Buffer.alloc(27 + segments.length);
    head.write("OggS", 0, "ascii");
    head[4] = 0; // version
    head[5] = headerType;
    head.writeBigUInt64LE(granule, 6);
    head[26] = segments.length;
    segments.forEach((n, i) => (head[27 + i] = n));
    return Buffer.concat([head, body]);
  };

  return Buffer.concat([
    page(0n, id, 0x02), // 流开始
    page(BigInt(totalSamples), Buffer.from("audio-payload"), 0x04),
  ]);
};

/** 造一个 opus 流的 ogg：第 1 页 OpusHead（带 pre-skip），第 2 页带 granule */
const makeOggOpus = (totalSamples: number, preSkip = 312) => {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "ascii");
  head[8] = 1; // version
  head[9] = 2; // channels
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(48000, 12); // input sample rate
  head.writeUInt16LE(0, 16); // output gain
  head[18] = 0; // mapping family

  const page = (granule: bigint, body: Buffer, headerType: number) => {
    const segments = [body.length];
    const head2 = Buffer.alloc(27 + segments.length);
    head2.write("OggS", 0, "ascii");
    head2[4] = 0;
    head2[5] = headerType;
    head2.writeBigUInt64LE(granule, 6);
    head2[26] = segments.length;
    segments.forEach((n, i) => (head2[27 + i] = n));
    return Buffer.concat([head2, body]);
  };

  return Buffer.concat([
    page(0n, head, 0x02),
    page(BigInt(totalSamples), Buffer.from("opus-payload"), 0x04),
  ]);
};

/* ────────────────────────────── 合成 mp4 ────────────────────────────── */

const box = (type: string, body: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, body]);
};

/** moov.mvhd（version 0）：timescale + duration */
const makeMp4 = (seconds: number, timescale = 1000) => {
  const mvhd = Buffer.alloc(100);
  mvhd[0] = 0; // version 0
  mvhd.writeUInt32BE(timescale, 12);
  mvhd.writeUInt32BE(Math.round(seconds * timescale), 16);
  const ftyp = box("ftyp", Buffer.from("isomiso2", "ascii"));
  return Buffer.concat([ftyp, box("moov", box("mvhd", mvhd))]);
};

/* ────────────────────────────── 用例 ────────────────────────────── */

console.log("[media] 素材时长解析");

test("wav：data 长度 / byteRate", () => {
  const info = parseWav(makeWav(6, 44100, 1, 16));
  assert.ok(info);
  assert.equal(Math.round(info.seconds * 1000), 6000);
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.channels, 1);
});

test("wav：立体声 / 48kHz 也算对", () => {
  const info = parseWav(makeWav(1.5, 48000, 2, 16));
  assert.ok(info);
  assert.equal(Math.round(info.seconds * 1000), 1500);
  assert.equal(info.channels, 2);
});

test("wav：不是 RIFF 就返回 null（不能瞎猜）", () => {
  assert.equal(parseWav(Buffer.from("not a wav file at all, just text....")), null);
});

test("mp3：逐帧累加（10 帧 × 1152 / 44100）", () => {
  const info = parseMp3(makeMp3Frames(10));
  assert.ok(info);
  assert.equal(info.sampleRate, 44100);
  assert.ok(Math.abs(info.seconds - (10 * 1152) / 44100) < 1e-9, String(info.seconds));
});

test("mp3：跳过 ID3v2 标签后仍能对上帧", () => {
  const info = parseMp3(makeMp3Frames(10, true));
  assert.ok(info);
  assert.ok(Math.abs(info.seconds - (10 * 1152) / 44100) < 1e-9, String(info.seconds));
});

test("mp3：纯垃圾数据返回 null", () => {
  assert.equal(parseMp3(Buffer.alloc(5000, 0x20)), null);
});

test("mp3：有 Xing 头时以头里的帧数为准（第一帧是元数据帧，不算音频）", () => {
  const frameLength = Math.floor((144 * 128000) / 44100);
  const xing = Buffer.alloc(frameLength);
  xing[0] = 0xff;
  xing[1] = 0xfb;
  xing[2] = 0x90;
  xing[3] = 0x00;
  // MPEG1 立体声 → side info 32 字节，Xing 紧跟在帧头 + side info 之后
  const at = 4 + 32;
  xing.write("Xing", at, "ascii");
  xing.writeUInt32BE(1, at + 4); // flags：只有 frames 字段
  xing.writeUInt32BE(10, at + 8); // 声明 10 个音频帧
  const audio = Buffer.alloc(frameLength);
  audio[0] = 0xff;
  audio[1] = 0xfb;
  audio[2] = 0x90;
  audio[3] = 0x00;

  const info = parseMp3(Buffer.concat([xing, audio]));
  assert.ok(info);
  assert.ok(Math.abs(info.seconds - (10 * 1152) / 44100) < 1e-9, String(info.seconds));
  assert.match(info.method, /Xing/);
});

test("ogg：末页 granule / 采样率", () => {
  const info = parseOgg(makeOgg(44100 * 3, 44100));
  assert.ok(info);
  assert.equal(Math.round(info.seconds * 1000), 3000);
  assert.equal(info.sampleRate, 44100);
});

test("ogg：不是 OggS 返回 null", () => {
  assert.equal(parseOgg(Buffer.alloc(200, 1)), null);
});

test("mp3：Xing 帧带 LAME 扩展 → 扣掉编码器延迟与补齐的静音", () => {
  // 声明 10 帧 = 10*1152 采样，再扣 delay 576 + padding 1206
  const info = parseMp3(makeMp3WithXing(10, { ident: "LAME3.100", delay: 576, padding: 1206 }));
  assert.ok(info);
  const expected = (10 * 1152 - 576 - 1206) / 44100;
  assert.ok(Math.abs(info.seconds - expected) < 1e-9, `${info.seconds} vs ${expected}`);
  assert.match(info.method, /已扣编码延迟/);
});

test("mp3：ffmpeg 写的 Lavc 标识也要认（否则白读一遍扩展区，偏长 30~50ms）", () => {
  const info = parseMp3(makeMp3WithXing(10, { ident: "Lavc58.29", delay: 576, padding: 1206 }));
  assert.ok(info);
  const expected = (10 * 1152 - 576 - 1206) / 44100;
  assert.ok(Math.abs(info.seconds - expected) < 1e-9, `${info.seconds} vs ${expected}`);
  assert.match(info.method, /已扣编码延迟/);
});

test("mp3：Lavf 标识同样认", () => {
  const info = parseMp3(makeMp3WithXing(10, { ident: "Lavf60.16", delay: 576, padding: 0 }));
  assert.ok(info);
  assert.ok(Math.abs(info.seconds - (10 * 1152 - 576) / 44100) < 1e-9, String(info.seconds));
});

test("mp3：扩展区标识不认识就不扣（宁可偏长也不给错数）", () => {
  const info = parseMp3(makeMp3WithXing(10, { ident: "XXXXX", delay: 576, padding: 1206 }));
  assert.ok(info);
  // 没扣 → 时长等于整帧数
  assert.ok(Math.abs(info.seconds - (10 * 1152) / 44100) < 1e-9, String(info.seconds));
  assert.doesNotMatch(info.method, /已扣/);
});

test("mp3：delay/padding 离谱时不采用（认错标识时不能给出离谱时长）", () => {
  const info = parseMp3(makeMp3WithXing(10, { ident: "Lavc", delay: 60000, padding: 90000 }));
  assert.ok(info);
  assert.ok(Math.abs(info.seconds - (10 * 1152) / 44100) < 1e-9, String(info.seconds));
});

test("ogg opus：granule 减掉 pre-skip（编码器垫在头部的静音）", () => {
  // 48000 * 5 = 240000 个采样，含 312 样本 pre-skip → 实际 5 - 6.5ms
  const info = parseOgg(makeOggOpus(240000, 312));
  assert.ok(info);
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.channels, 2);
  assert.ok(
    Math.abs(info.seconds - (240000 - 312) / 48000) < 1e-9,
    String(info.seconds),
  );
  assert.match(info.method, /pre-skip/);
});

test("ogg vorbis：pre-skip 为 0 时不减", () => {
  const info = parseOgg(makeOgg(44100 * 5, 44100));
  assert.ok(info);
  assert.equal(Math.round(info.seconds * 1000), 5000);
  assert.doesNotMatch(info.method, /pre-skip/);
});

test("mp4：moov.mvhd 的 duration / timescale", () => {
  const info = parseMp4(makeMp4(2.5, 1000));
  assert.ok(info);
  assert.equal(info.seconds, 2.5);
});

test("mp4：没有 moov 返回 null", () => {
  assert.equal(parseMp4(box("ftyp", Buffer.from("isom", "ascii"))), null);
});

const ok = failures.length === 0;
console.log(`\n${ok ? "全部通过" : `失败 ${failures.length} 个`}：${passed} 个用例`);
if (!ok) process.exit(1);
