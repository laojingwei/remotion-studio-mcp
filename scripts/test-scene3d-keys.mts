/**
 * 关键帧 ⇄ 段 的翻译测试（M4）。
 *
 * 这里验的是**正确性主线**：把 agent 写的段反解成关键帧、再重建回段，
 * 逐帧求值必须和原来一致。这条一旦破，用户"打完关键帧画面跳一下"就会成为常态，
 * 而且只在特定段组合下出现——很难靠点界面发现。
 */
import assert from "node:assert/strict";
import type { DslNode } from "../shared/scene3dDsl";
import { evalNode } from "../shared/scene3dAnim";
import {
  NODE_KEY_MAX,
  camAnimFromKeys,
  camHasFollow,
  nodeAnimFromKeys,
  nodeKeyAt,
  nodeKeyFrames,
  nodeKeysOf,
  removeKeyAt,
  shiftKeys,
  stretchKeys,
  upsertKey,
  upsertKeyKeepingZero,
  type CamKey,
  type NodeKey,
} from "../shared/scene3dKeys";

let pass = 0;
let fail = 0;
const ok = (name: string, fn: () => void) => {
  try {
    fn();
    pass++;
    console.log("  ✓", name);
  } catch (e) {
    fail++;
    console.log("  ✗", name, "\n    ", (e as Error).message);
  }
};

const node = (over: Partial<DslNode> = {}): DslNode =>
  ({
    id: "n1",
    geometry: { type: "sphere", radius: 1, segments: 32 },
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    ...over,
  }) as unknown as DslNode;

/** 逐帧比对两个求值结果 */
const sameAt = (a: DslNode, b: DslNode, from: number, to: number) => {
  for (let f = from; f <= to; f++) {
    const x = evalNode(a, f);
    const y = evalNode(b, f);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(x.pos[i] - y.pos[i]) < 1e-3, `第 ${f} 帧 pos${i}: ${x.pos[i]} vs ${y.pos[i]}`);
      assert.ok(Math.abs(x.rot[i] - y.rot[i]) < 1e-3, `第 ${f} 帧 rot${i}: ${x.rot[i]} vs ${y.rot[i]}`);
      assert.ok(Math.abs(x.scale[i] - y.scale[i]) < 1e-3, `第 ${f} 帧 scale${i}`);
    }
    assert.ok(Math.abs(x.opacity - y.opacity) < 1e-3, `第 ${f} 帧 opacity: ${x.opacity} vs ${y.opacity}`);
  }
};

console.log("关键帧 ⇄ 段 翻译");

/* ── 1. 一条普通的两段动画：反解再重建，逐帧一致 ── */
ok("两段位移动画：反解→重建后逐帧一致", () => {
  const src = node({
    anim: [
      { at: [0, 30], from: { posX: 0 }, to: { posX: 2 }, ease: "linear" },
      { at: [30, 60], from: { posX: 2 }, to: { posX: 5, posY: 1 }, ease: "easeOut" },
    ],
  } as Partial<DslNode>);
  const keys = nodeKeysOf(src);
  assert.deepEqual(keys.map((k) => k.frame), [0, 30, 60], "端点帧应去重成 3 颗");
  const rebuilt = node({ anim: nodeAnimFromKeys(keys) as DslNode["anim"] });
  sameAt(src, rebuilt, 0, 60);
});

/* ── 2. 部分通道的段：没动的通道不能被"补齐"成 0 ── */
ok("只动 rotY 的段：重建后位置/缩放/透明度不变", () => {
  const src = node({
    transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: 1.5 },
    anim: [{ at: [0, 40], to: { rotY: 180 }, ease: "easeInOut" }],
  } as Partial<DslNode>);
  const keys = nodeKeysOf(src);
  const rebuilt = node({ transform: src.transform, anim: nodeAnimFromKeys(keys) as DslNode["anim"] });
  sameAt(src, rebuilt, 0, 40);
  // 位置必须还是基础值（只写 rotY 的段不该把位置拉到 0）
  const mid = evalNode(rebuilt, 20);
  assert.ok(Math.abs(mid.pos[0] - 1) < 1e-6 && Math.abs(mid.pos[2] - 3) < 1e-6, "位置漂了");
});

