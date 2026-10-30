/**
 * 多轨时间轴单测（纯函数，不需要 remotion / 浏览器）。
 *
 *   npm test
 *
 * 盯三件事：
 *  1. **旧工程行为完全不变** —— 没写 start/track 的工程，spans 必须和"时长累加"逐帧相同，
 *     总时长也必须还是时长之和（这是 M1 零迁移的承诺）。
 *  2. 多轨数学：跨轨可重叠、总时长 = max(end)、sceneOffsets 与 spans 一致。
 *  3. op 层不静默：同轨重叠必须吸附并写进 summary，显式起点不允许被悄悄改掉。
 */
import assert from "node:assert/strict";
import { applyOps, createSeedProject, type Op } from "../shared/ops";
import { sceneSpans, sceneOffsets, totalDuration, type Project, type Scene } from "../shared/schema";
import {
  describeSceneBox,
  isFullFrameBox,
  normalizeSceneBox,
  sceneBoxCss,
} from "../shared/sceneBox";

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

const seed = (): Project => createSeedProject("t_multi");
const one = (p: Project, op: Op) => applyOps(p, [op]);
const sumDur = (p: Project) => p.scenes.reduce((s, x) => s + x.durationInFrames, 0);

/** 造一个只关心时长的最小场景（不碰模板，免得被 clampDuration 改数字） */
const fakeScene = (id: string, dur: number, extra: Partial<Scene> = {}): Scene => ({
  id,
  type: "title",
  name: id,
  durationInFrames: dur,
  props: {},
  ...extra,
});

/* ────────────────────────── 向后兼容 ────────────────────────── */

test("旧工程（无 start/track）：spans 与时长累加完全一致", () => {
  const p = seed();
  // 再随手改两个时长，确保不是恰好相等
  p.scenes[0].durationInFrames = 45;
  const spans = sceneSpans(p.scenes);
  let acc = 0;
  p.scenes.forEach((s, i) => {
    assert.equal(spans[i].start, acc, `第 ${i} 幕起点不对`);
    assert.equal(spans[i].dur, s.durationInFrames);
    assert.equal(spans[i].track, 0);
    acc += s.durationInFrames;
  });
  assert.equal(totalDuration(p), acc);
  assert.equal(totalDuration(p), sumDur(p));
});

test("旧工程：sceneOffsets 仍是累加结果（30 处老调用点不改也能用）", () => {
  const p = seed();
  const offsets = sceneOffsets(p.scenes);
  let acc = 0;
  p.scenes.forEach((s, i) => {
    assert.equal(offsets[i], acc);
    acc += s.durationInFrames;
  });
});

test("空场景 / 空轨道不会算出负数或 NaN", () => {
  assert.equal(totalDuration({ scenes: [] }), 0);
  assert.deepEqual(sceneSpans([]), []);
});

/* ────────────────────────── 多轨数学 ────────────────────────── */

test("显式 start 钉住位置，后面的自动块接着它排", () => {
  const scenes = [fakeScene("a", 30), fakeScene("b", 20, { start: 100 }), fakeScene("c", 10)];
  const spans = sceneSpans(scenes);
  assert.equal(spans[0].start, 0);
  assert.equal(spans[1].start, 100);
  assert.equal(spans[1].end, 120);
  assert.equal(spans[2].start, 120, "c 应该接在 b 后面");
  assert.equal(totalDuration({ scenes }), 130);
});

test("跨轨重叠：总时长 = max(end)，不是时长之和", () => {
  const scenes = [
    fakeScene("main", 90),
    fakeScene("pip", 30, { start: 15, track: 1 }),
  ];
  const spans = sceneSpans(scenes);
  assert.equal(spans[1].start, 15);
  assert.equal(spans[1].track, 1);
  assert.equal(totalDuration({ scenes }), 90);
  assert.notEqual(totalDuration({ scenes }), sumDur({ scenes } as Project));
});

