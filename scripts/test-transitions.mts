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
  exitStyle,
  exitWindow,
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

test("blinds：mask 黑条占比从 0 涨满整个周期（条纹数固定 6）", () => {
  const openOf = (frame: number) => {
    const s = transitionStyle("blinds", frame, 12);
    const m = String(s.maskImage).match(/#000 0 ([\d.]+)%/);
    assert.ok(m, `mask 格式不对: ${String(s.maskImage)}`);
    return Number(m![1]);
  };
  const period = 100 / 6;
  assert.equal(openOf(0), 0, "第 0 帧条纹全闭");
  assert.ok(near(openOf(6), period / 2), "中点展开一半");
  assert.ok(near(openOf(12), period), "转场结束条纹全开");
  // mask 必须同时带标准与 WebKit 前缀（headless Chrome 两个都认，但卸载时只删一个会漏）
  const s = transitionStyle("blinds", 6, 12);
  assert.ok(s.WebkitMaskImage, "缺 WebkitMaskImage");
});

test("flash：第 0 帧就可见（无 opacity 字段），亮度从 3.6 落回 1", () => {
  const s0 = transitionStyle("flash", 0, 12);
  assert.ok(!("opacity" in s0), "闪白是硬切显影，不能从透明淡入");
  assert.equal(num(s0, "filter"), 3.6);
  assert.equal(num(transitionStyle("flash", 12, 12), "filter"), 1);
});

test("glitch：确定性（同 frame 同结果），幅度随进度衰减到 0", () => {
  const dxOf = (frame: number) => {
    const m = String(transitionStyle("glitch", frame, 12).transform).match(
      /translateX\((-?[\d.]+)%\)/,
    );
    return Number(m![1]);
  };
  assert.equal(dxOf(5), dxOf(5), "同一帧两次计算必须一致（逐帧渲染各帧独立）");
  assert.equal(dxOf(12), 0, "转场结束时必须稳住");
  assert.ok(Math.abs(dxOf(2)) <= 2 + 0.01, "初始横跳不超过 2%");
});

test("diagonal：斜边从左上推进到完全出画", () => {
  const rOf = (frame: number) => {
    const m = String(transitionStyle("diagonal", frame, 12).clipPath).match(
      /polygon\(0 0, ([\d.]+)% 0/,
    );
    assert.ok(m, `clipPath 格式不对`);
    return Number(m![1]);
  };
  assert.equal(rOf(0), 0);
  assert.ok(rOf(6) > 40 && rOf(6) < 70, "中点推进一半");
  assert.equal(rOf(12), 118, "结束时前缘完全出画");
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

/* ─────────────────── 接缝退场：前一幕必须真的离开 ─────────────────── */

test("接缝退场：没有出场转场也要淡到 0（否则前幕文字一直留在画面上）", () => {
  const seam = 12;
  const first = exitStyle(null, 0, seam);
  const mid = exitStyle(null, 5, seam);
  const last = exitStyle(null, seam - 1, seam);
  assert.ok(Number(first.opacity) > 0.85, `第一帧应几乎不透明，实际 ${first.opacity}`);
  assert.ok(Number(mid.opacity) < 0.65 && Number(mid.opacity) > 0.3, `中间应半透明，实际 ${mid.opacity}`);
  assert.equal(Number(last.opacity), 0, `最后一帧必须完全透明，实际 ${last.opacity}`);
});

test("接缝退场：给了出场转场就按它的性格（保留 blur 的 filter）", () => {
  const seam = 12;
  const s = exitStyle({ type: "blur", durationInFrames: 12 }, 2, seam);
  assert.ok(String(s.filter ?? "").includes("blur"), JSON.stringify(s));
  assert.ok(Number(s.opacity) < 1, "仍然要往下压");
});

test("出场窗口末帧必定透明（不管出场设多长）", () => {
  const win = exitWindow({ durationInFrames: 300, seam: 8, transitionOut: { type: "fade", durationInFrames: 30 } });
  const last = exitStyle({ type: "fade", durationInFrames: 30 }, win.len - 1, win.len);
  assert.equal(Number(last.opacity), 0);
});

test("接缝退场：透明度单调下降（中间不能回弹）", () => {
  const seam = 15;
  let prev = 1.1;
  for (let f = 0; f < seam; f++) {
    const o = Number(exitStyle({ type: "slide", durationInFrames: 15 }, f, seam).opacity);
    assert.ok(o <= prev, `第 ${f} 帧 ${o} 比上一帧 ${prev} 还大`);
    prev = o;
  }
  assert.equal(prev, 0);
});

/* ─────────────── 出场窗口：不再被下一幕的入场时长压缩 ─────────────── */

test("出场比接缝长 → 窗口取出场时长，起点提前到接缝之前（这就是用户看到的问题）", () => {
  // 前幕 out=slide 30 帧，下幕 in=blur 12 帧 → 接缝只有 12
  const win = exitWindow({ durationInFrames: 300, seam: 12, transitionOut: { type: "slide", durationInFrames: 30 } });
  assert.equal(win.len, 30, "窗口应该是出场的 30 帧，而不是接缝的 12 帧");
  assert.equal(win.start, 300 + 12 - 30, "起点在接缝前 18 帧（300 - 18）");
  assert.ok(win.start < 300, "必须在幕内就开始退，否则又变成挤进接缝");
});

test("出场比接缝短 → 窗口取接缝长度，行为和以前一致", () => {
  const win = exitWindow({ durationInFrames: 300, seam: 30, transitionOut: { type: "slide", durationInFrames: 12 } });
  assert.equal(win.len, 30, "窗口至少要覆盖接缝，前幕才能真的退出去");
  assert.equal(win.start, 300, "起点正好在接缝处");
});

test("没有接缝（下幕硬切）→ 窗口就是出场自己的时长", () => {
  const win = exitWindow({ durationInFrames: 300, seam: 0, transitionOut: { type: "slide", durationInFrames: 30 } });
  assert.equal(win.len, 30);
  assert.equal(win.start, 270);
});

test("既没接缝也没出场 → 窗口为 0（不做任何样式）", () => {
  const win = exitWindow({ durationInFrames: 300, seam: 0, transitionOut: null });
  assert.equal(win.len, 0);
});

test("出场设得比整幕还长 → 压到整幕，起点不越界", () => {
  const win = exitWindow({ durationInFrames: 100, seam: 10, transitionOut: { type: "slide", durationInFrames: 500 } });
  assert.equal(win.start, 0, "起点不能为负");
  assert.equal(win.len, 110, "窗口 = 幕长 + 接缝");
});

test("入场是 none 时报文无意义，但出场仍按自己的时长走", () => {
  const win = exitWindow({
    durationInFrames: 200,
    seam: 0,
    transitionOut: { type: "blur", durationInFrames: 20 },
  });
  assert.deepEqual(win, { start: 180, len: 20 });
});

/* ────────────────────────── 汇总 ────────────────────────── */

console.log("");
if (failures.length) {
  console.error(`${failures.length} 个用例失败（通过 ${passed} 个）`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过：${passed} 个用例`);
