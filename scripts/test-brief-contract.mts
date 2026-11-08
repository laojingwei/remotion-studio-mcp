/**
 * 需求契约单测（纯函数，不碰磁盘 / 不起服务）。
 *
 *   tsx scripts/test-brief-contract.mts
 *
 * 覆盖 v4 的三块：
 *  - 设计锁：形态默认 → 档位 → 具体参数；情绪词只升降一档
 *  - 契约覆盖率：六条判据（一句话 / 段落表 / 镜头 / 参考 / 素材 / 交付）+ 形态分流（防空转）
 *  - 成片比对：mustInfo 漏项阻断、禁词命中阻断、开头第一句/时长偏差只提醒
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

const { deriveDesignLock, lockViolations, FORM_SPECS } = await import("../shared/designLock");
const { briefCoverage } = await import("../server/brief.service");
const { auditBriefAgainstProject } = await import("../server/brief-audit.service");

/** 一份"说清了"的完整 brief（口播讲解形态） */
const fullBrief = () => ({
  goal: "卖货",
  platform: "抖音",
  durationSec: 60,
  aspect: "9:16",
  style: "data-motion",
  layoutMode: "freeform",
  assetsNote: "无",
  voice: "AI 女声",
  subtitle: "硬字幕",
  delivery: "MP4",
  deadline: "10/10",
  brandRules: "无",
  core: { who: "经销商", believe: "新品利润高", action: "报名订货会" },
  form: "口播讲解",
  segments: [
    { startSec: 0, endSec: 3, content: "钩子：这档利润翻倍" },
    { startSec: 3, endSec: 60, content: "讲清三档利润与订货政策" },
  ],
  open3: { firstFrame: "数字 3 倍弹出", firstLine: "这档利润翻倍", bgmStart: "是" },
  ending: { lastLine: "名额有限", cta: "扫码报名", qr: "结尾右下", date: "10月10日", logo: "淡入" },
  mustInfo: [{ text: "新品A", where: "画面正文" }],
  shots: [{ desc: "讲师正面出镜讲开场", subject: "真人", durationSec: 3, segmentId: "1" }],
  refs: [{ source: "某品牌讲解片", range: "00:03–00:08", aspect: ["节奏"] }],
  assets: [{ item: "Logo", owner: "客户", due: "10/05" }],
  deliverables: [{ type: "主片", spec: "1080×1920 / H.264" }],
  acceptance: { approver: "老板", criteria: ["信息准确"], reviseRounds: 2 },
  mood: ["专业", "克制"],
});

console.log("[designLock] 形态默认与档位推导");

test("口播讲解 → 讲稿密度 / 克制动感 / 柔和转场 / 特效关", () => {
  const lock = deriveDesignLock({ form: "口播讲解" });
  assert.equal(lock.density, "讲稿", lock.density);
  assert.equal(lock.motion, "克制", lock.motion);
  assert.equal(lock.transition, "柔和", lock.transition);
  assert.equal(lock.effects, "关", lock.effects);
  assert.deepEqual(lock.effectWhitelist, [], "特效关就该是空白名单");
});

test("用户显式给的档位优先于形态默认", () => {
  const lock = deriveDesignLock({ form: "口播讲解", density: "杂志", motionLevel: "活泼" });
  assert.equal(lock.density, "杂志");
  assert.equal(lock.motion, "活泼");
  assert.equal(lock.sources.density, "user");
  assert.equal(lock.sources.transition, "form", "没显式给的仍标 form");
});

test("转场白名单与帧数上限跟着性格走", () => {
  const soft = deriveDesignLock({ form: "口播讲解", transitionTone: "柔和" });
  assert.ok(!soft.transitionWhitelist.includes("flip"), "柔和不该允许 flip");
  assert.equal(soft.transitionMaxFrames, 15);
  const sharp = deriveDesignLock({ form: "产品演示", transitionTone: "利落" });
  assert.equal(sharp.transitionMaxFrames, 10);
});

test("情绪词只做升降一档，不改变形态基准", () => {
  const base = deriveDesignLock({ form: "产品演示" }); // 标准
  const hi = deriveDesignLock({ form: "产品演示", mood: ["高级", "克制"] });
  assert.equal(hi.motion, "克制", "高级/克制 应把标准降到克制");
  assert.notEqual(base.motion, hi.motion);
  const quiet = deriveDesignLock({ form: "动画演示", mood: ["高级"] }); // 活泼 → 标准
  assert.equal(quiet.motion, "标准");
});