/* ── 3. scale 是乘法：反解成倍率后要能还原 ── */
ok("缩放动画：倍率反解正确（基础 2 × 段内 1→1.5）", () => {
  const src = node({
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 2 },
    anim: [{ at: [0, 20], from: { scale: 1 }, to: { scale: 1.5 }, ease: "linear" }],
  } as Partial<DslNode>);
  const keys = nodeKeysOf(src);
  assert.equal(keys[0].scale, 1, "起点倍率应为 1");
  assert.equal(keys[1].scale, 1.5, "终点倍率应为 1.5");
  const rebuilt = node({ transform: src.transform, anim: nodeAnimFromKeys(keys) as DslNode["anim"] });
  sameAt(src, rebuilt, 0, 20);
  assert.ok(Math.abs(evalNode(rebuilt, 10).scale[0] - 2.5) < 1e-3, "第 10 帧应为 2×1.25=2.5");
});

/* ── 4. 正确写了 from 的相邻段：逐帧一致 ── */
ok("相邻两段（首尾相接、from 写全）：重建后逐帧一致", () => {
  const src = node({
    anim: [
      { at: [0, 30], from: { posX: 0 }, to: { posX: 1 }, ease: "linear" },
      { at: [30, 90], from: { posX: 1 }, to: { posX: 3 }, ease: "linear" },
    ],
  } as Partial<DslNode>);
  assert.deepEqual(nodeKeyFrames(src), [0, 30, 90]);
  const keys = nodeKeysOf(src);
  assert.equal(keys.length, 3);
  const rebuilt = node({ anim: nodeAnimFromKeys(keys) as DslNode["anim"] });
  sameAt(src, rebuilt, 0, 90);
});

/**
 * **段结束后保持终值（hold）**：这是动画系统的标准行为，也是"第 60 帧定好了、
 * 后面不要回到 0"的正解。段外跳过（回基础值）会让最后一颗关键帧看起来没生效。
 */
ok("段结束后保持终值（hold），不回到基础值", () => {
  const src = node({ anim: [{ at: [0, 30], to: { posX: 5 }, ease: "linear" }] } as Partial<DslNode>);
  assert.equal(evalNode(src, 0).pos[0], 0, "起点是基础值");
  assert.equal(evalNode(src, 30).pos[0], 5, "终点是 to 值");
  assert.equal(evalNode(src, 60).pos[0], 5, "段结束后应保持终值");
  assert.equal(evalNode(src, 999).pos[0], 5, "一直到幕尾都保持");
});

ok("两段之间有间隙时保持前一段的终值", () => {
  const src = node({
    anim: [
      { at: [0, 30], to: { posX: 2 }, ease: "linear" },
      { at: [60, 90], to: { posX: 4 }, ease: "linear" },
    ],
  } as Partial<DslNode>);
  assert.equal(evalNode(src, 30).pos[0], 2);
  assert.equal(evalNode(src, 45).pos[0], 2, "间隙里应保持前一段的终值");
  assert.equal(evalNode(src, 60).pos[0], 2, "下一段起点接着前一段");
  assert.equal(evalNode(src, 90).pos[0], 4);
  assert.equal(evalNode(src, 120).pos[0], 4, "最后一段之后继续保持");
});

/**
 * 漏写 `from` 的相邻段：hold 语义下前一段的终值就是后一段的累计值，
 * 边界天然连续（以前会在这一帧跳回基础值）。
 */
ok("漏写 from 的相邻段：hold 语义下边界连续", () => {
  const src = node({
    anim: [
      { at: [0, 30], to: { posX: 1 }, ease: "linear" },
      { at: [30, 90], to: { posX: 3 }, ease: "linear" },
    ],
  } as Partial<DslNode>);
  const at30 = evalNode(src, 30).pos[0];
  const at31 = evalNode(src, 31).pos[0];
  assert.ok(Math.abs(at30 - 1) < 1e-6, `第 30 帧应停在第一段终值：${at30}`);
  assert.ok(at31 > at30 && at30 - at31 > -0.1, `不应跳变：${at30} → ${at31}`);

  const rebuilt = node({ anim: nodeAnimFromKeys(nodeKeysOf(src)) as DslNode["anim"] });
  assert.ok(Math.abs(evalNode(rebuilt, 30).pos[0] - at30) < 1e-3, "关键帧那一帧必须和原画面一致");
  assert.ok(Math.abs(evalNode(rebuilt, 90).pos[0] - 3) < 1e-3, "终点一致");
});

