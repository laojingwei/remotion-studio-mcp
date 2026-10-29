/**
 * 动效系统单测（纯函数 + op reducer，不需要浏览器）。
 *
 *   npm test
 *
 * 覆盖：
 *  - shared/numeric.ts 的 scaleNumericText（数字滚动的格式化，脏数字的重灾区）
 *  - set_theme 的 motion 开关（0 必须能落库 —— 它是最容易写成"假值被忽略"的地方）
 */
import assert from "node:assert/strict";
import { applyOps, createSeedProject, type Op } from "../shared/ops";
import { barRatio, easeOutCubic, parseNumeric, scaleNumericText } from "../shared/numeric";

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

const seed = () => createSeedProject("p_motion_test");
const apply = (ops: Op[]) => applyOps(seed(), ops).project;

console.log("[numeric] 数字滚动格式化");

test("整数按比例缩小并四舍五入", () => {
  assert.equal(scaleNumericText("86", 0.5), "43");
  assert.equal(scaleNumericText("86", 0), "0");
  assert.equal(scaleNumericText("86", 1), "86");
});

test("小数位保留原样（不能出现 3.1789999x）", () => {
  assert.equal(scaleNumericText("3.2x", 0.5), "1.6x");
  assert.equal(scaleNumericText("12.05%", 0.5), "6.03%");
});

test("前后缀原样保留", () => {
  assert.equal(scaleNumericText("1.2万", 0.5), "0.6万");
  assert.equal(scaleNumericText("¥299", 0.5), "¥150");
  assert.equal(scaleNumericText("-12%", 0.5), "-6%");
});

test("没有数字就原样返回", () => {
  assert.equal(scaleNumericText("暂无数据", 0.3), "暂无数据");
  assert.equal(scaleNumericText("", 0.3), "");
});

test("纯四位数（年份）不滚 —— 否则像乱码", () => {
  assert.equal(scaleNumericText("2024", 0.5), "2024");
  assert.equal(scaleNumericText("1998", 0.1), "1998");
  // 但有单位就不是年份了，要滚
  assert.equal(scaleNumericText("2024万", 0.5), "1012万");
});

test("factor >= 1 原样返回（收尾帧不能被浮点污染）", () => {
  assert.equal(scaleNumericText("86.7%", 1.0000001), "86.7%");
  assert.equal(scaleNumericText("86.7%", 1), "86.7%");
});

test("parseNumeric：带单位的百分比能取出数值（ring 的图字不一致就是这么来的）", () => {
  assert.equal(parseNumeric("72%"), 72);
  assert.equal(parseNumeric("-12.5 万"), -12.5);
  assert.equal(parseNumeric(72), 72);
  assert.equal(parseNumeric("没写数字"), 0);
  assert.equal(parseNumeric("没写数字", 50), 50);
});

test("barRatio：linear 按值/最大值，log 压数量级且 0 值归 0", () => {
  assert.equal(barRatio(30, 60), 0.5);
  assert.equal(barRatio(0, 60), 0);
  assert.equal(barRatio(-5, 60), 0, "负值不画柱子");
  assert.equal(barRatio(30, 0), 0, "最大值为 0 时不能除出 NaN");
  // 跨数量级：linear 里 3/6800 ≈ 0.04% 看不见；log 里还有约 1/4 的高度
  assert.ok(barRatio(3, 6800) < 0.001);
  const logRatio = barRatio(3, 6800, "log");
  assert.ok(logRatio > 0.1 && logRatio < 0.2, `log 比例 ${logRatio}`);
  assert.equal(barRatio(6800, 6800, "log"), 1, "最大值必须顶满");
});

test("easeOutCubic：0→0、1→1、中间单调递增且越来越慢", () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  const a = easeOutCubic(0.25);
  const b = easeOutCubic(0.5);
  assert.ok(a < b && b < 1, `应单调：${a} < ${b} < 1`);
  assert.ok(a > 0.25, "缓出应比线性快");
});

console.log("[set_theme] 动效强度");

test("不传 motion：主题里留不下 undefined 字段", () => {
  const p = apply([{ op: "set_theme", palette: { primary: "#ff0000" } }]);
  assert.equal(p.theme.palette.primary, "#ff0000");
  assert.ok(!("motion" in p.theme), "没设置就不该出现 motion 键");
});

test("motion=0 能落库（最容易被真值判断吞掉的值）", () => {
  const p = apply([{ op: "set_theme", motion: 0 }]);
  assert.equal(p.theme.motion, 0);
});

test("motion=2 落库，且 summary 说清楚是哪一档", () => {
  const r = applyOps(seed(), [{ op: "set_theme", motion: 2 }]);
  assert.equal(r.project.theme.motion, 2);
  assert.match(r.summary.join("；"), /更强/);
});

test("改配色不覆盖已有 motion", () => {
  const p1 = apply([{ op: "set_theme", motion: 2 }]);
  const p2 = applyOps(p1, [{ op: "set_theme", palette: { text: "#ffffff" } }]).project;
  assert.equal(p2.theme.motion, 2, "只改配色时动效强度必须保持");
});

test("motion 超出 0-2 会被 schema 拒绝？——op 层不夹，靠 schema 校验读入", () => {
  // op 层按原值写入，projectSchema 读盘时会再校验一次；
  // 这里只断言"没被静默夹成 1"，避免出现"设了 9 却按 2 渲染"的误解
  const p = apply([{ op: "set_theme", motion: 9 }]);
  assert.equal(p.theme.motion, 9);
});

console.log(`\n全部通过：${passed} 个用例`);
if (failures.length) {
  console.error(`失败 ${failures.length} 个：${failures.join(" / ")}`);
  process.exit(1);
}