test("每条轨道各自累加，互不干扰", () => {
  const scenes = [
    fakeScene("a", 30), // 轨道 0：0-30
    fakeScene("b", 40), // 轨道 0：30-70
    fakeScene("c", 20, { track: 1 }), // 轨道 1：0-20（不占用主轨水位）
    fakeScene("d", 10, { track: 1 }), // 轨道 1：20-30
    fakeScene("e", 5), // 轨道 0：70-75
  ];
  const spans = sceneSpans(scenes);
  assert.deepEqual(
    spans.map((s) => [s.start, s.end, s.track]),
    [
      [0, 30, 0],
      [30, 70, 0],
      [0, 20, 1],
      [20, 30, 1],
      [70, 75, 0],
    ],
  );
});

test("sceneSpans 是纯函数：不改入参", () => {
  const scenes = [fakeScene("a", 30), fakeScene("b", 20, { start: 5, track: 2 })];
  const snapshot = JSON.stringify(scenes);
  sceneSpans(scenes);
  assert.equal(JSON.stringify(scenes), snapshot);
});

/* ────────────────────────── move_scene ────────────────────────── */

test("move_scene：改起点 + 换轨，落库字段正确", () => {
  const p = seed();
  const id = p.scenes[1].id;
  const r = one(p, { op: "move_scene", sceneId: id, start: 12, track: 1 });
  const moved = r.project.scenes.find((s) => s.id === id)!;
  assert.equal(moved.start, 12);
  assert.equal(moved.track, 1);
  assert.equal(sceneSpans(r.project.scenes)[1].start, 12);
});

test("move_scene：不传 track 保持原轨道，传 0 则把 track 字段删干净", () => {
  const p = seed();
  const id = p.scenes[0].id;
  const a = one(p, { op: "move_scene", sceneId: id, start: 0, track: 2 });
  assert.equal(a.project.scenes[0].track, 2);
  const keep = one(a.project, { op: "move_scene", sceneId: id, start: 10 });
  assert.equal(keep.project.scenes[0].track, 2, "省略 track 不该把它踢回主轨");
  const b = one(a.project, { op: "move_scene", sceneId: id, start: 0, track: 0 });
  assert.equal(b.project.scenes[0].track, undefined);
  assert.ok(!("track" in b.project.scenes[0]));
});

test("move_scene：同轨重叠自动往后吸附，且写进 summary", () => {
  const p = seed();
  const [a, b] = p.scenes;
  // 把第 2 幕拖到第 1 幕中间 → 必须被推到第 1 幕末尾
  const r = one(p, { op: "move_scene", sceneId: b.id, start: 5 });
  const moved = r.project.scenes.find((s) => s.id === b.id)!;
  assert.equal(moved.start, a.durationInFrames);
  assert.ok(
    r.summary.some((s) => s.includes("同轨不能重叠")),
    `summary 没报告吸附：${r.summary.join(" | ")}`,
  );
});

test("move_scene：跨轨重叠允许（这就是画中画的来源）", () => {
  const p = seed();
  const [a, b] = p.scenes;
  const r = one(p, { op: "move_scene", sceneId: b.id, start: 3, track: 1 });
  const moved = r.project.scenes.find((s) => s.id === b.id)!;
  assert.equal(moved.start, 3, "换了轨道就不该被吸附");
  assert.equal(moved.track, 1);
  assert.ok(!r.summary.some((s) => s.includes("同轨不能重叠")));
});

test("move_scene：负数起点夹到 0", () => {
  const p = seed();
  const id = p.scenes[2].id;
  const r = one(p, { op: "move_scene", sceneId: id, start: -50, track: 3 });
  assert.equal(r.project.scenes.find((s) => s.id === id)!.start, 0);
});

/* ────────────────────────── set_scene_box ────────────────────────── */

test("set_scene_box：越界值被夹进合法区间", () => {
  const p = seed();
  const id = p.scenes[0].id;
  const r = one(p, {
    op: "set_scene_box",
    sceneId: id,
    box: { x: 500, y: -20, scale: 9, radius: 900, opacity: 3 },
  });
  const box = r.project.scenes[0].box!;
  assert.equal(box.x, 100);
  assert.equal(box.y, 0);
  assert.equal(box.scale, 1);
  assert.equal(box.radius, 50);
  assert.equal(box.opacity, 1);
  assert.equal(box.shadow, true, "投影默认开");
});