/* ── 5. 编辑器操作：加、删、平移、拉伸 ── */
ok("upsertKey 同帧覆盖、按帧插入", () => {
  const base: NodeKey[] = [
    { frame: 0, pos: [0, 0, 0], rot: [0, 0, 0], scale: 1, opacity: 1, ease: "easeInOut" },
    { frame: 30, pos: [1, 0, 0], rot: [0, 0, 0], scale: 1, opacity: 1, ease: "easeInOut" },
  ];
  const added = upsertKey(base, {
    frame: 15,
    pos: [0.5, 0, 0],
    rot: [0, 0, 0],
    scale: 1,
    opacity: 1,
    ease: "linear",
  });
  assert.deepEqual(added.map((k) => k.frame), [0, 15, 30]);
  const replaced = upsertKey(base, {
    frame: 30,
    pos: [9, 9, 9],
    rot: [0, 0, 0],
    scale: 1,
    opacity: 1,
    ease: "linear",
  });
  assert.equal(replaced.length, 2);
  assert.deepEqual(replaced[1].pos, [9, 9, 9]);
});

ok("removeKeyAt / shiftKeys / stretchKeys", () => {
  const base: NodeKey[] = [0, 20, 40].map((frame) => ({
    frame,
    pos: [frame, 0, 0] as [number, number, number],
    rot: [0, 0, 0] as [number, number, number],
    scale: 1,
    opacity: 1,
    ease: "easeInOut" as const,
  }));
  assert.deepEqual(removeKeyAt(base, 20).map((k) => k.frame), [0, 40]);
  assert.deepEqual(shiftKeys(base, 10).map((k) => k.frame), [10, 30, 50]);
  // 往前挪会被 0 钳住，钳完可能撞车——必须去重
  const clamped = shiftKeys(base, -30);
  assert.deepEqual(clamped.map((k) => k.frame), [0, 10], "钳到 0 后应去重");
  // 拉伸以首帧为锚：0/20/40 × 1.5 → 0/30/60
  assert.deepEqual(stretchKeys(base, 1.5).map((k) => k.frame), [0, 30, 60]);
  // 首帧不在 0 时不该被拽回 0
  const off: NodeKey[] = base.map((k) => ({ ...k, frame: k.frame + 100 }));
  assert.deepEqual(stretchKeys(off, 2).map((k) => k.frame), [100, 140, 180]);
});

/* ── 6. 少于两颗关键帧不成段 ── */
ok("单颗关键帧不生成段（返回 null）", () => {
  const one: NodeKey[] = [{ frame: 10, pos: [1, 0, 0], rot: [0, 0, 0], scale: 1, opacity: 1, ease: "easeInOut" }];
  assert.equal(nodeAnimFromKeys(one), null);
  assert.equal(nodeAnimFromKeys([]), null);
});

/* ── 7. 上限：9 颗关键帧 = 8 段 ── */
ok("上限 9 颗关键帧，正好 8 段", () => {
  const keys: NodeKey[] = Array.from({ length: NODE_KEY_MAX }, (_, i) => ({
    frame: i * 10,
    pos: [i, 0, 0] as [number, number, number],
    rot: [0, 0, 0] as [number, number, number],
    scale: 1,
    opacity: 1,
    ease: "easeInOut" as const,
  }));
  const anim = nodeAnimFromKeys(keys);
  assert.equal(anim!.length, 8);
  assert.deepEqual((anim![0] as { at: number[] }).at, [0, 10]);
  // 9 颗 → 8 段，最后一对是第 8、9 颗（70 → 80）
  assert.deepEqual((anim![7] as { at: number[] }).at, [70, 80]);
});

