/**
 * AI 味检测（词面 + 句式）。
 *
 * 规则来源：ai-humanizer-master（韩老师，MIT）的中文模式库 A1–A10 + 翻案腔。
 * 已按**视频口播**改写，做了三件事：
 *
 *   1. 只留「念出来就露馅」的类别。文章的标题层级、段落对称、emoji 标题、总分总骨架，
 *      在 30 秒片子里根本不存在，删掉。
 *   2. 补两条视频专有的：屏幕大字上的破折号/提示性冒号（观感直接掉档）、
 *      口播里 TTS 念不出来的符号（括号、书名号、孤立英文缩写）。
 *   3. 不抄它的 0–100 人话指数。给个分数只会让人刷分——「改到 86 分」和「这句话念着别扭」
 *      是两回事。这里只出**具体哪一句有问题、怎么改**。
 *
 * 判定尺度：词面类只是提醒（可能有用，也可能是在准确引用别人的黑话），
 * 但翻案腔与三项排比给 warn——它们是 AI 写作最容易被一眼认出的两个结构签名。
 */

export type FlavorHit = {
  /** 类别（A1 开头套话 / 翻案腔 / …） */
  cat: string;
  level: "warn" | "info";
  /** 直接可读的一行 */
  msg: string;
};

type WordCat = {
  cat: string;
  level: "warn" | "info";
  words: string[];
  fix: string;
};

/**
 * 词面类别。刻意保留原库的严重度分级：
 * 官腔、黑话、伪深度是「说了等于没说」，成语串与连接词滥用是「听着像通稿」。
 */
const WORD_CATS: WordCat[] = [
  {
    cat: "A1 开头套话",
    level: "warn",
    words: ["在当今", "众所周知", "毋庸置疑", "不可否认", "伴随着", "在这个时代", "一直以来", "时代背景"],
    fix: "前 3 秒只有一句话的机会，删掉铺垫直接说事",
  },
  {
    cat: "A2 连接词滥用",
    level: "info",
    words: ["此外", "与此同时", "不仅如此", "综上所述", "总而言之", "一方面", "另一方面"],
    fix: "口播不用连接词，靠句号断开就够",
  },
  {
    cat: "A3 官腔",
    level: "info",
    words: [
      "高度重视",
      "深入推进",
      "扎实开展",
      "积极探索",
      "有效落实",
      "持续优化",
      "凝聚共识",
      "汇聚合力",
      "协同推进",
      "至关重要",
      "举足轻重",
      "不可或缺",
      "深入探讨",
      "立体化",
    ],
    fix: "换成「做了什么 + 结果是多少」",
  },
  {
    cat: "A4 结尾升华",
    level: "warn",
    words: ["让我们共同", "让我们一起", "未来可期", "任重道远", "谱写新篇章", "砥砺前行", "扬帆远航", "展望未来", "贡献力量", "不断前行", "共同见证"],
    fix: "升华句一律删；结尾要么给结论，要么给「谁、何时、做什么」",
  },
  {
    cat: "A6 商业黑话",
    level: "info",
    words: ["赋能", "抓手", "闭环", "底层逻辑", "顶层设计", "降本增效", "全链路", "组合拳", "打通", "破圈", "引爆", "加持", "重塑", "生态位", "打造", "助力", "一站式", "深度融合"],
    fix: "换成大白话：赋能业务增长 → 让订单多了三成",
  },
  {
    cat: "A7 模糊归因",
    level: "warn",
    words: ["专家指出", "业内人士表示", "相关研究表明", "大量数据表明", "有学者认为", "专家普遍认为", "大家普遍认为", "据研究显示"],
    fix: "要么给出具体出处和时间，要么删掉——短视频里没出处等于没说过",
  },
  {
    cat: "A8 伪深度",
    level: "info",
    words: ["的体现", "的证明", "的象征", "彰显了", "凸显了", "深刻体现", "更深层次"],
    fix: "直接说事实，别解释它的意义",
  },
  {
    cat: "A9 假大空成语",
    level: "info",
    words: ["博大精深", "源远流长", "历久弥新", "与时俱进", "开拓创新", "锐意进取", "举世瞩目"],
    fix: "换成一个能点数的事实",
  },
  {
    cat: "A10 模板口水",
    level: "warn",
    words: ["大家好我是", "大家好，我是", "本文将从", "希望对您有所帮助", "以上就是", "如有疏漏", "感谢观看", "感谢阅读", "话不多说"],
    fix: "删掉——观众知道你在拍视频，不需要报幕",
  },
];