test("形态别名容错：写中文白话也能落到 7 种形态之一", () => {
  assert.equal(deriveDesignLock({ form: "口播" }).form, "口播讲解");
  assert.equal(deriveDesignLock({ form: "产品测评" }).form, "产品演示");
  assert.equal(deriveDesignLock({ form: "MG动画" }).form, "动画演示");
  assert.equal(deriveDesignLock({}).form, "口播讲解", "不填默认口播讲解");
});

test("7 种形态都有预设，且动画/混剪不需要镜头清单", () => {
  for (const f of Object.keys(FORM_SPECS)) {
    assert.ok(deriveDesignLock({ form: f }).titleSizePct > 0, f);
  }
  assert.equal(FORM_SPECS["动画演示"].shots, "list");
  assert.equal(FORM_SPECS["情景剧"].shots, "full");
});

console.log("[lockViolations] 设计锁违约检查");

const scene = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  name: "第 1 幕",
  durationInFrames: 90,
  elements: [] as unknown[],
  ...over,
});

test("文字元素超过密度上限要报", () => {
  const lock = deriveDesignLock({ form: "口播讲解", density: "讲稿" }); // 上限 7
  const elements = Array.from({ length: 9 }, (_, i) => ({ kind: "text", text: `字${i}`, size: 5.6 }));
  const v = lockViolations(lock, [scene({ elements })]);
  assert.ok(v.some((x) => x.kind === "elements"), JSON.stringify(v));
});

test("背景装饰层不算信息元素", () => {
  const lock = deriveDesignLock({ form: "情景剧" }); // 海报密度，上限 5
  const elements = [
    ...Array.from({ length: 4 }, (_, i) => ({ kind: "text", text: `字${i}`, size: 7 })),
    { kind: "svg", name: "背景网格", size: 100 },
    { kind: "svg", name: "光晕", size: 60 },
  ];
  const v = lockViolations(lock, [scene({ elements })]);
  assert.ok(!v.some((x) => x.kind === "elements"), JSON.stringify(v));
});

test("转场不在白名单 / 超过时长上限都要报", () => {
  const lock = deriveDesignLock({ form: "口播讲解", transitionTone: "柔和" });
  const v = lockViolations(lock, [
    scene({ elements: [{ kind: "text", text: "短", size: 5.6 }], transitionIn: { type: "flip", durationInFrames: 12 } }),
    scene({ id: "s2", name: "第 2 幕", transitionIn: { type: "blur", durationInFrames: 40 } }),
  ]);
  assert.ok(v.some((x) => x.kind === "transition" && x.message.includes("flip")), JSON.stringify(v));
  assert.ok(v.some((x) => x.kind === "transitionLength"), JSON.stringify(v));
});

test("相同的违约在多幕重复时聚合成一条（避免 14 条噪声）", () => {
  const lock = deriveDesignLock({ form: "口播讲解", transitionTone: "柔和" });
  const many = Array.from({ length: 6 }, (_, i) =>
    scene({ id: `s${i}`, name: `第 ${i + 1} 幕`, transitionIn: { type: "circle", durationInFrames: 12 } }),
  );
  const v = lockViolations(lock, many);
  assert.equal(v.filter((x) => x.kind === "transition").length, 1, JSON.stringify(v));
  assert.ok(v[0].sceneName.includes("6 幕"), v[0].sceneName);
});

console.log("[lockViolations] 自由排版豁免（字雨/落字是动画设计，不是版面违规）");

test("layoutFree 幕：元素数 / 字号档位 / 叠字转场全部豁免", () => {
  const lock = deriveDesignLock({ form: "口播讲解", density: "讲稿", transitionTone: "柔和" });
  // 30 个单字（远超上限 7）、字号偏离锁定值、30 字 > 20 用 flip——三条必撞
  const rain = Array.from({ length: 30 }, (_, i) => ({ kind: "text", text: `${i}`, size: 2.1 }));
  const s = scene({
    layoutFree: true,
    elements: rain,
    transitionIn: { type: "flip", durationInFrames: 12 },
  });
  const v = lockViolations(lock, [s]);
  assert.equal(v.filter((x) => x.kind === "elements" || x.kind === "titleSize").length, 0, JSON.stringify(v));
  assert.ok(!v.some((x) => x.message.includes("会叠字")), JSON.stringify(v));
});

