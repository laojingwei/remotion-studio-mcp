/**
 * 响度测量测试（服务端，需要真实文件）。
 *
 * 为什么不黑盒测：造不出"已知响度"的素材就没法判定对错。
 * 这里用**合成正弦**做基准 —— 1kHz 正弦在 K 加权下正好满足 EBU 的对齐关系
 * （RMS 多少 dBFS，LUFS 就差不多多少），所以可以用解析值卡死测量精度。
 *
 * 会往 public/assets 写临时文件，跑完删掉；文件名带固定前缀，失败也不会误删用户素材。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { measureLoudness } from "../server/loudness.service";
import { buildCompressCurve } from "../shared/audio";
import { ROOT } from "../server/root";

const TMP = path.join(ROOT, "public", "assets", "__loudness_test__.wav");

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  passed++;
  console.log(`  [ok] ${name}`);
};

/** 写一个单声道 16bit wav：正弦，指定频率与振幅 */
function writeTone(file: string, opts: { freq: number; amplitude: number; seconds?: number; silent?: boolean }) {
  const SR = 44100;
  const n = Math.round(SR * (opts.seconds ?? 3));
  const dataLen = n * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < n; i++) {
    const v = opts.silent ? 0 : opts.amplitude * Math.sin((2 * Math.PI * opts.freq * i) / SR);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

const dbOf = (x: number) => 20 * Math.log10(x);

async function main() {
  const existed = fs.existsSync(TMP);
  try {
    /* ── 1kHz 正弦：LUFS ≈ RMS（EBU 对齐关系），峰值可解析 ── */
    writeTone(TMP, { freq: 1000, amplitude: 0.5 });
    const r = await measureLoudness("/assets/__loudness_test__.wav", { force: true });

    await test("1kHz 正弦：LUFS 与 RMS 对齐（差值 < 0.5dB）", async () => {
      assert.ok(Math.abs(r.lufs - r.rmsDb) < 0.5, `LUFS=${r.lufs} RMS=${r.rmsDb}`);
    });

    await test("峰值测准（振幅 0.5 → -6dBFS）", async () => {
      assert.ok(Math.abs(r.peakDb - dbOf(0.5)) < 0.2, `峰值 ${r.peakDb}`);
    });

    await test("RMS 测准（振幅 0.5 正弦 → -9dBFS）", async () => {
      assert.ok(Math.abs(r.rmsDb - dbOf(0.5 / Math.SQRT2)) < 0.2, `RMS ${r.rmsDb}`);
    });

    await test("时长与曲线分辨率对得上", async () => {
      assert.ok(Math.abs(r.durationSec - 3) < 0.05, `时长 ${r.durationSec}`);
      assert.equal(r.stepMs, 200);
      assert.ok(r.curve.length >= 13 && r.curve.length <= 17, `曲线点数 ${r.curve.length}`);
    });

    await test("命中缓存（同文件不重复解码）", async () => {
      const again = await measureLoudness("/assets/__loudness_test__.wav");
      assert.equal(again.cached, true);
    });

    /* ── 高频：K 加权必须让 10kHz 比 1kHz 更响，否则说明加权没生效 ── */
    await test("10kHz 正弦被 K 加权抬高约 4dB（证明加权真的生效）", async () => {
      writeTone(TMP, { freq: 10000, amplitude: 0.5 });
      const hi = await measureLoudness("/assets/__loudness_test__.wav", { force: true });
      const delta = hi.lufs - hi.rmsDb;
      assert.ok(delta > 3 && delta < 5, `10kHz 的 LUFS-RMS = ${delta.toFixed(2)}dB`);
    });

    /* ── 安静素材：整体响度更低，但峰值限制会拦住"硬拉到目标" ── */
    await test("安静素材响度更低且能放大到不削波", async () => {
      writeTone(TMP, { freq: 1000, amplitude: 0.05 });
      const quiet = await measureLoudness("/assets/__loudness_test__.wav", { force: true });
      assert.ok(quiet.lufs < -25, `安静素材 LUFS=${quiet.lufs}`);
      // 峰值 -26dBFS，放大 5 倍也只有 -12dBFS，不该触发削波
      assert.ok(quiet.peakDb + 20 * Math.log10(5) < 0, "5 倍放大不应削波");
    });

    /* ── 逐点峰值曲线：压缩限幅靠它，必须与响度曲线逐点对齐 ── */
    await test("peakCurve 与 curve 点数一致，且最高点等于整段峰值", async () => {
      writeTone(TMP, { freq: 1000, amplitude: 0.5 });
      const p = await measureLoudness("/assets/__loudness_test__.wav", { force: true });
      assert.equal(p.peakCurve.length, p.curve.length);
      const maxPeak = Math.max(...p.peakCurve.filter(Number.isFinite));
      assert.ok(Math.abs(maxPeak - p.peakDb) < 0.5, `峰值曲线最高 ${maxPeak} vs 整段 ${p.peakDb}`);
    });

    /* ── 压缩：陡台阶 + 高电平 = 最容易被平滑冲过头的情形（复验 N-F） ── */
    await test("压缩曲线逐点限幅：峰值 × 增益不超过 -1dBFS", async () => {
      const lufs = [...Array(25).fill(-33.5), ...Array(25).fill(-3.9)];
      const peaks = [...Array(25).fill(-30), ...Array(25).fill(-0.9)];
      // 先证明"不管它就会冲过头"：不加峰值曲线时响段开头冲到 >1
      const blind = buildCompressCurve(lufs, { targetLufs: -23, ratio: 3 });
      assert.ok(Math.max(...blind.values) > 1, `无峰值限幅时最大增益 ${Math.max(...blind.values)}`);
      // 加峰值曲线后每个点都必须留 1dB 余量
      const guarded = buildCompressCurve(lufs, { targetLufs: -23, ratio: 3, peakDbCurve: peaks });
      guarded.values.forEach((g, i) => {
        const out = peaks[i] + 20 * Math.log10(Math.max(g, 1e-6));
        assert.ok(out <= -1 + 0.2, `第 ${i} 点输出 ${out.toFixed(2)}dBFS 超过 -1dBFS`);
      });
      assert.ok(guarded.peakLimited > 0, "被夹的采样点数必须回报");
    });

    await test("压缩被 maxCutDb 钉死时要能回报（ratio 再大也不会更平）", async () => {
      const lufs = [...Array(25).fill(-33.5), ...Array(25).fill(-3.9)];
      const r3 = buildCompressCurve(lufs, { targetLufs: -23, ratio: 3 });
      const r10 = buildCompressCurve(lufs, { targetLufs: -23, ratio: 10 });
      assert.ok(r3.cutLimited > 0, "默认 12dB 上限下响段应被夹住");
      assert.ok(r10.cutLimited >= r3.cutLimited);
    });

    /* ── 静音：-Infinity（调用方据此跳过） ── */
    await test("全静音 → LUFS 为 -Infinity", async () => {
      writeTone(TMP, { freq: 1000, amplitude: 0, silent: true });
      const silent = await measureLoudness("/assets/__loudness_test__.wav", { force: true });
      assert.equal(silent.lufs, -Infinity);
    });

    /* ── 不存在的文件：报错要带路径，方便 agent 改 ── */
    await test("不存在的文件报错可读", async () => {
      await assert.rejects(() => measureLoudness("/assets/__nope__.wav", { force: true }), /素材|不存在/);
    });
  } finally {
    if (!existed && fs.existsSync(TMP)) fs.rmSync(TMP, { force: true });
  }

  console.log(`\n响度测试：${passed} 例通过`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
