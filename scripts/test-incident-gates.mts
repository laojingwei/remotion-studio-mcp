/**
 * 事故闸口回归：这次改动的四个出口，每个都要被钉住。
 *
 * 对应 `检讨-配音交付流程失误.md` 里四类「把用户的确认权挪给自己」：
 *   1. confirm_brief(acknowledgedAssumptions=true) 一个布尔过 16 项
 *   2. 配音没被听过就建幕
 *   3. 重跑 TTS 后仍按旧版配音排版
 *   4. render_video(force=true) 无任何证据
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../server/root";
import { checkAssumptionQuotes } from "../server/brief.service";
import { MIN_QUOTE_CHARS, appendDecision, lastDecision, quoteIssue, readDecisions } from "../server/decision-log.service";
import { markNarrationHeard, narrationHeardState } from "../server/narration-timing.service";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ═════════ ① 一个布尔不能糊过 16 项 assumed ═════════ */

const SIXTEEN = [
  "受众=0-3月准新人",
  "layoutMode=freeform",
  "mustInclude 由文档挑选",
  "delivery=MP4",
  "deadline=今天",
  "brandRules=无",
  "禁止荧光黄",
  "禁止花字",
  "禁止表情包",
  "禁止大字压脸",
  "sfx=关",
  "safeArea=默认",
  "cover=不要",
  "mood=专业克制",
  "subtitleSpec=8-16字",
  "transitionTone=动感",
];

test("一条原话都没有 → 不通过（这就是事故里那个动作）", () => {
  const r = checkAssumptionQuotes(SIXTEEN, []);
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 16);
});