/**
 * 语境词：本身可能是本义（电路闭环、化学沉淀、排版对齐）。
 * 只有同一条文案里出现 ≥2 个才算黑话腔，单独出现不报。
 */
const CONTEXT_WORDS = ["沉淀", "颗粒度", "对齐", "打法", "拉通", "复盘", "闭环", "心智"];

type PatternCat = {
  cat: string;
  level: "warn" | "info";
  re: RegExp;
  /** 报出来的样例说法 */
  name: string;
  fix: string;
};

/**
 * 句式类。翻案腔（先立一个读者本来没有的误解，再推翻它）是 AI 口播的第一签名，
 * 几乎每支 AI 写的片子开头都是「这不是 X，而是 Y」。
 */
const PATTERN_CATS: PatternCat[] = [
  {
    cat: "翻案腔",
    level: "warn",
    re: /(?:并)?不是[^。！？\n]{0,40}?而是|并非[^。！？\n]{0,40}?而是|不在于[^。！？\n]{0,40}?而在于|与其说[^。！？\n]{0,40}?(?:不如|毋宁)/,
    name: "不是…而是…",
    fix: "从正面下判断：先说结论，再补依据。别先编一个没人有过的误解再推翻它",
  },
  {
    cat: "翻案腔",
    level: "warn",
    re: /(?:表面(?:上)?|看似)[^。！？\n]{0,40}?(?:其实|实际|实则)|你以为[^。！？\n]{0,40}?(?:其实|但|可)|回头才(?:发现|明白|知道)|答案恰恰相反|恰恰相反/,
    name: "看似…其实…",
    fix: "直接说事实。观众不需要你先替他误会一次",
  },
  {
    cat: "翻案腔",
    level: "info",
    re: /说到底|说白了|说穿了|先说结论|[^，。！？\n]{1,12}不重要，(?:重要|要紧)的是/,
    name: "说到底 / 先说结论",
    fix: "这类路标词在口播里是空转，删掉不影响理解",
  },
  {
    cat: "三项排比",
    level: "warn",
    re: /不仅[^。！？\n]{0,40}?也[^。！？\n]{0,40}?更|一是[^。！？\n]{0,30}?二是[^。！？\n]{0,30}?三是|既[^。！？\n]{0,20}?又[^。！？\n]{0,20}?还/,
    name: "不仅…也…更…",
    fix: "两项为限，第三项换说法或删。三项同构念出来像念稿",
  },
];

/** 屏幕大字上的标点：不是「AI 味」，但一眼看出是没打磨过的稿子直接搬上屏 */
function lintScreenPunct(t: string): FlavorHit[] {
  const out: FlavorHit[] = [];
  const dash = t.match(/[—–]{1,2}/g);
  if (dash) {
    out.push({
      cat: "屏幕标点",
      level: "warn",
      msg: `屏幕大字里有破折号（${dash.length} 处）：大字用换行或色块断开，别用破折号`,
    });
  }
  // 提示性冒号：排除时间（10:30）与比例（1:1）
  if (/[：:]/.test(t) && !/\d[：:]\d/.test(t)) {
    out.push({
      cat: "屏幕标点",
      level: "info",
      msg: "屏幕大字里有冒号：「核心是：」「三个方法：」这类提示性冒号删掉，直接把内容写成大字",
    });
  }
  if (/[!！]{2,}|[?？]{2,}/.test(t)) {
    out.push({ cat: "屏幕标点", level: "info", msg: "连续感叹号/问号：一个就够，两个像营销号" });
  }
  return out;
}

