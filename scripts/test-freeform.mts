/**
 * 自由画布编辑器辅助函数单测（纯函数，不需要浏览器、不需要起服务）。
 *
 *   npm test
 *
 * 重点覆盖"拖不动"的根因：
 *  关键帧里的 x/y/rotate/scale 是**绝对值**，窗口内会盖住基础值 ——
 *  只改 el.x 的话，画面上纹丝不动，但回读数据又是新值（最难查的一类 bug）。
 */
import assert from "node:assert/strict";
import {
  animTouchesLayout,
  evalAnim,
  freeElementLabel,
  isBackdropElement,
  reorderFreeElements,
  transformFreeElement,
  type FreeEl,
} from "../shared/freeform";

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

const el = (patch: Partial<FreeEl> = {}): FreeEl => ({
  type: "text",
  text: "标题",
  x: 50,
  y: 40,
  size: 10,
  rotate: 0,
  scale: 1,
  opacity: 1,
  from: 0,
  ...patch,
});

/* ────────────────────────── transformFreeElement ────────────────────────── */

test("拖动：只改 x/y，其它字段原样保留", () => {
  const a = el({ fill: "#fff" });
  const b = transformFreeElement(a, { x: 62, y: 33 });
  assert.equal(b.x, 62);
  assert.equal(b.y, 33);
  assert.equal(b.fill, "#fff");
  assert.equal(b.size, 10);
});

test("拖动：不带关键帧时不动 anim", () => {
  const b = transformFreeElement(el(), { x: 60 });
  assert.equal(b.anim, undefined);
});

test("拖动：关键帧里的 x/y 跟着一起平移（否则窗口内拖了等于没拖）", () => {
  const a = el({
    x: 50,
    y: 40,
    anim: [
      { at: [0, 20], from: { opacity: 0, y: 48 }, to: { opacity: 1, y: 40 }, ease: "spring" },
    ],
  });
  const b = transformFreeElement(a, { x: 50, y: 60 }); // 下移 20
  assert.equal(b.y, 60);
  assert.equal(b.anim?.[0].from?.y, 68);
  assert.equal(b.anim?.[0].to?.y, 60);
  // opacity 不属于位移动画，不能被顺手改掉
  assert.equal(b.anim?.[0].from?.opacity, 0);
  assert.equal(b.anim?.[0].to?.opacity, 1);
});

test("拖动：只给 y 时 x 的关键帧也按 dx=0 保持不动", () => {
  const a = el({
    x: 30,
    anim: [{ at: [0, 10], from: { x: 20, y: 30 }, to: { x: 30, y: 40 } }],
  });
  const b = transformFreeElement(a, { y: 55 });
  assert.equal(b.anim?.[0].from?.x, 20);
  assert.equal(b.anim?.[0].from?.y, 45);
});

test("旋转：角度差同步加到关键帧的 rotate 上", () => {
  const a = el({ rotate: 0, anim: [{ at: [0, 12], from: { rotate: -10 }, to: { rotate: 0 } }] });
  const b = transformFreeElement(a, { rotate: 30 });
  assert.equal(b.rotate, 30);
  assert.equal(b.anim?.[0].from?.rotate, 20);
  assert.equal(b.anim?.[0].to?.rotate, 30);
});

test("缩放：关键帧的 scale 按比例缩放，不是加差值", () => {
  const a = el({ scale: 1, anim: [{ at: [0, 12], from: { scale: 0 }, to: { scale: 1 } }] });
  const b = transformFreeElement(a, { scale: 2 });
  assert.equal(b.scale, 2);
  assert.equal(b.anim?.[0].from?.scale, 0);
  assert.equal(b.anim?.[0].to?.scale, 2);
});

test("缩放：clamp 在 0.2~4（和编辑层手柄一致）", () => {
  assert.equal(transformFreeElement(el(), { scale: 9 }).scale, 4);
  assert.equal(transformFreeElement(el(), { scale: 0.01 }).scale, 0.2);
});

test("拖动后整条轨迹确实平移了（用 evalAnim 验算）", () => {
  const a = el({ y: 40, anim: [{ at: [0, 20], from: { y: 48 }, to: { y: 40 } }] });
  const b = transformFreeElement(a, { y: 70 });
  // 动画起点、中段、终点全部 +30
  for (const frame of [0, 10, 20]) {
    const before = evalAnim(a, frame).y;
    const after = evalAnim(b, frame).y;
    assert.ok(Math.abs(after - before - 30) < 0.001, `frame ${frame}: ${before} → ${after}`);
  }
  // 窗口外也只差这 30
  assert.ok(Math.abs(evalAnim(b, 40).y - evalAnim(a, 40).y - 30) < 0.001);
});

