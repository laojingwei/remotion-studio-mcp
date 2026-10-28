/**
 * 转场样式单测（纯函数，不需要 remotion / 浏览器）。
 *
 *   npm test
 *
 * 重点：每种类型在起始/中间/结束帧都必须产出合法数值，
 * 且方向符合预期（淡入从 0 到 1、擦除从 100% 收到 0、推进从放大回到 1 等）。
 */
import assert from "node:assert/strict";
import {
  seamOverlaps,
  TRANSITION_OPTIONS,
  TRANSITION_TYPES,
  transitionStyle,
  type TransitionStyle,
} from "../shared/transitions";

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

/** 从 style 里取一个数值（数字直接用，字符串取第一个数） */
const num = (style: TransitionStyle, key: string): number => {
  const v = style[key];
  assert.ok(v !== undefined, `缺少样式字段 ${key}`);
  const n = typeof v === "number" ? v : Number.parseFloat(String(v).match(/-?\d+(?:\.\d+)?/)?.[0] ?? "NaN");
  assert.ok(Number.isFinite(n), `${key} 不是有限数值: ${String(v)}`);
  return n;
};

const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

/* ────────────────────────── 通用 ────────────────────────── */

test("所有类型在所有关键帧产出有限数值", () => {
  for (const type of TRANSITION_TYPES) {
    for (const frame of [0, 3, 6, 12, 30]) {
      const style = transitionStyle(type, frame, 12, 90);
      for (const [k, v] of Object.entries(style)) {
        if (typeof v === "number") assert.ok(Number.isFinite(v), `${type}.${k}=${v}`);
        else assert.ok(typeof v === "string" && v.length > 0, `${type}.${k} 为空`);
      }
    }
  }
});

test("none 不产生任何样式", () => {
  assert.deepEqual(transitionStyle("none", 5, 12), {});
});

test("转场选项覆盖所有类型，且 label 不重复", () => {
  assert.deepEqual(
    TRANSITION_OPTIONS.map((o) => o.key).sort(),
    [...TRANSITION_TYPES].sort(),
  );
  assert.equal(new Set(TRANSITION_OPTIONS.map((o) => o.label)).size, TRANSITION_OPTIONS.length);
});

/* ────────────────────────── 各类型方向 ────────────────────────── */

test("fade：0 帧透明，转场结束后不透明；场景末尾保留轻微压暗", () => {
  assert.equal(num(transitionStyle("fade", 0, 12, 90), "opacity"), 0);
  assert.equal(num(transitionStyle("fade", 12, 12, 90), "opacity"), 1);
  // 场景最后 6 帧从 1 压到 0.85，给切走一点呼吸感
  assert.equal(num(transitionStyle("fade", 90, 12, 90), "opacity"), 0.85);
});

test("slide：从下往上（translateY 6% → 0）", () => {
  assert.equal(num(transitionStyle("slide", 0, 12), "opacity"), 0);
  assert.equal(num(transitionStyle("slide", 0, 12), "transform"), 6);
  assert.equal(num(transitionStyle("slide", 12, 12), "transform"), 0);
});

test("wipe：裁剪从 100% 收到 0", () => {
  const grab = (frame: number) => {
    const m = String(transitionStyle("wipe", frame, 12).clipPath).match(
      /inset\(0 0 ([\d.]+)% 0\)/,
    );
    assert.ok(m, `clipPath 格式不对: ${String(transitionStyle("wipe", frame, 12).clipPath)}`);
    return Number(m![1]);
  };
  assert.equal(grab(0), 100);
  assert.equal(grab(12), 0);
});

test("zoom：从 1.08 缩回 1", () => {
  assert.ok(near(num(transitionStyle("zoom", 0, 12), "transform"), 1.08));
  assert.equal(num(transitionStyle("zoom", 12, 12), "transform"), 1);
});

test("blur：模糊从 14px 收到 0", () => {
  assert.equal(num(transitionStyle("blur", 0, 12), "filter"), 14);
  assert.equal(num(transitionStyle("blur", 12, 12), "filter"), 0);
});

