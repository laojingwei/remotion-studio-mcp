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

const { briefToText } = await import("../server/brief.service");
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