test("只给一半 → 不通过，并指出缺哪几条", () => {
  const r = checkAssumptionQuotes(SIXTEEN, [
    { field: "受众=0-3月准新人", userSaid: "就是要给刚开始看直播的人" },
    { field: "delivery=MP4", userSaid: "给我 mp4 就行" },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 14);
  assert.ok(r.missing.includes("brandRules=无"));
});

test("16 条全给真原话 → 通过，且按 assumed 顺序归一化", () => {
  const r = checkAssumptionQuotes(
    SIXTEEN,
    SIXTEEN.map((f) => ({ field: f, userSaid: `这条按你说的来，${f} 我没意见` })),
  );
  assert.equal(r.ok, true, JSON.stringify({ missing: r.missing, tooShort: r.tooShort }));
  assert.equal(r.checks.length, 16);
  assert.equal(r.checks[0].field, "受众=0-3月准新人");
});

test("「可以」「好」「你定」这种不算原话 —— 它们撑不起一次授权", () => {
  for (const bare of ["可以", "好", "你定", "随便", "同意", "ok"]) {
    const r = checkAssumptionQuotes(["mood=专业克制"], [{ field: "mood=专业克制", userSaid: bare }]);
    assert.equal(r.ok, false, `「${bare}」不该通过`);
    assert.ok(r.tooShort[0].includes("不算原话"), r.tooShort[0]);
  }
});

test("原话要说出同意的是什么事（带内容的短句才通过）", () => {
  const r = checkAssumptionQuotes(
    ["mood=专业克制"],
    [{ field: "mood=专业克制", userSaid: "别太花，稳重一点就行" }],
  );
  assert.equal(r.ok, true, JSON.stringify(r.tooShort));
});

test("字段名对不上 → 视为没给（防「随便写个 field 糊过去」）", () => {
  const r = checkAssumptionQuotes(["delivery=MP4"], [{ field: "delivery", userSaid: "给我 mp4 就行" }]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["delivery=MP4"]);
});

/* ═════════ ② 用户原话长度闸口（force / narration 共用） ═════════ */

test("force 不给原话 → 报错，且报错里要教怎么写", () => {
  const msg = quoteIssue("");
  assert.ok(msg && msg.includes("必须带用户原话"), msg ?? "null");
});

test("force 原话太短（< 5 字）→ 拒绝", () => {
  const msg = quoteIssue("渲吧");
  assert.ok(msg && msg.includes("太短"), msg ?? "null");
  assert.equal("渲吧".length < MIN_QUOTE_CHARS, true);
});

test("force 给足原话 → 放行", () => {
  assert.equal(quoteIssue("不用看了，先渲一版给我看看"), null);
});

/* ═════════ ③ 配音「听过」的三种状态（用真实文件测，不手算） ═════════ */

const TMP = `p_gate_test_${process.pid}`;
const dir = path.join(ROOT, "data", "projects", TMP);
const timingFile = path.join(dir, "narration-timing.json");

function writeTiming(t: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(timingFile, JSON.stringify(t), "utf8");
}
function clearTiming() {
  if (fs.existsSync(timingFile)) fs.unlinkSync(timingFile);
}

test("没合成过配音 → none（纯图文片不该被这个闸口挡住）", () => {
  clearTiming();
  assert.equal(narrationHeardState(TMP).state, "none");
});

test("合成过但没听过 → unheard（这就是事故里的状态）", () => {
  writeTiming({ at: "2026-10-31T05:34:00Z", fps: 30, totalSec: 118, segments: [{}, {}, {}, {}, {}] });
  const s = narrationHeardState(TMP);
  assert.equal(s.state, "unheard");
  assert.ok(s.detail.includes("还没听过"), s.detail);
});

test("听过且就是当前版本 → heard，且带上用户原话", () => {
  writeTiming({
    at: "v2",
    fps: 30,
    totalSec: 118,
    segments: [{}],
    heardAt: "2026-10-31T06:00:00Z",
    heardOf: "v2",
    heardUserSaid: "配音可以了，继续做画面",
  });
  const s = narrationHeardState(TMP);
  assert.equal(s.state, "heard");
  assert.ok(s.detail.includes("配音可以了"), s.detail);
});

test("重跑了 TTS（版本变了）→ 又变回 unheard，必须重听", () => {
  writeTiming({
    at: "v3",
    fps: 30,
    totalSec: 120,
    segments: [{}],
    heardAt: "2026-10-31T06:00:00Z",
    heardOf: "v2",
    heardUserSaid: "配音可以了",
  });
  const s = narrationHeardState(TMP);
  assert.equal(s.state, "unheard", "改过稿还按旧版排版，等于把画面锁在废弃的语音上");
  assert.ok(s.detail.includes("旧版本"), s.detail);
});

test("markNarrationHeard 能落盘，且立刻变成 heard", () => {
  writeTiming({ at: "v4", fps: 30, totalSec: 100, segments: [{}] });
  const after = markNarrationHeard(TMP, "听过了，语速没问题");
  assert.equal(after.heardOf, after.at);
  assert.equal(after.heardUserSaid, "听过了，语速没问题");
  assert.equal(narrationHeardState(TMP).state, "heard");
});

test("没有配音时 markNarrationHeard 要报错（不能凭空确认）", () => {
  clearTiming();
  assert.throws(() => markNarrationHeard(TMP, "听过了"), /还没有配音/);
});

/* ═════════ ④ 决策留痕：同一类闸口能查到最近一次原话 ═════════ */

test("force 原话会写进 decisions.jsonl，且能读回最近一次", () => {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "decisions.jsonl");
  if (fs.existsSync(f)) fs.unlinkSync(f);
  appendDecision(TMP, { kind: "force-render", userQuote: "不用看了，先渲一版给我", note: "rev=12" });
  appendDecision(TMP, { kind: "force-render", userQuote: "行吧那你直接出片", note: "rev=18" });
  const last = lastDecision(TMP, "force-render");
  assert.ok(last, "要能读回记录");
  assert.equal(last!.userQuote, "行吧那你直接出片", "要拿最近一次，不是第一次");
  assert.equal(readDecisions(TMP).length, 2);
});

// 收尾清理
clearTiming();
for (const name of ["decisions.jsonl", "narration-timing.json"]) {
  const f = path.join(dir, name);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
if (fs.existsSync(dir)) fs.rmdirSync(dir);

/* ────────────────────────── 汇总 ────────────────────────── */
console.log(`\n事故闸口：${pass} 通过${fail ? `，${fail} 失败` : "，全部通过"}`);
if (fail) process.exit(1);
