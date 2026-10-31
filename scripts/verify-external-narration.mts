/**
 * 外部配音端到端：真人录音 / 别的 TTS 给的音频，三种真实形态全覆盖。
 *   A. 一幕多条 + 首尾留空（from 指定）
 *   B. 整轨切片（startFrom + durationInFrames）
 *   C. flac 读不出时长 → 明确拒绝 + 转码指引
 * 然后验证闸口：没听过不许建幕；听过放行；挪动音频后又要重听。
 */
process.env.SERVER_URL = "http://127.0.0.1:4399";
process.env.MCP_EXPOSE = "all";

const BASE = process.env.SERVER_URL ?? "http://127.0.0.1:4399";
/** 样本目录：由 scripts/make-audio-samples.sh 生成，或自己放同名的 mp3/wav */
const D = process.env.AUDIO_SAMPLES ?? "C:/Users/Administrator/AppData/Local/Temp/extaudio2";
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
const line = (s: string) => `\n${"═".repeat(72)}\n${s}\n${"═".repeat(72)}`;

// 样本不在就明确跳过，而不是报一堆"失败"
const fsChk = await import("node:fs");
const need = ["vo-01.mp3", "vo-02.mp3", "full-track.wav", "vo-flac.flac"];
const missing = need.filter((f) => !fsChk.existsSync(`${D}/${f}`));
if (missing.length) {
  console.log(
    `\n⏭  样本缺失，跳过（缺：${missing.join("、")}）\n` +
      `   生成方式见 scripts/make-audio-samples.sh，或设环境变量 AUDIO_SAMPLES 指向已有样本目录。\n`,
  );
  process.exit(0);
}
if (!String(BASE).startsWith("http")) {
  console.log("\n⏭  SERVER_URL 不是 http 地址，跳过\n");
  process.exit(0);
}
let pass = 0;
let fail = 0;
const expect = (label: string, cond: boolean, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✅" : "❌"} ${label}${!cond && extra ? `\n     ${extra.slice(0, 200)}` : ""}`);
};

/* 备一个能过契约闸口的工程 */
const ASSUMED = [
  "受众=准新人", "layoutMode=freeform", "mustInclude 由文档挑选", "delivery=MP4",
  "deadline=今天", "brandRules=无", "禁止荧光黄", "禁止花字", "禁止表情包", "禁止大字压脸",
  "sfx=关", "safeArea=默认", "cover=不要", "mood=专业克制", "subtitleSpec=8-16字", "transitionTone=动感",
];
async function freshProject(name: string) {
  const created = await (await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  })).json();
  const pid = created.project?.id ?? created.id;

  // 完整走 brief + confirm：否则后面所有"被拒"都可能其实是 brief 闸口拦的，
  // 测不到配音闸口（第一版测试就栽在这——误判成"配音闸口生效"）。
  await call("save_brief", {
    projectId: pid,
    goal: "涨粉", platform: "抖音", durationSec: 20, aspect: "9:16",
    style: "kinetic-brutalist", layoutMode: "freeform", assetsNote: "外部配音已给",
    voice: "真人配音（外部文件）", subtitle: "硬字幕", delivery: "MP4", deadline: "今天", brandRules: "无",
    mustInclude: ["到手 3700"],
    core: { who: "准新人", believe: "抽成高", action: "关注" },
    form: "口播讲解",
    segments: [{ startSec: 0, endSec: 8, content: "钩子" }, { startSec: 8, endSec: 20, content: "讲抽成" }],
    open3: { firstFrame: "数字", firstLine: "一万音浪到手多少", bgmStart: "是" },
    ending: { lastLine: "关注", cta: "关注" },
    mustInfo: [{ text: "到手 3700", where: "正文" }],
    shots: [{ desc: "数字", subject: "无出镜", durationSec: 3, segmentId: "1" }],
    refs: [{ source: "某片", range: "00:03-00:08", aspect: ["节奏"] }],
    assets: [{ item: "外部配音", owner: "客户", due: "今天" }],
    deliverables: [{ type: "主片", spec: "1080x1920" }],
    acceptance: { approver: "用户", criteria: ["信息准确"], reviseRounds: 2 },
    mood: ["专业"],
    assumed: ASSUMED,
  });
  const cf = await call("confirm_brief", {
    projectId: pid,
    assumptions: ASSUMED.map((f) => ({ field: f, userSaid: `关于「${f}」，我同意你按这个来` })),
  });
  if (!cf.ok) throw new Error("测试前置失败（brief 没确认）：" + cf.text.slice(0, 200));

  // 建两幕占位（此时工程没有配音 → 配音闸口应为 none，放行）
  const bf = await call("build_film", {
    projectId: pid,
    replace: true,
    scenes: [
      { type: "title", props: { title: "占位一" }, text: "占位一" },
      { type: "list", props: { heading: "占位", items: [{ title: "a", note: "1" }] }, text: "占位二" },
    ],
  });
  if (!bf.ok) throw new Error("测试前置失败（建占位幕）：" + bf.text.slice(0, 200));
  return pid;
}

