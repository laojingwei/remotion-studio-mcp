/**
 * E3 回归：采样率修复后 BPM 必须命中真实值。
 * 素材来自测试报告的 audio-fixtures/（BPM 精确已知）+ 本脚本合成的多采样率节拍器。
 * 用法：npx tsx scripts/tmp-beat-regression.mts
 */
import fs from "node:fs";
import path from "node:path";
import { analyzeBeats } from "../server/audio-analysis.service";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.resolve(ROOT, "..", "mcp工程验证", "audio-fixtures");
const TMP = path.join(ROOT, "public", "assets");

function wavHeader(n: number, sampleRate: number): Buffer {
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

/** 合成节拍器：满幅 click + 一点底噪（太干净会触发 essentia 的节拍层级歧义） */
function writeClickWav(file: string, sampleRate: number, bpm: number, seconds = 10) {
  const interval = Math.round((60 / bpm) * sampleRate);
  const n = sampleRate * seconds;
  const data = Buffer.alloc(n * 2);
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };
  for (let i = 0; i < n; i++) {
    const inTick = i % interval;
    const v =
      inTick < Math.round(sampleRate * 0.01)
        ? Math.exp(-inTick / (sampleRate * 0.003)) * Math.sin((2 * Math.PI * 1000 * inTick) / sampleRate) * 0.9
        : rand() * 0.01; // -40dB 底噪
    data.writeInt16LE(Math.round(v * 32000), i * 2);
  }
  const buf = wavHeader(n, sampleRate);
  data.copy(buf, 44);
  fs.writeFileSync(file, buf);
}

// ① 测试人员的 fixture（真实合成鼓组 / 节拍器 / 氛围）——不在仓库里，存在才跑
const fixtureCases: { file: string; bpm: number | null; note: string }[] = fs.existsSync(FIXTURES)
  ? [
      { file: "drums90.wav", bpm: 90, note: "90BPM 鼓组 24000Hz" },
      { file: "drums90b.wav", bpm: 90, note: "90BPM 真实鼓组" },
      { file: "click120.wav", bpm: 120, note: "120BPM 节拍器" },
      { file: "click120_22k.wav", bpm: 120, note: "120BPM 节拍器 22050Hz" },
      { file: "ambient.wav", bpm: null, note: "无节拍氛围 → 置信度必须 < 2.5" },
    ]
  : [];

// ② 多采样率节拍器（44.1k 是真实世界最常见的采样率，必须覆盖）
const SR16 = 16000, SR22 = 22050, SR24 = 24000, SR44 = 44100;
const synthCases: { file: string; bpm: number; sr: number }[] = [
  { file: "regress_click44_160.wav", bpm: 160, sr: SR44 },
  { file: "regress_click24_90.wav", bpm: 90, sr: SR24 },
  { file: "regress_click22_120.wav", bpm: 120, sr: SR22 },
  { file: "regress_click16_140.wav", bpm: 140, sr: SR16 },
];

let failed = 0;
const run = async (file: string, expect: number | null, note: string) => {
  try {
    const r = await analyzeBeats(`/assets/${file}`, { force: true });
    const ok =
      expect === null
        ? r.confidence < 2.5
        : Math.abs(r.bpm - expect) <= Math.max(1.5, expect * 0.02) && r.confidence >= 2.5;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${file}  ${note}  实测 ${r.bpm}  置信度 ${r.confidence}  拍点 ${r.beats.length}`,
    );
    if (!ok) failed++;
  } catch (e) {
    const msg = String(e);
    if (expect === null) {
      console.log(`PASS  ${file}  ${note}  直接报无可识别节拍也算过`);
    } else {
      console.log(`FAIL  ${file}  ${note}  异常: ${msg.slice(0, 120)}`);
      failed++;
    }
  }
};

for (const c of fixtureCases) {
  fs.copyFileSync(path.join(FIXTURES, c.file), path.join(TMP, `regress_${c.file}`));
  await run(`regress_${c.file}`, c.bpm, c.note);
}
for (const c of synthCases) {
  writeClickWav(path.join(TMP, c.file), c.sr, c.bpm);
  await run(c.file, c.bpm, `sr=${c.sr}`);
}

// ③ 白噪声：无周期包络，置信度必须低
{
  const sr = SR44;
  const n = sr * 10;
  const data = Buffer.alloc(n * 2);
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(rand() * 6000), i * 2);
  const file = "regress_noise.wav";
  fs.writeFileSync(path.join(TMP, file), wavHeader(n, sr));
  fs.appendFileSync(path.join(TMP, file), data);
  await run(file, null, "白噪声 → 置信度必须 < 2.5");
}

const tmpFiles = fs
  .readdirSync(TMP)
  .filter((f) => f.startsWith("regress_"));
for (const f of tmpFiles) fs.rmSync(path.join(TMP, f), { force: true });

console.log(failed ? `\nFAILED: ${failed}` : "\nALL PASS");
process.exit(failed ? 1 : 0);
