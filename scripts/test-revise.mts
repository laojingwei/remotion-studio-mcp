/**
 * 改稿即改片：定位、幕长影响、时间骨架合并、分镜同步。
 *
 * 这一层是纯计算，但决定的是「改了哪一段、哪一幕会变、哪些元素会被挤掉」——
 * 定错了就是改了 A 段却重配 B 段、或者幕长变了却没人提醒元素被截断。
 * 所以每条兜底逻辑都要有测试钉住。
 */
import assert from "node:assert/strict";
import {
  analyzeReflow,
  mergeTiming,
  patchStoryboard,
  resolveChanges,
  type LooseScene,
} from "../server/revise.service";
import type { Script } from "../server/script.service";
import type { Storyboard } from "../server/storyboard.service";
import type { NarrationTiming } from "../server/narration-timing.service";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e instanceof Error ? e.message : String(e)}`);
  }
}

const script = (): Script => ({
  type: "口播稿",
  segments: [
    { text: "第一句", sceneId: "s1" },
    { text: "第二句", sceneId: "s2" },
    { text: "第三句" },
  ],
});

const storyboard = (): Storyboard => ({
  shots: [
    { type: "hook", text: "第一句", sceneId: "s1" },
    { type: "point", text: "第二句", sceneId: "s2" },
    { type: "outro", text: "第三句" },
  ],
});

console.log("\n改稿定位（resolveChanges）\n");

test("按段号定位，幕 id 从分镜表补齐", () => {
  const r = resolveChanges(script(), storyboard(), [{ segment: 1, text: "改过的第一句" }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].index, 0);
  assert.equal(r[0].sceneId, "s1");
  assert.equal(r[0].how, "segment");
  assert.equal(r[0].changed, true);
});

test("按 sceneId 定位（稿件里有 sceneId 优先）", () => {
  const r = resolveChanges(script(), storyboard(), [{ sceneId: "s2", text: "改过的第二句" }]);
  assert.equal(r[0].index, 1);
  assert.equal(r[0].how, "script-scene");
});

test("稿件没回填 sceneId 时，退到分镜表的 sceneId", () => {
  const s = script();
  delete s.segments[0].sceneId;
  const r = resolveChanges(s, storyboard(), [{ sceneId: "s1", text: "改" }]);
  assert.equal(r[0].index, 0);
  assert.equal(r[0].how, "storyboard-scene");
});

test("段号越界要报错并给出范围", () => {
  assert.throws(
    () => resolveChanges(script(), storyboard(), [{ segment: 9, text: "x" }]),
    /越界.*1–3/,
  );
});

test("文案一字未改 → changed=false", () => {
  const r = resolveChanges(script(), storyboard(), [{ segment: 2, text: " 第二句 " }]);
  assert.equal(r[0].changed, false);
});

test("同一段改两次取最后一次", () => {
  const r = resolveChanges(script(), storyboard(), [
    { segment: 1, text: "先改成这个" },
    { segment: 1, text: "最终这句" },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].text, "最终这句");
});

test("既没段号也没 sceneId 要报错", () => {
  assert.throws(() => resolveChanges(script(), storyboard(), [{ text: "x" }]), /segment/);
});

test("空文案要拒绝（别用改稿当删段）", () => {
  assert.throws(() => resolveChanges(script(), storyboard(), [{ segment: 1, text: "  " }]), /不能为空/);
});

console.log("\n幕长影响（analyzeReflow）\n");

const scene = (): LooseScene => ({
  id: "s1",
  name: "开场",
  durationInFrames: 300,
  elements: [
    { id: "n1", kind: "audio", narration: true, name: "旁白", from: 0, durationInFrames: 300 },
    { id: "e1", kind: "text", name: "长标签", from: 250, durationInFrames: 100 },
    { id: "e2", kind: "text", name: "收尾贴纸", from: 280, durationInFrames: 10 },
    { id: "e3", kind: "image", name: "图", from: 100, durationInFrames: 50 },
    { id: "e4", kind: "svg", name: "撑满", from: 0, durationInFrames: -1 },
  ],
});

test("幕变短：截断 / 越界分开报，旁白与 -1 不参与", () => {
  const r = analyzeReflow(scene(), 258);
  assert.equal(r.deltaFrames, -42);
  assert.equal(r.narrationCount, 1);
  assert.deepEqual(r.clipped.map((x) => x.id), ["e1"]);
  assert.deepEqual(r.unreachable.map((x) => x.id), ["e2"]);
  assert.deepEqual(r.earlyEnd, []);
});

test("幕变长：提前结束的元素报空白，撑满的不报", () => {
  const r = analyzeReflow(scene(), 400);
  assert.deepEqual(r.clipped, []);
  assert.deepEqual(r.unreachable, []);
  // e1 到 350、e2 到 290、e3 到 150，都短于新幕长 400
  assert.deepEqual(r.earlyEnd.map((x) => x.id).sort(), ["e1", "e2", "e3"]);
});

test("没写时长的元素按撑满算，不算截断", () => {
  const r = analyzeReflow(
    { id: "s", name: "x", durationInFrames: 100, elements: [{ id: "a", kind: "text", name: "t", from: 0 }] },
    60,
  );
  assert.deepEqual(r.clipped, []);
  assert.deepEqual(r.unreachable, []);
});

console.log("\n时间骨架合并（mergeTiming）\n");

const timing = (): NarrationTiming => ({
  at: "2026-11-01T00:00:00.000Z",
  fps: 30,
  totalSec: 10,
  segments: [
    { index: 1, text: "第一句", frames: 100, suggested: 120, durationSec: 3.3, sceneId: "s1" },
    { index: 2, text: "第二句", frames: 150, suggested: 180, durationSec: 5, sceneId: "s2" },
  ],
});

test("按 sceneId 命中，只改那一段并重算总长", () => {
  const { timing: next, matched } = mergeTiming(timing(), [
    { sceneId: "s2", index: 1, text: "新第二句", frames: 200, suggested: 240, durationSec: 6.7 },
  ]);
  assert.equal(matched, 1);
  assert.equal(next.segments[0].frames, 100); // 没改的那段读数不动
  assert.equal(next.segments[1].text, "新第二句");
  assert.equal(next.segments[1].suggested, 240);
  assert.equal(next.totalSec, Math.round(((120 + 240) / 30) * 10) / 10);
});

test("骨架里没有 sceneId 时按序号兜底（调用方确认段数一致才放行）", () => {
  const t = timing();
  delete t.segments[0].sceneId;
  delete t.segments[1].sceneId;
  const { matched } = mergeTiming(
    t,
    [{ index: 1, text: "x", frames: 1, suggested: 2, durationSec: 0.1 }],
    { allowIndexFallback: true },
  );
  assert.equal(matched, 1);
});

test("没放行序号兜底时不许蒙", () => {
  const t = timing();
  delete t.segments[0].sceneId;
  delete t.segments[1].sceneId;
  const { matched } = mergeTiming(t, [{ index: 1, text: "x", frames: 1, suggested: 2, durationSec: 0.1 }]);
  assert.equal(matched, 0);
});

test("对不上就一条都不改（别蒙）", () => {
  const t = timing();
  const { matched, timing: next } = mergeTiming(t, [
    { sceneId: "other", index: 0, text: "x", frames: 1, suggested: 2, durationSec: 0.1 },
  ]);
  assert.equal(matched, 0);
  assert.deepEqual(next.segments, t.segments);
});

console.log("\n分镜同步（patchStoryboard）\n");

test("按 sceneId 改文案与幕长", () => {
  const r = patchStoryboard(storyboard(), [
    { index: 1, sceneId: "s2", text: "新第二句", durationInFrames: 240 },
  ]);
  assert.ok(r);
  assert.deepEqual(r.matched, [2]);
  assert.equal(r.storyboard.shots[1].text, "新第二句");
  assert.equal(r.storyboard.shots[1].durationInFrames, 240);
  assert.equal(r.storyboard.shots[0].text, "第一句");
});

test("没回填 sceneId 的幕按同序号兜底", () => {
  const r = patchStoryboard(storyboard(), [{ index: 2, text: "新第三句", durationInFrames: 90 }]);
  assert.ok(r);
  assert.deepEqual(r.matched, [3]);
  assert.equal(r.storyboard.shots[2].text, "新第三句");
});

test("sceneId 对不上且该序号已有别的幕 → 跳过，不乱写", () => {
  const r = patchStoryboard(storyboard(), [{ index: 0, sceneId: "nope", text: "x" }]);
  assert.ok(r);
  assert.deepEqual(r.matched, []);
  assert.deepEqual(r.skipped, [1]);
  assert.equal(r.storyboard.shots[0].text, "第一句");
});

test("没有分镜表就返回 null（不硬造一份）", () => {
  assert.equal(patchStoryboard(null, [{ index: 0, text: "x" }]), null);
});

console.log(`\n${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
