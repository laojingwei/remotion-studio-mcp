/**
 * 提示词库构建器：种子（人写的中文正文）+ 源站元数据 → `server/skills/prompt-library/**`。
 *
 * 用法：
 *   npx tsx scripts/build-prompt-library.mts            # 写入 md
 *   npx tsx scripts/build-prompt-library.mts --dry      # 只校验，不落盘
 *   npx tsx scripts/build-prompt-library.mts --check    # 校验 + 打印覆盖率，退出码非 0 表示有错
 *
 * 为什么要构建器而不是手写 207 个 md：
 * 1. 元信息（作者、原贴、槽位默认值、时长画幅）来自 `data/prompt-motion/source.json`，
 *    手抄 207 遍必错，而它又是"可回链、可核对"的凭据。
 * 2. 编号必须稳定：PM 编号由 source.json 里 slug 的排序位置决定，**不依赖种子写了多少条**。
 *    否则今天写 3 条、明天写 20 条，编号会整体漂移，面板里用户记住的编号就废了。
 * 3. 格式要一次定死：将来标签页的索引是机械解析的（见 server/styleLibrary.service.ts
 *    的 sectionOf / bulletOf），字段少一行、顺序变一次就会静默失效。
 *
 * 版式上一条硬约定：**`## 槽位` 放在 `## 提示词` 前面**。
 * 索引取正文的规则是"从 `## 提示词` 取到 `## 补充` 或文件尾"，不会在下一个 `##` 处停。
 * 槽位放后面就会被算进提示词正文，agent 读到的"提示词"里混进一堆字段说明。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { ROOT } from "../server/root";
import type { PromptGenre, Seed, TechniqueSeed } from "./seeds/prompt-library/types.mts";
import { FAMILIES } from "./seeds/prompt-library/families.mts";
import { PROMPT_GENRES, promptFidelityLabel, type PromptFidelity } from "../shared/prompt-library";

const SEED_DIR = path.join(ROOT, "scripts", "seeds", "prompt-library");
const SOURCE_FILE = path.join(ROOT, "data", "prompt-motion", "source.json");
const LIB_REL = "server/skills/prompt-library";
const LIB_ROOT = path.join(ROOT, LIB_REL);
const MANIFEST = path.join(ROOT, "data", "prompt-motion", "manifest.json");
const DEDUPE = path.join(ROOT, "data", "prompt-motion", "dedupe.json");

/**
 * 明确排除、不做成 md 的源条目。
 *
 * 为什么要有这份名单而不是"没写就不写"：207 条源条目最后只出 153 篇，
 * 差额必须能逐条说明去向——否则过一阵没人知道是漏了还是故意不要。
 */
const EXCLUDED: { slug: string; why: string }[] = [
  {
    slug: "sab8a-364a5a",
    why: "「Talking-head clip edit」是剪辑既有人像素材的活，本工具从零建场景、不做素材剪辑",
  },
];

/**
 * 类型 → 物理文件夹。**唯一来源是 `shared/prompt-library.ts`**。
 * 服务端按同一份定义扫目录，所以这里只做形状转换，不重复写文件夹名。
 */
const GENRES = Object.fromEntries(
  PROMPT_GENRES.map((g) => [g.id, { dir: g.dir, label: g.label }]),
) as Record<PromptGenre, { dir: string; label: string }>;

/** 槽位键 → 中文标签。源站字段是英文，直接甩给用户看不懂 */
const SLOT_LABEL: Record<string, string> = {
  size: "画幅",
  length: "时长",
  bpm: "节奏",
  product: "产品",
  brand: "品牌",
  ending: "结尾",
  palette: "配色",
  concept: "概念",
  typeface: "字体",
  style: "风格",
  theme: "主题",
  focus: "重点",
  topic: "主题",
  audience: "受众",
  premise: "设定",
  sound: "声音",
  voice: "配音",
  subject: "主体",
  what: "内容",
  count: "数量",
  language: "语言",
  tone: "基调",
  drink: "饮品",
  finish: "质感",
  base: "蓝本",
  design: "设计稿",
  twist: "改造方向",
};