/* ═════════ A. 一幕多条 + 首尾留空 ═════════ */
line("A. 同一幕放两条旁白，中间留空 40 帧（首尾不相连）");
{
  const pid = await freshProject("ext-A-multi");
  const scenes = (await (await fetch(`${BASE}/api/projects/${pid}`)).json()).project.scenes;
  const s1 = scenes[0].id;

  const r = await call("register_narration", {
    projectId: pid,
    segments: [
      { path: `${D}/vo-01.mp3`, sceneId: s1, text: "第一句：一万音浪到手多少", from: 0 },
      { path: `${D}/vo-02.mp3`, sceneId: s1, text: "第二句：平台先抽一半", from: 200 },
    ],
  });
  expect("两条 mp3 都登记成功", r.ok, r.text);
  expect("回执给完整可播链接", /http:\/\/127\.0\.0\.1:4399\/assets\//.test(r.text), r.text);
  expect("回执说明这一幕有几条 / 什么位置", /2 条|@0 帧|@200 帧/.test(r.text), r.text);

  const els = (await (await fetch(`${BASE}/api/projects/${pid}`)).json()).project.scenes[0].elements.filter(
    (e: { kind?: string }) => e.kind === "audio",
  );
  expect("工程里真的落了 2 条音频", els.length === 2, JSON.stringify(els.length));
  expect("第 1 条在 0 帧、第 2 条在 200 帧（中间留空）",
    els.some((e: { from?: number }) => e.from === 0) && els.some((e: { from?: number }) => e.from === 200),
    JSON.stringify(els.map((e: { from?: number }) => e.from)));
  const scDur = (await (await fetch(`${BASE}/api/projects/${pid}`)).json()).project.scenes[0].durationInFrames;
  expect("幕被延长到装得下（不是把音频截断）", scDur >= 200 + 60, `幕长 ${scDur}`);
  expect("都带旁白标记", els.every((e: { narration?: boolean }) => e.narration === true));

  // 闸口：没听过 → 不许建幕
  const blocked = await call("build_film", {
    projectId: pid,
    scenes: [{ type: "title", props: { title: "一万音浪" }, text: "一万音浪" }],
  });
  expect("没听过 → build_film 被拒（外部音频也管住了）", !blocked.ok, blocked.text);
  expect("拒绝理由里带可播链接", /http:\/\/127\.0\.0\.1:4399\/assets\//.test(blocked.text), blocked.text);

  const heard = await call("confirm_narration", { projectId: pid, userSaid: "两条都听过了，语速没问题" });
  expect("确认听过 → 成功", heard.ok, heard.text);
  expect("回执给出这一版指纹", /指纹/.test(heard.text), heard.text);

  const ok2 = await call("build_film", {
    projectId: pid,
    scenes: [{ type: "title", props: { title: "一万音浪到手多少" }, text: "一万音浪到手多少" }],
  });
  expect("听过之后 → 放行", ok2.ok, ok2.text);

  await fetch(`${BASE}/api/projects/${pid}`, { method: "DELETE" });
}

/* ═════════ B. 整轨切片 ═════════ */
line("B. 一条 12 秒整轨，切成两段挂在不同位置（startFrom + durationInFrames）");
{
  const pid = await freshProject("ext-B-slice");
  const scenes = (await (await fetch(`${BASE}/api/projects/${pid}`)).json()).project.scenes;
  const s1 = scenes[0].id;

  const r = await call("register_narration", {
    projectId: pid,
    segments: [
      { path: `${D}/full-track.wav`, sceneId: s1, from: 0, startFrom: 0, durationInFrames: 150, text: "前半" },
      { path: `${D}/full-track.wav`, sceneId: s1, from: 180, startFrom: 150, durationInFrames: 150, text: "后半" },
    ],
  });
  expect("同一条整轨切两段 → 成功", r.ok, r.text);
  expect("回执标出「取文件 N 帧起」", /取文件 150 帧起/.test(r.text), r.text);

  const els = (await (await fetch(`${BASE}/api/projects/${pid}`)).json()).project.scenes[0].elements.filter(
    (e: { kind?: string }) => e.kind === "audio",
  );
  expect("两段都从同一个文件来", new Set(els.map((e: { src?: string }) => e.src)).size === 1);
  expect("第二段 startFrom=150", els.some((e: { startFrom?: number }) => e.startFrom === 150),
    JSON.stringify(els.map((e: { startFrom?: number }) => e.startFrom)));

  await fetch(`${BASE}/api/projects/${pid}`, { method: "DELETE" });
}

/* ═════════ C. 不支持的格式 ═════════ */
line("C. flac 读不出时长 → 明确拒绝（不猜、不静默）");
{
  const pid = await freshProject("ext-C-flac");
  const scenes = (await (await fetch(`${BASE}/api/projects/${pid}`)).json()).project.scenes;

  const r = await call("register_narration", {
    projectId: pid,
    segments: [{ path: `${D}/vo-flac.flac`, sceneId: scenes[0].id, text: "这段是 flac" }],
  });
  expect("flac → 被拒绝", !r.ok, r.text);
  expect("拒绝理由说清是读不出时长", /读不出时长/.test(r.text), r.text);
  expect("给出可执行的转码命令", /ffmpeg -i/.test(r.text), r.text);

  // 混着给：好的 + 坏的 → 整批拒绝（不能只落一半）
  const mix = await call("register_narration", {
    projectId: pid,
    segments: [
      { path: `${D}/vo-01.mp3`, sceneId: scenes[0].id, text: "好的" },
      { path: `${D}/vo-flac.flac`, sceneId: scenes[0].id, text: "坏的" },
    ],
  });
  expect("好文件 + 坏文件混着 → 整批拒绝（不留半批）", !mix.ok, mix.text);
  const els = ((await (await fetch(`${BASE}/api/projects/${pid}`)).json()).project.scenes[0].elements ?? []).filter(
    (e: { kind?: string }) => e.kind === "audio",
  );
  expect("拒绝后工程里没有落半批音频", els.length === 0, JSON.stringify(els.length));

  await fetch(`${BASE}/api/projects/${pid}`, { method: "DELETE" });
}

/* ═════════ D. 听过之后挪动音频 → 指纹变，要重听 ═════════ */
line("D. 听过之后把音频挪到另一幕 → 必须重听");
{
  const pid = await freshProject("ext-D-move");
  const scenes = (await (await fetch(`${BASE}/api/projects/${pid}`)).json()).project.scenes;
  await call("register_narration", {
    projectId: pid,
    segments: [{ path: `${D}/vo-01.mp3`, sceneId: scenes[0].id, text: "先放第一幕", from: 0 }],
  });
  const heard = await call("confirm_narration", { projectId: pid, userSaid: "听过了，可以继续" });
  expect("先确认听过", heard.ok, heard.text);

  // 挪到第二幕（绝对位置变了）
  const audioEl = (await (await fetch(`${BASE}/api/projects/${pid}`)).json()).project.scenes[0].elements.find(
    (e: { kind?: string }) => e.kind === "audio",
  );
  await fetch(`${BASE}/api/projects/${pid}/ops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actor: "agent",
      ops: [{ op: "move_element", sceneId: scenes[0].id, elementId: audioEl.id, toSceneId: scenes[1].id }],
    }),
  }).catch(() => null);

  // move_element 可能不支持跨幕，退而求其次：直接改 from
  await fetch(`${BASE}/api/projects/${pid}/ops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actor: "agent",
      ops: [{ op: "update_element", sceneId: scenes[0].id, elementId: audioEl.id, patch: { from: 90 } }],
    }),
  });

  const blocked = await call("build_film", {
    projectId: pid,
    scenes: [{ type: "title", props: { title: "x" }, text: "x" }],
  });
  expect("挪了位置 → 建幕又被拒（指纹变了）", !blocked.ok, blocked.text);
  expect("理由说清是「旧一版」或「没听过」", /旧一版|还没听过/.test(blocked.text), blocked.text);

  await fetch(`${BASE}/api/projects/${pid}`, { method: "DELETE" });
}

line(`外部配音：${pass} 项通过${fail ? `，${fail} 项失败` : "，全部通过"}`);
if (fail) process.exit(1);
