/**
 * build_film 的入场动画生成（纯函数）。
 *
 *   tsx scripts/test-stagger.mts
 *
 * 这里最容易出的两个错都不会抛异常、只会"看起来怪"：
 *   1. 第 N 个元素的 at1 超出幕长 → 动画永远播不完，画面停在半透明；
 *   2. at0 >= at1 → 关键帧无效，元素直接定在原地。
 * 所以用单测把边界钉死，而不是等成片出来靠眼睛发现。
 */
import assert from "node:assert/strict";
import { freeElSchema, staggerAnim } from "../shared/freeform";

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

console.log("[staggerAnim] 入场关键帧");

test("关键帧时间窗落在幕内，且 at0 < at1", () => {
  for (const dur of [30, 60, 150, 600]) {
    for (let i = 0; i < 8; i++) {
      const [k] = staggerAnim({ y: 40, index: i, sceneDur: dur });
      const [a0, a1] = k.at;
      assert.ok(a0 >= 0 && a0 < dur, `at0=${a0} 越界（幕长 ${dur}）`);
      assert.ok(a1 > a0 && a1 <= dur - 1, `at1=${a1} 越界或顺序反了（幕长 ${dur}）`);
    }
  }
});

test("错峰：后面的元素起播更晚（stagger 生效）", () => {
  const starts = [0, 1, 2, 3].map((i) => staggerAnim({ y: 40, index: i, sceneDur: 200 })[0].at[0]);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] >= starts[i - 1], `第 ${i} 个起播不晚于前一个：${starts}`);
  }
  assert.ok(starts[3] > starts[0], "错峰没生效");
});

test("幕很短时不会越界（元素多也压得回去）", () => {
  const [k] = staggerAnim({ y: 40, index: 9, sceneDur: 12, step: 3, inFrames: 14 });
  assert.ok(k.at[1] <= 11, `at1=${k.at[1]} 超出幕长 12`);
  assert.ok(k.at[1] > k.at[0]);
});

test("from/to 用绝对 y（关键帧里 x/y 是绝对值，不是偏移）", () => {
  const [k] = staggerAnim({ y: 44, index: 0, sceneDur: 90, rise: 4 });
  assert.equal(k.to?.y, 44);
  assert.equal(k.from?.y, 48);
  assert.equal(k.from?.opacity, 0);
  assert.equal(k.to?.opacity, 1);
});

test("生成的关键帧能通过 freeElSchema 校验（ease 只认 linear/easeInOut/spring）", () => {
  const el = {
    id: "e1",
    type: "text",
    text: "利润翻倍",
    x: 50,
    y: 30,
    size: 9,
    anim: staggerAnim({ y: 30, index: 0, sceneDur: 150 }),
  };
  const parsed = freeElSchema.safeParse(el);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("rise=0 时退化成纯淡入（不位移）", () => {
  const [k] = staggerAnim({ y: 50, index: 0, sceneDur: 90, rise: 0 });
  assert.equal(k.from?.y, 50);
  assert.equal(k.to?.y, 50);
});

console.log(failures.length ? `\n失败 ${failures.length} 项` : `\n全部通过：${passed} 个用例`);
if (failures.length) process.exit(1);