type SourceItem = {
  slug: string;
  title: string;
  creator: string;
  tweetUrl: string;
  originalPrompt: string;
  template: string;
  sections: Record<string, string>;
  slots: { key: string; label: string; hint: string; default: string }[];
  media: { video: string | null; preview: string | null; poster: string | null };
  chars: { template: number };
};

/** 源站那句英文里混着的技术栈词，落进我们的 md 就是"教 agent 做我们做不到的事" */
const BANNED = [
  "Playwright",
  "window.seek",
  "tmix",
  "Web Audio",
  "OfflineAudioContext",
  "HTML",
  "three.js",
];

/**
 * 画风耦合度：从正文里判断这条配方有多依赖"画面长什么样"。
 *
 * 为什么用规则而不是逐条手标：153 条手标一定前后不一致，而且加一条新配方就没人记得标。
 * 规则只有两条，且都基于正文里客观存在的词：
 * · 出现媒介词（手绘/水墨/像素/剪纸/定格…）→ 绑定：这类片子的"手绘"就是内容本身；
 * · 只出现配色/字体词 → 部分：换风格时这几句要跟着换，结构不动；
 * · 都没有 → 自由。
 *
 * 「素材」「3D」「实拍」故意不算媒介词：它们几乎每篇都出现（"用素材拼"、"3D 渲染产品"），
 * 一加进去 80% 的配方都会变成"绑定"，标注就没意义了。
 */
const MEDIUM_WORDS = [
  "手绘", "水墨", "像素", "剪纸", "黏土", "定格", "蜡笔", "油画", "木刻", "铜版",
  "丝网", "水彩", "拼贴", "素描", "版画", "赛璐璐", "纸片", "浮雕", "皮影", "字符画",
  "立体书", "积木", "胶片",
];
const STYLE_WORDS = [
  "配色", "色值", "底色", "主色", "品牌色", "调色", "色板", "字体", "字重", "衬线",
  "无衬线", "字族",
];

function fidelityOf(body: string): PromptFidelity {
  if (MEDIUM_WORDS.some((w) => body.includes(w))) return "bound";
  if (STYLE_WORDS.some((w) => body.includes(w))) return "partial";
  return "free";
}

/**
 * 技法条目额外要挡的词。
 *
 * 26 条技法的原文都是 Canvas 2D 绘制函数（`S.A1(c,w,h,t,s)` 那种）。抄进正文等于
 * 教 agent 写我们跑不了的代码；只留"效果长什么样 + 参数 + 在我们工具里怎么拼"。
 */
const TECH_BANNED = [...BANNED, "Canvas 2D", "requestAnimationFrame", "canvas"];

/**
 * 槽位说明（中文）。
 *
 * 源站的 hint 是写给英文用户的（"1920x1080 landscape, 1080x1920 vertical…"），
 * 直接搬进中文库既难读、又会让 agent 把英文原样吐给用户。这里按 key 统一给中文口径；
 * 没收录的 key 才回落到源站 hint。
 */
const SLOT_HINT: Record<string, string> = {
  size: "横屏 1920×1080 / 竖屏 1080×1920 / 方形 1080×1080",
  length: "按片长总控；超过 45 秒就分段做，别一条硬拉",
  bpm: "每个动作都落在这个拍上，100–128 最常见",
  product: "名字 + 链接，不眼熟就加网址",
  brand: "配色与字体，不给就交给调研",
  ending: "最后一帧压的那句话",
  palette: "最多三色加黑白",
  concept: "一句话说死的视觉概念",
  typeface: "一种字体，全片不换",
  style: "画面语言：美术、年代、媒介质感",
  theme: "这条片子围绕的主题",
  topic: "要讲的东西",
  audience: "讲给谁听",
  focus: "必须让人记住的那一件事",
  premise: "一句话设定：谁、在哪、发生什么",
  sound: "音乐与音效的口径",
  voice: "配音音色与语速",
  subject: "要建的那个主体",
  what: "内容清单",
  count: "段数",
  language: "出屏文字的语言",
  tone: "整体调性",
  base: "要改的那条片：上一条，或一个链接",
  design: "设计稿来源，要一比一还原",
  twist: "往哪个方向改",
};

