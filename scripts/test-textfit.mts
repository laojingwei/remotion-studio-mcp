/**
 * 字宽换算与「一行放多大」纯函数单测。
 *
 *   npm test
 *
 * 这几个数字直接决定横屏标题会不会折行、会不会整块缩在左边，
 * 所以把「中文 1 字宽、英文 0.55」这条约定钉成用例 —— 改权重前先看这里。
 */
import assert from "node:assert/strict";

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

const { charWidth, weightedLength, fitHeadSize, clampHeadSize } = await import("../shared/textFit");

test("charWidth：中文/全角按 1，拉丁数字 0.55，空格 0.3", () => {
  assert.equal(charWidth("中"), 1);
  assert.equal(charWidth("，"), 1);
  assert.equal(charWidth("a"), 0.55);
  assert.equal(charWidth("9"), 0.55);
  assert.equal(charWidth(" "), 0.3);
});

test("weightedLength：纯中文等于字数", () => {
  assert.equal(weightedLength("周末去山里发呆"), 7);
});

test("weightedLength：混排按等效宽度，不按字符数", () => {
  // 三小时学会用(6) + 空格 0.3 + agent(5*0.55=2.75) + 空格 0.3 + 做动画(3) = 12.35
  const w = weightedLength("三小时学会用 agent 做动画");
  assert.ok(Math.abs(w - 12.35) < 1e-9, `实际 ${w}`);
  assert.ok(w < "三小时学会用 agent 做动画".length, "等效宽度必须小于字符数");
});

test("fitHeadSize：空文本/非法单位返回 Infinity（交给 clamp 兜底）", () => {
  assert.equal(fitHeadSize("", 1000, 10, 1.4), Number.POSITIVE_INFINITY);
  assert.equal(fitHeadSize("字", 1000, 0, 1.4), Number.POSITIVE_INFINITY);
});

test("fitHeadSize：字越多字号越小，且字号 × 等效字数 ≈ 可用宽度", () => {
  const avail = 1700;
  const long = fitHeadSize("一二三四五六七八九十", avail, 10.8, 1.42);
  const short = fitHeadSize("一二三", avail, 10.8, 1.42);
  assert.ok(short > long, "短句必须能放得更大");
  // 反算：字号(单位) × headScale × unit × 等效字数 应贴着 avail*0.96
  const used = long * 1.42 * 10.8 * 10;
  assert.ok(Math.abs(used - avail * 0.96) < 1e-6, `反算宽度 ${used}`);
});

test("clampHeadSize：夹在上下限之间", () => {
  assert.equal(clampHeadSize("字", 10000, 10.8, 1.42, 4.6, 14), 14, "短句撞上限");
  assert.equal(clampHeadSize("一".repeat(200), 1700, 10.8, 1.42, 4.6, 14), 4.6, "长句撞下限");
});

console.log("");
if (failures.length) {
  console.error(`${failures.length} 个用例失败（通过 ${passed} 个）`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过：${passed} 个用例`);
