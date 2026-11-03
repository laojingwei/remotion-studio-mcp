/**
 * 相机「看向锁定」的求值验证。
 *
 * 验的是三条主线，全都是**肉眼很难发现、但一错整段镜头就废**的东西：
 * 1. 锁定段内 target 每帧等于目标节点世界位置（含节点自己的关键帧动画与父级链）；
 * 2. 退出锁定那一帧位置连续（不甩镜），之后正常飞到新目标；
 * 3. follow + lookAt 同时给时，target 不能被 follow 的平移叠加两次。
 *
 * 用渲染器同一份 `dslCamera`，所以这里过的语义就是成片里的语义。
 */
import assert from "node:assert/strict";
import { dslCamera } from "../src/scenes/scene3d/DslScene";
import type { Scene3DDsl } from "../shared/scene3dDsl";
import { worldPointOf } from "../shared/scene3dTransform";
import { type CamKey, camAnimFromKeys } from "../shared/scene3dKeys";
import { camConstraintAt, camKeyWithPose, camKeysOf, camZeroKeyOf, withCamLookAt } from "../web/panels/scene3dCamKeys";

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

const FPS = 30;
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;
const near3 = (a: readonly number[], b: readonly number[], eps = 1e-3) =>
  near(a[0], b[0], eps) && near(a[1], b[1], eps) && near(a[2], b[2], eps);
const at = (spec: Scene3DDsl, frame: number) => dslCamera(spec, frame / FPS, FPS);

/** 地球：沿 X 轴匀速从 0 走到 6（父级不带动画，够验"每帧重算"） */
const earth = {
  id: "earth",
  label: "地球",
  geometry: { type: "sphere" as const, radius: 1, segments: 24 },
  transform: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: 1 },
  anim: [
    {
      at: [0, 60] as [number, number],
      from: { posX: 0 },
      to: { posX: 6 },
      ease: "linear" as const,
    },
  ],
};

console.log("[scene3d lookAt] 锁定求值");

ok("锁定段内 target 每帧等于目标世界位置", () => {
  const spec: Scene3DDsl = {
    camera: {
      position: [0, 2, 10],
      target: [0, 0, 0],
      fov: 40,
      anim: [
        { at: [0, 60], from: { posX: 0, posY: 2, posZ: 10 }, to: { posX: 8, posY: 2, posZ: 10 }, ease: "linear", lookAt: "earth" },
      ],
    },
    nodes: [earth],
  };
  for (const f of [0, 17, 30, 59]) {
    const c = at(spec, f);
    const w = worldPointOf(spec.nodes, "earth", f)!;
    assert.ok(near3(c.worldTarget, w), `第 ${f} 帧 target=[${c.worldTarget}] 应等于地球 [${w}]`);
    assert.equal(c.lockId, "earth");
  }
});

ok("lookAtOffset 叠加在目标世界位置上", () => {
  const spec: Scene3DDsl = {
    camera: {
      position: [0, 2, 10],
      target: [0, 0, 0],
      fov: 40,
      anim: [{ at: [0, 60], lookAt: "earth", lookAtOffset: [0, 0.6, 0] }],
    },
    nodes: [earth],
  };
  const c = at(spec, 30);
  const w = worldPointOf(spec.nodes, "earth", 30)!;
  assert.ok(near3(c.worldTarget, [w[0], w[1] + 0.6, w[2]]), `期望 y+0.6，实得 [${c.worldTarget}]`);
});

ok("退出锁定：切换帧连续，之后飞到新目标", () => {
  const spec: Scene3DDsl = {
    camera: {
      position: [0, 2, 10],
      target: [0, 0, 0],
      fov: 40,
      anim: [
        { at: [0, 30], lookAt: "earth", from: { posX: 0, posY: 2, posZ: 10 }, to: { posX: 4, posY: 2, posZ: 10 } },
        // 退出段：**故意不写 from.target**，靠自动衔接
        { at: [30, 60], to: { targetX: -5, targetY: 3, targetZ: 0 }, ease: "linear" },
      ],
    },
    nodes: [earth],
  };
  const before = at(spec, 29).worldTarget;
  const atExit = at(spec, 30).worldTarget;
  const earthAtExit = worldPointOf(spec.nodes, "earth", 30)!;
  assert.ok(near3(atExit, earthAtExit), `退出帧应仍看向地球 [${earthAtExit}]，实得 [${atExit}]`);
  assert.ok(near3(before, atExit, 0.35), `退出前后不应跳（差 ${Math.hypot(before[0] - atExit[0], before[1] - atExit[1], before[2] - atExit[2])}）`);
  const end = at(spec, 60).worldTarget;
  assert.ok(near3(end, [-5, 3, 0]), `段末应到新目标，实得 [${end}]`);
  assert.equal(at(spec, 30).lockId, undefined);
});

