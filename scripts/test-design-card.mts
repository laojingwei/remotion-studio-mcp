/**
 * 设计稿（export_design）的契约测试。
 *
 * 为什么要有：设计稿是"用户第一次读这部片子"的唯一时机。它坏掉的方式不是报错，
 * 而是「读起来挺完整，但该报的没报」——用户照着一份漏了二维码、漏了禁用词、
 * 时长少一半的稿子点头，然后整片返工。所以把每个"必须报"与"不许乱报"钉成断言。
 *
 * 覆盖：
 *   1. 七节齐全、逐幕后每幕一行
 *   2. 必须出现的信息：真去画面/口播里找（写在 brief 里不等于会出现在片子里）
 *   3. 禁用词出现在任何一幕 → 必须修
 *   4. plain 幕显「换页」而不是「没写变化」（催封面写变化是错的）
 *   5. 时长偏离 >15% 才报，±10% 不报
 *   6. 出过样张就不再提"还没做样张"
 *   7. 文案里的竖线不能把表格撑破
 *   8. 空幕（无字也无口播）要被点出来
 */
import assert from "node:assert/strict";

import { buildDesignCard } from "../server/design.service";
import type { Brief } from "../server/brief.service";
import type { Storyboard, Shot } from "../server/storyboard.service";

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

const project = { name: "测试片", fps: 30, formats: [{ key: "h", label: "横版", width: 1920, height: 1080 }] };

const brief = (patch: Partial<Brief> = {}): Brief => ({
  form: "动画演示",
  durationSec: 30,
  core: { who: "老板", believe: "这件事能省一半时间", action: "扫码试用" },
  segments: [{ startSec: 0, endSec: 30, content: "从头讲到尾" }],
  ...patch,
});

const shot = (patch: Partial<Shot> = {}): Shot => ({
  type: "bigtext",
  durationInFrames: 150,
  props: { heading: "一句大字" },
  text: "一句口播",
  relation: "plain",
  ...patch,
});

const card = (shots: Shot[], b: Brief | null = brief(), review: null | { probeAt?: string } = null) =>
  buildDesignCard({
    project,
    brief: b,
    storyboard: { shots } as Storyboard,
    picks: null,
    review: review as never,
    now: new Date("2026-11-08T00:00:00Z"),
  });

console.log("设计稿结构");
check("七节齐全，逐幕一条一行", () => {
  const c = card([shot(), shot({ relation: "cause", props: { heading: "因果" } })]);
  for (const h of ["## 一、", "## 二、", "## 三、", "## 四、", "## 五、", "## 七、"]) {
    assert.ok(c.markdown.includes(h), `缺少小节 ${h}`);
  }
  // 只数逐幕表：结构表的行也是「| 1 | … |」，靠"时长列形如 5.0s"区分
  const rows = c.markdown.split("\n").filter((l) => /^\| [12] \| [\d.]+s \|/.test(l));
  assert.equal(rows.length, 2, `逐幕表应有 2 行，实际 ${rows.length}`);
});

check("开头就说清「还没建场景」与怎么改", () => {
  const c = card([shot()]);
  assert.ok(c.markdown.includes("还没建任何场景"), "用户会以为这就是成片");
  assert.ok(/要改直接说位置和改法/.test(c.markdown), "没告诉用户怎么改，他就只能全盘否定");
});

console.log("必须出现的信息 / 禁用词");
check("必须信息没落到画面 → 必须修", () => {
  const c = card([shot()], brief({ mustInfo: [{ text: "客服二维码", where: "结尾" }] }));
  const gap = c.gaps.find((g) => g.level === "block" && g.text.includes("客服二维码"));
  assert.ok(gap, "漏报：建出来结尾不会有二维码");
});

check("必须信息出现在画面文字里 → 不报", () => {
  const c = card(
    [shot(), shot({ props: { heading: "扫码加客服", note: "" }, text: "扫码领清单" })],
    brief({ mustInfo: [{ text: "扫码领清单" }] }),
  );
  assert.ok(
    !c.gaps.some((g) => g.text.includes("扫码领清单")),
    "口播里已经说了还报，等于教人忽略这个清单",
  );
});

check("禁用词出现在任何一幕 → 必须修", () => {
  const c = card([shot({ text: "我们是行业第一" })], brief({ bans: ["第一"] }));
  const gap = c.gaps.find((g) => g.level === "block" && g.text.includes("第一"));
  assert.ok(gap, "客户明令禁止的词漏报是硬伤");
});

check("禁用词报告带幕号与上下文（量词误伤要能一眼判断）", () => {
  // bans「第一」命中文案「第一句」是真实场景：没上下文 agent 只能来回猜是不是真违规
  const c = card([shot({ text: "60% 的人在你讲第一句时离开" })], brief({ bans: ["第一"] }));
  const gap = c.gaps.find((g) => g.level === "block" && g.text.includes("第一"))!;
  assert.ok(gap, "漏报");
  assert.ok(gap.text.includes("第 1 幕"), `没报幕号，agent 还要自己找：${gap.text}`);
  assert.ok(gap.text.includes("第一句"), `没带上下文，分不清「行业第一」和「第一句」：${gap.text}`);
});