/**
 * 槽位默认值的整句翻译。
 *
 * 这几个值占了全库槽位的绝大多数（品牌 79 次、结尾 73 次、配色 71 次……），
 * 逐条手写中文既没必要也一定会漏；按"值"而不是"条目"翻，一次到位且前后一致。
 * 只在值**完全相等**时命中——不做模糊替换，免得把某个产品的真实文案也改了。
 */
const SLOT_VALUE: Record<string, string> = {
  "its own colors and typeface": "沿用产品自己的配色与字体",
  "a one-line call to action": "一行行动号召",
  "at most three colors plus black and white": "最多三色加黑白",
  'your pick (e.g. "ink becomes type becomes architecture")': "自选（例：墨变成字，字变成建筑）",
  "Geist, Inter or a bold display face from Google Fonts": "Geist、Inter，或一款粗显示体",
  "a score and sound effects written in code": "谱曲与音效都由我们自己合成",
  "a clear synthesized voice (e.g. edge-tts en-US-AriaNeural)": "清晰的合成音（如 edge-tts 的 Aria 音色）",
  "my site (paste the URL)": "我的站点（贴网址）",
  "my product (paste the URL)": "我的产品（贴网址）",
  "our product": "我们的产品",
  "your brand colors": "你的品牌色",
  "your choice": "自选",
  "your topic": "自选主题",
  "this product": "本产品",
  "this project": "本项目",
  "my app": "我的应用",
  "my studio": "我的工作室",
  "my website (paste the URL)": "我的网站（贴网址）",
  "the product at the link I give you": "我给的链接里的产品",
  "Distilbook (add its URL)": "Distilbook（补上网址）",
  "your product (add the link)": "你的产品（补上链接）",
  "a general audience": "大众受众",
  "a curious viewer with no technical background": "没有技术背景的好奇观众",
  "someone deciding whether to use it": "正在犹豫要不要用它的人",
  "someone who's never seen it": "第一次听说它的人",
  "a first-time visitor": "第一次访问的人",
  "a football fan who's never wondered": "从没好奇过这条线的橄榄球迷",
  "a developer": "开发者",
  "complete beginners": "完全零基础",
  "gamers": "玩家",
  "a physics student": "物理系学生",
  "someone with zero computer background": "零计算机背景的人",
  "someone who hasn't read it": "没读过那篇文章的人",
  "stirring and any garnish": "搅拌与装饰",
  "the last video we made": "我们上一条片",
  "a crypto reference": "一个加密题材的参照",
  "describe what you sell and who it's for": "写清你卖什么、卖给谁",
  "describe your colors": "写清你的配色",
  "a story you invent": "你编一个故事",
  "a story you imagine": "你想象一个故事",
  "an idea that will blow my mind": "一个能让我震惊的点子",
  "a pelican riding a bicycle": "一只骑自行车的鹈鹕",
  "a bug that doesn't want to be fixed": "一只不想被修好的虫子",
  "a story about time": "一个关于时间的故事",
  "what makes a place feel like home?": "什么让一个地方像家",
  "an idea that could go viral: a hook in the first second and a payoff people want to share": "一个能传播的点子：第一秒给钩子，结尾让人想转发",
  "your choice: whatever serves the story": "自选：怎么服务故事怎么来",
  "your choice: whatever serves the story best": "自选：怎么服务故事怎么来",
  "sound that tells half the story, with no dialogue at all": "声音讲一半故事，全片无对白",
  "music, narration and subtitles": "音乐、旁白与字幕",
  "a different genre every time, e.g. film noir, nature documentary, 8-bit game, infomercial": "每次换一种体裁：黑色电影、自然纪录片、八位机游戏、电视购物…",
  "the concept of \"Overthinking\"": "「过度思考」这个概念",
  "mathematics: shapes, proofs and patterns you'd find in a math book": "数学：数学书里的图形、证明与规律",
  "a poster breaking out of its own frame": "一张海报撕开自己的画框",
  "telling me what day of the week it is today": "告诉我今天是星期几",
  "your own motion reel: your choice of subject": "自选主题的个人运镜集锦",
  "whatever best flexes what Opus 5.5 can do": "最能展示 Opus 5.5 能力的东西",
  "whatever you think shows you off best": "你觉得最能展示自己的东西",
  "me, from what you know about me": "从你了解的我出发",
  "me introducing myself to a recruiter: my name, what I do, my best work": "向招聘方自我介绍：名字、做什么、最好的作品",
  "my skills (list them)": "我的技能（逐条列出）",
  "applying to my agency as a motion designer: your skills and capabilities": "投递工作室：技能与能力",
  "celebrating The Ferguson Recipes' 20th anniversary": "Ferguson Recipes 二十周年",
  "Korea's Chuseok: research its customs, food and imagery first": "韩国秋夕：先查习俗、食物与意象",
  "thanking the first 100 users of @eyezonbot": "感谢 @eyezonbot 的前 100 位用户",
  "the girl in the image I attach doing an exciting dance": "我附的图里那个女孩跳一段",
  "a niche branding agency for startup founders: create all the graphics from scratch, as if they were your agency's work": "只服务创业公司的小众品牌工作室：图形全部现画，当作自己工作室的作品",
  "anything, your call: make it crazy": "随便挑，放开做",
  "anything you pick: the design style, look and subject are yours": "全部自选：风格、外观、主题都归你",
};

