/**
 * 指南层数据扩展单测（纯函数，不碰磁盘）。
 *
 *   npm test
 *
 * 覆盖（garden-skills 集成 · C 档）：
 *  - brief 的 format / soundPlan 渲染进 brief 文本（落盘是普通字符串透传）
 *  - storyboard shot 三问字段（change / carry）在文本渲染里可见
 *  - 超过 12 幕时分镜文本带长片章节提示；12 幕以内不带
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

const { briefToText, recipeGateError } = await import("../server/brief.service");
const { storyboardToText } = await import("../server/storyboard.service");

console.log("[brief] 用途类型与声音计划字段");

test("format / soundPlan 渲染进 brief 文本", () => {
  const text = briefToText({
    format: "B 产品宣传",
    soundPlan: "BGM 素材库挑选，人声优先避让",
    goal: "涨粉",
  } as never);
  assert.ok(text.includes("format：B 产品宣传"), text);
  assert.ok(text.includes("soundPlan：BGM 素材库挑选，人声优先避让"), text);
});

test("字段缺省时不出现空行", () => {
  const text = briefToText({ goal: "涨粉" } as never);
  assert.ok(!text.includes("format"), text);
  assert.ok(!text.includes("soundPlan"), text);
});

console.log("[brief] 推断项存证（assumed）");

test("assumed 单列成警告，不混进正文", () => {
  const text = briefToText({ goal: "涨粉", assumed: ["palette", "pace"] } as never);
  assert.ok(text.includes("agent 替用户定的"), text);
  assert.ok(text.includes("palette、pace"), text);
  assert.ok(!text.includes("- assumed"), "assumed 不该作为普通字段出现在正文");
});

test("没有 assumed 时不出现警告", () => {
  const text = briefToText({ goal: "涨粉" } as never);
  assert.ok(!text.includes("替用户定的"), text);
});

console.log("[brief] 配方对账（提示词库 PM/TK）");

test("槽位表按 配方→实际 渲染，冲突单独标出", () => {
  const text = briefToText({
    goal: "涨粉",
    recipe: { id: "PM010", name: "FigPad 产品宣传", file: "x.md", kind: "recipe" },
    recipeSlots: [
      { slot: "产品", recipe: "FigPad", actual: "回声笔记" },
      { slot: "画幅", recipe: "1920×1080", actual: "1080×1920", conflict: "按用户竖屏，构图改上下叠放" },
    ],
  } as never);
  assert.ok(text.includes("【配方对账】整片配方 PM010 FigPad 产品宣传"), text);
  assert.ok(text.includes("骨架照它，内容一格都不照抄"), text);
  assert.ok(text.includes("配方「FigPad」→ 实际「回声笔记」"), text);
  assert.ok(text.includes("冲突裁决：按用户竖屏"), text);
});

test("actual 空着要说「还没定」并列出缺格", () => {
  const text = briefToText({
    recipe: { id: "PM010", name: "x" },
    recipeSlots: [{ slot: "时长", recipe: "60 秒" }],
  } as never);
  assert.ok(text.includes("（还没定，要先问用户）"), text);
  assert.ok(text.includes("这几格还是空的：时长"), text);
});

test("只有配方没有槽位 → 提醒先做对账", () => {
  const text = briefToText({ recipe: { id: "PM010", name: "x" } } as never);
  assert.ok(text.includes("还没做槽位对账"), text);
});

test("技法（TK）不写成整片配方", () => {
  const text = briefToText({
    recipe: { id: "TK002", name: "光标打字", kind: "tech" },
    recipeSlots: [{ slot: "用在", recipe: "开场", actual: "第 1 幕" }],
  } as never);
  assert.ok(text.includes("【配方对账】技法 TK002"), text);
});

test("没采纳配方时不出现配方段", () => {
  const text = briefToText({ goal: "涨粉" } as never);
  assert.ok(!text.includes("配方对账"), text);
  assert.ok(!text.includes("recipeSlots"), text);
});

console.log("[brief] 配方闸口（confirm_brief 会拦）");

test("没采纳配方 → 闸口放行（老工程不受影响）", () => {
  assert.equal(recipeGateError({ goal: "涨粉" } as never), null);
  assert.equal(recipeGateError(null), null);
});

test("采纳整片配方但没有槽位 → 拦住", () => {
  const err = recipeGateError({ recipe: { id: "PM010", name: "FigPad" } } as never);
  assert.ok(err && err.includes("recipeSlots 空"), String(err));
  assert.ok(err!.includes("get_prompt_pick"), String(err));
});

test("槽位有一格 actual 空着 → 拦住并点名", () => {
  const err = recipeGateError({
    recipe: { id: "PM010", name: "FigPad" },
    recipeSlots: [
      { slot: "产品", actual: "回声笔记" },
      { slot: "时长", recipe: "60 秒" },
    ],
  } as never);
  assert.ok(err && err.includes("时长"), String(err));
  assert.ok(!err!.includes("产品、"), String(err));
});

test("槽位全填 → 放行", () => {
  assert.equal(
    recipeGateError({
      recipe: { id: "PM010", name: "FigPad" },
      recipeSlots: [
        { slot: "产品", actual: "回声笔记" },
        { slot: "时长", recipe: "60 秒", actual: "30 秒", conflict: "按用户" },
      ],
    } as never),
    null,
  );
});

test("技法（TK）不拦——它不改整片结构", () => {
  assert.equal(
    recipeGateError({
      recipe: { id: "TK002", name: "光标打字", kind: "tech" },
      recipeSlots: [],
    } as never),
    null,
  );
  // kind 忘了写、但编号是 TK：仍按技法放行（编号是唯一可靠的判据）
  assert.equal(recipeGateError({ recipe: { id: "TK007", name: "x" } } as never), null);
});

test("槽位条目缺 slot 名 → 视为没对账", () => {
  const err = recipeGateError({
    recipe: { id: "PM001", name: "x" },
    recipeSlots: [{ actual: "随便填的" }],
  } as never);
  assert.ok(err && err.includes("recipeSlots 空"), String(err));
});

console.log("[storyboard] 三问字段与长片提示");
test("change / carry 渲染进分镜文本", () => {
  const text = storyboardToText({
    shots: [
      { type: "title", text: "开场", change: "LOGO 从粒子聚成", carry: "上支片尾的圆" },
      { type: "bullets", text: "三个卖点" },
    ],
  });
  assert.ok(text.includes("变化：LOGO 从粒子聚成"), text);
  assert.ok(text.includes("承接：上支片尾的圆"), text);
  assert.ok(!text.includes("long-form"), "12 幕以内不应出现长片提示");
});

test("13 幕带长片章节提示，12 幕不带", () => {
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ type: i === 0 ? "title" : "bullets", text: `第 ${i + 1} 幕` }));
  assert.ok(storyboardToText({ shots: mk(13) }).includes("long-form"));
  assert.ok(storyboardToText({ shots: mk(13) }).includes("共 13 幕"));
  assert.ok(!storyboardToText({ shots: mk(12) }).includes("long-form"));
});

console.log(failures.length ? `\n失败 ${failures.length} 项` : `\n全部通过：${passed} 个用例`);
if (failures.length) process.exit(1);
