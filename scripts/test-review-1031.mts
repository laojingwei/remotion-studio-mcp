/**
 * 2026-10-31 复盘整改的回归测试（纯函数 + 参数校验，不需要浏览器）。
 *
 * 覆盖四件事，每一件都对应一次真实事故：
 *  1. 嵌套字段写错名不再"假成功"（segments.dur 那次试了四次）；
 *  2. 退役字段给出明确替代名（mustInclude / delivery）；
 *  3. 自由画布的文本与字号能被审计看见（8 幕 95 个元素全在 props 里，审计却一条没读到）；
 *  4. 画幅可以只写 key（"portrait" 不再报 Expected object）。
 */
import assert from "node:assert/strict";
import { TOOLS, validateToolArgs } from "../server/mcp-tools";
import { sceneAuditElements } from "../shared/sceneElements";
import { freeElSchema } from "../shared/freeform";
import { legacyFieldNotice, recomputeDesignLock, stepMissingDetail } from "../server/brief.service";
import { lockViolations } from "../shared/designLock";
import { getMeta } from "../shared/sceneMetas";
import { isMotionScene } from "../shared/sceneKinds";
import { applyOps, createSeedProject } from "../shared/ops";
import { projectSchema } from "../shared/schema";
import { backdropWindow, isFullWindow } from "../shared/backdrop";

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

const tool = (name: string) => {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`没有工具 ${name}`);
  return t;
};

console.log("[param-guard] 嵌套字段名写错要拒绝并指路");
test("segments[].dur 报错，并建议 startSec/endSec", () => {
  assert.throws(
    () => validateToolArgs(tool("save_brief"), { segments: [{ dur: 0, end: 3, content: "钩子" }] }),
    (e: Error) => /segments\[0\]\.dur/.test(e.message) && /startSec/.test(e.message),
  );
});
test("正确写法（startSec/endSec）能过", () => {
  const ok = validateToolArgs(tool("save_brief"), {
    segments: [{ startSec: 0, endSec: 3, content: "钩子" }],
  });
  assert.ok(Array.isArray(ok.segments));
});

console.log("\n[param-guard] 退役字段要给出替代名");
test("mustInclude → 提示改用 mustInfo", () => {
  assert.throws(
    () => validateToolArgs(tool("save_brief"), { mustInclude: ["370"] }),
    /已退役.*mustInfo/,
  );
});
test("delivery → 提示改用 deliverables", () => {
  assert.throws(
    () => validateToolArgs(tool("save_brief"), { delivery: "竖屏" }),
    /已退役.*deliverables/,
  );
});

console.log("\n[param-guard] elementId 收数字要指向 index");
test("elementId: 13 报「按下标请用 index」", () => {
  assert.throws(
    () => validateToolArgs(tool("update_freeform_element"), { sceneId: "s", elementId: 13, patch: {} }),
    /index/,
  );
});

console.log("\n[param-guard] 画幅简写");
test("formats 收 \"portrait\" 字符串", () => {
  const ok = validateToolArgs(tool("set_formats"), { formats: "portrait" });
  assert.equal(ok.formats, "portrait");
});
test("formats 收 [\"portrait\",\"square\"]", () => {
  const ok = validateToolArgs(tool("set_formats"), { formats: ["portrait", "square"] });
  assert.deepEqual(ok.formats, ["portrait", "square"]);
});

console.log("\n[audit-visibility] 自由画布元素要能被审计看见");
test("props.elements 的文本进审计视图", () => {
  const scene = {
    type: "freeform",
    props: { elements: [{ type: "text", text: "370 元" }] },
    elements: [{ id: "el1", kind: "text", text: "字幕里的话" }],
  };
  const els = sceneAuditElements(scene);
  const texts = els.map((e) => e.text);
  assert.ok(texts.includes("370 元"), "props 里的文本丢了");
  assert.ok(texts.includes("字幕里的话"), "叠加层文本丢了");
});
test("freeform 的 text 映射成 kind=text，字号取 size", () => {
  const els = sceneAuditElements({
    type: "freeform",
    props: { elements: [{ type: "text", text: "巨字", size: 19 }] },
  });
  assert.equal(els[0].kind, "text");
  assert.equal(els[0].size, 19);
});
test("fx / shape 不会被当成文字元素", () => {
  const els = sceneAuditElements({
    type: "freeform",
    props: { elements: [{ type: "fx" }, { type: "shape", shape: "rect" }] },
  });
  assert.equal(els.filter((e) => e.kind === "text").length, 0);
});

