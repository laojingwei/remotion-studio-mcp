/**
 * 文案体检单测：`npx tsx scripts/test-copy.mts`
 *
 * 查四类「像废话 / 像 AI」的信号：空洞词、数字缺参照、句子太长、AI 味（句式与词面）。
 * 查不出「没意思」——那是 get_guide("content") 的三问。
 */
import assert from "node:assert/strict";
import { lintCopy, lintCopyLines, lintScriptLines } from "../shared/copyLint";
import { detectFlavor, detectScriptFlavor } from "../shared/aiFlavor";

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

/* ────────────────────── AI 味：句式 ────────────────────── */

console.log("[copy] AI 味（句式）");

const cats = (text: string, kind: "screen" | "voice" = "voice") =>
  detectFlavor(text, kind).map((h) => h.cat);

test("翻案腔「不是…而是」被点名且是 warn", () => {
  const hits = detectFlavor("这不是剪辑技巧，而是注意力问题。");
  assert.ok(hits.some((h) => h.cat === "翻案腔" && h.level === "warn"), JSON.stringify(hits));
});

test("翻案腔的变体（看似…其实 / 你以为…其实 / 恰恰相反）都命中", () => {
  for (const t of ["看似是内容问题，其实是节奏问题。", "你以为他在剪片子，其实他在卖货。", "答案恰恰相反。"]) {
    assert.ok(cats(t).includes("翻案腔"), t);
  }
});

test("三项排比被点名", () => {
  assert.ok(cats("不仅省时间，也省钱，更省心。").includes("三项排比"));
  assert.ok(cats("一是没时间，二是没工具，三是没方法。").includes("三项排比"));
});

test("两项并列不算排比", () => {
  assert.ok(!cats("既省时间又省钱。").includes("三项排比"));
});

test("结尾升华被点名", () => {
  assert.ok(cats("让我们一起见证这个行业的未来。").includes("A4 结尾升华"));
  assert.ok(cats("未来可期，任重道远。").includes("A4 结尾升华"));
});

test("模糊归因被点名", () => {
  assert.ok(cats("专家指出，短视频的核心是前 3 秒。").includes("A7 模糊归因"));
  assert.ok(cats("据研究显示，人注意力只有 8 秒。").includes("A7 模糊归因"));
});

test("开头套话被点名", () => {
  assert.ok(cats("众所周知，短视频很难做。").includes("A1 开头套话"));
  assert.ok(cats("在当今这个内容为王的时代，人人都在拍视频。").includes("A1 开头套话"));
});

test("黑话归到商业黑话，不再重复算空洞词", () => {
  const out = msgs("我们致力于打造一站式解决方案，赋能业务增长。");
  assert.ok(out.includes("商业黑话"), out);
  assert.ok(!out.includes("空洞词"), `不该再报空洞词：${out}`);
});

test("语境词单独出现不报，挤两个才报", () => {
  assert.ok(!cats("电路闭环了。").includes("商业黑话"), "单个语境词是误报");
  assert.ok(cats("我们先对齐一下颗粒度。").includes("商业黑话"));
});

/* ────────────────────── AI 味：视频专有 ────────────────────── */

console.log("[copy] AI 味（屏幕标点 / 念不出来）");

test("屏幕大字有破折号被点名", () => {
  const hits = detectFlavor("效率提升 —— 从 3 秒到 800 毫秒", "screen");
  assert.ok(hits.some((h) => h.cat === "屏幕标点" && h.msg.includes("破折号")), JSON.stringify(hits));
});

test("屏幕大字的提示性冒号被点名，时间不算", () => {
  assert.ok(cats("核心是：前 3 秒", "screen").includes("屏幕标点"));
  assert.ok(!cats("10:30 开始直播", "screen").includes("屏幕标点"));
});

test("口播里的括号被点名（TTS 会念）", () => {
  assert.ok(cats("这套方法（其实就是懒）很管用。").includes("念不出来"));
});

test("口播里的英文缩写被点名，要求写读音", () => {
  const hits = detectFlavor("看这个 ROI 数据。");
  assert.ok(hits.some((h) => h.cat === "念不出来" && h.msg.includes("ROI")), JSON.stringify(hits));
});

test("屏幕文字不检查英文缩写（大字写缩写很正常）", () => {
  assert.ok(!cats("ROI 提升 3 倍", "screen").includes("念不出来"));
});

/* ────────────────────── AI 味：整篇 ────────────────────── */

console.log("[copy] AI 味（整篇）");

test("整篇没有数字被点名", () => {
  const hits = detectScriptFlavor(["我们先看看这个办法。", "很多人都试过。", "效果还行吧。"]);
  assert.ok(hits.some((h) => h.cat === "缺乏细节" && h.level === "warn"), JSON.stringify(hits));
});

test("句子长度几乎一样被点名（节奏单一）", () => {
  const hits = detectScriptFlavor(["我们先看第一个。", "这个办法很快的。", "效果确实还不错。", "你也可以试一试。", "最后一句要记住。"]);
  assert.ok(hits.some((h) => h.cat === "节奏单一"), JSON.stringify(hits));
});

test("长短交错 + 有数字，不误报", () => {
  const hits = detectScriptFlavor(["40 条片子，换了开头的那批，完播率翻了 3 倍。", "就这么简单。", "但我们试了两个月才敢下结论，中间推翻过三次。"]);
  assert.deepEqual(hits, [], JSON.stringify(hits));
});

/* ────────────────────── 干净文案不误报 ────────────────────── */

test("正常口播一条问题都不报", () => {
  const out = msgs("我们把加载从 3 秒压到 800 毫秒，用户当场就发现了。");
  assert.equal(out, "", out);
});

test("正常屏幕大字一条问题都不报", () => {
  const out = msgs("下沉市场贡献 62% 增量", "screen");
  assert.equal(out, "", out);
});

test("lintScriptLines 会带上整篇结论", () => {
  const lines = lintScriptLines(
    [
      { text: "这不是技术问题，而是认知问题。", kind: "voice", label: "第 1 段" },
      { text: "让我们一起努力。", kind: "voice", label: "第 2 段" },
    ],
    3,
  );
  const all = lines.join("\n");
  assert.ok(all.includes("翻案腔"), all);
  assert.ok(all.includes("整篇没有一个数字"), all);
});

console.log(`\n文案体检单测：${passed} 项通过${process.exitCode ? "，有失败" : "，全过 ✅"}`);