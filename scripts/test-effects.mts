/**
 * 特效轨单测（纯函数，不需要 remotion / 浏览器）。
 *
 *   npm test
 *
 * 盯三件事：
 *  1. `effectFrameStyle`：区间外零输出、区间内包络正确（开头结尾归零）、多个特效能合并；
 *  2. op 层：add/update/remove_effect 不静默 —— from/intensity 的约束靠 schema 卡，
 *     不存在的 id 必须抛错而不是悄悄吞掉；
 *  3. 旧工程零迁移：没有 effects 字段的工程跑任意 op 后依然没有这个字段。
 */
import assert from "node:assert/strict";
import { applyOps, createSeedProject, type Op } from "../shared/ops";
import {
  EFFECT_OPTIONS,
  effectFrameStyle,
  effectLabel,
  effectParamsOf,
  effectSpan,
  type EffectClip,
} from "../shared/effects";

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

const flash = (id: string, from: number, dur = 24, intensity = 1) => ({
  id,
  kind: "flash" as const,
  name: "闪白",
  from,
  durationInFrames: dur,
  intensity,
});

/** 闪白区间的最后一帧：钟形包络在区间内不会真的归零，但应该已经落下去 */
const flashTail = (clips: ReturnType<typeof flash>[]) =>
  effectFrameStyle(clips, 19).overlays[0]?.opacity;

/* ────────────────────────── effectFrameStyle ────────────────────────── */

test("区间外零输出：没有特效 / 帧不在任何区间里", () => {
  assert.deepEqual(effectFrameStyle(undefined, 10), { overlays: [] });
  assert.deepEqual(effectFrameStyle([], 10), { overlays: [] });
  const s = effectFrameStyle([flash("a", 100, 24)], 50);
  assert.deepEqual(s, { overlays: [] });
  assert.equal(s.transform, undefined);
  assert.equal(s.filter, undefined);
});

test("闪白：中点最亮、开头结尾为 0（overlay 而不是 filter）", () => {
  const clips = [flash("a", 0, 20)];
  const start = effectFrameStyle(clips, 0);
  const mid = effectFrameStyle(clips, 10);
  const after = effectFrameStyle(clips, 20);
  assert.equal(start.overlays[0]?.opacity, 0);
  assert.ok(mid.overlays[0]!.opacity > 0.9, `中点应该接近 1，实际 ${mid.overlays[0]?.opacity}`);
  // 钟形包络：区间内不会真的到 0（最后一帧还有余晖），区间外必须干净
  assert.ok((flashTail(clips) ?? 1) < 0.4);
  assert.equal(after.overlays.length, 0);
  assert.equal(effectFrameStyle(clips, 10).filter, undefined);
});

test("闪白强度 0.5：中点亮度减半", () => {
  const mid = effectFrameStyle([flash("a", 0, 20, 0.5)], 10);
  assert.ok(Math.abs(mid.overlays[0]!.opacity - 0.5) < 0.06, `实际 ${mid.overlays[0]?.opacity}`);
});