test("freeform 天然豁免，不用声明 layoutFree", () => {
  const lock = deriveDesignLock({ form: "口播讲解", density: "讲稿" });
  const rain = Array.from({ length: 12 }, (_, i) => ({ kind: "text", text: `字${i}`, size: 2.1 }));
  const v = lockViolations(lock, [scene({ type: "freeform", elements: rain })]);
  assert.ok(!v.some((x) => x.kind === "elements" || x.kind === "titleSize"), JSON.stringify(v));
});

test("layoutFree 只豁免版面三条，转场白名单与时长上限仍然生效", () => {
  const lock = deriveDesignLock({ form: "口播讲解", transitionTone: "柔和" });
  const v = lockViolations(lock, [
    scene({
      layoutFree: true,
      elements: [{ kind: "text", text: "短", size: 5.6 }],
      transitionIn: { type: "blur", durationInFrames: 40 },
    }),
  ]);
  assert.ok(v.some((x) => x.kind === "transitionLength"), JSON.stringify(v));
});

console.log("[briefCoverage] 六条「算说清了」的判据");

test("空 brief：六条全缺，且明确不可开工", () => {
  const c = briefCoverage({});
  assert.equal(c.ok, false);
  const codes = c.blocking.map((x) => x.code).join(",");
  for (const need of ["core.who", "form", "segments.empty", "refs.empty", "deliverables.empty"]) {
    assert.ok(codes.includes(need), `缺 ${need}：${codes}`);
  }
});

test("完整的口播 brief：通过", () => {
  const c = briefCoverage(fullBrief() as never);
  assert.ok(c.ok, JSON.stringify(c.blocking));
  assert.ok(c.judgedFilled >= 3, `判断项 ${c.judgedFilled}`);
});

test("段落表只有时长没有内容 → 不算说清", () => {
  const b = fullBrief();
  b.segments = [{ startSec: 0, endSec: 60, content: "" }];
  const c = briefCoverage(b as never);
  assert.ok(c.blocking.some((x) => x.code === "segments.0.content"), JSON.stringify(c.blocking));
});

test("段落表合计与目标时长差 >5% → 报错（这次 75s 估成 98s 就是这类）", () => {
  const b = fullBrief();
  b.segments = [{ startSec: 0, endSec: 40, content: "只写 40 秒" }];
  const c = briefCoverage(b as never);
  assert.ok(c.blocking.some((x) => x.code === "segments.sum"), JSON.stringify(c.blocking));
});

test("参考只给链接不指时间点 → 不算确认", () => {
  const b = fullBrief();
  b.refs = [{ source: "https://example.com/a", aspect: ["节奏"] }] as never;
  const c = briefCoverage(b as never);
  assert.ok(c.blocking.some((x) => x.code === "refs.0.range"), JSON.stringify(c.blocking));
});

test("客户确实没有参考：写清替代依据可放行，空着仍阻断", () => {
  const blank = fullBrief();
  blank.refs = [] as never;
  assert.ok(
    briefCoverage(blank as never).blocking.some((x) => x.code === "refs.empty"),
    "空着应该阻断",
  );

  const withReason = fullBrief();
  withReason.refs = [] as never;
  (withReason as never as Record<string, unknown>).noRefReason = "没有参考，按他们官网 VI 和上次那条爆款定";
  const c = briefCoverage(withReason as never);
  assert.ok(!c.blocking.some((x) => x.code === "refs.empty"), JSON.stringify(c.blocking));
  assert.ok(c.warnings.some((x) => x.code === "refs.none"), "放行要留痕");

  const tooShort = fullBrief();
  tooShort.refs = [] as never;
  (tooShort as never as Record<string, unknown>).noRefReason = "没有";
  assert.ok(
    briefCoverage(tooShort as never).blocking.some((x) => x.code === "refs.empty"),
    "理由太短不算说清",
  );
});

test("素材没写责任人 / 截止 → 不算确认", () => {
  const b = fullBrief();
  b.assets = [{ item: "产品图" }] as never;
  const c = briefCoverage(b as never);
  assert.ok(c.blocking.some((x) => x.code === "assets.0.owner"), JSON.stringify(c.blocking));
  assert.ok(c.blocking.some((x) => x.code === "assets.0.due"), JSON.stringify(c.blocking));
});

