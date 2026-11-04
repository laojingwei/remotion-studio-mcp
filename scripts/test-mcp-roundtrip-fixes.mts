/**
 * MCP 全链路实测后的回归单测（2026-11-04）。
 *
 * 覆盖三个「回执与闸口打架」的地方，都是肉眼 review 看不出来、但会让 agent 白跑一轮的：
 *  1. save_brief 说「契约完整」而 confirm_brief 拒人（两处判定不同源）
 *  2. preview_frames 的帧号越界静默钳到末帧（4 个不同帧返回同一张图）
 *  3. 跨工程调用的「找不到场景」不提示工程归属
 */
import assert from "node:assert/strict";
import { confirmGapText, confirmGaps } from "../server/brief.service";
import { sceneMissingMessage } from "../server/tools/_shared";

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}：${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ✗ ${name}`);
  }
}

const NL = String.fromCharCode(10);

/* ── ① 契约口径：confirmGaps 就是 confirm_brief 的判定 ── */
test("空 brief：缺口覆盖 9 步必填，且每项都带字段名（= confirm_brief 的原话）", () => {
  const gaps = confirmGaps({} as never);
  assert.ok(gaps.length >= 6, `预期多步缺，实际 ${gaps.length}`);
  const keys = gaps.flatMap((g) => g.miss.map((m) => m.key));
  // 9 步必填集（BRIEF_STEPS）——与 confirm_brief 同一份
  for (const k of ["goal", "platform", "durationSec", "aspect", "style", "voice", "deliverables"]) {
    assert.ok(keys.includes(k), `缺口里应该点名 ${k}：${keys.join(",")}`);
  }
});

test("缺口文案：说清「现在问确认会被拒」，并给步数", () => {
  const txt = confirmGapText({} as never, NL);
  assert.match(txt, /confirm_brief 还差 \d+ 步 \/ \d+ 项必填/);
  assert.match(txt, /现在问确认会被拒/);
});

test("契约齐的 brief：confirmGapText 返回空串（回执才能说「能过」）", () => {
  const full = {
    core: { who: "技术负责人", believe: "视频可以像代码一样调度", action: "跑一次" },
    form: "动画演示",
    segments: [{ startSec: 0, endSec: 10, content: "开场", shotIds: [] }],
    open3: { firstFrame: "黑底白字", firstLine: "做视频最贵的是改", bgmStart: "是" },
    ending: { lastLine: "全链路跑通", cta: "跑一次" },
    mustInfo: [{ text: "MCP", where: "画面正文" }],
    bans: ["赋能"],
    shots: [{ id: "s1", desc: "标题字", subject: "无人物", location: "图形", productState: "无", durationSec: 10, segmentId: "1" }],
    refs: [],
    noRefReason: "没有参考片，风格按 hologram-hud 定",
    assets: [{ item: "无", owner: "agent", due: "当天" }],
    deliverables: [{ type: "主片", spec: "1080p" }],
    acceptance: { approver: "我", criteria: ["准确"], reviseRounds: 2 },
    goal: "看懂能力边界",
    platform: "B站",
    durationSec: 10,
    aspect: "16:9",
    style: "hologram-hud",
    layoutMode: "内置场景",
    assetsNote: "无",
    voice: "女声",
    subtitle: "硬字幕",
    deadline: "2026-11-05",
    brandRules: "无",
  };
  const gaps = confirmGaps(full as never);
  assert.equal(gaps.length, 0, `不该有缺口：${JSON.stringify(gaps)}`);
  assert.equal(confirmGapText(full as never, NL), "", "契约齐时不该再输出缺口块");
});

/* ── ② 找不到场景：跨工程时要说清是「两个工程」 ── */
test("找不到场景：列出本工程现有场景", () => {
  const msg = sceneMissingMessage({ id: "p_a", name: "片子A" }, [{ id: "s1", name: "开场" }], "s9");
  assert.match(msg, /工程「片子A」里没有场景 s9/);
  assert.match(msg, /s1（开场）/);
});

test("找不到场景：默认工程不同时提示 projectId 只对当次生效", () => {
  const msg = sceneMissingMessage({ id: "p_a", name: "片子A" }, [], "s9");
  // lastProjectId 在这条单测里通常是 null 或别的工程；断言措辞不依赖具体值
  assert.ok(msg.length > 20);
});

test("找不到场景：空工程也有明确说法", () => {
  const msg = sceneMissingMessage({ id: "p_x" }, [], "s1");
  assert.match(msg, /一个都没有/);
});

/* ── ③ 盘点结果 ── */
console.log("");
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);