test("set_scene_box：部分更新不会把没传的字段冲掉", () => {
  const p = seed();
  const id = p.scenes[0].id;
  const a = one(p, { op: "set_scene_box", sceneId: id, box: { x: 72, y: 26, scale: 0.34 } });
  const b = one(a.project, { op: "set_scene_box", sceneId: id, box: { radius: 3 } });
  const box = b.project.scenes[0].box!;
  assert.equal(box.x, 72);
  assert.equal(box.y, 26);
  assert.equal(box.scale, 0.34);
  assert.equal(box.radius, 3);
});

test("set_scene_box：null 恢复全屏（字段整个删掉，不留半截）", () => {
  const p = seed();
  const id = p.scenes[0].id;
  const a = one(p, { op: "set_scene_box", sceneId: id, box: { scale: 0.4 } });
  const b = one(a.project, { op: "set_scene_box", sceneId: id, box: null });
  assert.equal(b.project.scenes[0].box, undefined);
  assert.ok(b.summary.some((s) => s.includes("全屏")));
});

test("全屏框 = 不生成任何样式（旧工程逐像素一致的保证）", () => {
  assert.equal(sceneBoxCss(undefined, 1080, 1920), null);
  assert.equal(sceneBoxCss(normalizeSceneBox({}), 1080, 1920), null);
  assert.equal(sceneBoxCss({ x: 50, y: 50, scale: 1 }, 1080, 1920), null);
  assert.ok(isFullFrameBox({ x: 50, y: 50, scale: 1, radius: 0 }));
  assert.ok(!isFullFrameBox({ x: 50, y: 50, scale: 0.5 }));
});

test("画中画框：位移用百分比、圆角按 scale 预放大", () => {
  const css = sceneBoxCss({ x: 70, y: 30, scale: 0.5, radius: 4 }, 1000, 1000)!;
  assert.ok(String(css.transform).includes("translate(20.000%, -20.000%)"), String(css.transform));
  assert.ok(String(css.transform).includes("scale(0.5)"));
  // 4% × 1000 = 40px，再除以 0.5 → 80px，缩放回来正好 40px
  assert.equal(css.borderRadius, 80);
  assert.equal(css.overflow, "hidden");
});

test("describeSceneBox：全屏返回空串，小窗说人话", () => {
  assert.equal(describeSceneBox(undefined), "");
  const desc = describeSceneBox({ x: 72, y: 26, scale: 0.34, radius: 3 });
  assert.ok(desc.includes("72% / 26%"), desc);
  assert.ok(desc.includes("缩放 34%"), desc);
});

/* ────────────────────────── 与既有 op 的配合 ────────────────────────── */

test("add_scene 支持直接落在画中画轨（start + track）", () => {
  const p = seed();
  const before = p.scenes.length;
  const r = one(p, {
    op: "add_scene",
    type: p.scenes[0].type,
    start: 20,
    track: 1,
    durationInFrames: 60,
  });
  assert.equal(r.project.scenes.length, before + 1);
  const added = r.project.scenes[r.project.scenes.length - 1];
  assert.equal(added.start, 20);
  assert.equal(added.track, 1);
});

test("duplicate_scene 不带 start：副本接在原块后面而不是重合", () => {
  const p = seed();
  const id = p.scenes[1].id;
  const withStart = one(p, { op: "move_scene", sceneId: id, start: 40, track: 1 });
  const dup = one(withStart.project, { op: "duplicate_scene", sceneId: id });
  const copies = dup.project.scenes.filter((s) => s.name.endsWith("副本"));
  assert.equal(copies.length, 1);
  assert.equal(copies[0].start, undefined, "副本不该继承原块的 start");
  const spans = sceneSpans(dup.project.scenes);
  const src = spans.find((s) => s.id === id)!;
  const copy = spans.find((s) => s.id === copies[0].id)!;
  assert.equal(copy.start, src.end, "副本应紧接原块");
});

