/**
 * 轨迹曲线（贝塞尔）的数学与求值验证。
 *
 * 这里验的是四条**改坏就整段轨迹报废**的性质：
 * 1. 零偏移必须精确等于直线（否则所有老数据、所有"没调曲线"的段都会变形）；
 * 2. 两端给相同偏移必须"同向鼓出"（符号约定错了会变成 S 形波，肉眼很难描述但一眼别扭）；
 * 3. 控制点与 out/in 严格互逆（互逆一旦有偏差，拖完手柄松手轨迹就跳）；
 * 4. 自动平滑在共享关键帧处 C1 连续（速度不出折角）。
 */
import assert from "node:assert/strict";
import {
  collinearCos,
  hasCurve,
  mateHandle,
  pathAt,
  pathControls,
  pathTangents,
  smoothAtKey,
  smoothTangents,
  type Vec3,
} from "../shared/scene3dPath";
import { evalNode } from "../shared/scene3dAnim";
import { dslCamera } from "../src/scenes/scene3d/DslScene";
import type { Scene3DDsl } from "../shared/scene3dDsl";

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

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const A: Vec3 = [0, 0, 0];
const B: Vec3 = [6, 0, 0];
const Z: Vec3 = [0, 0, 0];

console.log("[scene3d path] 曲线数学");

ok("零偏移精确退化为直线", () => {
  for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    const p = pathAt(A, B, Z, Z, t);
    assert.ok(near(p[0], 6 * t), `t=${t} x=${p[0]} 应为 ${6 * t}`);
    assert.ok(near(p[1], 0) && near(p[2], 0));
  }
});

ok("端点精确落在起终点", () => {
  assert.deepEqual(pathAt(A, B, [1, 9, -3], [2, -8, 4], 0), A);
  const e = pathAt(A, B, [1, 9, -3], [2, -8, 4], 1);
  assert.ok(near(e[0], 6) && near(e[1], 0) && near(e[2], 0));
});

ok("两端给相同偏移 = 同向鼓出（不是 S 形波）", () => {
  const mid = pathAt(A, B, [0, 4, 0], [0, 4, 0], 0.5);
  assert.ok(mid[1] > 0.9, `中点 y 应明显为正，实得 ${mid[1]}`);
  assert.ok(near(mid[0], 3), `中点 x 应仍在 3，实得 ${mid[0]}`);
  /** 四分之一处也应朝同一侧（S 形波会在后半段翻到负半轴） */
  assert.ok(pathAt(A, B, [0, 4, 0], [0, 4, 0], 0.25)[1] > 0);
});

ok("负偏移 = 反向鼓出", () => {
  assert.ok(pathAt(A, B, [0, -4, 0], [0, -4, 0], 0.5)[1] < -0.9);
});

ok("控制点 ↔ 切线互逆", () => {
  const out: Vec3 = [0.3, 2.5, -1];
  const inn: Vec3 = [-0.8, 1.2, 3];
  const { c1, c2 } = pathControls(A, B, out, inn);
  const back = pathTangents(A, B, c1, c2);
  for (let i = 0; i < 3; i++) {
    assert.ok(near(back.out[i], out[i], 1e-9), `out[${i}] ${back.out[i]} ≠ ${out[i]}`);
    assert.ok(near(back.inn[i], inn[i], 1e-9), `in[${i}] ${back.inn[i]} ≠ ${inn[i]}`);
  }
});

ok("零偏移时控制点落在 A→B 的 1/3、2/3（手柄贴在直线上）", () => {
  const { c1, c2 } = pathControls(A, B, Z, Z);
  assert.deepEqual(c1, [2, 0, 0]);
  assert.deepEqual(c2, [4, 0, 0]);
});

ok("贝塞尔曲线与 Hermite 求值一致（同一组控制点）", () => {
  const out: Vec3 = [0, 3, 0];
  const inn: Vec3 = [0, 3, 0];
  const { c1, c2 } = pathControls(A, B, out, inn);
  for (const t of [0.2, 0.4, 0.5, 0.8]) {
    const bez = (i: number) =>
      Math.pow(1 - t, 3) * A[i] + 3 * Math.pow(1 - t, 2) * t * c1[i] + 3 * (1 - t) * t * t * c2[i] + t * t * t * B[i];
    const h = pathAt(A, B, out, inn, t);
    for (let i = 0; i < 3; i++) assert.ok(near(h[i], bez(i), 1e-9), `t=${t} 轴${i}: ${h[i]} vs ${bez(i)}`);
  }
});

