/**
 * 密度节奏单测（纯函数，不渲染）。
 *
 *   tsx scripts/test-density.mts
 *
 * 判据不是"某一幕够不够满"，而是"有没有起伏"：
 * 单幕 36%–55% 完全正常；问题是连续多幕同一档、没有穿插。
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

const { sceneFill, projectDensity, rhythmIssues, densitySummary, textWidthInSizeUnits } = await import(
  "../shared/density"
);

const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };
const text = (t: string, x: number, y: number, size = 3) => ({ kind: "text", text: t, x, y, size });

/** 内容占 y 约 36%–55%（被说"看着不舒服"的那种） */
const bandMid = (i: number) => ({
  id: `s${i}`,
  name: `第 ${i} 幕`,
  type: "bullets",
  elements: [text("第一行内容", 50, 38, 2), text("第二行内容", 50, 52, 2)],
});
/** 满版：铺到 y 13%–87% */
const bandTight = (i: number) => ({
  id: `t${i}`,
  name: `第 ${i} 幕`,
  type: "list",
  elements: [text("顶部标题", 50, 18, 3), text("中部内容", 50, 50, 3), text("底部结论", 50, 82, 3)],
});
/** 更空：只占中间一小条 */
const bandLoose = (i: number) => ({
  id: `l${i}`,
  name: `第 ${i} 幕`,
  type: "bigtext",
  elements: [text("一句话", 50, 46, 2), text("补充", 50, 52, 2)],
});

console.log("[sceneFill] 几何估算");

test("多行文字按 maxWidth 折行，高度跟着涨", () => {
  const one = sceneFill({ elements: [{ kind: "text", text: "一二三四五六七八九十", x: 50, y: 50, size: 4 }] }, PORTRAIT)!;
  const wrapped = sceneFill(
    { elements: [{ kind: "text", text: "一二三四五六七八九十", x: 50, y: 50, size: 4, maxWidth: 20 }] },
    PORTRAIT,
  )!;
  assert.ok(wrapped.verticalSpan > one.verticalSpan, `${wrapped.verticalSpan} vs ${one.verticalSpan}`);
});

test("等效字宽：汉字 1、数字更窄、空格最窄", () => {
  assert.equal(Math.round(textWidthInSizeUnits("汉字", 10)), 20);
  assert.ok(textWidthInSizeUnits("1234", 10) < textWidthInSizeUnits("一二三四", 10));
  assert.ok(textWidthInSizeUnits("  ", 10) < textWidthInSizeUnits("11", 10));
});

test("装饰层不计入内容包围盒（否则背景会把「空」掩盖掉）", () => {
  const fill = sceneFill(
    {
      elements: [
        text("一小行字", 50, 46),
        { kind: "svg", name: "背景网格", x: 50, y: 50, size: 100 },
      ],
    },
    PORTRAIT,
  )!;
  assert.equal(fill.contentElements, 1);
  assert.equal(fill.decorativeElements, 1);
  assert.ok(fill.verticalSpan < 0.1, `纵向应仍然很小，实际 ${fill.verticalSpan}`);
});

test("没有自由元素（内置版式）→ 返回 null，不瞎猜", () => {
  assert.equal(sceneFill({ elements: [] }, PORTRAIT), null);
  assert.equal(sceneFill({}, PORTRAIT), null);
});

console.log("[rhythmIssues] 判节奏，不判单幕");

test("单幕 36%–55% 不报错（这是设计，不是问题）", () => {
  const list = projectDensity([bandMid(1)], PORTRAIT);
  assert.equal(rhythmIssues(list, PORTRAIT).length, 0);
});

test("不同密度交替 → 不报", () => {
  const list = projectDensity([bandMid(1), bandTight(2), bandMid(3), bandTight(4)], PORTRAIT);
  assert.equal(rhythmIssues(list, PORTRAIT).length, 0, JSON.stringify(rhythmIssues(list, PORTRAIT)));
});

test("连续 5 幕同一密度 → 报「平」，并给穿插建议", () => {
  const list = projectDensity([bandMid(1), bandMid(2), bandMid(3), bandMid(4), bandMid(5)], PORTRAIT);
  const issues = rhythmIssues(list, PORTRAIT);
  const mono = issues.find((x) => x.kind === "monotone");
  assert.ok(mono, JSON.stringify(issues));
  assert.ok(mono!.message.includes("连续 5 幕"), mono!.message);
  assert.ok(mono!.message.includes("穿插") || mono!.message.includes("起伏"), mono!.message);
});

test("连续「空」档 → 说法更重（又平又空）", () => {
  const list = projectDensity([bandLoose(1), bandLoose(2), bandLoose(3), bandLoose(4)], PORTRAIT);
  const mono = rhythmIssues(list, PORTRAIT).find((x) => x.kind === "monotone");
  assert.ok(mono && mono.message.includes("又平又空"), mono?.message);
});

test("连续 2 幕真空（<30%）→ 单独报「确实没铺开」", () => {
  const list = projectDensity([bandLoose(1), bandLoose(2), bandTight(3)], PORTRAIT);
  const issues = rhythmIssues(list, PORTRAIT);
  assert.ok(issues.some((x) => x.kind === "empty-run"), JSON.stringify(issues));
});

test("全片没有「满」档 → 报缺高潮", () => {
  const list = projectDensity(
    [bandMid(1), bandLoose(2), bandMid(3), bandLoose(4), bandMid(5)],
    PORTRAIT,
  );
  const issues = rhythmIssues(list, PORTRAIT);
  assert.ok(issues.some((x) => x.kind === "no-peak"), JSON.stringify(issues));
});

test("封面 / 标题类豁免，且不打断连续判断", () => {
  const cover = { id: "c", name: "封面", type: "title", elements: [text("标题", 50, 45, 8)] };
  const list = projectDensity([bandMid(1), bandMid(2), cover, bandMid(3), bandMid(4)], PORTRAIT);
  assert.equal(list[2].band, "skip");
  const mono = rhythmIssues(list, PORTRAIT).find((x) => x.kind === "monotone");
  assert.ok(mono, "封面不该把连续 4 幕切断");
  assert.equal(mono!.count, 4);
});

test("参与判断的幕少于 3 → 不判（素材太少，判了也是噪声）", () => {
  const list = projectDensity([bandMid(1), bandMid(2)], PORTRAIT);
  assert.equal(rhythmIssues(list, PORTRAIT).length, 0);
});

test("横屏用横向跨度判：内容只占左半边 → 空档", () => {
  const leftOnly = {
    id: "x",
    name: "左半边",
    type: "bullets",
    elements: [text("左边的说明文字", 30, 40, 3), text("左边第二段文字", 30, 58, 3)],
  };
  const list = projectDensity([leftOnly], LANDSCAPE);
  assert.equal(list[0].band, "loose", JSON.stringify(list[0]));
});

console.log("[densitySummary]");

test("分布摘要给出空/中/满的幕数", () => {
  const list = projectDensity([bandMid(1), bandTight(2), bandLoose(3), bandMid(4)], PORTRAIT);
  const s = densitySummary(list);
  assert.ok(s.includes("空"), s);
  assert.ok(s.includes("满 1"), s);
  assert.ok(s.includes("参与判断 4 幕"), s);
});

console.log(failures.length ? `\n失败 ${failures.length} 项` : `\n全部通过：${passed} 个用例`);
if (failures.length) process.exit(1);