test("形态分流：情景剧要逐镜有出镜归属，动画演示不用镜头清单", () => {
  const drama = fullBrief() as never as Record<string, unknown>;
  drama.form = "情景剧";
  drama.shots = [{ desc: "开场", durationSec: 3, segmentId: "1" }, { desc: "结尾", durationSec: 5 }];
  const cDrama = briefCoverage(drama as never);
  assert.ok(cDrama.blocking.some((x) => x.code.includes("segmentId")), JSON.stringify(cDrama.blocking));

  const anim = fullBrief();
  anim.form = "动画演示";
  anim.shots = [] as never;
  const cAnim = briefCoverage(anim as never);
  assert.ok(!cAnim.blocking.some((x) => x.code.startsWith("shots")), JSON.stringify(cAnim.blocking));
});

test("agent 替用户拍板超过 3 条 → 提醒", () => {
  const b = fullBrief();
  (b as never as Record<string, unknown>).assumed = ["style", "pace", "palette", "texture"];
  const c = briefCoverage(b as never);
  assert.ok(c.warnings.some((x) => x.code === "assumed.many"));
});

console.log("[brief_audit] 成片对契约");

const project = (texts: string[], over: Record<string, unknown> = {}) => ({
  fps: 30,
  scenes: [
    {
      id: "s1",
      name: "第 1 幕",
      durationInFrames: 900,
      subtitle: "这档利润翻倍",
      elements: texts.map((t, i) => ({ kind: "text", name: `t${i}`, text: t, size: 5.6 })),
      ...over,
    },
  ],
});

test("mustInfo 漏项 → 阻断（这是契约能成立的唯一硬保证）", () => {
  const r = auditBriefAgainstProject(fullBrief() as never, project(["新品B"]) as never);
  assert.equal(r.ok, false);
  assert.ok(r.blocking.some((x) => x.includes("新品A")), JSON.stringify(r.blocking));
});

test("mustInfo 出现 → 通过", () => {
  const r = auditBriefAgainstProject(fullBrief() as never, project(["新品A", "三档利润"]) as never);
  assert.ok(r.passed.some((x) => x.includes("必须出现")), JSON.stringify(r.passed));
});

test("禁用词命中 → 阻断", () => {
  const b = fullBrief();
  (b as never as Record<string, unknown>).bans = ["竞品X"];
  const r = auditBriefAgainstProject(b as never, project(["新品A", "比竞品X更便宜"]) as never);
  assert.equal(r.ok, false);
  assert.ok(r.blocking.some((x) => x.includes("竞品X")), JSON.stringify(r.blocking));
});

test("开头第一句对不上 → 只提醒不阻断", () => {
  const r = auditBriefAgainstProject(
    fullBrief() as never,
    { fps: 30, scenes: [{ id: "s1", name: "第1幕", durationInFrames: 1800, subtitle: "完全不同的开场", elements: [{ kind: "text", text: "新品A" }] }] } as never,
  );
  assert.ok(r.warnings.some((x) => x.includes("开头第一句")), JSON.stringify(r.warnings));
  assert.ok(!r.blocking.some((x) => x.includes("开头")), "开头句不该阻断");
});

test("时长偏离段落表 >10% → 提醒（75s 估成 98s 的场景）", () => {
  const r = auditBriefAgainstProject(
    fullBrief() as never,
    { fps: 30, scenes: [{ id: "s1", name: "第1幕", durationInFrames: 30 * 98, elements: [{ kind: "text", text: "新品A" }] }] } as never,
  );
  assert.ok(r.warnings.some((x) => x.includes("时长偏离")), JSON.stringify(r.warnings));
});

test("设计锁违约会进提醒（元素数超标）", () => {
  const lock = deriveDesignLock({ form: "口播讲解", density: "海报" }); // 上限 5
  const many = ["新品A", "词1", "词2", "词3", "词4", "词5", "词6", "词7", "词8"];
  const r = auditBriefAgainstProject(fullBrief() as never, project(many) as never, lock);
  assert.ok(r.warnings.some((x) => x.includes("文字元素")), JSON.stringify(r.warnings));
});

console.log(failures.length ? `\n失败 ${failures.length} 项` : `\n全部通过：${passed} 个用例`);
if (failures.length) process.exit(1);