ok("自动平滑：共享关键帧处切线连续（C1）", () => {
  const P0: Vec3 = [0, 0, 0];
  const P1: Vec3 = [4, 2, 0];
  const P2: Vec3 = [8, 0, 0];
  const s0 = smoothTangents(null, P0, P1, P2);
  const s1 = smoothTangents(P0, P1, P2, null);
  /** 前一段终点切线 m1 = d − in；后一段起点切线 m0 = d + out */
  const d0: Vec3 = [P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]];
  const d1: Vec3 = [P2[0] - P1[0], P2[1] - P1[1], P2[2] - P1[2]];
  const m1Prev = [d0[0] - s0.inn[0], d0[1] - s0.inn[1], d0[2] - s0.inn[2]];
  const m0Next = [d1[0] + s1.out[0], d1[1] + s1.out[1], d1[2] + s1.out[2]];
  for (let i = 0; i < 3; i++) {
    assert.ok(near(m1Prev[i], m0Next[i], 1e-9), `轴${i}：入 ${m1Prev[i]} ≠ 出 ${m0Next[i]}`);
  }
});

ok("首末段没有邻居时平滑退化为直线", () => {
  const s = smoothTangents(null, A, B, null);
  assert.deepEqual(s.out, [0, 0, 0]);
  assert.deepEqual(s.inn, [0, 0, 0]);
});

ok("邻居很远时切线限长（否则会甩出一个大钩子）", () => {
  /** 极端场景：当前段只有 10 单位，前一个关键帧在 100 单位开外 */
  const far: Vec3 = [-100, 0, 0];
  const s = smoothTangents(far, A, B, null);
  const len = Math.hypot(s.out[0], s.out[1], s.out[2]);
  assert.ok(len <= 10 * 0.75 + 1e-9, `|out|=${len.toFixed(2)} 应被钳在 ${10 * 0.75}`);
  /** 方向必须保留（沿运动方向拉出），只是幅度受限 */
  assert.ok(s.out[0] > 0, `方向应沿 +X（从 prev 走向 B），实得 ${JSON.stringify(s.out)}`);
  assert.ok(s.out[0] <= 7.5 + 1e-9);
});

ok("零位移段不被邻居拉出小圈", () => {
  const same: Vec3 = [0, 0, 0];
  const s = smoothTangents([-5, 0, 0], same, same, [5, 0, 0]);
  assert.deepEqual(s.out, [0, 0, 0]);
  assert.deepEqual(s.inn, [0, 0, 0]);
});

ok("hasCurve：全零视为直线，任一轴非零视为曲线", () => {
  assert.equal(hasCurve(undefined), false);
  assert.equal(hasCurve({}), false);
  assert.equal(hasCurve({ out: [0, 0, 0], in: [0, 0, 0] }), false);
  assert.equal(hasCurve({ out: [0, 1e-4, 0] }), false, "1e-4 是浮点噪声，不该触发曲线分支");
  assert.equal(hasCurve({ out: [0, 0.01, 0] }), true);
});

ok("长运镜（851 帧、两段）平滑后不超调", () => {
  /**
   * 复刻面板「平滑」的算法：段两端分别取邻居差分的一半。
   * 用户的场景就是这种大跨度运镜——不钳制时曲线会甩出一个远超场景尺度的钩子。
   */
  const P0: Vec3 = [0, 2, 10];
  const P1: Vec3 = [8, 2, 6];
  const P2: Vec3 = [0, 2, 2];
  const seg1 = smoothTangents(null, P0, P1, P2);
  const seg2 = smoothTangents(P0, P1, P2, null);

  const devOf = (a: Vec3, b: Vec3, s: { out: Vec3; inn: Vec3 }) => {
    let max = 0;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const p = pathAt(a, b, s.out, s.inn, t);
      const l = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      max = Math.max(max, Math.hypot(p[0] - l[0], p[1] - l[1], p[2] - l[2]) / len);
    }
    return max;
  };
  const dev1 = devOf(P0, P1, { out: seg1.out, inn: seg1.inn });
  const dev2 = devOf(P1, P2, { out: seg2.out, inn: seg2.inn });
  assert.ok(dev1 < 0.3, `第一段最大偏离 ${(dev1 * 100).toFixed(0)}% 段长，太夸张`);
  assert.ok(dev2 < 0.3, `第二段最大偏离 ${(dev2 * 100).toFixed(0)}% 段长，太夸张`);
});

