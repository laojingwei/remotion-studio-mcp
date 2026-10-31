/**
 * 事故复验：拿检讨里的操作序列重跑一遍，看四个新闸口是否真的堵住。
 * 与 tmp-incident-audit.mts 的区别：这个跑**修复后**的行为，每一步都断言。
 */
process.env.SERVER_URL = "http://127.0.0.1:4399";
process.env.MCP_EXPOSE = "all";

const BASE = "http://127.0.0.1:4399";
const m = await import("../server/mcp-tools");
const reg = ((m.buildMcpServer() as unknown as { _registeredTools: Record<string, { handler: Function }> })
  ._registeredTools) ?? {};

const call = async (name: string, args: Record<string, unknown> = {}) => {
  try {
    const out = await reg[name].handler(args, {} as never);
    return { ok: !out?.isError, text: String(out?.content?.[0]?.text ?? "") };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
};
const mk = async (n: string) =>
  ((await (await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: n }),
  })).json()).project?.id ?? "") as string;
const rm = (id: string) => fetch(`${BASE}/api/projects/${id}`, { method: "DELETE" });

const line = (s: string) => `\n${"═".repeat(70)}\n${s}\n${"═".repeat(70)}`;
let pass = 0;
let fail = 0;
const expect = (label: string, cond: boolean, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${extra ? `\n     ${extra}` : ""}`);
  }
};

const ASSUMED = [
  "受众=0-3月准新人", "layoutMode=freeform", "mustInclude 由文档挑选", "delivery=MP4",
  "deadline=今天", "brandRules=无", "禁止荧光黄", "禁止花字", "禁止表情包", "禁止大字压脸",
  "sfx=关", "safeArea=默认", "cover=不要", "mood=专业克制", "subtitleSpec=8-16字", "transitionTone=动感",
];

const FULL_BRIEF = {
  goal: "涨粉", platform: "抖音", durationSec: 20, aspect: "9:16",
  style: "kinetic-brutalist", layoutMode: "freeform", assetsNote: "没有素材，纯排版",
  voice: "AI 女声", subtitle: "硬字幕", delivery: "MP4", deadline: "今天", brandRules: "无",
  mustInclude: ["到手 3700"],
  core: { who: "准新人", believe: "抽成高、到手很少", action: "关注看下一章" },
  form: "口播讲解",
  segments: [{ startSec: 0, endSec: 4, content: "钩子：一万音浪到手多少" }, { startSec: 4, endSec: 20, content: "讲清抽成" }],
  open3: { firstFrame: "10000 数字", firstLine: "一万音浪到手多少", bgmStart: "是" },
  ending: { lastLine: "下一章讲公会", cta: "关注" },
  mustInfo: [{ text: "到手 3700", where: "第 2 幕正文" }],
  shots: [{ desc: "数字冲击版式", subject: "无出镜", durationSec: 4, segmentId: "1" }],
  refs: [{ source: "某爆款解说", range: "00:03-00:08", aspect: ["节奏"] }],
  assets: [{ item: "Logo", owner: "客户", due: "今天" }],
  deliverables: [{ type: "主片", spec: "1080x1920" }],
  acceptance: { approver: "用户", criteria: ["信息准确"], reviseRounds: 2 },
  mood: ["专业", "克制"],
  assumed: ASSUMED,
};

/* ═════════ 闸口 ①：一个布尔糊不过 16 项 assumed ═════════ */
line("闸口①：confirm_brief(acknowledgedAssumptions=true) —— 事故里的原动作");
{
  const pid = await mk("verify-bool-gate");
  await call("save_brief", { projectId: pid, ...FULL_BRIEF });
  const r = await call("confirm_brief", { projectId: pid, acknowledgedAssumptions: true });
  expect("只传布尔 → 被拒绝", !r.ok, r.text.slice(0, 150));
  expect("拒绝理由里列出缺的字段", /还没有用户原话|不能只传/.test(r.text), r.text.slice(0, 200));
  await rm(pid);
}

/* ═════════ 闸口 ②：给了原话才放行 ═════════ */
line("闸口②：16 条逐条带用户原话");
{
  const pid = await mk("verify-quote-gate");
  await call("save_brief", { projectId: pid, ...FULL_BRIEF });

  // 先试「只给一半」
  const half = await call("confirm_brief", {
    projectId: pid,
    assumptions: ASSUMED.slice(0, 8).map((f) => ({ field: f, userSaid: "这条我没意见，按你说的办" })),
  });
  expect("只给一半原话 → 被拒绝", !half.ok, half.text.slice(0, 120));

  // 再试「给全但都是『可以』」
  const bare = await call("confirm_brief", {
    projectId: pid,
    assumptions: ASSUMED.map((f) => ({ field: f, userSaid: "可以" })),
  });
  expect("原话全是「可以」→ 被拒绝", !bare.ok, bare.text.slice(0, 120));

  // 最后给全真原话
  const good = await call("confirm_brief", {
    projectId: pid,
    assumptions: ASSUMED.map((f) => ({ field: f, userSaid: `关于「${f}」，我同意你按这个来` })),
  });
  expect("16 条真原话 → 通过", good.ok, good.text.slice(0, 200));
  expect("回执说「你提供的记录」而不是「已核对」", /你提供的核对记录/.test(good.text), good.text.slice(0, 200));
  expect("回执不再替 agent 背书", !/已核对替你拍板的/.test(good.text));

  // 核对记录必须落盘
  const b = await (await fetch(`${BASE}/api/projects/${pid}/brief`)).json();
  expect("核对记录落进 brief.assumptionChecks", (b.brief?.assumptionChecks ?? []).length === 16,
    JSON.stringify((b.brief?.assumptionChecks ?? []).length));

  /* ═════════ 闸口 ③：配音没听过 → 不许建幕 ═════════ */
  line("闸口③：合成配音但用户没听过，直接建整片");
  await call("save_script", { projectId: pid, segments: [{ text: "一万音浪到手多少" }, { text: "平台先抽一半" }] });
  await call("confirm_script", { projectId: pid });

  const tts = await call("tts_narration", {
    projectId: pid,
    mode: "timing",
    segments: [{ text: "一万音浪到手多少" }, { text: "平台先抽一半" }],
  });
  expect("tts_narration 成功", tts.ok, tts.text.slice(0, 150));
  const fullUrl = tts.text.match(/http:\/\/[^\s]+\.(?:wav|mp3)/);
  expect("回执里有完整可播链接", !!fullUrl, tts.text.slice(0, 300));
  if (fullUrl) {
    const head = await fetch(fullUrl[0], { method: "GET" });
    expect("这条链接真的能播（HTTP 200 + audio）", head.status === 200 &&
      String(head.headers.get("content-type") ?? "").includes("audio"),
      `${head.status} ${head.headers.get("content-type")}`);
  }
  expect("回执要求先发给用户听", /发给用户|停在这里/.test(tts.text), tts.text.slice(0, 300));

  const film1 = await call("build_film", {
    projectId: pid,
    scenes: [{ type: "title", props: { title: "一万音浪到手多少" }, text: "一万音浪到手多少" }],
  });
  expect("没听过就 build_film → 被拒绝", !film1.ok, film1.text.slice(0, 200));
  expect("拒绝理由指向 confirm_narration", /confirm_narration/.test(film1.text), film1.text.slice(0, 250));

  /* ═════════ 闸口 ④：confirm_narration 要原话 ═════════ */
  line("闸口④：confirm_narration 的原话要求");
  const tooShort = await call("confirm_narration", { projectId: pid, userSaid: "可以" });
  expect("userSaid 太短（schema 层就拒）", !tooShort.ok, tooShort.text.slice(0, 150));

  const heard = await call("confirm_narration", { projectId: pid, userSaid: "配音听过了，语速没问题，继续做画面" });
  expect("给足原话 → 记录成功", heard.ok, heard.text.slice(0, 200));
  expect("回执明说「工具无法验证真伪」", /无法验证/.test(heard.text), heard.text.slice(0, 250));

  const film2 = await call("build_film", {
    projectId: pid,
    scenes: [
      { type: "title", props: { title: "一万音浪到手多少" }, text: "一万音浪到手多少" },
      { type: "list", props: { heading: "抽成", items: [{ title: "50%", note: "平台" }] }, text: "平台先抽一半" },
    ],
  });
  expect("听过之后 build_film → 放行", film2.ok, film2.text.slice(0, 250));

  await rm(pid);
}

/* ═════════ 闸口 ⑤：force 渲染必须带原话 ═════════ */
line("闸口⑤：render_video(force=true) 不带原话");
{
  const pid = await mk("verify-force-gate");
  const noQuote = await call("render_video", { projectId: pid, force: true, dryRun: false });
  expect("force 不带原话 → 被拒绝", !noQuote.ok, noQuote.text.slice(0, 200));
  expect("拒绝理由教了怎么写", /forceUserQuote/.test(noQuote.text), noQuote.text.slice(0, 250));

  const shortQuote = await call("render_video", { projectId: pid, force: true, forceUserQuote: "渲吧" });
  expect("原话太短 → 被拒绝", !shortQuote.ok, shortQuote.text.slice(0, 150));

  await rm(pid);
}

line(`复验结果：${pass} 项通过${fail ? `，${fail} 项失败` : "，全部通过"}`);
if (fail) process.exit(1);
