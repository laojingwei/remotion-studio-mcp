/**
 * 音频纯函数测试：人声避让（ducking）与节拍网格。
 *
 * 这两块都直接决定成片听感/卡点准不准，而且渲染端与服务端共用同一份实现——
 * 一旦算错，表现是「预览正常、出片不对」这类最难查的偏差，所以边界要钉死。
 */
import assert from "node:assert/strict";

import {
  beatFrames,
  beatTimes,
  buildCompressCurve,
  curveGainAt,
  duckGainAt,
  gainForTarget,
  nearestBeat,
  summarizeCurve,
  voiceSpans,
  DEFAULT_DUCKING,
} from "../shared/audio";
import { createSeedProject } from "../shared/ops";
import type { Scene } from "../shared/schema";

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  [ok] ${name}`);
};

const FPS = 30;

/* ─────────────────────────── duckGainAt ─────────────────────────── */

const CFG = { ...DEFAULT_DUCKING, enabled: true, depth: 0.3, attackMs: 100, releaseMs: 200, padMs: 0 };
const SPANS = [{ start: 2, end: 4 }];

test("人声以外是 1.0（不动音量）", () => {
  assert.equal(duckGainAt(0, SPANS, CFG, FPS), 1);
  assert.equal(duckGainAt(10 * FPS, SPANS, CFG, FPS), 1);
});

test("人声期间压到 depth", () => {
  assert.equal(duckGainAt(3 * FPS, SPANS, CFG, FPS), 0.3);
  assert.equal(duckGainAt(2 * FPS, SPANS, CFG, FPS), 0.3); // 区间起点
  assert.equal(duckGainAt(4 * FPS, SPANS, CFG, FPS), 0.3); // 区间终点
});

test("attack 段线性下降（中点约一半）", () => {
  // attack 100ms = 0.1s：t=1.95s 是 attack 中点
  const g = duckGainAt(1.95 * FPS, SPANS, CFG, FPS);
  assert.ok(Math.abs(g - 0.65) < 0.02, `实际 ${g}`);
});

test("release 段线性回升（中点约一半）", () => {
  const g = duckGainAt(4.1 * FPS, SPANS, CFG, FPS);
  assert.ok(Math.abs(g - 0.65) < 0.02, `实际 ${g}`);
});

test("attack/release 之外完全恢复", () => {
  assert.ok(duckGainAt(1.8 * FPS, SPANS, CFG, FPS) > 0.99);
  assert.ok(duckGainAt(4.5 * FPS, SPANS, CFG, FPS) > 0.99);
});

test("enabled=false 时永远是 1", () => {
  assert.equal(duckGainAt(3 * FPS, SPANS, { ...CFG, enabled: false }, FPS), 1);
});

test("多个区间重叠时取最小值（压得更狠的说了算）", () => {
  const spans = [
    { start: 2, end: 4 },
    { start: 3, end: 5 },
  ];
  assert.equal(duckGainAt(3.5 * FPS, spans, { ...CFG, depth: 0.5 }, FPS), 0.5);
});

test("空区间 / 无区间不报错", () => {
  assert.equal(duckGainAt(5, [], CFG, FPS), 1);
  assert.equal(duckGainAt(5, [{ start: 2, end: 2 }], CFG, FPS), 1);
});

test("padMs 让压低提前一点开始", () => {
  const withPad = { ...CFG, padMs: 500 }; // 前后各 0.5s
  assert.ok(duckGainAt(1.6 * FPS, SPANS, withPad, FPS) < 1); // 原本 2s 才开始，pad 后 1.5s
});

/* ─────────────────────────── voiceSpans ─────────────────────────── */

const scene = (patch: Partial<Scene>): Scene =>
  ({ ...createSeedProject().scenes[0], ...patch }) as Scene;

test("有字幕的幕会产生人声区间", () => {
  const s = scene({ id: "s1", durationInFrames: 90, subtitle: "第一句话" });
  const spans = voiceSpans([s], FPS);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, 0);
  assert.ok(Math.abs(spans[0].end - 3) < 0.4, `实际 ${spans[0].end}`);
});

test("多行字幕切成多段，且句间留空隙（BGM 能回升）", () => {
  const s = scene({ id: "s1", durationInFrames: 150, subtitle: "第一句话\n第二句话" });
  const spans = voiceSpans([s], FPS);
  assert.equal(spans.length, 2);
  assert.ok(spans[0].end < spans[1].start, "两段之间要留缝");
});

test("没字幕的幕不产生区间", () => {
  const s = scene({ id: "s1", durationInFrames: 90, subtitle: "" });
  assert.equal(voiceSpans([s], FPS).length, 0);
});

test("场景内音频元素优先于字幕", () => {
  const s = scene({
    id: "s1",
    durationInFrames: 300,
    subtitle: "这行字幕不该被用\r\n第二行也不该",
    elements: [{ id: "a1", kind: "audio", name: "旁白", src: "/assets/x.wav", x: 0, y: 0, from: 30, durationInFrames: 60 } as never],
  });
  const spans = voiceSpans([s], FPS);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, 1); // 从第 30 帧 = 1s 开始
  assert.equal(spans[0].end, 3); // 第 30+60 帧
});

/* ─────────────────────────── 节拍网格 ─────────────────────────── */

test("120 BPM 每 0.5 秒一拍", () => {
  const t = beatTimes({ bpm: 120, offsetSec: 0, source: "manual" }, 3);
  assert.deepEqual(t, [0, 0.5, 1, 1.5, 2, 2.5, 3]);
});

test("拍点不超过片长", () => {
  const t = beatTimes({ bpm: 120, offsetSec: 0, source: "manual" }, 1.2);
  assert.deepEqual(t, [0, 0.5, 1]);
});

test("offset 为正：第一拍推后", () => {
  const t = beatTimes({ bpm: 60, offsetSec: 0.25, source: "manual" }, 2);
  assert.deepEqual(t, [0.25, 1.25]);
});

test("offset 为负：第一拍在片头之前，后续拍落进来", () => {
  const t = beatTimes({ bpm: 60, offsetSec: -0.75, source: "manual" }, 2);
  assert.deepEqual(t, [0.25, 1.25]);
});

test("帧号去重（高 BPM + 低帧率时相邻拍会落到同一帧）", () => {
  const f = beatFrames({ bpm: 300, offsetSec: 0, source: "manual" }, 2, 30);
  assert.equal(new Set(f).size, f.length);
  assert.ok(f.every((v, i) => i === 0 || v > f[i - 1]), "必须严格递增");
});

test("nearestBeat 找到最近的拍", () => {
  const grid = { bpm: 120, offsetSec: 0, source: "manual" as const };
  assert.equal(nearestBeat(grid, 5, FPS, 47), 45); // 47 帧 ≈ 1.567s，最近是 1.5s=45 帧
  assert.equal(nearestBeat(grid, 5, FPS, 44), 45);
});

test("非法 BPM 不炸（返回空）", () => {
  assert.deepEqual(beatTimes({ bpm: 0, offsetSec: 0, source: "manual" }, 5), []);
});

/* ─────────────────────────── 增益曲线（压缩结果还原） ─────────────────────────── */

test("curveGainAt：没有曲线 = 1（旧工程逐样本不变）", () => {
  assert.equal(curveGainAt(undefined, 3), 1);
  assert.equal(curveGainAt({ stepMs: 100, values: [] }, 3), 1);
});

test("curveGainAt：采样点之间线性插值", () => {
  const curve = { stepMs: 100, values: [1, 2, 3] };
  assert.equal(curveGainAt(curve, 0), 1);
  assert.equal(curveGainAt(curve, 0.1), 2);
  // 0.15s 落在第 1、2 个采样点中间 → 2 与 3 之间取中
  assert.equal(curveGainAt(curve, 0.15), 2.5);
});

test("curveGainAt：端点之外沿用端点值（尾巴不会突然变响）", () => {
  const curve = { stepMs: 100, values: [2, 4] };
  assert.equal(curveGainAt(curve, -1), 2);
  assert.equal(curveGainAt(curve, 100), 4);
});

/* ─────────────────────────── 配平：目标响度 → 增益 ─────────────────────────── */

test("gainForTarget：安静素材放大到目标", () => {
  const d = gainForTarget({ lufs: -30, peakDb: -20, targetLufs: -16, maxGain: 10 });
  assert.equal(d.limitedBy, "target");
  assert.ok(Math.abs(d.gain - 5.01) < 0.05, `实际 ${d.gain}`);
  // 默认上限是 MAX_VOLUME(5)：同一段素材不放开 maxGain 就会被上限卡住
  assert.equal(gainForTarget({ lufs: -30, peakDb: -20, targetLufs: -16 }).limitedBy, "max");
});

test("gainForTarget：峰值会拦住放大（宁可小声也不爆音）", () => {
  const d = gainForTarget({ lufs: -30, peakDb: -2, targetLufs: -16 });
  assert.equal(d.limitedBy, "peak");
  assert.ok(d.gain < 1.2, `实际 ${d.gain}`);
  // 峰值 -2dBFS + 增益 1.12 ≈ -1dBFS，正好压在默认峰值上限
  assert.ok(Math.abs(20 * Math.log10(d.gain) - 1) < 0.05);
});

test("gainForTarget：太响的素材往下压", () => {
  const d = gainForTarget({ lufs: -10, peakDb: -0.5, targetLufs: -20 });
  assert.ok(Math.abs(d.gain - 0.316) < 0.01, `实际 ${d.gain}`);
});

test("gainForTarget：上限倍数生效，静音素材不动", () => {
  const capped = gainForTarget({ lufs: -60, peakDb: -60, targetLufs: -16, maxGain: 3 });
  assert.equal(capped.limitedBy, "max");
  assert.equal(capped.gain, 3);
  assert.equal(gainForTarget({ lufs: -Infinity, peakDb: -120, targetLufs: -16 }).gain, 1);
});

/* ─────────────────────────── 压缩：响度曲线 → 增益曲线 ─────────────────────────── */

test("buildCompressCurve：安静的段落补、响的段落压（起伏被压平）", () => {
  const lufs = [-40, -40, -12, -12, -40, -40];
  // buildCompressCurve 现在返回 {values, peakLimited, ...}，断言只看 values
  const { values: g } = buildCompressCurve(lufs, { targetLufs: -20, ratio: 4, attackSteps: 1, releaseSteps: 1 });
  assert.ok(g[0] > 1.5, `前段应补：${g[0]}`);
  assert.ok(g[2] < g[0], `响的段落应压得更少：${g[2]} vs ${g[0]}`);
  const flat = summarizeCurve(g);
  assert.ok(flat.max / flat.min > 1.5);
});

test("buildCompressCurve：ratio=1 只做整体增益，轻响差完全保持（不压动态）", () => {
  // 平均 -20 恰好在目标 → 整体增益 0 → 三段增益全 1：轻响差 10dB 原样保留
  const { values: g } = buildCompressCurve([-30, -20, -10], { targetLufs: -20, ratio: 1, attackSteps: 1, releaseSteps: 1 });
  for (const [i, v] of g.entries()) {
    assert.ok(Math.abs(v - 1) < 0.02, `ratio=1 不该改动态（第 ${i} 点 ${v}）`);
  }
  // 平均 -25、目标 -20 → 整体 +5dB，但三段增益必须一致（只有整体平移，动态不变）
  const { values: g2 } = buildCompressCurve([-30, -20, -25], { targetLufs: -20, ratio: 1, attackSteps: 1, releaseSteps: 1 });
  const want = Math.pow(10, 5 / 20);
  for (const [i, v] of g2.entries()) {
    assert.ok(Math.abs(v - want) < 0.05, `整体增益应一致（第 ${i} 点 ${v}，期望 ${want.toFixed(3)}）`);
  }
});

test("buildCompressCurve：静音段不被放大（不把底噪放大成嘶声）", () => {
  const { values: g } = buildCompressCurve([-20, -Infinity, -Infinity], { targetLufs: -20, ratio: 3 });
  assert.equal(g[1], g[0]);
  assert.equal(g[2], g[0]);
});

test("buildCompressCurve：增益被 maxGain 与 MAX_VOLUME 双重夹住", () => {
  const { values: g } = buildCompressCurve([-70, -70, -70], { targetLufs: -16, ratio: 3, maxGainDb: 40, attackSteps: 8 });
  for (const v of g) assert.ok(v <= 5 && v >= 0, `越界 ${v}`);
});

test("summarizeCurve：空曲线返回 1", () => {
  assert.deepEqual(summarizeCurve([]), { min: 1, max: 1, avg: 1 });
});

test("buildCompressCurve：轻响差被压到约 1/ratio（F15 回归锁）", () => {
  // 轻 -30 / 响 -12（差 18dB），目标 = 平均 → 整体增益 0，纯看压缩
  const { values: g } = buildCompressCurve([-30, -30, -12, -12], {
    targetLufs: -21,
    ratio: 3,
    attackSteps: 1,
    releaseSteps: 1,
  });
  const lightDb = 20 * Math.log10(g[0]);
  const loudDb = 20 * Math.log10(g[2]);
  // 施加增益后的实际响度差：(-12 + loudDb) - (-30 + lightDb)，应 ≈ 18/3 = 6dB
  const spreadAfter = -12 + loudDb - (-30 + lightDb);
  assert.ok(Math.abs(spreadAfter - 6) < 0.5, `压后轻响差应 ≈6dB，实测 ${spreadAfter.toFixed(2)}dB`);
});

console.log(`\n音频纯函数测试：${passed} 例通过`);