test("震动：transform 有位移、越到后面幅度越小", () => {
  const clips = [{ id: "s", kind: "shake" as const, name: "震动", from: 0, durationInFrames: 20, intensity: 1 }];
  const early = effectFrameStyle(clips, 2);
  const late = effectFrameStyle(clips, 17);
  assert.match(early.transform ?? "", /translate\(/);
  // 都是 sin/cos 组合， Late 幅度带 (1-p) 衰减，位移一定小于早段
  const num = (t?: string) => Math.max(...(t ?? "0").match(/-?\d+\.?\d*/g)!.map(Number));
  assert.ok(Math.abs(num(late.transform)) < Math.abs(num(early.transform)));
});

test("冲击：只改 transform 的 scale，中点最大", () => {
  const clips = [{ id: "p", kind: "punch" as const, name: "冲击", from: 0, durationInFrames: 20, intensity: 1 }];
  const mid = effectFrameStyle(clips, 10);
  assert.match(mid.transform ?? "", /scale\(1\.07/);
  assert.equal(mid.filter, undefined);
  assert.doesNotMatch(effectFrameStyle(clips, 0).transform ?? "", /scale\(1\.0[1-9]/);
});

test("模糊：走 filter 不走 transform", () => {
  const clips = [{ id: "b", kind: "blur" as const, name: "模糊", from: 0, durationInFrames: 20, intensity: 1 }];
  const mid = effectFrameStyle(clips, 10);
  assert.match(mid.filter ?? "", /blur\(/);
  assert.equal(mid.transform, undefined);
});

test("多个特效同一帧要合并（transform 拼接、overlays 并列）", () => {
  const clips = [
    flash("f", 0, 20),
    { id: "s", kind: "shake" as const, name: "震动", from: 0, durationInFrames: 20, intensity: 1 },
    { id: "v", kind: "vignette" as const, name: "暗角", from: 0, durationInFrames: 20, intensity: 0.8 },
  ];
  const mid = effectFrameStyle(clips, 10);
  assert.equal(mid.overlays.length, 2);
  assert.match(mid.transform ?? "", /translate\(/);
});

test("effectSpan：from/dur 归整", () => {
  assert.deepEqual(effectSpan({ id: "x", kind: "flash", from: -5, durationInFrames: 0.4 }), {
    start: 0,
    dur: 1,
    end: 1,
  });
});

test("effectLabel：类型都能给出中文名", () => {
  for (const o of EFFECT_OPTIONS) assert.notEqual(effectLabel(o.key), o.key);
  assert.equal(effectLabel("不存在"), "不存在");
});

test("每一种**内置**类型在中点都要真的出效果（不能有死类型）", () => {
  // custom 不在这一条里：它没有关键帧时"什么都不做"是正确行为（schema 也会挡住这种数据）
  for (const o of EFFECT_OPTIONS.filter((x) => !x.agentOnly)) {
    const s = effectFrameStyle(
      [{ id: o.key, kind: o.key, name: o.label, from: 0, durationInFrames: 20, intensity: 1 }],
      10,
    );
    const alive = s.overlays.length > 0 || !!s.transform || !!s.filter;
    assert.ok(alive, `${o.label}（${o.key}）在中点没有任何输出`);
  }
});

test("扫光：一条会移动的渐变高光（不同帧位置不同）", () => {
  const clips = [{ id: "g", kind: "shine" as const, name: "扫光", from: 0, durationInFrames: 20, intensity: 1 }];
  const a = effectFrameStyle(clips, 4).overlays[0]?.background ?? "";
  const b = effectFrameStyle(clips, 15).overlays[0]?.background ?? "";
  assert.match(a, /linear-gradient\(105deg/);
  assert.notEqual(a, b, "高光位置必须随进度移动，否则看着是静止的");
});

test("旋转：只改 transform 的 rotate", () => {
  const mid = effectFrameStyle(
    [{ id: "r", kind: "spin", name: "旋转", from: 0, durationInFrames: 20, intensity: 1 }],
    5,
  );
  assert.match(mid.transform ?? "", /rotate\(/);
  assert.equal(mid.filter, undefined);
});

test("故障：横向错位 + 扫描线覆盖层", () => {
  const mid = effectFrameStyle(
    [{ id: "x", kind: "glitch", name: "故障", from: 0, durationInFrames: 16, intensity: 1 }],
    8,
  );
  assert.match(mid.transform ?? "", /translateX\(/);
  assert.match(mid.overlays[0]?.background ?? "", /repeating-linear-gradient/);
});

test("去色 / 呼吸 / 频闪：都走 filter", () => {
  const mk = (kind: "gray" | "pulse" | "strobe") => [
    { id: kind, kind, name: kind, from: 0, durationInFrames: 20, intensity: 1 },
  ];
  assert.match(effectFrameStyle(mk("gray"), 10).filter ?? "", /grayscale\(/);
  assert.match(effectFrameStyle(mk("pulse"), 10).filter ?? "", /brightness\(/);
  assert.match(effectFrameStyle(mk("strobe"), 7).filter ?? "", /brightness\(/);
  // 频闪要真的在闪：相邻两帧的亮度必须不同
  assert.notEqual(effectFrameStyle(mk("strobe"), 6).filter, effectFrameStyle(mk("strobe"), 9).filter);
});

test("暗角没写 color 时必须是黑色（老工程不能变成「白角」）", () => {
  const mid = effectFrameStyle(
    [{ id: "v", kind: "vignette", from: 0, durationInFrames: 20, intensity: 1 }],
    10,
  );
  assert.match(mid.overlays[0]?.background ?? "", /rgba\(0,0,0/);
});

test("颜色参数生效（闪白可以变闪黑，暗角可以换色）", () => {
  const black = effectFrameStyle(
    [{ id: "b", kind: "flash", name: "闪黑", from: 0, durationInFrames: 20, intensity: 1, color: "#000000" }],
    10,
  );
  assert.equal(black.overlays[0]?.background, "#000000");
  const vign = effectFrameStyle(
    [{ id: "v", kind: "vignette", name: "暗角", from: 0, durationInFrames: 20, intensity: 1, color: "#102030" }],
    10,
  );
  assert.match(vign.overlays[0]?.background ?? "", /rgba\(16,32,48/);
});

/* ────────────────────────── op 层 ────────────────────────── */

const seed = () => createSeedProject();
const one = (p: ReturnType<typeof seed>, op: Op) => {
  const r = applyOps(p, [op]);
  assert.equal(r.project.rev, p.rev + 1, "rev 必须 +1");
  return r;
};

test("add_effect：默认值补齐 + summary 写明区间", () => {
  const { project, summary } = one(seed(), {
    op: "add_effect",
    clip: { kind: "flash", from: 30 },
  });
  const fx = project.effects?.[0];
  assert.ok(fx);
  assert.equal(fx.kind, "flash");
  assert.equal(fx.durationInFrames, 24);
  assert.equal(fx.intensity, 1);
  assert.ok(summary.some((s) => s.includes("第 30 帧")));
});

test("update_effect：野值被 schema 卡住（intensity 2 → 1 的边界校验应抛错）", () => {
  const p = one(seed(), { op: "add_effect", clip: { kind: "flash", from: 0 } }).project;
  const id = p.effects![0].id;
  // intensity 超范围：zod 会抛，绝不能静默落库
  assert.throws(() => applyOps(p, [{ op: "update_effect", effectId: id, patch: { intensity: 2 } }]));
});

test("update_effect：正常改 from/dur/intensity", () => {
  const p = one(seed(), { op: "add_effect", clip: { kind: "shake", from: 0 } }).project;
  const id = p.effects![0].id;
  const r = applyOps(p, [
    { op: "update_effect", effectId: id, patch: { from: 45, durationInFrames: 40, intensity: 0.6 } },
  ]);
  const fx = r.project.effects![0];
  assert.equal(fx.from, 45);
  assert.equal(fx.durationInFrames, 40);
  assert.equal(fx.intensity, 0.6);
});

test("remove_effect：最后一条删掉后字段也要清干净", () => {
  const p = one(seed(), { op: "add_effect", clip: { kind: "punch", from: 0 } }).project;
  const id = p.effects![0].id;
  const r = applyOps(p, [{ op: "remove_effect", effectId: id }]);
  assert.equal(r.project.effects, undefined);
});

test("update/remove 不存在的 id 要抛错（不许静默成功）", () => {
  const p = seed();
  assert.throws(() => applyOps(p, [{ op: "update_effect", effectId: "fx_x", patch: { from: 1 } }]));
  assert.throws(() => applyOps(p, [{ op: "remove_effect", effectId: "fx_x" }]));
});

test("update_effect：换类型时名字跟着换，但用户改过的名保留", () => {
  const p = one(seed(), { op: "add_effect", clip: { kind: "flash", from: 0 } }).project;
  const id = p.effects![0].id;
  assert.equal(p.effects![0].name, "闪白");

  const renamed = applyOps(p, [{ op: "update_effect", effectId: id, patch: { kind: "shake" } }]);
  assert.equal(renamed.project.effects![0].kind, "shake");
  assert.equal(renamed.project.effects![0].name, "震动");

  const custom = applyOps(renamed.project, [
    { op: "update_effect", effectId: id, patch: { name: "我的抖动" } },
  ]).project;
  const again = applyOps(custom, [{ op: "update_effect", effectId: id, patch: { kind: "punch" } }]);
  assert.equal(again.project.effects![0].name, "我的抖动");
});

test("restore 要连 effects 一起回滚（否则撤销不了特效）", () => {
  const base = seed();
  const withFx = one(base, { op: "add_effect", clip: { kind: "glitch", from: 5 } }).project;
  const snap = (effects: unknown) => ({
    scenes: base.scenes,
    theme: base.theme,
    name: base.name,
    audio: base.audio,
    audioTracks: base.audioTracks,
    ...(effects === undefined ? {} : { effects }),
  });

  // 明确 "当时是空数组" → 回滚后必须没有特效
  const back = applyOps(withFx, [
    { op: "restore", project: snap([]) as never },
  ]);
  assert.equal(back.project.effects, undefined, "快照里 effects: [] 时，回滚后必须也没有");

  // 老客户端的内存快照没有 effects 字段 → 不能动现有特效（否则一按 Ctrl+Z 就删光）
  const legacy = applyOps(withFx, [{ op: "restore", project: snap(undefined) as never }]);
  assert.equal(legacy.project.effects?.length, 1, "老快照缺 effects 字段时必须保留当前特效");

  // 有特效的快照 → 原样恢复
  const fxSnapshot = applyOps(withFx, [
    { op: "update_effect", effectId: withFx.effects![0].id, patch: { from: 99 } },
  ]).project;
  const restored = applyOps(withFx, [
    { op: "restore", project: snap(fxSnapshot.effects) as never },
  ]);
  assert.equal(restored.project.effects![0].from, 99);
});


test("旧工程零迁移：没有 effects 的工程跑别的 op 后也不会冒出空数组", () => {
  const p = seed();
  const r = applyOps(p, [{ op: "set_theme", radius: 3 }]);
  assert.equal(r.project.effects, undefined);
});

/* ────────────────────────── 内置特效的可调参数 ────────────────────────── */

test("参数默认值 = 老版本写死的常数（不填 params 时输出逐帧不变）", () => {
  // 拿几个代表类型对比「不传 params」和「显式传全部默认值」，必须一模一样
  for (const kind of ["flash", "shine", "shake", "punch", "blur", "vignette", "strobe"] as const) {
    const bare = effectFrameStyle(
      [{ id: "x", kind, name: "t", from: 0, durationInFrames: 20, intensity: 1 }],
      9,
    );
    const explicit = effectFrameStyle(
      [
        {
          id: "x",
          kind,
          name: "t",
          from: 0,
          durationInFrames: 20,
          intensity: 1,
          params: Object.fromEntries(effectParamsOf(kind).map((p) => [p.key, p.def])),
        },
      ],
      9,
    );
    assert.deepEqual(explicit, bare, `${kind}：显式默认值必须与不填等价`);
  }
});

test("参数真的能改画面：震动幅度 / 模糊半径 / 闪白峰值位置", () => {
  const shake = (amp: number) =>
    effectFrameStyle(
      [{ id: "s", kind: "shake", name: "震动", from: 0, durationInFrames: 20, intensity: 1, params: { amp } }],
      3,
    ).transform ?? "";
  const dx = (t: string) => Math.abs(Number(t.match(/translate\(([-\d.]+)%/)?.[1] ?? "0"));
  assert.ok(dx(shake(4)) > dx(shake(1)), "幅度变大，位移必须变大");

  const blur = (px: number) =>
    effectFrameStyle(
      [{ id: "b", kind: "blur", name: "模糊", from: 0, durationInFrames: 20, intensity: 1, params: { px } }],
      10,
    ).filter ?? "";
  assert.notEqual(blur(10), blur(30), "模糊半径必须可调");

  // 峰值位置：0.2 = 一上来就到最亮 → 第 2 帧比第 18 帧亮
  const flash = (peak: number, frame: number) =>
    effectFrameStyle(
      [{ id: "f", kind: "flash", name: "闪白", from: 0, durationInFrames: 20, intensity: 1, params: { peak } }],
      frame,
    ).overlays[0]?.opacity ?? 0;
  assert.ok(flash(0.15, 2) > flash(0.15, 18), "峰值靠前时，前段应该更亮");
  assert.ok(flash(0.85, 18) > flash(0.85, 2), "峰值靠后时，后段应该更亮");
});

test("进度曲线：out 让同样的帧更早变强", () => {
  const at = (curve: "linear" | "out") =>
    effectFrameStyle(
      [{ id: "f", kind: "flash", name: "闪白", from: 0, durationInFrames: 20, intensity: 1, curve }],
      2,
    ).overlays[0]?.opacity ?? 0;
  assert.ok(at("out") > at("linear"), "先快后慢：早期应该更亮");
});

test("参数超范围直接报错（不静默夹边界）", () => {
  assert.throws(
    () => one(seed(), { op: "add_effect", clip: { kind: "shake", from: 0, params: { amp: 999 } } }),
    /超出范围/,
  );
});

test("update_effect 的 params 按键合并（不会把别的参数打回默认）", () => {
  const p = one(seed(), {
    op: "add_effect",
    clip: { kind: "shake", from: 0, params: { amp: 3, freqX: 30 } },
  }).project;
  const id = p.effects![0].id;
  const q = one(p, { op: "update_effect", effectId: id, patch: { params: { amp: 5 } } }).project;
  assert.equal(q.effects![0].params?.amp, 5);
  assert.equal(q.effects![0].params?.freqX, 30, "没传的键必须保留");
});

/* ────────────────────────── 自定义特效（agent 传关键帧） ────────────────────────── */

const custom = (keys: unknown[], extra: Record<string, unknown> = {}) =>
  ({
    id: "c1",
    kind: "custom" as const,
    name: "自定义",
    from: 0,
    durationInFrames: 20,
    intensity: 1,
    custom: { keys },
    ...extra,
  }) as never;

test("自定义特效：关键帧线性插值出 transform / filter / 覆盖层", () => {
  const clip = custom([
    { p: 0, scale: 1, blur: 0 },
    { p: 0.5, scale: 1.2, blur: 8, overlay: "#FF0055", overlayOpacity: 0.6 },
    { p: 1, scale: 1, blur: 0, overlayOpacity: 0 },
  ]);
  const mid = effectFrameStyle([clip], 10);
  assert.match(mid.transform ?? "", /scale\(1\.2/);
  assert.match(mid.filter ?? "", /blur\(8\.00px\)/);
  assert.equal(mid.overlays[0]?.background, "#FF0055");
  assert.ok((mid.overlays[0]?.opacity ?? 0) > 0.5);

  // 首尾都是中性值 → 区间两端不该有残留效果
  const head = effectFrameStyle([clip], 0);
  assert.match(head.transform ?? "", /scale\(1\.0000\)/);
  assert.equal(head.overlays.length, 0);
});

test("自定义特效：关键帧不必排序，也能正确求值", () => {
  const sorted = custom([
    { p: 0, x: 0 },
    { p: 1, x: 10 },
  ]);
  const messy = custom([
    { p: 1, x: 10 },
    { p: 0, x: 0 },
  ]);
  assert.deepEqual(effectFrameStyle([messy], 5), effectFrameStyle([sorted], 5));
});

test("自定义特效：intensity 是朝中性值收拢，0 = 画面完全原样", () => {
  const clip = custom(
    [
      { p: 0, scale: 1, x: 0 },
      { p: 1, scale: 2, x: 20 },
    ],
    { intensity: 0 },
  );
  const s = effectFrameStyle([clip], 10);
  assert.match(s.transform ?? "", /translate\(0\.00%, 0\.00%\)/);
  assert.match(s.transform ?? "", /scale\(1\.0000\)/);
});

test("自定义特效：ease=back 会过冲（做回弹感），in/out 改变起步速度", () => {
  const back = custom([
    { p: 0, x: 0 },
    { p: 0.5, x: 10, ease: "back" },
  ]);
  const over = Number(
    effectFrameStyle([back], 7).transform?.match(/translate\(([-\d.]+)%/)?.[1] ?? "0",
  );
  assert.ok(over > 10, `back 应该在到达前冲过目标值，实际 ${over}`);

  const at = (ease: "in" | "out" | "linear") =>
    Number(
      effectFrameStyle([custom([{ p: 0, x: 0 }, { p: 1, x: 10, ease }])], 5)
        .transform?.match(/translate\(([-\d.]+)%/)?.[1] ?? "0",
    );
  assert.ok(at("in") < at("linear"), "ease=in 前期更慢");
  assert.ok(at("out") > at("linear"), "ease=out 前期更快");
});

test("自定义特效：p 只有一帧时是恒定值，不会 NaN", () => {
  const one_ = custom([{ p: 0.5, rotate: 5 }]);
  const s = effectFrameStyle([one_], 3);
  assert.match(s.transform ?? "", /rotate\(5\.00deg\)/);
  assert.ok(!(s.transform ?? "").includes("NaN"));
});

test("custom 没有关键帧必须被 schema 挡住（否则是一条永不生效的特效）", () => {
  assert.throws(
    () => one(seed(), { op: "add_effect", clip: { kind: "custom", from: 0 } }),
    /custom/,
  );
});

test("换回内置类型时丢掉自定义关键帧，且 summary 里写明（不静默）", () => {
  const p = one(seed(), {
    op: "add_effect",
    clip: custom([{ p: 0, x: 0 }, { p: 1, x: 8 }]),
  }).project;
  const id = p.effects![0].id;
  const r = applyOps(p, [{ op: "update_effect", effectId: id, patch: { kind: "shake" } }]);
  assert.equal(r.project.effects![0].custom, undefined);
  assert.ok(
    r.summary.some((s) => s.includes("自定义关键帧已丢弃")),
    `summary 必须说明丢弃：${r.summary.join(" / ")}`,
  );
});

test("add_effect 给内置类型带 custom 字段 = 脏数据，要丢掉", () => {
  const p = one(seed(), {
    op: "add_effect",
    clip: { kind: "flash", from: 0, custom: { keys: [{ p: 0, x: 1 }] } },
  }).project;
  assert.equal(p.effects![0].custom, undefined);
});

test("summary 会写清已调哪些参数（回执能看出改了啥）", () => {
  const p = one(seed(), {
    op: "add_effect",
    clip: { kind: "shake", from: 0, params: { amp: 4 } },
  });
  assert.ok(p.summary.join(" ").includes("已调"), p.summary.join(" "));
});

/* ────────────────────────── 循环（第 2 轮踩坑清单的后续需求） ────────────────────────── */

test("循环：进度按单次循环时长反复归零，而不是一次播完", () => {
  const clips: EffectClip[] = [
    { id: "fx1", kind: "flash", from: 0, durationInFrames: 300, loop: true, loopDurationInFrames: 30, intensity: 1 },
  ];
  // 每 30 帧一个钟形循环：第 0 帧（相位 0）≈ 0，第 15 帧（相位 0.5）≈ 峰值 1
  const peak = effectFrameStyle(clips, 15).overlays[0]?.opacity ?? -1;
  const valley = effectFrameStyle(clips, 30).overlays[0]?.opacity ?? -1;
  const peak2 = effectFrameStyle(clips, 285).overlays[0]?.opacity ?? -1; // 第 10 次循环的峰
  assert.ok(peak > 0.9, `第 15 帧应是峰值，实际 ${peak}`);
  assert.ok(valley < 0.05, `第 30 帧应回到谷底，实际 ${valley}`);
  assert.ok(peak2 > 0.9, `第 285 帧仍应循环到峰值，实际 ${peak2}`);
});

test("循环停止：到达 loopStopAfterSeconds 后效果完全退出", () => {
  const clips: EffectClip[] = [
    {
      id: "fx1",
      kind: "vignette",
      from: 0,
      durationInFrames: 3000,
      loop: true,
      loopDurationInFrames: 60,
      loopStopAfterSeconds: 2, // 60 帧（fps=30）后停止
      intensity: 1,
    },
  ];
  const before = effectFrameStyle(clips, 30, 30).overlays.length;
  const after = effectFrameStyle(clips, 61, 30);
  assert.equal(before, 1, "停止点之前正常显示覆盖层");
  assert.equal(after.overlays.length, 0, "停止后覆盖层应完全消失");
  assert.equal(after.opacity, undefined, "停止后不应残留整体透明度");
});

test("非循环行为不变：老工程逐帧一致（回归）", () => {
  const clips: EffectClip[] = [{ id: "fx1", kind: "flash", from: 0, durationInFrames: 24, intensity: 1 }];
  const single = effectFrameStyle(clips, 12).overlays[0]?.opacity ?? -1;
  const loopOff = effectFrameStyle(clips, 12, 30).overlays[0]?.opacity ?? -1;
  assert.equal(single, loopOff, "不传 loop 时输出必须与老版本一致");
});

test("loop 落库：add_effect / update_effect 都能带循环参数", () => {
  const r = one(seed(), {
    op: "add_effect",
    clip: { kind: "pulse", from: 0, durationInFrames: 900, loop: true, loopDurationInFrames: 54, loopStopAfterSeconds: 20 },
  });
  const c = r.project.effects![0];
  assert.equal(c.loop, true);
  assert.equal(c.loopDurationInFrames, 54);
  assert.equal(c.loopStopAfterSeconds, 20);
  const r2 = one(r.project, { op: "update_effect", effectId: c.id, patch: { loopStopAfterSeconds: 5 } });
  assert.equal(r2.project.effects![0].loopStopAfterSeconds, 5, "update_effect 应能改停止秒数");
  assert.equal(r2.project.effects![0].loop, true, "patch 不动其它循环字段");
});

test("色盘输出 rgba() 颜色：渲染必须生效（回归：曾被只认 hex 的解析器当白色）", () => {
  // 面板 ColorPicker 在无 alpha 色盘的浏览器里发 rgba() 字符串（withColorAlpha 的输出）
  const clip: any = {
    id: "fx-r",
    kind: "vignette",
    from: 0,
    durationInFrames: 100,
    color: "rgba(255, 0, 0, 0.4)",
  };
  const s = effectFrameStyle([clip], 50, 30);
  const bg = s.overlays[0]?.background ?? "";
  assert.ok(bg.includes("rgba(255,0,0,"), `红色应进 CSS：${bg}`);
  // alpha 相乘：vignette 外圈基数 0.92 × 颜色自带 0.4 ≈ 0.368
  assert.ok(/0\.3[0-9]{2}\)/.test(bg), `颜色自带 alpha 应参与合成：${bg}`);
});

test("8 位 hex：RGB 与 alpha 通道都参与渲染", () => {
  const clip: any = {
    id: "fx-8",
    kind: "shine",
    from: 0,
    durationInFrames: 100,
    color: "#FFD16680",
  };
  const s = effectFrameStyle([clip], 50, 30);
  const bg = s.overlays[0]?.background ?? "";
  assert.ok(bg.includes("rgba(255,209,102,"), `RGB 应解析：${bg}`);
  // 高光点 alpha 0.9 × 颜色 0x80/255 ≈ 0.451
  assert.ok(/0\.45[0-9]?\)/.test(bg), `alpha 应相乘：${bg}`);
});

test("6 位 hex 行为不变（回归）", () => {
  const clip: any = {
    id: "fx-6",
    kind: "vignette",
    from: 0,
    durationInFrames: 100,
    color: "#FFD166",
  };
  const s = effectFrameStyle([clip], 30, 30);
  const bg = s.overlays[0]?.background ?? "";
  assert.ok(bg.includes("rgba(255,209,102,0.920)"), `6 位 hex 应照常（alpha 基数 0.92）：${bg}`);
});

test("垃圾颜色兜底白色（不抛异常）", () => {
  const clip: any = {
    id: "fx-bad",
    kind: "vignette",
    from: 0,
    durationInFrames: 100,
    color: "not-a-color",
  };
  const s = effectFrameStyle([clip], 30, 30);
  const bg = s.overlays[0]?.background ?? "";
  assert.ok(bg.includes("rgba(255,255,255,"), `垃圾输入应兜底白色：${bg}`);
});

/* ────────────────────────── 汇总 ────────────────────────── */

console.log("");
if (failures.length) {
  console.error(`${failures.length} 个用例失败（通过 ${passed} 个）`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过：${passed} 个用例`);
