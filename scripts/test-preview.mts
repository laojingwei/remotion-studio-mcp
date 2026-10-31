/**
 * 预览片段选段单测（纯函数）。
 *
 *   tsx scripts/test-preview.mts
 *
 * 为什么值得单测：选错段落比不预览更糟 —— 用户看了"没问题"的一段，
 * 整片渲出来才发现转场叠字，等于给了他假安心。
 */
import assert from "node:assert/strict";

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

const { pickPreviewRange } = await import("../shared/previewWindow");

const fps = 30;
/** 造 3 幕：0–90 / 90–180 / 180–270 */
const scenes = [
  { id: "s1", durationInFrames: 90 },
  { id: "s2", durationInFrames: 90, transitionIn: { type: "blur", durationInFrames: 14 } },
  { id: "s3", durationInFrames: 90, transitionIn: { type: "none", durationInFrames: 0 } },
];
const spans = [
  { start: 0, dur: 90, end: 90, track: 0 },
  { start: 90, dur: 90, end: 180, track: 0 },
  { start: 180, dur: 90, end: 270, track: 0 },
];
const base = { scenes, spans, totalFrames: 270, fps, seconds: 6 };

console.log("[pickPreviewRange] 选段");

test("有转场 → 挑第一个转场交界，前后各半个窗口", () => {
  const p = pickPreviewRange(base);
  assert.equal(p.kind, "seam", p.kind);
  assert.equal(p.start, 90 - 90, "6 秒窗口 = 180 帧，边界前 90 帧");
  assert.equal(p.end, 180);
  assert.ok(p.reason.includes("blur"), p.reason);
  assert.ok(p.reason.includes("90"), p.reason);
});

test("没有转场 → 退到开头，并说明原因", () => {
  const plain = {
    ...base,
    scenes: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
  };
  const p = pickPreviewRange(plain);
  assert.equal(p.kind, "start");
  assert.equal(p.start, 0);
  assert.equal(p.end, 180);
  assert.ok(p.reason.includes("硬切"), p.reason);
});

test("transitionIn 是 none 不算接缝", () => {
  const p = pickPreviewRange({
    ...base,
    scenes: [
      { id: "s1" },
      { id: "s2", transitionIn: { type: "none", durationInFrames: 0 } },
      { id: "s3", transitionIn: { type: "fade", durationInFrames: 12 } },
    ],
  });
  // 第一个真接缝在 180
  assert.equal(p.kind, "seam");
  assert.ok(p.reason.includes("fade"), p.reason);
  assert.equal(p.end, Math.min(269, 180 + 90));
});

test("有缝（start 被钉死）不算接缝 —— 那不是转场", () => {
  const p = pickPreviewRange({
    ...base,
    spans: [
      { start: 0, dur: 90, end: 90, track: 0 },
      { start: 120, dur: 90, end: 210, track: 0 }, // 中间空了 30 帧
    ],
    totalFrames: 210,
  });
  assert.equal(p.kind, "start", p.kind);
});

test("指定幕 → 前后各带 1 秒", () => {
  const p = pickPreviewRange({ ...base, sceneIds: ["s2"] });
  assert.equal(p.kind, "scenes");
  assert.equal(p.start, 90 - 30);
  assert.equal(p.end, 180 + 30);
});

test("指定多幕 → 从第一幕头到最后一幕尾", () => {
  const p = pickPreviewRange({ ...base, sceneIds: ["s1", "s2"] });
  assert.equal(p.start, 0);
  assert.equal(p.end, 180 + 30);
});

test("指定帧区间优先于指定幕", () => {
  const p = pickPreviewRange({ ...base, range: [10, 40], sceneIds: ["s2"] });
  assert.equal(p.kind, "range");
  assert.equal(p.start, 10);
  assert.equal(p.end, 40);
});

test("帧区间越界会被夹住，不会渲到片尾之外", () => {
  const p = pickPreviewRange({ ...base, range: [250, 9999] });
  assert.equal(p.start, 250);
  assert.equal(p.end, 269);
});

test("sceneIds 全不匹配 → 明确报错（别静默给个开头的片段）", () => {
  assert.throws(() => pickPreviewRange({ ...base, sceneIds: ["nope"] }), /一个都没匹配上/);
});

test("只有一幕：取开头，理由说清「只有一幕」", () => {
  const p = pickPreviewRange({
    scenes: [{ id: "s1" }],
    spans: [{ start: 0, dur: 300, end: 300, track: 0 }],
    totalFrames: 300,
    fps,
    seconds: 6,
  });
  assert.equal(p.kind, "start");
  assert.ok(p.reason.includes("只有一幕"), p.reason);
});

test("片段很短（总长 < 窗口）不会越界", () => {
  const p = pickPreviewRange({
    scenes: [{ id: "s1" }],
    spans: [{ start: 0, dur: 40, end: 40, track: 0 }],
    totalFrames: 40,
    fps,
    seconds: 6,
  });
  assert.equal(p.start, 0);
  assert.equal(p.end, 39);
});

test("画中画（track>0）不参与接缝判断", () => {
  const p = pickPreviewRange({
    scenes: [
      { id: "s1" },
      { id: "s2", transitionIn: { type: "slide", durationInFrames: 12 } },
    ],
    spans: [
      { start: 0, dur: 90, end: 90, track: 0 },
      { start: 90, dur: 90, end: 180, track: 1 }, // 画中画轨，不是主轨接缝
    ],
    totalFrames: 180,
    fps,
    seconds: 6,
  });
  assert.equal(p.kind, "start", p.kind);
});

console.log(failures.length ? `\n失败 ${failures.length} 项` : `\n全部通过：${passed} 个用例`);
if (failures.length) process.exit(1);
