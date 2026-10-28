/**
 * 颜色透明度工具单测（纯函数）。
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { colorAlpha, parseColor, toHex, toHex8, withColorAlpha } from "../shared/color";

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

test("parseColor：六位 / 三位 / 八位 / 三位带 alpha", () => {
  assert.deepEqual(parseColor("#ff8800"), { r: 255, g: 136, b: 0, a: 1 });
  assert.deepEqual(parseColor("#f80"), { r: 255, g: 136, b: 0, a: 1 });
  assert.equal(parseColor("#ff880080")?.a, 128 / 255);
  assert.equal(parseColor("#f808")?.a, 136 / 255);
});

test("parseColor：rgb / rgba", () => {
  assert.deepEqual(parseColor("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseColor("rgba(1,2,3,0.5)"), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.equal(parseColor("red"), null);
  assert.equal(parseColor("var(--x)"), null);
});

test("withColorAlpha：hex → rgba，clamp 0-1", () => {
  assert.equal(withColorAlpha("#ff8800", 0.5), "rgba(255, 136, 0, 0.5)");
  assert.equal(withColorAlpha("#ff8800", 2), "rgba(255, 136, 0, 1)");
  assert.equal(withColorAlpha("red", 0.5), "red");
});

test("colorAlpha：解析已有 alpha", () => {
  assert.equal(colorAlpha("#ffffff"), 1);
  assert.equal(colorAlpha("rgba(0,0,0,0.3)"), 0.3);
  assert.equal(colorAlpha("red"), 1);
});

test("toHex：去掉 alpha，给 color input 用", () => {
  assert.equal(toHex("rgba(255, 136, 0, 0.5)"), "#ff8800");
  assert.equal(toHex("#f80"), "#ff8800");
  assert.equal(toHex("red"), "#ffffff");
});

test("toHex8：输出 8 位（原生 alpha 色盘用）", () => {
  assert.equal(toHex8("#ff8800"), "#ff8800ff");
  assert.equal(toHex8("rgba(255, 136, 0, 0.5)"), "#ff880080");
  assert.equal(toHex8("#f808"), "#ff880088");
  assert.equal(toHex8("red"), "#ffffffff");
});

console.log("");
if (failures.length) {
  console.error(`${failures.length} 个用例失败（通过 ${passed} 个）`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过：${passed} 个用例`);