/** 槽位默认值的中文形态：`15` → `15 秒`，`1920x1080` → `1920×1080` */
function slotValue(key: string, raw: string): string {
  if (!raw) return "（未填）";
  const t = raw.trim();
  if (SLOT_VALUE[t]) return SLOT_VALUE[t];
  const sec = /^(\d+)-second$/.exec(t);
  if (sec) return `${sec[1]} 秒`;
  const min = /^(\d+)-minute$/.exec(t);
  if (min) return `${min[1]} 分钟`;
  // 配音值是"英文形容词 + 具体音色"，前半句可以统一成中文，括号里的音色名保留（那是要填的参数）
  const voice = /^a clear synthesized voice(.*)$/.exec(t);
  if (voice) return `清晰的合成音${voice[1]}`;
  if (key === "length" && /^\d+$/.test(raw.trim())) return `${raw.trim()} 秒`;
  if (key === "size") return raw.replace(/(\d+)\s*[xX×]\s*(\d+)/, "$1×$2");
  if (key === "bpm") return `${raw} BPM`;
  return raw;
}

function sha12(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
}

function sanitizeName(name: string): string {
  return name.replace(/[\s/\\:*?"<>|·]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** `15` → `15 秒`；`1-minute` 原样保留；`1920x1080` → `1920×1080` */
function secondsText(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (/^\d+$/.test(t)) return `${t} 秒`;
  return t;
}

function sizeText(raw: string | undefined): string | null {
  if (!raw) return null;
  return raw.replace(/(\d+)\s*[xX×]\s*(\d+)/, "$1×$2");
}

function slotOf(item: SourceItem, key: string): string | undefined {
  return item.slots.find((s) => s.key === key)?.default;
}

/** 种子 + 家族 → 一条完整条目。家族只提供"族内一样的东西"，差异段仍在种子 */
function resolve(seed: Seed): {
  genre: PromptGenre;
  look: string;
  fit: string;
  tags: string[];
  body: string;
} {
  const fam = seed.family ? FAMILIES[seed.family] : undefined;
  if (seed.family && !fam) throw new Error(`未知家族「${seed.family}」`);
  const look = seed.look ?? (fam && seed.theme ? fam.lookTpl.replace("{t}", seed.theme) : "");
  const parts = [seed.note ? `**这一条**：${seed.note.trim()}` : "", seed.body ?? fam?.body ?? ""];
  return {
    genre: (seed.genre ?? fam?.genre) as PromptGenre,
    look: look.trim(),
    fit: (seed.fit ?? fam?.fit ?? "").trim(),
    tags: seed.tags ?? fam?.tags ?? [],
    body: parts.filter(Boolean).join("\n\n").trim(),
  };
}

/** 同稿组：同一段提示词被多人提交时，其余作者挂在主条目上 */
type DupInfo = { count: number; others: { title: string; creator: string }[] };

function render(item: SourceItem, seed: Seed, id: string, dup?: DupInfo): string {
  const r = resolve(seed);
  const g = GENRES[r.genre];
  const slotRaw = (k: string) => seed.slotCn?.[k] ?? slotOf(item, k);
  const dur = [
    slotRaw("length") ? slotValue("length", slotRaw("length")!) : null,
    slotRaw("size") ? slotValue("size", slotRaw("size")!) : null,
  ];
  const bpm = slotOf(item, "bpm");
  if (bpm) dur.push(`${bpm} BPM`);

  const lines: string[] = [];
  lines.push(`# ${id} ${seed.name}`);
  lines.push("");
  lines.push(`- 类型：${g.label}`);
  if (dur.filter(Boolean).length) lines.push(`- 时长：${dur.filter(Boolean).join(" · ")}`);
  lines.push(`- 长什么样：${r.look}`);
  lines.push(`- 适合：${r.fit}`);
  lines.push(`- 关键词：${r.tags.join("、")}`);
  lines.push(`- 画风耦合：${promptFidelityLabel(fidelityOf(r.body))}`);
  lines.push(
    `- 出处：@${item.creator} · ${item.tweetUrl} · prompt-motion.com/customize/${item.slug}`,
  );
  if (dup && dup.others.length) {
    const who = dup.others.slice(0, 6).map((o) => `@${o.creator}`).join("、");
    const more = dup.others.length > 6 ? " 等" : "";
    lines.push(
      `- 同稿：另有 ${dup.others.length} 位作者提交了同一段提示词（${who}${more}）——源站允许照抄模板直接交，所以这 ${dup.count} 条源页共用这一份配方`,
    );
  }
  lines.push("");

  if (item.slots.length) {
    lines.push("## 槽位");
    lines.push("");
    for (const s of item.slots) {
      const label = SLOT_LABEL[s.key] ?? s.label;
      const hint = SLOT_HINT[s.key] ?? s.hint;
      // 主题类槽位直接用条目的中文主题：源站默认值是英文描述句，而中文主题本来就写好了
      const auto =
        s.key === "theme" || s.key === "product" ? (seed.slotCn?.[s.key] ?? seed.theme) : undefined;
      const raw = auto ?? slotRaw(s.key);
      const val = slotValue(s.key, raw);
      // 值与说明撞车时只留值（例：配色默认就是"最多三色加黑白"，再跟一句同样的说明很傻）
      lines.push(`- ${label}：${val}${hint && hint !== val ? ` —— ${hint}` : ""}`);
    }
    lines.push("");
  }

  lines.push("## 提示词");
  lines.push("");
  lines.push(r.body);
  lines.push("");
  return lines.join("\n");
}

/** 结构校验。宁可挡住，也不要写出一批"看起来像那么回事"的废文档 */
function check(seed: Seed, item: SourceItem | undefined): string[] {
  const errs: string[] = [];
  if (!item) return [`slug「${seed.slug}」在 source.json 里不存在`];
  if (!seed.name || seed.name.length > 24) errs.push("name 缺失或超过 24 字");
  if (seed.family && !(seed.family in FAMILIES)) errs.push(`未知家族「${seed.family}」`);
  if (seed.family && !seed.theme) errs.push("用了家族却没写 theme（摘要模板要它）");
  if (!seed.family && !seed.body) errs.push("既没家族也没自带 body，正文会是空的");

  let r: ReturnType<typeof resolve>;
  try {
    r = resolve(seed);
  } catch (e) {
    return [...errs, (e as Error).message];
  }
  if (!(r.genre in GENRES)) errs.push(`genre「${r.genre}」不合法`);
  if (/\n/.test(r.look)) errs.push("look 必须是单行");
  if (r.look.includes("{t}")) errs.push("look 里还有没替换的 {t}");
  if (r.look.length < 15 || r.look.length > 90) errs.push(`look 长度 ${r.look.length}（要 15–90）`);
  if (r.fit.length < 8 || r.fit.length > 60) errs.push(`fit 长度 ${r.fit.length}（要 8–60）`);
  if (r.tags.length < 3 || r.tags.length > 6) errs.push("tags 要 3–6 个");
  const body = r.body;
  if (body.length < 400 || body.length > 1800) errs.push(`正文 ${body.length} 字（要 400–1800）`);
  if (/^##\s/m.test(body)) errs.push("正文里不能出现 `##`（会把索引取到的正文截断）");
  if (/\{\{/.test(body)) errs.push("正文里不要留 {{占位符}}（槽位由 `## 槽位` 承担）");
  const marks = (body.match(/\*\*[^*]+\*\*/g) ?? []).length;
  if (marks < 3) errs.push(`正文只有 ${marks} 个小标题（至少 3 个）`);
  for (const w of BANNED) if (body.includes(w)) errs.push(`正文出现源站技术栈词「${w}」，要换成本工具的写法`);
  return errs;
}

/** 单技法（TK 段）的渲染：没有源站元数据，所有字段都来自种子 */
function renderTechnique(t: TechniqueSeed, id: string): string {
  const g = GENRES.technique;
  const lines: string[] = [];
  lines.push(`# ${id} ${t.name}`);
  lines.push("");
  lines.push(`- 类型：${g.label}`);
  lines.push(`- 时长：${t.dur ?? "按内容定，一般 4–10 秒"}`);
  lines.push(`- 长什么样：${t.look}`);
  lines.push(`- 适合：${t.fit}`);
  lines.push(`- 关键词：${t.tags.join("、")}`);
  // 技法本身就是一种画法：谈不上"把字雨换一种风格"，换风格它就不是字雨了
  lines.push(`- 画风耦合：${promptFidelityLabel("bound")}`);
  // 用「·」分段是刻意的：服务端 sourceOf 按 · 切段取 creator/url/page。
  // 技法没有作者也没有源站链接，但仍要让抽屉里的「出处」有字可读。
  lines.push(
    `- 出处：原「技法」代码样片 ${t.sourceId} · data/archive/upgrade-source/02-手法/（原件归档）`,
  );
  lines.push("");
  lines.push("## 提示词");
  lines.push("");
  lines.push(t.body.trim());
  lines.push("");
  return lines.join("\n");
}

/** 技法条目的结构校验。规则和配方不同：没有槽位、没有源站 slug，但有更严的技术栈禁令 */
function checkTechnique(t: TechniqueSeed): string[] {
  const errs: string[] = [];
  if (!t.sourceId) errs.push("缺 sourceId（出处行要用它回溯原件）");
  if (!t.name || t.name.length > 24) errs.push("name 缺失或超过 24 字");
  if (/\n/.test(t.look)) errs.push("look 必须是单行");
  if (t.look.length < 20 || t.look.length > 90) errs.push(`look 长度 ${t.look.length}（要 20–90）`);
  if (t.fit.length < 8 || t.fit.length > 60) errs.push(`fit 长度 ${t.fit.length}（要 8–60）`);
  if (t.tags.length < 3 || t.tags.length > 6) errs.push("tags 要 3–6 个");
  const body = t.body.trim();
  if (body.length < 400 || body.length > 1800) errs.push(`正文 ${body.length} 字（要 400–1800）`);
  if (/^##\s/m.test(body)) errs.push("正文里不能出现 `##`（会把索引取到的正文截断）");
  if (/\{\{/.test(body)) errs.push("正文里不要留 {{占位符}}");
  const marks = (body.match(/\*\*[^*]+\*\*/g) ?? []).length;
  if (marks < 3) errs.push(`正文只有 ${marks} 个小标题（至少 3 个）`);
  for (const w of TECH_BANNED) if (body.includes(w)) errs.push(`正文出现代码样片词「${w}」，要换成本工具的写法`);
  return errs;
}

async function loadTechniqueSeeds(): Promise<TechniqueSeed[]> {
  const files = fs
    .readdirSync(SEED_DIR)
    .filter((f) => /^techniques-.*\.mts$/.test(f))
    .sort();
  const all: TechniqueSeed[] = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(path.join(SEED_DIR, f)).href)) as {
      TECHNIQUES?: TechniqueSeed[];
    };
    if (!mod.TECHNIQUES?.length) {
      console.warn(`⚠ ${f} 没有导出 TECHNIQUES`);
      continue;
    }
    all.push(...mod.TECHNIQUES);
  }
  return all;
}

async function loadSeeds(): Promise<Seed[]> {
  const files = fs
    .readdirSync(SEED_DIR)
    .filter((f) => /^batch-.*\.mts$/.test(f))
    .sort();
  const all: Seed[] = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(path.join(SEED_DIR, f)).href)) as { SEEDS?: Seed[] };
    if (!mod.SEEDS?.length) {
      console.warn(`⚠ ${f} 没有导出 SEEDS`);
      continue;
    }
    all.push(...mod.SEEDS);
  }
  return all;
}

async function main() {
  const dry = process.argv.includes("--dry");
  const checkOnly = process.argv.includes("--check");

  if (!fs.existsSync(SOURCE_FILE)) {
    console.error(`缺少 ${path.relative(ROOT, SOURCE_FILE)}，先跑 npx tsx scripts/extract-prompt-motion.mts`);
    process.exit(1);
  }
  const source = JSON.parse(fs.readFileSync(SOURCE_FILE, "utf8")) as { items: SourceItem[] };
  const bySlug = new Map(source.items.map((i) => [i.slug, i]));
  // 编号按 slug 字典序固定，和种子写了多少条无关
  const order = [...source.items].map((i) => i.slug).sort();
  const idOf = new Map(order.map((s, i) => [s, `PM${String(i + 1).padStart(3, "0")}`]));

  const seeds = await loadSeeds();
  const errors: string[] = [];
  const seenSlug = new Set<string>();
  const seenName = new Set<string>();

  for (const s of seeds) {
    const errs = check(s, bySlug.get(s.slug));
    if (seenSlug.has(s.slug)) errs.push("slug 重复");
    if (seenName.has(s.name)) errs.push("name 在本批里重复");
    seenSlug.add(s.slug);
    seenName.add(s.name);
    for (const e of errs) errors.push(`${s.slug}：${e}`);
  }

  const techSeeds = await loadTechniqueSeeds();
  const seenTechName = new Set<string>();
  for (const t of techSeeds) {
    const errs = checkTechnique(t);
    if (seenTechName.has(t.name)) errs.push("name 在本批里重复");
    seenTechName.add(t.name);
    for (const e of errs) errors.push(`技法 ${t.sourceId || t.name}：${e}`);
  }

  if (errors.length) {
    console.error(`✗ ${errors.length} 处问题：`);
    for (const e of errors) console.error("  " + e);
    process.exit(1);
  }

  const dupGroups = fs.existsSync(DEDUPE)
    ? (JSON.parse(fs.readFileSync(DEDUPE, "utf8")) as {
        count: number;
        primary: string;
        slugs: string[];
      }[])
    : [];
  const dupOf = new Map<string, DupInfo>();
  for (const g of dupGroups) {
    if (g.count < 2) continue;
    const others = g.slugs
      .filter((x) => x !== g.primary)
      .map((x) => {
        const it = bySlug.get(x);
        return { title: it?.title ?? x, creator: it?.creator ?? x };
      });
    dupOf.set(g.primary, { count: g.count, others });
  }

  const manifest: { id: string; slug: string; name: string; genre: PromptGenre; file: string; mdSha: string }[] = [];
  let wrote = 0;

  for (const seed of seeds) {
    const item = bySlug.get(seed.slug)!;
    const id = idOf.get(seed.slug)!;
    const md = render(item, seed, id, dupOf.get(seed.slug));
    const genre = resolve(seed).genre;
    const rel = path.posix.join(GENRES[genre].dir, `${id}_${sanitizeName(seed.name)}.md`);
    const abs = path.join(LIB_ROOT, rel);
    manifest.push({ id, slug: seed.slug, name: seed.name, genre, file: rel, mdSha: sha12(md) });
    if (dry || checkOnly) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, md, "utf8");
    wrote++;
  }

  // 技法紧接配方之后写。编号按种子声明顺序，和配方的 slug 排序是两套互不干扰的号段。
  techSeeds.forEach((t, i) => {
    const id = `TK${String(i + 1).padStart(3, "0")}`;
    const md = renderTechnique(t, id);
    const rel = path.posix.join(GENRES.technique.dir, `${id}_${sanitizeName(t.name)}.md`);
    const abs = path.join(LIB_ROOT, rel);
    manifest.push({
      id,
      slug: `tech:${t.sourceId}`,
      name: t.name,
      genre: "technique",
      file: rel,
      mdSha: sha12(md),
    });
    if (dry || checkOnly) return;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, md, "utf8");
    wrote++;
  });

  if (!dry && !checkOnly) {
    manifest.sort((a, b) => a.id.localeCompare(b.id));
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
    fs.writeFileSync(
      MANIFEST,
      JSON.stringify(
        {
          version: 1,
          builtAt: new Date().toISOString(),
          sourceRoot: LIB_REL,
          sourceTotal: source.items.length,
          count: manifest.length,
          items: manifest,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  const byGenre = new Map<string, number>();
  for (const s of seeds) {
    const label = GENRES[resolve(s).genre].label;
    byGenre.set(label, (byGenre.get(label) ?? 0) + 1);
  }
  if (techSeeds.length) byGenre.set(GENRES.technique.label, techSeeds.length);
  console.log(
    `${checkOnly ? "校验" : dry ? "试运行" : "写入"}：${seeds.length}/${source.items.length} 条配方 + ${
      techSeeds.length
    } 条技法${wrote ? `，落盘 ${wrote} 个 md` : ""}`,
  );
  console.log(
    "分布：" + [...byGenre.entries()].map(([k, v]) => `${k} ${v}`).join("｜"),
  );
  console.log(`库根：${LIB_REL}`);
  const dupTotal = [...dupOf.values()].reduce((n, d) => n + d.others.length, 0);
  console.log(
    `源条目 ${source.items.length} = 本篇 ${seeds.length} + 同稿合并 ${dupTotal} + 明确排除 ${EXCLUDED.length}`,
  );
  for (const e of EXCLUDED) console.log(`  排除 ${e.slug}：${e.why}`);
}

main();