/** 口播里 TTS 念不出来或念错的东西 */
function lintSpeakable(t: string): FlavorHit[] {
  const out: FlavorHit[] = [];
  if (/[（(][^）)]{1,30}[）)]/.test(t)) {
    out.push({
      cat: "念不出来",
      level: "warn",
      msg: "口播里有括号：配音会把括号里的话一起念出来，或者干脆跳过——改成正文，或删",
    });
  }
  if (/《[^》]{1,30}》/.test(t)) {
    out.push({ cat: "念不出来", level: "info", msg: "口播里有书名号：TTS 不念书名号，书名直接写出来" });
  }
  if (/[—–]{1,2}/.test(t)) {
    out.push({ cat: "念不出来", level: "info", msg: "口播里有破折号：念的时候没有对应停顿，改成逗号或句号" });
  }
  const abbr = t.match(/\b[A-Z]{2,5}\b/g);
  if (abbr) {
    out.push({
      cat: "念不出来",
      level: "info",
      msg: `英文缩写 ${[...new Set(abbr)].slice(0, 3).join("/")}：TTS 会逐字母念，写成读音（API → A P I 或「接口」）`,
    });
  }
  return out;
}

/** 单条文案体检：返回按类别去重后的命中 */
export function detectFlavor(text: string, kind: "screen" | "voice" = "voice"): FlavorHit[] {
  const t = String(text ?? "");
  if (!t.trim()) return [];
  const out: FlavorHit[] = [];
  const nl = "、";

  for (const c of WORD_CATS) {
    const hits = c.words.filter((w) => t.includes(w));
    if (!hits.length) continue;
    out.push({
      cat: c.cat,
      level: c.level,
      msg: `${c.cat}：${hits.slice(0, 3).join(nl)}${hits.length > 3 ? ` 等 ${hits.length} 个` : ""}——${c.fix}`,
    });
  }

  // 语境词：同一条里 ≥2 个才报
  const ctx = CONTEXT_WORDS.filter((w) => t.includes(w));
  if (ctx.length >= 2) {
    out.push({
      cat: "商业黑话",
      level: "info",
      msg: `黑话腔：${ctx.join(nl)}——同一条里挤了两个以上，八成是在说空话，换成具体动作`,
    });
  }

  for (const p of PATTERN_CATS) {
    const m = t.match(p.re);
    if (!m) continue;
    out.push({
      cat: p.cat,
      level: p.level,
      msg: `${p.cat}（${p.name}）：「${m[0].slice(0, 18)}${m[0].length > 18 ? "…" : ""}」——${p.fix}`,
    });
  }

  out.push(...(kind === "screen" ? lintScreenPunct(t) : lintSpeakable(t)));
  return out;
}

/**
 * 整篇体检：单条看不出来、只有连着读才暴露的问题。
 * 对应原库的 B5（缺乏具体细节）与 B1（句式单一）——但只做能自动判的两条。
 */
export function detectScriptFlavor(texts: string[]): FlavorHit[] {
  const all = texts.join("");
  if (!all.trim()) return [];
  const out: FlavorHit[] = [];

  if (!/\d/.test(all)) {
    out.push({
      cat: "缺乏细节",
      level: "warn",
      msg: "整篇没有一个数字：每个论点配一个能点数的事实（金额/时长/百分比/数量），拿不到就写「两台设备」「来回三趟」",
    });
  }

  const sentences = all
    .split(/[。！？!?\n]/)
    .map((s) => s.trim())
    .filter((s) => [...s].length >= 4);
  if (sentences.length >= 5) {
    const lens = sentences.map((s) => [...s].length);
    const spread = Math.max(...lens) - Math.min(...lens);
    if (spread < 6) {
      out.push({
        cat: "节奏单一",
        level: "info",
        msg: `全篇 ${sentences.length} 句，最长最短只差 ${spread} 字——句子一样长念出来像念稿。插一两句 4–6 字的短句（「就这么简单」）打散`,
      });
    }
  }
  return out;
}