test("set_scene_timing 变长：同轨钉死起点的后一块被推开，且写进 summary", () => {
  const p = seed();
  const [a, b] = p.scenes;
  const moved = one(p, { op: "move_scene", sceneId: b.id, start: a.durationInFrames });
  const longer = moved.project.scenes[0].durationInFrames + 60;
  const r = one(moved.project, {
    op: "set_scene_timing",
    sceneId: a.id,
    durationInFrames: longer,
  });
  const spans = sceneSpans(r.project.scenes);
  const bSpan = spans.find((s) => s.id === b.id)!;
  assert.equal(bSpan.start, longer, "后一块应被推到新末尾");
  assert.ok(r.summary.some((s) => s.includes("同轨不能重叠")), r.summary.join(" | "));
});

test("set_scene_timing 变长：没写 start 的后一块自动跟着走（旧行为不变）", () => {
  const p = seed();
  const [a, b] = p.scenes;
  const longer = a.durationInFrames + 60;
  const r = one(p, { op: "set_scene_timing", sceneId: a.id, durationInFrames: longer });
  const spans = sceneSpans(r.project.scenes);
  assert.equal(spans.find((s) => s.id === b.id)!.start, longer);
  assert.equal(r.project.scenes.find((s) => s.id === b.id)!.start, undefined);
});

test("同轨判重叠按时间先后，不按数组顺序（拖后面的块不该推走前面那块）", () => {
  const p = seed();
  const [first, second, third] = p.scenes;
  // 轨道 1：第二幕钉在 40，第三幕钉在 200（数组顺序仍是 2 在前）
  const a = one(p, { op: "move_scene", sceneId: second.id, start: 40, track: 1 });
  // 留足空隙（第二幕自己也有时长），确保两块真的不重叠
  const far = 40 + second.durationInFrames + 100;
  const b = one(a.project, { op: "move_scene", sceneId: third.id, start: far, track: 1 });
  const sp = sceneSpans(b.project.scenes);
  const s1 = sp.find((x) => x.id === second.id)!;
  const s2 = sp.find((x) => x.id === third.id)!;
  assert.equal(s1.start, 40, "时间早的块不该被后面那块挤走");
  assert.equal(s2.start, far);
  assert.ok(!b.summary.some((x) => x.includes("同轨不能重叠")), b.summary.join(" | "));
});

test("同轨判重叠：真的重叠时才推，且推的是时间靠后那一块", () => {
  const p = seed();
  const [, second, third] = p.scenes;
  const a = one(p, { op: "move_scene", sceneId: second.id, start: 40, track: 1 });
  // 第三幕钉在 60 → 与第二幕 40..(40+dur) 真重叠
  const b = one(a.project, { op: "move_scene", sceneId: third.id, start: 60, track: 1 });
  const sp = sceneSpans(b.project.scenes);
  const s1 = sp.find((x) => x.id === second.id)!;
  const s2 = sp.find((x) => x.id === third.id)!;
  assert.equal(s1.start, 40, "时间早的块留在原位");
  assert.ok(s2.start >= s1.end, `后一块应被推到 ${s1.end}，实际 ${s2.start}`);
  assert.ok(b.summary.some((x) => x.includes("同轨不能重叠")), b.summary.join(" | "));
});

test("compact_main_track：清掉主轨自定义起点，非主轨不动", () => {
  const p = seed();
  const [a, , third] = p.scenes;
  // 主轨钉死起点 + 轨道 1 也钉一个
  const m1 = one(p, { op: "move_scene", sceneId: a.id, start: 120, track: 0 });
  const m2 = one(m1.project, { op: "move_scene", sceneId: third.id, start: 40, track: 1 });
  assert.equal(m2.project.scenes[0].start, 120);
  const packed = one(m2.project, { op: "compact_main_track" });
  assert.equal(packed.project.scenes[0].start, undefined, "主轨起点应被清掉");
  const pip = packed.project.scenes.find((x) => x.id === third.id)!;
  assert.equal(pip.start, 40, "非主轨的起点不能动");
  assert.ok(packed.summary.some((x) => x.includes("连续")), packed.summary.join(" | "));
});

test("compact_main_track：主轨本来就连续时不给假 summary", () => {
  const p = seed();
  const packed = one(p, { op: "compact_main_track" });
  assert.ok(packed.summary.some((x) => x.includes("本来就是连续")), packed.summary.join(" | "));
});