ok("显式写 from.target 时不自动衔接（尊重作者）", () => {
  const spec: Scene3DDsl = {
    camera: {
      position: [0, 2, 10],
      target: [0, 0, 0],
      fov: 40,
      anim: [
        { at: [0, 30], lookAt: "earth" },
        { at: [30, 60], from: { targetX: 100, targetY: 0, targetZ: 0 }, to: { targetX: 100, targetY: 0, targetZ: 0 } },
      ],
    },
    nodes: [earth],
  };
  assert.ok(near3(at(spec, 30).worldTarget, [100, 0, 0]), "显式 from.target 应生效");
});

ok("锁定持续到片尾（最后一段 hold）", () => {
  const spec: Scene3DDsl = {
    camera: {
      position: [0, 2, 10],
      target: [0, 0, 0],
      fov: 40,
      anim: [{ at: [0, 10], lookAt: "earth" }],
    },
    nodes: [earth],
  };
  const c = at(spec, 200);
  const w = worldPointOf(spec.nodes, "earth", 200)!;
  assert.ok(near3(c.worldTarget, w), `第 200 帧仍应锁地球 [${w}]，实得 [${c.worldTarget}]`);
});

ok("follow + lookAt：target 不被 follow 平移叠加两次", () => {
  /** 相机位置 = 跟随节点偏移 [0,1,4]；看向点 = 节点本身 */
  const spec: Scene3DDsl = {
    camera: {
      position: [0, 0, 0],
      target: [0, 0, 0],
      fov: 40,
      anim: [
        {
          at: [0, 60],
          from: { posX: 0, posY: 1, posZ: 4 },
          to: { posX: 0, posY: 1, posZ: 4 },
          follow: "earth",
          lookAt: "earth",
        },
      ],
    },
    nodes: [earth],
  };
  const f = 40;
  const w = worldPointOf(spec.nodes, "earth", f)!;
  const c = at(spec, f);
  assert.ok(near3(c.worldTarget, w), `target 必须正好是地球 [${w}]，实得 [${c.worldTarget}]（叠加两次会翻倍偏移）`);
  assert.ok(
    near3(c.worldPos, [w[0] + 0, w[1] + 1, w[2] + 4]),
    `相机位置应为地球 + 偏移，实得 [${c.worldPos}]`,
  );
});

ok("锁定目标不存在时 lockId 不生效（不能崩）", () => {
  const spec: Scene3DDsl = {
    camera: { position: [0, 2, 10], target: [0, 0, 0], fov: 40, anim: [{ at: [0, 60], lookAt: "nope" }] },
    nodes: [earth],
  };
  const c = at(spec, 10);
  assert.equal(c.lockId, "nope");
  assert.ok(Number.isFinite(c.worldTarget[0]), "target 必须仍是有限数");
});

console.log("[scene3d lookAt] 编辑器操作（切段 / 打点不丢锁）");

/** 一段带缓动的运镜：用来验"在段中间锁定会不会把整条轨迹改掉" */
const moveCam: Scene3DDsl = {
  camera: {
    position: [0, 2, 10],
    target: [0, 0, 0],
    fov: 40,
    anim: [
      {
        at: [0, 60],
        from: { posX: 0, posY: 2, posZ: 10, targetX: 0, targetY: 0, targetZ: 0, fov: 40 },
        to: { posX: 6, posY: 3, posZ: 8, targetX: 0, targetY: 0, targetZ: 0, fov: 40 },
        ease: "easeInOut",
      },
    ],
  },
  nodes: [earth],
};