console.log("\n[freeform] width/height 可单独给，存量行为不变");
test("只给 size 时 schema 仍能过（存量元素不变）", () => {
  const r = freeElSchema.safeParse({ type: "shape", shape: "rect", size: 30 });
  assert.ok(r.success);
});
test("width/height 被接受", () => {
  const r = freeElSchema.safeParse({ type: "shape", shape: "rect", size: 76, width: 76, height: 20 });
  assert.ok(r.success);
});

console.log("\n[brief] 缺项要指名，老字段退役要说明");
test("空 brief 的第 5 步缺 mustInfo（带 key）", () => {
  const miss = stepMissingDetail(5, {} as never);
  assert.equal(miss[0]?.key, "mustInfo");
});
test("空数组也算没填", () => {
  const miss = stepMissingDetail(5, { mustInfo: [] } as never);
  assert.equal(miss.length, 1);
});
test("只有老字段的 brief 给出退役提示", () => {
  const notice = legacyFieldNotice({ mustInclude: ["370"], delivery: "竖屏" } as never);
  assert.ok(notice && /已退役/.test(notice) && /第 5 步/.test(notice) && /第 8 步/.test(notice));
});
test("新字段齐全时不打扰", () => {
  const notice = legacyFieldNotice({
    mustInfo: [{ text: "370" }],
    deliverables: [{ type: "主片", spec: "1080×1920" }],
  } as never);
  assert.equal(notice, null);
});

console.log("\n[motion] 动效场景不参与版面审计");
test("kinetic 里 20 个文字元素不触发密度上限", () => {
  const lock = recomputeDesignLock({ form: "口播讲解" } as never);
  const scenes = [
    {
      id: "s1",
      name: "弹跳字",
      type: "kinetic",
      durationInFrames: 120,
      elements: Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, kind: "text", text: "字", size: 12 })),
    },
  ];
  const v = lockViolations(lock, scenes as never[]);
  assert.equal(v.filter((x: { kind: string }) => x.kind === "elements" || x.kind === "titleSize").length, 0);
});
test("同一批元素放在 title 版式里要报违规（对照组）", () => {
  const lock = recomputeDesignLock({ form: "口播讲解" } as never);
  const scenes = [
    {
      id: "s2",
      name: "标题页",
      type: "title",
      durationInFrames: 120,
      elements: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, kind: "text", text: "字", size: 12 })),
    },
  ];
  const v = lockViolations(lock, scenes as never[]);
  assert.ok(v.some((x: { kind: string }) => x.kind === "elements"));
});
test("动效场景仍然受转场白名单约束", () => {
  const lock = recomputeDesignLock({ form: "口播讲解" } as never);
  const v = lockViolations(lock, [
    { id: "s3", name: "光晕", type: "glow", durationInFrames: 120, transitionIn: { type: "wipe", durationInFrames: 8 }, elements: [] },
  ] as never[]);
  assert.ok(v.some((x: { kind: string }) => x.kind === "transition"));
});
test("12 个动效/氛围类型都注册进 SCENE_METAS，且分类正确", () => {
  const motion = ["glow", "grain", "lightleak", "kinetic", "maskreveal", "typewriter", "counter", "gradienttext", "scramble"];
  const mood = ["bokeh", "sparks", "vhs"];
  for (const t of motion) {
    const m = getMeta(t);
    assert.ok(m, `${t} 没有 meta`);
    assert.equal(m!.category, "动效");
    assert.ok(Object.keys(m!.defaultProps).length > 0);
    assert.ok(isMotionScene(t), `${t} 应在 MOTION_SCENE_TYPES 里（否则会被版面审计误判）`);
    // 默认值必须能过自己的 schema，否则新建这一幕直接报错
    assert.ok(m!.schema.safeParse(m!.defaultProps).success, `${t} 的 defaultProps 过不了 schema`);
  }
  for (const t of mood) {
    const m = getMeta(t);
    assert.ok(m, `${t} 没有 meta`);
    assert.equal(m!.category, "氛围");
    assert.ok(m!.schema.safeParse(m!.defaultProps).success, `${t} 的 defaultProps 过不了 schema`);
  }
});

