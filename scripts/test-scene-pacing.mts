/**
 * 幕数 / 单段时长的合理性。
 *
 * 这组测试的真正目的：把「幕数」锁成**推导结果**而不是常量。
 * 之前反复出现「14 幕」的说法，就是因为它被当成了默认值。
 */
import assert from "node:assert/strict";
import {
  SCENE_MAX_SEC,
  SCENE_MIN_SEC,
  estimateSceneCount,
  sceneCountNote,
  segmentDurationIssues,
} from "../shared/scenePacing";

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

/* ─────────── 库里真实工程的幕数，必须全部落在参考区间内 ─────────── */

test("真实工程：2 幕 / 7.5s 在区间内", () => {
  const { min, max } = estimateSceneCount(7.5);
  assert.ok(2 >= min && 2 <= max, `区间 ${min}-${max}`);
});

test("真实工程：5 幕 / 22s 在区间内", () => {
  const { min, max } = estimateSceneCount(22);
  assert.ok(5 >= min && 5 <= max, `区间 ${min}-${max}`);
});

test("真实工程：18 幕 / 89.3s 在区间内（不是「标准 14 幕」）", () => {
  const { min, max } = estimateSceneCount(89.3);
  assert.ok(18 >= min && 18 <= max, `区间 ${min}-${max}`);
});

test("真实工程：37 幕 / 573.8s 在区间内（平均 15.5s/幕 也算正常）", () => {
  const { min, max } = estimateSceneCount(573.8);
  assert.ok(37 >= min && 37 <= max, `区间 ${min}-${max}`);
});

test("真实工程：50 幕 / 413.4s 在区间内", () => {
  const { min, max } = estimateSceneCount(413.4);
  assert.ok(50 >= min && 50 <= max, `区间 ${min}-${max}`);
});

test("区间随总时长放大（不是固定幕数）", () => {
  const a = estimateSceneCount(60);
  const b = estimateSceneCount(600);
  // 边界值可能正好相等（600s 最少 30 幕 = 60s 最多 30 幕），所以逐端比而不是整段盖过
  assert.ok(b.min > a.min, `下界应随时长上升：${a.min} → ${b.min}`);
  assert.ok(b.max > a.max, `上界应随时长上升：${a.max} → ${b.max}`);
});

test("总时长为 0 / 负数时返回空区间（不报假数据）", () => {
  assert.deepEqual(estimateSceneCount(0), { min: 0, max: 0 });
  assert.deepEqual(estimateSceneCount(-5), { min: 0, max: 0 });
});

/* ─────────── 偏离区间时的提示 ─────────── */

test("幕数偏少：提示偏长，且给出参考区间", () => {
  const note = sceneCountNote(90, 3); // 平均 30s 一幕
  assert.ok(note && note.includes("偏长"), note ?? "null");
  assert.ok(note!.includes("量级"), "必须说明这不是标准");
});

test("幕数偏多：提示偏碎", () => {
  const note = sceneCountNote(20, 40); // 平均 0.5s 一幕
  assert.ok(note && note.includes("偏碎"), note ?? "null");
});

test("幕数正常：不提示（宁可不报也不误报）", () => {
  assert.equal(sceneCountNote(90, 18), null);
  assert.equal(sceneCountNote(413, 50), null);
});

/* ─────────── 单段时长 ─────────── */

test("段太短（< 1.2s）→ 阻断，因为它放不下一句能读完的话", () => {
  const r = segmentDurationIssues([{ startSec: 0, endSec: 0.8, content: "钩子" }]);
  assert.equal(r.blocking.length, 1);
  assert.ok(r.blocking[0].message.includes("放不下"), r.blocking[0].message);
});

test("段偏短（1.2–1.8s）→ 只提醒，不阻断", () => {
  const r = segmentDurationIssues([{ startSec: 0, endSec: 1.5, content: "短句" }]);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.warnings.length, 1);
});

test("段偏长（> 60s）→ 只提醒拆幕，不阻断（一段可以拆多幕）", () => {
  const r = segmentDurationIssues([{ startSec: 0, endSec: 75, content: "讲清楚利润结构" }]);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].message.includes("分几幕") || r.warnings[0].message.includes("拆"), r.warnings[0].message);
});

test("90s 片子的正常分段（3 / 42 / 45）一条都不报 —— 45s 一段是合理的", () => {
  const r = segmentDurationIssues([
    { startSec: 0, endSec: 3, content: "钩子" },
    { startSec: 3, endSec: 45, content: "讲清三档利润" },
    { startSec: 45, endSec: 90, content: "证据 + 报名" },
  ]);
  assert.equal(r.blocking.length, 0, JSON.stringify(r.blocking));
  assert.equal(r.warnings.length, 0, `不该有任何提醒：${JSON.stringify(r.warnings)}`);
});

test("正常段落（2–30s）→ 一句话都不说", () => {
  const r = segmentDurationIssues([
    { startSec: 0, endSec: 3, content: "钩子" },
    { startSec: 3, endSec: 25, content: "方案" },
    { startSec: 25, endSec: 30, content: "CTA" },
  ]);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.warnings.length, 0);
});

test("时长字段缺失 / 非法时跳过，不报错（合法性另有检查）", () => {
  const r = segmentDurationIssues([
    { content: "只有内容没时长" },
    { startSec: 5, endSec: 0, content: "结束早于开始" },
  ]);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.warnings.length, 0);
});

test("索引对应原始位置（filter 掉空段后也不会错位报「第 N 段」）", () => {
  const r = segmentDurationIssues([
    { startSec: 0, endSec: 5, content: "a" },
    { startSec: 5, endSec: 5.5, content: "b" },
  ]);
  assert.equal(r.blocking[0].index, 1, `应该指向第 2 段（index 1），实际 ${r.blocking[0].index}`);
});

test("常量自洽：最短 < 最长，否则区间会反", () => {
  assert.ok(SCENE_MIN_SEC > 0);
  assert.ok(SCENE_MAX_SEC > SCENE_MIN_SEC);
});

/* ────────────────────────── 汇总 ────────────────────────── */
console.log(`\n幕数/节奏：${pass} 通过${fail ? `，${fail} 失败` : "，全部通过"}`);
if (fail) process.exit(1);