ok("段中间锁定：整段机位轨迹不变（只改看向）", () => {
  const r = withCamLookAt(moveCam, 30, "earth", FPS);
  assert.ok("anim" in r, "切段不应报错");
  const next: Scene3DDsl = { ...moveCam, camera: { ...moveCam.camera!, anim: r.anim } };
  let maxDp = 0;
  let maxDfov = 0;
  for (let f = 0; f <= 60; f++) {
    const a = at(moveCam, f);
    const b = at(next, f);
    maxDp = Math.max(maxDp, Math.abs(a.worldPos[0] - b.worldPos[0]), Math.abs(a.worldPos[1] - b.worldPos[1]), Math.abs(a.worldPos[2] - b.worldPos[2]));
    maxDfov = Math.max(maxDfov, Math.abs(a.fov - b.fov));
  }
  assert.ok(maxDp < 0.12, `机位轨迹偏差 ${maxDp.toFixed(3)} 太大（线性重采样失效）`);
  assert.ok(maxDfov < 0.05, `fov 偏差 ${maxDfov.toFixed(3)}`);
  assert.ok(
    near3(at(next, 30).worldTarget, worldPointOf(next.nodes, "earth", 30)!),
    `第 30 帧应已锁向地球，实得 [${at(next, 30).worldTarget}]`,
  );
  assert.ok(near3(at(next, 45).worldTarget, worldPointOf(next.nodes, "earth", 45)!));
  assert.ok((next.camera!.anim ?? []).length <= 14, `重采样段数 ${next.camera!.anim!.length} 超预期`);
});

ok("段中间锁定后，段起点之前的段不受影响（约束只作用于目标段）", () => {
  const base: Scene3DDsl = {
    camera: {
      position: [0, 2, 10],
      target: [0, 0, 0],
      fov: 40,
      anim: [
        { at: [0, 30], from: { posX: 0, posY: 2, posZ: 10 }, to: { posX: 4, posY: 2, posZ: 10 }, ease: "linear" },
        { at: [30, 60], from: { posX: 4, posY: 2, posZ: 10 }, to: { posX: 0, posY: 2, posZ: 10 }, ease: "linear" },
      ],
    },
    nodes: [earth],
  };
  const r = withCamLookAt(base, 45, "earth", FPS);
  assert.ok("anim" in r);
  const next: Scene3DDsl = { ...base, camera: { ...base.camera!, anim: r.anim } };
  assert.ok(near3(at(next, 30).worldTarget, [0, 0, 0]), "第 30 帧（未锁定）看向点不应改变");
  assert.ok(near3(at(next, 20).worldPos, at(base, 20).worldPos), "第 20 帧机位不应改变");
});

ok("无运镜时锁定：只补一个单点段，0 帧机位不动", () => {
  const base: Scene3DDsl = { camera: { position: [0, 2, 10], target: [0, 0, 0], fov: 40 }, nodes: [earth] };
  const r = withCamLookAt(base, 30, "earth", FPS);
  assert.ok("anim" in r);
  assert.equal(r.anim.length, 1);
  assert.deepEqual(r.anim[0].at, [30, 30]);
  const next: Scene3DDsl = { ...base, camera: { ...base.camera!, anim: r.anim } };
  assert.ok(near3(at(next, 0).worldPos, [0, 2, 10]), "0 帧仍用基础机位");
  assert.ok(near3(at(next, 0).worldTarget, [0, 0, 0]), "0 帧仍看原点");
  assert.ok(near3(at(next, 30).worldTarget, worldPointOf(next.nodes, "earth", 30)!));
});

ok("退出锁定：from 里不留 target 通道", () => {
  const locked: Scene3DDsl = {
    camera: {
      position: [0, 2, 10],
      target: [0, 0, 0],
      fov: 40,
      anim: [{ at: [0, 60], lookAt: "earth", from: { posX: 0, posY: 2, posZ: 10 }, to: { posX: 5, posY: 2, posZ: 10 } }],
    },
    nodes: [earth],
  };
  const r = withCamLookAt(locked, 30, null, FPS);
  assert.ok("anim" in r);
  const tail = r.anim.find((a) => Math.round(a.at[0]) === 30)!;
  assert.ok(tail, "应在 30 帧切出退出段");
  assert.equal(tail.lookAt, undefined);
  const f = tail.from as Record<string, number> | undefined;
  assert.equal(f?.targetX, undefined);
  assert.equal(f?.targetY, undefined);
  assert.equal(f?.targetZ, undefined);
});