console.log("\n[backdrop] 氛围层（垫在版式之下）");
test("set_scene_backdrop 能挂上，参数与默认不透明度正确", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const { project } = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "bokeh", props: { count: 20 } } },
  ]);
  const sc = project.scenes.find((x) => x.id === sceneId)!;
  assert.equal(sc.backdrop?.type, "bokeh");
  assert.equal(sc.backdrop?.opacity, 0.8);
  assert.equal((sc.backdrop?.props as { count?: number })?.count, 20);
});
test("带正文的动效不能当氛围层（会出两套字）", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  assert.throws(
    () => applyOps(p, [{ op: "set_scene_backdrop", sceneId, backdrop: { type: "typewriter" } }]),
    /不能当氛围层/,
  );
});
test("backdrop 传 null 清掉", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const first = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "grain" } },
  ]).project;
  const cleared = applyOps(first, [{ op: "set_scene_backdrop", sceneId, backdrop: null }]).project;
  assert.equal(cleared.scenes.find((x) => x.id === sceneId)!.backdrop, undefined);
});
test("氛围层的 props 写错当场报错（不等到渲染黑屏）", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  assert.throws(() =>
    applyOps(p, [
      { op: "set_scene_backdrop", sceneId, backdrop: { type: "bokeh", props: { count: 999 } } },
    ]),
  );
});
test("backdrop 不污染 elements / 不改变时长", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const before = p.scenes[0];
  const { project } = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "sparks" } },
  ]);
  const after = project.scenes.find((x) => x.id === sceneId)!;
  assert.equal(after.durationInFrames, before.durationInFrames);
  assert.deepEqual(after.elements ?? [], before.elements ?? []);
});
test("place 三档都能写入，缺省为「下」", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const d = applyOps(p, [{ op: "set_scene_backdrop", sceneId, backdrop: { type: "grain" } }]).project;
  assert.equal(d.scenes.find((x) => x.id === sceneId)!.backdrop?.place, "下");
  const top = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "grain", place: "顶" } },
  ]).project;
  assert.equal(top.scenes.find((x) => x.id === sceneId)!.backdrop?.place, "顶");
});
test("精细层级 z 会写进 backdrop（与贴纸混排用）", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const r = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "bokeh", z: 12 } },
  ]).project;
  assert.equal(r.scenes.find((x) => x.id === sceneId)!.backdrop?.z, 12);
});
test("层次写错值要被 schema 挡住（只认 下/上/顶）", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const bad = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "grain", place: "最下面" as never } },
  ]).project;
  assert.ok(!projectSchema.safeParse(bad).success);
});

console.log("\n[backdrop-range] 出现区间（from / duration / 淡入淡出）");
test("不填区间 = 铺满整幕，且不写 from/duration 进数据", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const span = p.scenes[0].durationInFrames;
  const sc = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "grain" } },
  ]).project.scenes.find((x) => x.id === sceneId)!;
  assert.equal(sc.backdrop?.from, undefined);
  assert.equal(sc.backdrop?.duration, undefined);
  // 不写柔化字段 = 自动，此时整幕的自动值就是 0
  assert.equal(sc.backdrop?.fadeIn, undefined);
  assert.equal(sc.backdrop?.fadeOut, undefined);
  const w = backdropWindow(sc.backdrop!, span);
  assert.deepEqual(w, { from: 0, duration: span, fadeIn: 0, fadeOut: 0, autoIn: false, autoOut: false });
  assert.ok(isFullWindow(w, span), "整幕应判为 full（渲染端据此不套 Sequence）");
});
test("填了区间能落库，且窗口按它算", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const span = p.scenes[0].durationInFrames;
  const sc = applyOps(p, [
    {
      op: "set_scene_backdrop",
      sceneId,
      backdrop: { type: "bokeh", from: 30, duration: 60, fadeIn: 10, fadeOut: 12 },
    },
  ]).project.scenes.find((x) => x.id === sceneId)!;
  assert.equal(sc.backdrop?.from, 30);
  assert.equal(sc.backdrop?.duration, 60);
  assert.deepEqual(backdropWindow(sc.backdrop!, span), {
    from: 30,
    duration: 60,
    fadeIn: 10,
    fadeOut: 12,
    autoIn: false,
    autoOut: false,
  });
  assert.ok(!isFullWindow(backdropWindow(sc.backdrop!, span), span));
});
test("from 超过幕尾要报错（不静默截断成空画面）", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const span = p.scenes[0].durationInFrames;
  assert.throws(
    () =>
      applyOps(p, [
        { op: "set_scene_backdrop", sceneId, backdrop: { type: "glow", from: span } },
      ]),
    /超出幕尾/,
  );
});
test("from+duration 超过幕长要报错，且提示可用的最大 duration", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const span = p.scenes[0].durationInFrames;
  assert.throws(
    () =>
      applyOps(p, [
        { op: "set_scene_backdrop", sceneId, backdrop: { type: "glow", from: 20, duration: span } },
      ]),
    /超出/,
  );
});
test("淡入+淡出 超过总长要报错", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  assert.throws(
    () =>
      applyOps(p, [
        {
          op: "set_scene_backdrop",
          sceneId,
          backdrop: { type: "grain", duration: 20, fadeIn: 15, fadeOut: 15 },
        },
      ]),
    /一直半透明/,
  );
});
test("越界数据在渲染端被截断（手改 json / 幕被改短时的兜底）", () => {
  // 幕只有 90，数据写着 from=80 duration=200 → 应该被截到 10 帧，不产生负剩余
  const w = backdropWindow({ from: 80, duration: 200 }, 90);
  assert.equal(w.from, 80);
  assert.equal(w.duration, 10);
  // fadeIn 超过总长时按总长封顶，fadeOut 只能是 0
  const w2 = backdropWindow({ from: 0, duration: 10, fadeIn: 99, fadeOut: 99 }, 90);
  assert.equal(w2.fadeIn, 10);
  assert.equal(w2.fadeOut, 0);
  // from 直接越界 → 收到最后一帧
  const w3 = backdropWindow({ from: 999 }, 90);
  assert.equal(w3.from, 89);
  assert.equal(w3.duration, 1);
});
test("区间不影响 hierarchy / props / 时长", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const before = p.scenes[0];
  const sc = applyOps(p, [
    {
      op: "set_scene_backdrop",
      sceneId,
      backdrop: { type: "sparks", from: 10, duration: 40, place: "顶", z: 5, props: { count: 40 } },
    },
  ]).project.scenes.find((x) => x.id === sceneId)!;
  assert.equal(sc.durationInFrames, before.durationInFrames);
  assert.equal(sc.backdrop?.place, "顶");
  assert.equal(sc.backdrop?.z, 5);
  assert.equal((sc.backdrop?.props as { count?: number })?.count, 40);
  assert.ok(isMotionScene(sc.type) || true);
});