test("reorder_scenes：主轨有钉死起点时，summary 必须明说「时间位置没变」（否则像成功）", () => {
  const p = seed();
  // 钉在主轨上（track 0）——这正是复盘坑 #2 的现场：挪完再重排，幕序看着改了、时间没动
  const pinned = one(p, { op: "move_scene", sceneId: p.scenes[2].id, start: 500 });
  const ids = [...pinned.project.scenes].reverse().map((s) => s.id);
  const r = one(pinned.project, { op: "reorder_scenes", sceneIds: ids });
  const warn = r.summary.find((s) => s.includes("⚠"));
  assert.ok(warn, `没有警告行：${r.summary.join(" | ")}`);
  assert.ok(/没变|没生效/.test(warn!), `警告没说清后果：${warn}`);
  // 警告里要有解法，否则 agent 只能试错
  assert.ok(/reflow/.test(warn!), `警告没给解法：${warn}`);
  // 起点确实没被动
  const pinnedScene = r.project.scenes.find((s) => s.id === p.scenes[2].id)!;
  assert.equal(pinnedScene.start, 500);
});

test("reorder_scenes(reflow:true)：主轨钉死起点被清掉，时间按新顺序首尾相接", () => {
  const p = seed();
  const pinned = one(p, { op: "move_scene", sceneId: p.scenes[2].id, start: 500 });
  const ids = [...pinned.project.scenes].reverse().map((s) => s.id);
  const r = one(pinned.project, { op: "reorder_scenes", sceneIds: ids, reflow: true });
  assert.ok(
    r.project.scenes.every((s) => s.start === undefined),
    "主轨还留着自定义起点",
  );
  const spans = sceneSpans(r.project.scenes);
  let acc = 0;
  spans.forEach((sp) => {
    assert.equal(sp.start, acc, `「${sp.id}」起点没接在上一块后面`);
    acc = sp.end;
  });
  assert.ok(r.summary.some((s) => s.includes("首尾相接")), r.summary.join(" | "));
});

test("reorder_scenes(reflow:true)：轨道 1 以上的起点保留（画中画不该被主轨重排带走）", () => {
  const p = seed();
  const pip = one(p, { op: "move_scene", sceneId: p.scenes[2].id, start: 40, track: 1 });
  const ids = [...pip.project.scenes].reverse().map((s) => s.id);
  const r = one(pip.project, { op: "reorder_scenes", sceneIds: ids, reflow: true });
  const scene = r.project.scenes.find((s) => s.id === p.scenes[2].id)!;
  assert.equal(scene.start, 40, "画中画的起点被清掉了");
  assert.equal(scene.track, 1);
});

/* ────────────────────── 转场类型：写错会毁整个工程 ────────────────────── */

test("update_scene 拒绝不存在的转场类型（以前会写进文件 → 工程再也打不开）", () => {
  const p = seed();
  assert.throws(
    () =>
      one(p, {
        op: "update_scene",
        sceneId: p.scenes[0].id,
        patch: { transitionIn: { type: "glitch", durationInFrames: 8 } as never },
      }),
    /不合法/,
  );
});

test("update_scene 接受合法转场；没给时长按 12 帧兜底，none 给 0", () => {
  const p = seed();
  const r = one(p, {
    op: "update_scene",
    sceneId: p.scenes[0].id,
    patch: { transitionOut: { type: "wipe" } as never },
  });
  assert.equal(r.project.scenes[0].transitionOut?.type, "wipe");
  assert.equal(r.project.scenes[0].transitionOut?.durationInFrames, 12);

  const r2 = one(r.project, {
    op: "update_scene",
    sceneId: p.scenes[0].id,
    patch: { transitionOut: { type: "none" } as never },
  });
  assert.equal(r2.project.scenes[0].transitionOut?.durationInFrames, 0);
});

/* ────────────────────────── 汇总 ────────────────────────── */

console.log("");
if (failures.length) {
  console.error(`${failures.length} 个用例失败（通过 ${passed} 个）`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过：${passed} 个用例`);