ok("打关键帧不丢锁定（约束跟着段起点走）", () => {
  const keys: CamKey[] = [
    { frame: 0, pos: [0, 2, 10], target: [0, 0, 0], fov: 40, ease: "easeInOut", lookAt: "earth" },
    { frame: 30, pos: [2, 2, 9], target: [0, 0, 0], fov: 40, ease: "easeInOut", lookAt: "earth" },
    { frame: 60, pos: [4, 2, 8], target: [0, 0, 0], fov: 40, ease: "easeInOut" },
  ];
  const anim = camAnimFromKeys(keys) as Array<{ at: [number, number]; lookAt?: string }> | null;
  assert.ok(anim);
  assert.equal(anim.length, 2);
  assert.equal(anim[0].lookAt, "earth", "第 0–30 段应保持锁定");
  assert.equal(anim[1].lookAt, "earth", "第 30–60 段应保持锁定（key30 是段起点）");
});

ok("camConstraintAt 取当前生效段的约束", () => {
  const g: Scene3DDsl = {
    camera: {
      position: [0, 2, 10],
      target: [0, 0, 0],
      fov: 40,
      anim: [
        { at: [0, 30], lookAt: "earth", lookAtOffset: [0, 0.5, 0] },
        { at: [30, 60] },
      ],
    },
    nodes: [earth],
  };
  assert.equal(camConstraintAt(g, 10).lookAt, "earth");
  assert.deepEqual(camConstraintAt(g, 10).lookAtOffset, [0, 0.5, 0]);
  assert.equal(camConstraintAt(g, 40).lookAt, undefined, "退出段不该再有锁定");
});

ok("camKeyWithPose 继承约束（拖相机 / 打关键帧 / 改数值共用）", () => {
  const locked: Scene3DDsl = {
    camera: { position: [0, 2, 10], target: [0, 0, 0], fov: 40, anim: [{ at: [0, 60], lookAt: "earth" }] },
    nodes: [earth],
  };
  const k = camKeyWithPose(locked, 30, { pos: [1, 2, 3], target: [0, 0, 0], fov: 40 });
  assert.equal(k.frame, 30);
  assert.equal(k.lookAt, "earth", "锁定段里造的关键帧必须带 lookAt，否则拖一下相机锁定就没了");
  assert.deepEqual(k.pos, [1, 2, 3]);

  const free: Scene3DDsl = { camera: { position: [0, 2, 10], target: [0, 0, 0], fov: 40 }, nodes: [earth] };
  assert.equal(camKeyWithPose(free, 30, { pos: [1, 2, 3], target: [0, 0, 0], fov: 40 }).lookAt, undefined);

  const zero = camZeroKeyOf(locked, FPS);
  assert.equal(zero.frame, 0);
  assert.equal(zero.lookAt, "earth", "0 帧锚点也要继承，否则重建后第 0 段失去锁定");
});

ok("锁定段里拖相机：重建后从拖动帧起仍锁定", () => {
  const locked: Scene3DDsl = {
    camera: {
      position: [0, 2, 10],
      target: [0, 0, 0],
      fov: 40,
      anim: [
        {
          at: [0, 60],
          from: { posX: 0, posY: 2, posZ: 10, targetX: 0, targetY: 0, targetZ: 0, fov: 40 },
          to: { posX: 6, posY: 2, posZ: 10, targetX: 0, targetY: 0, targetZ: 0, fov: 40 },
          ease: "linear",
          lookAt: "earth",
        },
      ],
    },
    nodes: [earth],
  };
  /** 模拟 commitCamera：取现有 key（已带约束）→ 用 camKeyWithPose 造第 30 帧那颗 → 重建 */
  const keys = camKeysOf(locked, FPS);
  const k30 = camKeyWithPose(locked, 30, { pos: [3, 2, 9], target: [0, 0, 0], fov: 40 });
  const next = [...keys.filter((k) => k.frame !== 30), k30].sort((a, b) => a.frame - b.frame);
  const anim = camAnimFromKeys(next) as Array<{ at: [number, number]; lookAt?: string }> | null;
  assert.ok(anim);
  const seg30 = anim.find((a) => a.at[0] === 30);
  assert.ok(seg30, "应有一段从 30 帧开始");
  assert.equal(seg30!.lookAt, "earth", "拖动那一帧之后的段必须仍然锁定");
  assert.ok(near3(at({ ...locked, camera: { ...locked.camera!, anim } }, 45).worldTarget, worldPointOf(locked.nodes, "earth", 45)!));
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
