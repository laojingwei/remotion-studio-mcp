/**
 * 参数语义收口（P1-4）单测：区间符号、stroke 归一化、ducking 默认值、新字段可落库。
 *
 *   tsx scripts/test-param-semantics.mts
 */
import assert from "node:assert/strict";
import { lintCopy } from "../shared/copyLint";
import { freeElSchema, normalizeFreeElement } from "../shared/freeform";
import { DEFAULT_DUCKING } from "../shared/audio";
import { subtitleStyleSchema, themeSchema, DEFAULT_THEME } from "../shared/schema";

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

console.log("[文案体检] 区间符号");

test("价格区间用长横线 → 提示改成连字符", () => {
  const msgs = lintCopy("礼物六档 10–99 元").map((x) => x.msg);
  assert.ok(msgs.some((m) => m.includes("长横线") && m.includes("10–99")), JSON.stringify(msgs));
});

test("用普通连字符 → 不报", () => {
  const msgs = lintCopy("礼物六档 10-99 元").map((x) => x.msg);
  assert.ok(!msgs.some((m) => m.includes("长横线")), JSON.stringify(msgs));
});

test("破折号不是区间时，走原来的破折号规则（不重复报）", () => {
  const msgs = lintCopy("他来了——然后就走了").map((x) => x.msg);
  assert.ok(!msgs.some((m) => m.includes("长横线")), "非数字区间不该报区间问题");
});

console.log("[stroke 归一化]");

test("stroke:true → 用 fill 当描边色 + 宽度 2（并去掉布尔值）", () => {
  const el = normalizeFreeElement({ type: "shape", shape: "circle", fill: "#E4572E", stroke: true });
  assert.equal(el.stroke, "#E4572E");
  assert.equal(el.strokeWidth, 2);
});

test("stroke:false → 直接去掉描边字段", () => {
  const el = normalizeFreeElement({ type: "shape", fill: "#000", stroke: false });
  assert.equal("stroke" in el, false);
});

test("strokeWidth 收到布尔也换算（true=2 / false=0）", () => {
  assert.equal(normalizeFreeElement({ type: "text", text: "x", strokeWidth: true }).strokeWidth, 2);
  assert.equal(normalizeFreeElement({ type: "text", text: "x", strokeWidth: false }).strokeWidth, 0);
});

test("字符串 stroke（正常写法）原样保留", () => {
  const el = normalizeFreeElement({ type: "shape", stroke: "#FFF", strokeWidth: 3 });
  assert.equal(el.stroke, "#FFF");
  assert.equal(el.strokeWidth, 3);
});

console.log("[新字段]");

test("freeform 元素支持 anchor:left，且能过 schema", () => {
  const parsed = freeElSchema.safeParse({ type: "text", text: "左对齐的标题", x: 6, y: 20, size: 5, anchor: "left" });
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("字幕支持 bottomPct（按画面高度百分比）", () => {
  const parsed = subtitleStyleSchema.safeParse({ bottomPct: 20, fontSize: 3.8 });
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  // 越界要拒绝：>60% 会把字幕顶到画面中间
  assert.equal(subtitleStyleSchema.safeParse({ bottomPct: 80 }).success, false);
});

test("ducking 默认深度是 0.6（0.3 会导致口播期 BGM 几乎听不见）", () => {
  assert.equal(DEFAULT_DUCKING.depth, 0.6);
  assert.equal(DEFAULT_DUCKING.enabled, true);
});

test("主题默认值仍然合法（没被这次改动带崩）", () => {
  const parsed = themeSchema.safeParse(DEFAULT_THEME);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

console.log(failures.length ? `\n失败 ${failures.length} 项` : `\n全部通过：${passed} 个用例`);
if (failures.length) process.exit(1);