test("flip：绕竖轴从 90° 翻到 0°", () => {
  const grab = (frame: number) => {
    const m = String(transitionStyle("flip", frame, 12).transform).match(
      /rotateY\(([\d.]+)deg\)/,
    );
    assert.ok(m, `rotateY 格式不对`);
    return Number(m![1]);
  };
  assert.equal(grab(0), 90);
  assert.equal(grab(12), 0);
});

test("circle：半径从 0 扩到 75%", () => {
  assert.equal(num(transitionStyle("circle", 0, 12), "clipPath"), 0);
  assert.equal(num(transitionStyle("circle", 12, 12), "clipPath"), 75);
});

test("超过转场时长后保持结束状态（clamp）", () => {
  assert.equal(num(transitionStyle("fade", 99, 12, 90), "opacity"), 0.85);
  assert.equal(num(transitionStyle("zoom", 99, 12), "transform"), 1);
});

test("frame 为负 / 时长为 0 时不产生 NaN", () => {
  assert.equal(num(transitionStyle("blur", -5, 12), "filter"), 14);
  assert.equal(num(transitionStyle("fade", 0, 0), "opacity"), 0);
});

/* ────────────────── seamOverlaps：接缝重叠 ────────────────── */

/** 造一个 span（start/dur/track → end 自动算） */
const sp = (start: number, dur: number, track = 0) => ({ start, dur, end: start + dur, track });
const fade = (n: number) => ({ type: "fade", durationInFrames: n });

test("seamOverlaps：接缝用下一幕的入场时长，前一幕往后撑", () => {
  const scenes = [{ transitionIn: fade(12) }, { transitionIn: fade(12) }];
  assert.deepEqual(seamOverlaps(scenes, [sp(0, 90), sp(90, 90)]), [12, 0]);
});

test("seamOverlaps：长度永远等于场景数（渲染端按下标取）", () => {
  const scenes = [{}, {}, {}];
  const out = seamOverlaps(scenes, [sp(0, 30), sp(30, 30), sp(60, 30)]);
  assert.equal(out.length, 3);
  assert.deepEqual(out, [0, 0, 0]);
});

test("seamOverlaps：中间有缝（钉死过起点）不算接缝", () => {
  const scenes = [{}, { transitionIn: fade(12) }];
  assert.deepEqual(seamOverlaps(scenes, [sp(0, 90), sp(120, 90)]), [0, 0]);
});

test("seamOverlaps：下一幕是硬切就不重叠", () => {
  const scenes = [{}, { transitionIn: { type: "none", durationInFrames: 12 } }];
  assert.deepEqual(seamOverlaps(scenes, [sp(0, 90), sp(90, 90)]), [0, 0]);
});

test("seamOverlaps：下一幕没有入场转场就不重叠", () => {
  const scenes = [{}, {}];
  assert.deepEqual(seamOverlaps(scenes, [sp(0, 90), sp(90, 90)]), [0, 0]);
});

test("seamOverlaps：画中画不参与接缝（只有主轨算）", () => {
  const scenes = [{}, { transitionIn: fade(12) }];
  assert.deepEqual(seamOverlaps(scenes, [sp(0, 90), sp(90, 60, 1)]), [0, 0]);
});

test("seamOverlaps：重叠不能吃掉前一幕（至少留 1 帧）", () => {
  const scenes = [{}, { transitionIn: fade(30) }];
  assert.deepEqual(seamOverlaps(scenes, [sp(0, 8), sp(8, 90)]), [7, 0]);
});

test("seamOverlaps：不能吃掉后一幕的淡出区（否则淡出时露出前一幕）", () => {
  const scenes = [{}, { transitionIn: fade(30), transitionOut: fade(20) }];
  // 后一幕 40 帧、淡出 20 帧 → 重叠最多 19
  assert.deepEqual(seamOverlaps(scenes, [sp(0, 90), sp(90, 40)]), [19, 0]);
});

test("seamOverlaps：三幕链各自按下一幕算", () => {
  const scenes = [{}, { transitionIn: fade(10) }, { transitionIn: fade(20) }];
  assert.deepEqual(seamOverlaps(scenes, [sp(0, 60), sp(60, 60), sp(120, 60)]), [10, 20, 0]);
});

/* ────────────────────────── 汇总 ────────────────────────── */

console.log("");
if (failures.length) {
  console.error(`${failures.length} 个用例失败（通过 ${passed} 个）`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过：${passed} 个用例`);