console.log("\n[backdrop-soften] 柔化自动跟随幕的出入场转场");
test("区间贴幕首 + 幕有 12 帧入场 → 淡入交给幕（自己不再淡，避免双重变暗）", () => {
  const w = backdropWindow({ from: 0, duration: 60 }, 120, { sceneInFrames: 12 });
  assert.equal(w.fadeIn, 0, "幕已经在淡入，氛围层不该再淡一次");
  assert.equal(w.autoIn, true, "0 是算出来的，不是用户写的");
});
test("区间贴幕首 + 幕本身硬切 → 氛围层自己柔化 8 帧", () => {
  const w = backdropWindow({ from: 0, duration: 60 }, 120, { sceneInFrames: 0 });
  assert.equal(w.fadeIn, 8);
});
test("区间落在幕中间 → 取 max(幕转场, 8)，和这个工程的节奏一致", () => {
  assert.equal(backdropWindow({ from: 40, duration: 40 }, 120, { sceneInFrames: 12 }).fadeIn, 12);
  assert.equal(backdropWindow({ from: 40, duration: 40 }, 120, { sceneInFrames: 4 }).fadeIn, 8);
  assert.equal(backdropWindow({ from: 40, duration: 60 }, 120, { sceneOutFrames: 4 }).fadeOut, 8);
});
test("区间贴幕尾 + 幕有出场 → 淡出交给幕", () => {
  const w = backdropWindow({ from: 60, duration: 60 }, 120, { sceneOutFrames: 14 });
  assert.equal(w.fadeOut, 0);
  assert.equal(w.autoOut, true);
});
test("区间贴幕尾 + 幕靠接缝淡出（outFrames 传接缝）→ 也交给幕", () => {
  const w = backdropWindow({ from: 60, duration: 60 }, 120, { sceneOutFrames: 12 });
  assert.equal(w.fadeOut, 0);
});
test("显式写 0 = 强制硬切，不会被自动值覆盖", () => {
  const w = backdropWindow({ from: 40, duration: 40, fadeIn: 0, fadeOut: 0 }, 120, {
    sceneInFrames: 12,
    sceneOutFrames: 12,
  });
  assert.equal(w.fadeIn, 0);
  assert.equal(w.fadeOut, 0);
  assert.equal(w.autoIn, false);
  assert.equal(w.autoOut, false);
});
test("柔化永远不会超过区间长度（否则整段都是半透明）", () => {
  const w = backdropWindow({ from: 50, duration: 6 }, 120, { sceneInFrames: 12, sceneOutFrames: 12 });
  assert.ok(w.fadeIn + w.fadeOut <= w.duration, `淡入 ${w.fadeIn} + 淡出 ${w.fadeOut} > ${w.duration}`);
  assert.equal(w.fadeIn, 6);
  assert.equal(w.fadeOut, 0);
});
test("铺满整幕时自动柔化恒为 0（存量画面逐像素不变）", () => {
  const w = backdropWindow({}, 120, { sceneInFrames: 12, sceneOutFrames: 12 });
  assert.equal(w.fadeIn, 0);
  assert.equal(w.fadeOut, 0);
  assert.equal(w.autoIn, false);
  assert.ok(isFullWindow(w, 120), "整幕要判成 full，渲染端据此不套 Sequence");
});
test("ops 不写柔化 → 数据里不出现这两个字段（留给渲染端自动算）", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const sc = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "grain", from: 20, duration: 40 } },
  ]).project.scenes.find((x) => x.id === sceneId)!;
  assert.equal(sc.backdrop?.fadeIn, undefined);
  assert.equal(sc.backdrop?.fadeOut, undefined);
});
test("ops 显式写 0 → 数据里保留 0（用户明确要硬切）", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const sc = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "grain", from: 20, duration: 40, fadeIn: 0 } },
  ]).project.scenes.find((x) => x.id === sceneId)!;
  assert.equal(sc.backdrop?.fadeIn, 0);
});