/* ── 8. 相机段 ── */
ok("相机运镜：三颗关键帧 → 两段，from/to 写全七通道", () => {
  const keys: CamKey[] = [
    { frame: 0, pos: [0, 1.6, 8], target: [0, 0, 0], fov: 42, ease: "easeInOut" },
    { frame: 60, pos: [3, 2, 4], target: [0, 0, 0], fov: 42, ease: "linear" },
    { frame: 120, pos: [0, 0.5, 3], target: [0, 0.5, 0], fov: 55, ease: "easeOut" },
  ];
  const anim = camAnimFromKeys(keys) as Array<{
    at: number[];
    from: Record<string, number>;
    to: Record<string, number>;
    ease: string;
  }>;
  assert.equal(anim.length, 2);
  assert.deepEqual(anim[0].at, [0, 60]);
  assert.equal(anim[0].ease, "easeInOut");
  assert.equal(anim[1].ease, "linear", "每段的缓动跟着起点关键帧走");
  assert.deepEqual(Object.keys(anim[0].from).sort(), [
    "fov",
    "posX",
    "posY",
    "posZ",
    "targetX",
    "targetY",
    "targetZ",
  ]);
  assert.equal(anim[1].to.fov, 55);
  assert.equal(camAnimFromKeys([keys[0]]), null);
});

ok("camHasFollow 能识别跟随段", () => {
  assert.equal(camHasFollow({ anim: [{ at: [0, 10] }] }), false);
  assert.equal(camHasFollow({ anim: [{ at: [0, 10], follow: "earth" }] }), true);
  assert.equal(camHasFollow(undefined), false);
});

/* ────────── "第 0 帧永远是初始位置"这条约定 ────────── */

ok("非 0 帧写关键帧时自动补 0 帧锚点（0 帧不动）", () => {
  // 节点初始在 x=-1.7，用户在 60 帧把它挪到 x=2
  const node = { id: "n", geometry: { type: "sphere", radius: 1 }, transform: { position: [-1.7, 0, 0] } } as unknown as DslNode;
  const key60 = { ...nodeKeyAt(node, 0), frame: 60, pos: [2, 0, 0] as [number, number, number] };
  const keys = upsertKeyKeepingZero(nodeKeysOf(node), key60, nodeKeyAt(node, 0));

  assert.deepEqual(keys.map((k) => k.frame), [0, 60], "必须自动补出第 0 帧");
  assert.equal(keys[0].pos[0], -1.7, "0 帧保持初始位置");

  const rebuilt = { ...node, anim: nodeAnimFromKeys(keys) as DslNode["anim"] };
  assert.equal(evalNode(rebuilt, 0).pos[0], -1.7, "重建后第 0 帧仍是初始位置");
  assert.equal(evalNode(rebuilt, 60).pos[0], 2, "第 60 帧是用户改的值");
  // 中间帧是插值，不是突变
  const mid = evalNode(rebuilt, 30).pos[0];
  assert.ok(mid > -1.7 && mid < 2, `中间帧应插值，实际 ${mid}`);
});

ok("已经有段时不再补 0 帧（保持用户自己的关键帧布局）", () => {
  const keys: NodeKey[] = [
    { frame: 30, pos: [1, 0, 0], rot: [0, 0, 0], scale: 1, opacity: 1, ease: "easeInOut" },
    { frame: 90, pos: [3, 0, 0], rot: [0, 0, 0], scale: 1, opacity: 1, ease: "easeInOut" },
  ];
  const next = upsertKeyKeepingZero(
    keys,
    { frame: 60, pos: [2, 0, 0], rot: [0, 0, 0], scale: 1, opacity: 1, ease: "easeInOut" },
    { frame: 0, pos: [0, 0, 0], rot: [0, 0, 0], scale: 1, opacity: 1, ease: "easeInOut" },
  );
  assert.deepEqual(next.map((k) => k.frame), [30, 60, 90]);
});

ok("同一帧重复打 = 覆盖（不新增、不改其它帧）", () => {
  const keys: NodeKey[] = [
    { frame: 0, pos: [0, 0, 0], rot: [0, 0, 0], scale: 1, opacity: 1, ease: "easeInOut" },
    { frame: 60, pos: [2, 0, 0], rot: [0, 0, 0], scale: 1, opacity: 1, ease: "easeInOut" },
  ];
  const next = upsertKeyKeepingZero(
    keys,
    { frame: 60, pos: [5, 0, 0], rot: [0, 0, 0], scale: 1, opacity: 1, ease: "easeInOut" },
    nodeKeyAt({ id: "n", geometry: { type: "sphere", radius: 1 } } as unknown as DslNode, 0),
  );
  assert.equal(next.length, 2, "覆盖不应该增加颗数");
  assert.equal(next[1].pos[0], 5, "第 60 帧被覆盖成新值");
  assert.equal(next[0].pos[0], 0, "第 0 帧不受影响");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
