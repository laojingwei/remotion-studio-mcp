/**
 * 验收分级（P0–P3）的契约测试。
 *
 * 为什么要测这条：`blockingIssues` 决定"能不能渲染"。它失效的方式是**安静地放行**——
 * 一条 P0 被当成 P2，用户看到的就是"意思错了还交付了"。而阻塞逻辑一旦放宽，
 * 后面每个工具都会跟着放宽。
 *
 * 覆盖：
 *   1. 级别常量：顺序与阻断范围（回执的分组顺序依赖 REVIEW_LEVELS 的顺序）
 *   2. blockingIssues 只挑 P0/P1，P2/P3 放过，空值不炸
 *   3. markNeedsWork：清掉 confirmedAt、issues 追加且新的在前
 *   4. markReviewConfirmed 带 P2/P3：仍留档（不阻断 ≠ 丢掉）
 *   5. 老 review.json（没有 issues 字段）读取不崩
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PROJECTS_ROOT } from "../server/paths";
import {
  BLOCKING_LEVELS,
  REVIEW_LEVELS,
  blockingIssues,
  markNeedsWork,
  markReviewConfirmed,
  readReview,
  type ReviewIssue,
} from "../server/review.service";

const PID = "p_test_review_levels";
const DIR = path.join(PROJECTS_ROOT, PID);
const FILE = path.join(DIR, "review.json");

let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  [ok] ${name}`);
  } catch (err) {
    failed++;
    console.log(`  [fail] ${name}\n        ${err instanceof Error ? err.message : String(err)}`);
  }
};

const issue = (level: ReviewIssue["level"], text = "x", scene?: number): ReviewIssue => ({
  level,
  text,
  ...(scene ? { scene } : {}),
});

console.log("级别常量");
check("REVIEW_LEVELS 按 P0→P3 排列（回执分组靠这个顺序）", () => {
  assert.deepEqual(REVIEW_LEVELS, ["P0", "P1", "P2", "P3"]);
});
check("只有 P0/P1 阻断", () => {
  assert.deepEqual(BLOCKING_LEVELS, ["P0", "P1"]);
});

console.log("阻断判定");
check("挑出 P0/P1，忽略 P2/P3", () => {
  const got = blockingIssues([issue("P3"), issue("P2"), issue("P1"), issue("P0")]);
  assert.deepEqual(
    got.map((x) => x.level),
    ["P1", "P0"],
    "P2/P3 被当成阻断会逼用户为错别字重看一遍；P0/P1 漏掉会交付错误内容",
  );
});
check("没有任何 issue / undefined 都不炸", () => {
  assert.deepEqual(blockingIssues([]), []);
  assert.deepEqual(blockingIssues(undefined), []);
});
check("全是 P2/P3 时可以过", () => {
  assert.equal(blockingIssues([issue("P2"), issue("P3")]).length, 0);
});

console.log("状态写入");
check("markNeedsWork 清掉 confirmedAt 并追加 issues（新的在前）", () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  markReviewConfirmed(PID, ["先前的"], [issue("P3", "旧问题")]);
  const after = markNeedsWork(PID, ["字幕压住了"], [issue("P1", "字幕压住二维码", 3)]);
  assert.equal(after.confirmedAt, undefined, "previous 的通过没被清掉，render_video 会以为还能渲");
  assert.equal(after.issues?.[0].text, "字幕压住二维码", "新一轮的 issues 没排在最前面");
  assert.ok(after.issues?.some((x) => x.text === "旧问题"), "旧 issues 被覆盖了，复核时看不到历史");
  assert.deepEqual(after.feedback, ["先前的", "字幕压住了"]);
});

check("markReviewConfirmed 带 P2/P3 时也留档", () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  const r = markReviewConfirmed(PID, [], [issue("P2", "结尾有点赶"), issue("P3", "图标小")]);
  assert.ok(r.confirmedAt, "通过时间没写");
  assert.equal(r.issues?.length, 2, "不阻断不等于丢掉：这几条下一版可能还要改");
});

check("老 review.json（没有 issues 字段）读取不崩", () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ confirmedAt: "2026-01-01T00:00:00.000Z", feedback: ["老格式"] }), "utf8");
  const r = readReview(PID);
  assert.equal(r?.issues, undefined);
  assert.deepEqual(blockingIssues(r?.issues), [], "老工程没有 issues 时不能被当成有阻断");
});

fs.rmSync(DIR, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