test("拖动：x/y 取两位小数（不让浮点尾巴进数据）", () => {
  const b = transformFreeElement(el(), { x: 33.333333, y: 66.666666 });
  assert.equal(b.x, 33.33);
  assert.equal(b.y, 66.67);
});

test("animTouchesLayout：只认位置类关键帧", () => {
  assert.equal(animTouchesLayout(el({ anim: [{ at: [0, 10], to: { y: 10 } }] })), true);
  assert.equal(animTouchesLayout(el({ anim: [{ at: [0, 10], to: { scale: 1 } }] })), true);
  assert.equal(animTouchesLayout(el({ anim: [{ at: [0, 10], to: { opacity: 1 } }] })), false);
  assert.equal(animTouchesLayout(el()), false);
});

/* ────────────────────────── 命名 / 背景层 ────────────────────────── */

test("freeElementLabel：带序号和类型，文字附文案摘要", () => {
  assert.equal(freeElementLabel(el({ text: "好片子" }), 0), "1 · 文字「好片子」");
  assert.ok(freeElementLabel(el({ text: "一二三四五六七八九十十一十二十三" }), 2).includes("…"));
  assert.equal(freeElementLabel(el({ type: "fx", kind: "stars" }), 1), "2 · 特效 stars");
  assert.equal(freeElementLabel(el({ type: "shape", shape: "circle" }), 3), "4 · 形状 circle");
});

test("isBackdropElement：只有特效算背景层", () => {
  assert.equal(isBackdropElement(el({ type: "fx", kind: "glow" })), true);
  assert.equal(isBackdropElement(el({ type: "text" })), false);
  assert.equal(isBackdropElement(el({ type: "shape" })), false);
});

/* ────────────────────────── 图层顺序 ────────────────────────── */

const names = (els: FreeEl[]) => els.map((e) => e.text ?? e.type).join(",");
const three = () => ["a", "b", "c", "d"].map((t) => el({ text: t }));

test("图层：置顶 = 移到数组末尾", () => {
  const r = reorderFreeElements(three(), [0], "front");
  assert.equal(names(r.elements), "b,c,d,a");
  assert.deepEqual(r.moved, [3]);
});

test("图层：置底 = 移到数组开头", () => {
  const r = reorderFreeElements(three(), [3], "back");
  assert.equal(names(r.elements), "d,a,b,c");
  assert.deepEqual(r.moved, [0]);
});

test("图层：上移一层只跟相邻的一个换位", () => {
  const r = reorderFreeElements(three(), [1], "forward");
  assert.equal(names(r.elements), "a,c,b,d");
  assert.deepEqual(r.moved, [2]);
});

test("图层：下移一层", () => {
  const r = reorderFreeElements(three(), [2], "backward");
  assert.equal(names(r.elements), "a,c,b,d");
  assert.deepEqual(r.moved, [1]);
});

test("图层：已在最上时上移是无操作", () => {
  const r = reorderFreeElements(three(), [3], "forward");
  assert.equal(names(r.elements), "a,b,c,d");
  assert.deepEqual(r.moved, [3]);
});

test("图层：多选一起上移时不会互相踩（保持相对顺序）", () => {
  const r = reorderFreeElements(three(), [0, 1], "forward");
  assert.equal(names(r.elements), "c,a,b,d");
  assert.deepEqual(r.moved, [1, 2]);
});

test("图层：多选置顶保持相对顺序", () => {
  const r = reorderFreeElements(three(), [3, 0], "front");
  assert.equal(names(r.elements), "b,c,a,d");
  assert.deepEqual(r.moved, [2, 3]);
});

test("图层：越界序号被忽略，不炸", () => {
  const r = reorderFreeElements(three(), [-1, 9, 1], "front");
  assert.equal(names(r.elements), "a,c,d,b");
  assert.deepEqual(reorderFreeElements([], [0], "front").moved, []);
});

/* ────────────────────────── 收尾 ────────────────────────── */

console.log(`\n${failures.length ? "FAILED" : "全部通过"}：${passed} 个用例`);
if (failures.length) {
  console.error(`失败：${failures.join("、")}`);
  process.exit(1);
}
