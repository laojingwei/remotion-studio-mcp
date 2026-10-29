/**
 * 文案体检单测：`npx tsx scripts/test-copy.mts`
 *
 * 查的是「像废话」的三类信号：空洞词、数字缺参照、句子太长。
 * 查不出「没意思」——那是 get_guide("content") 的三问。
 */
import assert from "node:assert/strict";
import { lintCopy, lintCopyLines } from "../shared/copyLint";

let passed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (err) {
    console.log(`  [FAIL] ${name}\n    ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
};

const msgs = (text: string, kind: "screen" | "voice" = "voice") =>
  lintCopy(text, kind).map((x) => x.msg).join("\n");

console.log("[copy] 文案体检");

test("空洞词被点名", () => {
  const out = msgs("我们持续优化流程，全面提升了响应速度，取得了显著成效。");
  assert.ok(out.includes("空洞词"), out);
  assert.ok(out.includes("显著"), out);
});

test("干净的文案不报空洞词", () => {
  const out = msgs("响应时间从 26 小时压到 4 小时。");
  assert.ok(!out.includes("空洞词"), out);
});

test("数字缺参照系被提醒", () => {
  const out = msgs("今年我们的复购率增长了 37%。");
  assert.ok(out.includes("参照系"), out);
});

test("带对照的数字不提醒", () => {
  const out = msgs("复购率增长 37%，行业均值只有 12%。");
  assert.ok(!out.includes("参照系"), out);
});

test("口播一句太长被提醒", () => {
  const long = "这个镜头我们连续拍了整整三天三夜才拍到想要的画面但是最后剪辑的时候发现它其实一点都不重要还拖慢了整支片子的节奏";
  const out = msgs(long, "voice");
  assert.ok(out.includes("一口气念不完"), out);
});

test("屏幕文字超过 18 字被提醒", () => {
  const out = msgs("下沉市场贡献了百分之六十二的增量但客单价只有一线城市的一半", "screen");
  assert.ok(out.includes("读不完了"), out);
});

test("屏幕文字两个以上停顿被提醒", () => {
  const out = msgs("先定位，再配色，最后加动效", "screen");
  assert.ok(out.includes("停顿"), out);
});

test("空文本不报任何问题", () => {
  assert.deepEqual(lintCopy("", "voice"), []);
  assert.deepEqual(lintCopy("   ", "screen"), []);
});

test("批量体检同类问题限量输出", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    text: `第${i}句我们持续优化流程，全面提升了响应速度，取得了显著成效。`,
    kind: "voice" as const,
    label: `第 ${i + 1} 段`,
  }));
  const lines = lintCopyLines(items, 2);
  assert.ok(lines.filter((x) => x.includes("空洞词")).length <= 2, lines.join("\n"));
});

console.log(`\n文案体检单测：${passed} 项通过${process.exitCode ? "，有失败" : "，全过 ✅"}`);