console.log("\n[backdrop-fx] 整层倍速与只播一轮");
test("speed 落库，默认 1", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const plain = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "grain" } },
  ]).project.scenes.find((x) => x.id === sceneId)!;
  assert.equal(plain.backdrop?.speed, 1);
  assert.equal(plain.backdrop?.mode, "loop");
  const fast = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "grain", speed: 2 } },
  ]).project.scenes.find((x) => x.id === sceneId)!;
  assert.equal(fast.backdrop?.speed, 2);
});
test("speed 超界被夹到 0.1–10（不报错，但不让写坏）", () => {
  // 上下限跟着面板滑块走：用户能拖到 10×，后端就不该在 4 处悄悄截断
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const slow = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "glow", speed: 0.01 } },
  ]).project.scenes.find((x) => x.id === sceneId)!;
  assert.equal(slow.backdrop?.speed, 0.1);
  const fast = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "glow", speed: 99 } },
  ]).project.scenes.find((x) => x.id === sceneId)!;
  assert.equal(fast.backdrop?.speed, 10);
});
test("漏光可以设 once（扫一次就停）", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const r = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "lightleak", mode: "once" } },
  ]);
  const sc = r.project.scenes.find((x) => x.id === sceneId)!;
  assert.equal(sc.backdrop?.mode, "once");
  assert.ok(!r.summary.join("").includes("没有"), "漏光不该出现\"没有一轮\"的提示");
});
test("对没有周期的动效写 once → 回执明确提示（不报错，否则用户以为设置生效了）", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const r = applyOps(p, [
    { op: "set_scene_backdrop", sceneId, backdrop: { type: "grain", mode: "once" } },
  ]);
  assert.ok(r.summary.join("").includes("没有"), "应提示 once 对颗粒没有可见效果");
});
test("speed / mode 不改变区间、层级、时长", () => {
  const p = createSeedProject("t");
  const sceneId = p.scenes[0].id;
  const sc = applyOps(p, [
    {
      op: "set_scene_backdrop",
      sceneId,
      backdrop: { type: "lightleak", speed: 1.5, mode: "once", from: 10, duration: 40, place: "顶" },
    },
  ]).project.scenes.find((x) => x.id === sceneId)!;
  assert.equal(sc.backdrop?.from, 10);
  assert.equal(sc.backdrop?.duration, 40);
  assert.equal(sc.backdrop?.place, "顶");
  assert.equal(sc.durationInFrames, p.scenes[0].durationInFrames);
});

test("老工程（没有 backdrop 字段）仍能通过 schema", () => {
  const p = createSeedProject("t");
  const { project } = applyOps(p, [{ op: "set_scene_timing", sceneId: p.scenes[0].id, durationInFrames: 90 }]);
  assert.ok(projectSchema.safeParse(project).success);
});

console.log(`\n${failures.length ? "FAILED" : "全部通过"}：${passed} 个用例`);
if (failures.length) {
  console.error(`失败：${failures.join("、")}`);
  process.exit(1);
}