console.log("[scene3d path] 接入求值");

ok("节点位置走曲线（evalNode）", () => {
  const node = {
    id: "n",
    geometry: { type: "sphere" as const, radius: 1, segments: 16 },
    transform: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: 1 },
    anim: [
      {
        at: [0, 60] as [number, number],
        to: { posX: 6 },
        ease: "linear" as const,
        curve: { out: [0, 4, 0], in: [0, 4, 0] },
      },
    ],
  };
  const mid = evalNode(node as never, 30);
  assert.ok(near(mid.pos[0], 3, 1e-6), `x=${mid.pos[0]}`);
  assert.ok(Math.abs(mid.pos[1] - 1) < 1e-6, `y 应为 1（向上鼓），实得 ${mid.pos[1]}`);
  /** 直线段（无 curve）必须还是原来的逐通道插值 */
  const straight = evalNode({ ...node, anim: [{ ...node.anim[0], curve: undefined }] } as never, 30);
  assert.ok(near(straight.pos[1], 0), "无 curve 时 y 必须保持 0");
});

ok("相机位置走曲线（dslCamera）", () => {
  const spec: Scene3DDsl = {
    camera: {
      position: [0, 0, 10],
      target: [0, 0, 0],
      fov: 40,
      anim: [
        {
          at: [0, 60],
          from: { posX: 0, posY: 0, posZ: 10 },
          to: { posX: 6, posY: 0, posZ: 10 },
          ease: "linear",
          curve: { out: [0, 4, 0], in: [0, 4, 0] },
        },
      ],
    },
    nodes: [{ id: "n", geometry: { type: "sphere", radius: 1, segments: 16 } } as never],
  };
  const mid = dslCamera(spec, 1, 30); // t=1s → frame 30
  assert.ok(Math.abs(mid.worldPos[0] - 3) < 1e-3, `x=${mid.worldPos[0]}`);
  assert.ok(Math.abs(mid.worldPos[1] - 1) < 1e-3, `y=${mid.worldPos[1]}`);
});

ok("相机曲线段仍能和 lookAt 共存（位置走曲线、朝向仍锁目标）", () => {
  const spec: Scene3DDsl = {
    camera: {
      position: [0, 0, 10],
      target: [0, 0, 0],
      fov: 40,
      anim: [
        {
          at: [0, 60],
          from: { posX: 0, posY: 0, posZ: 10 },
          to: { posX: 6, posY: 0, posZ: 10 },
          curve: { out: [0, 4, 0], in: [0, 4, 0] },
          lookAt: "n",
        },
      ],
    },
    nodes: [
      {
        id: "n",
        geometry: { type: "sphere", radius: 1, segments: 16 },
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
      } as never,
    ],
  };
  const mid = dslCamera(spec, 1, 30);
  assert.ok(Math.abs(mid.worldPos[1] - 1) < 1e-3, "机位应在曲线的拱顶附近");
  assert.deepEqual(mid.worldTarget.map((v) => Math.round(v * 1e6) / 1e6), [0, 0, 0]);
  assert.equal(mid.lockId, "n");
});

console.log("[scene3d path] 相切联动（拖一侧，另一侧共线反向跟随）");

ok("对侧手柄与本侧关于锚点共线反向（C1 相切）", () => {
  const anchor: Vec3 = [0, 0, 0];
  const dragged: Vec3 = [3, 4, 0]; // 长度 5
  const mate = mateHandle(anchor, dragged, 5, 2.5); // 对侧原长是它的一半
  assert.ok(Math.abs(collinearCos(anchor, dragged, mate) + 1) < 1e-9, `cos=${collinearCos(anchor, dragged, mate)}`);
  const len = Math.hypot(...mate);
  assert.ok(Math.abs(len - 2.5) < 1e-9, `对侧长度应按比例缩到 2.5，实得 ${len}`);
});

ok("本侧拉长一倍，对侧长度也翻倍（两侧一起伸缩）", () => {
  const anchor: Vec3 = [1, 2, 3];
  const base: Vec3 = [4, 2, 3]; // 长 3
  const twice: Vec3 = [7, 2, 3]; // 长 6
  const m0 = mateHandle(anchor, base, 3, 1.5);
  const m1 = mateHandle(anchor, twice, 3, 1.5);
  assert.ok(Math.abs(Math.hypot(m1[0] - anchor[0], m1[1] - anchor[1], m1[2] - anchor[2]) - 3) < 1e-9);
  assert.ok(m1[0] < m0[0], "本侧往 +X 拉，对侧应更往 −X");
});