check("counter 的数字要出现在逐幕表的屏幕字里", () => {
  // value=60 是那一幕最大的字：只收字符串的话逐幕表只剩 "%"，用户看不见主数字
  const c = card([
    shot({ type: "counter", props: { value: 60, suffix: "%", label: "的人在前 3 秒离开", decimals: 0 } }),
  ]);
  const row = c.markdown.split("\n").find((l) => /^\| 1 \| [\d.]+s \|/.test(l)) ?? "";
  assert.ok(row.includes("60"), `主数字没上屏：${row}`);
  assert.ok(!row.includes("decimals"), `参数数字（decimals）不该出现在屏幕字里：${row}`);
});

check("字幕与大标题逐字相同 → 提醒去重", () => {
  const c = card([
    shot({ type: "list", text: "开场三件事", props: { heading: "开场三件事", items: [{ title: "a" }] } }),
    shot({ type: "outro", text: "今天只改第一句", props: { title: "先改第一句", action: "x" } }),
  ]);
  assert.ok(
    c.gaps.some((g) => g.text.includes("逐字相同") && g.text.includes("第 1 幕")),
    "同屏同句出现两遍没报——观众会觉得难受但说不出为什么",
  );
  // outro 那幕字幕≠标题（「今天只改第一句」vs「先改第一句」），不许误报
  assert.ok(
    !c.gaps.some((g) => g.text.includes("逐字相同") && g.text.includes("第 2 幕")),
    "字幕只是接近但不同的大字被误报",
  );
});

console.log("关系与时长");
check("plain 幕写「换页」而不是催它写变化", () => {
  const c = card([shot({ relation: "plain" }), shot({ relation: "cause" })]);
  const row = c.markdown.split("\n").find((l) => /^\| 1 \| [\d.]+s \|/.test(l)) ?? "";
  assert.ok(row.includes("换页"), `封面行没写「换页」：${row}`);
  assert.ok(!row.includes("没写变化"), "封面本来不承担关系，催它写变化是错的");
});

check("承担关系的分布不把 plain 混进去", () => {
  const c = card([shot({ relation: "plain" }), shot({ relation: "plain" }), shot({ relation: "cause" })]);
  const line = c.markdown.split("\n").find((l) => l.includes("真正承担关系的")) ?? "";
  assert.ok(line.includes("因果×1"), `分布里没写因果：${line}`);
  assert.ok(!line.includes("不承担关系×"), "plain 混进「承担关系」的分布，会让这行自相矛盾");
});

check("时长偏离 >15% 才报，±10% 不报", () => {
  // 2 幕 × 150 帧 = 10s；目标 30s → 差 67%
  const far = card([shot(), shot()]);
  assert.ok(
    far.gaps.some((g) => g.text.includes("目标 30s")),
    "差 67% 都没报，用户会拿到一条只有三分之一的片子",
  );
  // 2 幕 × 450 帧 = 30s → 正好
  const near = card([shot({ durationInFrames: 450 }), shot({ durationInFrames: 450 })]);
  assert.ok(!near.gaps.some((g) => g.text.includes("目标 30s")), "时长刚好还报，属于噪音");
});

console.log("样张与空幕");
check("没出过样张 → 建议改里提醒；出过就不提", () => {
  const none = card([shot()]);
  assert.ok(none.gaps.some((g) => g.text.includes("风格样张")), "用户第一次看画面就是成片，这条必须提");
  const done = card([shot()], brief(), { probeAt: new Date().toISOString() });
  assert.ok(!done.gaps.some((g) => g.text.includes("风格样张")), "已经出过样张还提，清单会失去可信度");
});

check("读窗不够要报：字多、幕短就是「只能看到不能读到」", () => {
  // 20 字 × 0.25s + 0.3s 落字 = 5.3s，只给 3s（90 帧）
  const tight = card([shot({ text: "一个月稳定出十二条内容，第三个月开始有询盘进来", durationInFrames: 90 })]);
  assert.ok(
    tight.gaps.some((g) => g.text.includes("读不完")),
    "20 字给 3 秒没报，用户会觉得「一闪而过」而不知道为什么",
  );
  // 同一句话给 8 秒就不该报
  const loose = card([shot({ text: "一个月稳定出十二条内容，第三个月开始有询盘进来", durationInFrames: 240 })]);
  assert.ok(!loose.gaps.some((g) => g.text.includes("读不完")), "给够时间还报，属于噪音");
});

check("空幕（无字也无口播）被点出来", () => {
  const c = card([shot({ props: {}, text: "", name: "" })]);
  assert.ok(c.gaps.some((g) => g.text.includes("空白")), "建出来是几秒空白，必须提醒");
});

console.log("格式健壮性");
check("文案里的竖线不撑破表格", () => {
  const c = card([shot({ text: "A|B 对比", props: { heading: "左|右" } })]);
  const rows = c.markdown.split("\n").filter((l) => /^\| 1 \| [\d.]+s \|/.test(l));
  const cols = rows[0].split("|").length;
  const header = c.markdown.split("\n").find((l) => l.startsWith("| # |")) ?? "";
  assert.equal(cols, header.split("|").length, `列数不一致：${rows[0]}`);
});

check("没有分镜时不崩，明说还没分镜", () => {
  const c = card([]);
  assert.ok(c.markdown.includes("还没有分镜"), "空分镜应给一句提示，而不是空表");
  assert.equal(c.stats.shots, 0);
});

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