ok("原长为 0 时按对称处理，不出 NaN", () => {
  const m = mateHandle([0, 0, 0], [2, 0, 0], 0, 1);
  assert.deepEqual(m, [-2, 0, 0]);
  assert.ok(Number.isFinite(m[0]));
});

ok("拖到锚点上时对侧收回锚点（不产生 NaN 方向）", () => {
  const m = mateHandle([1, 1, 1], [1, 1, 1], 3, 2);
  assert.deepEqual(m, [1, 1, 1]);
});

ok("联动的两段写回后，接缝处切线同向（m1 与 m0 夹角为 0）", () => {
  /** 段1：[0,0,0] → [6,0,0]，段2：[6,0,0] → [12,4,0]。拖段2的出侧手柄，段1 的入侧联动 */
  const K: Vec3 = [6, 0, 0];
  const prev: Vec3 = [0, 0, 0];
  const next: Vec3 = [12, 4, 0];
  const dragged: Vec3 = [8, 3, 0]; // 段2 的新 c1
  const mateC = mateHandle(K, dragged, Math.hypot(2, 3, 0), Math.hypot(2, 0, 0));
  const t1 = pathTangents(prev, K, pathControls(prev, K, [0, 0, 0], [0, 0, 0]).c1, mateC);
  const t2 = pathTangents(K, next, dragged, pathControls(K, next, [0, 0, 0], [0, 0, 0]).c2);
  /** 段1 终切 = (K−prev) − inn1；段2 起切 = (next−K) + out2 */
  const m1: Vec3 = [K[0] - prev[0] - t1.inn[0], K[1] - prev[1] - t1.inn[1], K[2] - prev[2] - t1.inn[2]];
  const m0: Vec3 = [next[0] - K[0] + t2.out[0], next[1] - K[1] + t2.out[1], next[2] - K[2] + t2.out[2]];
  assert.ok(Math.abs(collinearCos([0, 0, 0], m1, m0) - 1) < 1e-9, `两段切线应同向，cos=${collinearCos([0, 0, 0], m1, m0)}`);
});

ok("只平滑某个点：相邻两段拿到同一条切线（C1 相切）", () => {
  const prev: Vec3 = [0, 0, 0];
  const key: Vec3 = [3, 0, 0];
  const next: Vec3 = [6, 0, 2];
  const r = smoothAtKey(prev, key, next, 3, Math.hypot(3, 2));
  assert.ok(r.inPrev && r.outNext);
  const d0: Vec3 = [key[0] - prev[0], key[1] - prev[1], key[2] - prev[2]];
  const d1: Vec3 = [next[0] - key[0], next[1] - key[1], next[2] - key[2]];
  const m1: Vec3 = [d0[0] - r.inPrev![0], d0[1] - r.inPrev![1], d0[2] - r.inPrev![2]];
  const m0: Vec3 = [d1[0] + r.outNext![0], d1[1] + r.outNext![1], d1[2] + r.outNext![2]];
  assert.ok(Math.abs(collinearCos([0, 0, 0], m1, m0) - 1) < 1e-9, `${JSON.stringify(m1)} vs ${JSON.stringify(m0)}`);
});

ok("点平滑时切线限长按较短的那段算（两侧共用同一个上限，不会破坏共线）", () => {
  const prev: Vec3 = [0, 0, 0];
  const key: Vec3 = [10, 0, 0];
  const next: Vec3 = [0, 20, 0];
  const r = smoothAtKey(prev, key, next, 10, 20);
  const d0: Vec3 = [10, 0, 0];
  const m1: Vec3 = [d0[0] - r.inPrev![0], d0[1] - r.inPrev![1], d0[2] - r.inPrev![2]];
  assert.ok(Math.abs(Math.hypot(...m1) - 7.5) < 1e-9, `切长应为 10×0.75=7.5，实得 ${Math.hypot(...m1)}`);
});

ok("端点（只有一侧有段）不硬造切线：返回 null 让调用方保持原样", () => {
  const r = smoothAtKey(null, [0, 0, 0], [3, 0, 0], 0, 3);
  assert.equal(r.inPrev, null);
  assert.equal(r.outNext, null);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
