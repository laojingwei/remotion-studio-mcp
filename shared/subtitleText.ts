/**
 * 字幕文本清洗与拆段（纯函数，渲染烧录与 SRT 导出共用）。
 *
 * 为什么要有这个文件：
 * agent 写字幕时常把一整句（甚至一整段稿）塞进一幕，标点一起上屏，
 * 结果就是「又臭又长」——一屏几十字，观众来不及读。
 *
 * 短视频字幕的行业惯例其实很死：
 *   - 一屏 8–16 字（最多不超过 18），一眼扫完；
 *   - 上屏**不带标点**，标点只用来断句；
 *   - 按语义断，不按字数硬切——逗号处断，长句在「的/了/着」这类虚词后断；
 *   - 句号 / 分号 / 问号是**硬边界**，两句不能合成一屏；逗号是软边界，短句可以并。
 *
 * 所以这里不是「提示 agent 注意」，而是**写入时就拆好、渲染时再兜一次底**：
 * set_subtitle / build_storyboard / tts_narration / 老工程都会过同一套拆段逻辑，
 * 画面与导出的 SRT 永远一致。
 */

/** 字幕长度基准（单次调用可覆盖） */
export const SUBTITLE_LIMITS = {
  /** 单屏最大字数：超过就不合格 */
  max: 18,
  /** 拆段后的目标长度：留点余量，合并别太满 */
  softMax: 14,
  /** 比这个还短就该并到邻句，避免「对」「然后」这种一闪而过的孤儿 */
  minChars: 6,
  /** 硬上限：超过这个长度是一屏读不完的硬伤（check / render 会拦） */
  hard: 26,
} as const;

/** 硬边界标点：句号/分号/问号这一级，两句**不允许合成一屏** */
const STRONG_PUNCT = /[。！？；…!?;]/g;
/** 软边界标点：逗号/顿号这一级，短句可以并 */
const WEAK_PUNCT = /[，、,：:~～—－·|/\\]/g;
/** 上屏要清掉的装饰符号（引号、括号、书名号…） */
const DECOR = /[「」『』“”‘’"'《》〈〉【】\[\]（）()<>]/g;
/** 中文里适合当断点的虚词：在这些字**后面**断，读起来不断气 */
const SOFT_CUT = "的了着过吗呢吧啊呀嘛哦哈";
/** 保护 3.5% / 1,200 / v2.0 里的点与逗号，别当成句号切了 */
const NUM_DOT = "\u0001";
const NUM_COMMA = "\u0002";

export type SplitOptions = {
  maxChars?: number;
  softMax?: number;
  minChars?: number;
};

const ctx = (o: SplitOptions = {}) => {
  const max = Math.max(6, o.maxChars ?? SUBTITLE_LIMITS.max);
  return {
    max,
    // 合并目标永远不超过上限（传了更小的 maxChars 时跟着收紧）
    soft: Math.max(4, Math.min(o.softMax ?? SUBTITLE_LIMITS.softMax, max)),
    min: Math.max(2, o.minChars ?? SUBTITLE_LIMITS.minChars),
  };
};

const charLen = (s: string) => [...s].length;
const isNumSep = (c: string | undefined) => c === NUM_DOT || c === NUM_COMMA;
const restoreNum = (s: string) =>
  s.replace(new RegExp(NUM_DOT, "g"), ".").replace(new RegExp(NUM_COMMA, "g"), ",");

/**
 * 清标点内部版：数字分隔符换成哨兵字符（拆段时不会被当断点），
 * 硬边界换成换行（= 不可合并的分句单元），软边界换成空格。
 * 拆完由调用方 `restoreNum` 还原。
 */
function prepareText(raw: string): string {
  if (!raw) return "";
  let s = String(raw).replace(/\r/g, "");
  s = s.replace(/(\d)\.(\d)/g, `$1${NUM_DOT}$2`).replace(/(\d),(\d)/g, `$1${NUM_COMMA}$2`);
  s = s.replace(DECOR, "");
  s = s.replace(STRONG_PUNCT, "\n");
  s = s.replace(WEAK_PUNCT, " ");
  // 剩下的 . 和 , 一定是标点（数字里的已被哨兵保护），按句界处理
  s = s.replace(/[.,]/g, "\n");
  s = s.replace(/[ \t\u3000]+/g, " ");
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/** 清标点 / 折叠空白：上屏文本不带标点（数字里的 . , 保留；硬边界保留换行） */
export const cleanSubtitleText = (raw: string): string => restoreNum(prepareText(raw));

/**
 * 把一条超长分句按语义切成多段（优先虚词后，其次词边界，最后硬切）。
 * `target` 是想要的长度，`hardMax` 是绝对不能超的上限；尾巴太短就回缩切点，避免孤儿屏。
 */
function hardSplit(text: string, target: number, hardMax: number, minChars: number): string[] {
  const chars = [...text];
  if (chars.length <= hardMax) return [text];
  const out: string[] = [];
  const floor = Math.max(4, Math.floor(target * 0.55));
  let i = 0;
  while (i < chars.length) {
    const left = chars.length - i;
    if (left <= hardMax) {
      out.push(chars.slice(i).join(""));
      break;
    }
    const end = i + target;
    let cut = -1;
    // 1) 虚词后断：读起来最自然
    for (let j = end; j >= i + floor; j--) {
      if (SOFT_CUT.includes(chars[j - 1])) {
        cut = j;
        break;
      }
    }
    // 2) 词边界：不切断英文单词，也不切在数字 / 百分比中间（12.8% 切成 12. / 8% 是最常见的烂字幕）
    if (cut < 0) {
      for (let j = end; j >= i + floor; j--) {
        const prev = chars[j - 1];
        const next = chars[j] ?? "";
        if (isNumSep(prev) || isNumSep(next)) continue;
        if (/^[%％]$/.test(next)) continue;
        if (/[0-9]/.test(prev) && /[0-9]/.test(next)) continue;
        if (!(/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next))) {
          cut = j;
          break;
        }
      }
    }
    // 3) 兜底：硬切（同样避开数字分隔符与百分比）
    if (cut < 0) {
      cut = end;
      while (
        cut > i + 3 &&
        (isNumSep(chars[cut - 1]) || /^[%％]$/.test(chars[cut] ?? "") || /[0-9]/.test(chars[cut] ?? ""))
      ) {
        cut--;
      }
    }
    // 尾巴太短（剩 1–3 字）就回缩切点，让尾巴至少 minChars，别留一闪而过的孤儿屏。
    // 但如果回缩后会断在虚词前面（「…占屏宽 / 的三十分之一」），宁可不回缩：
    // 以虚词开头的屏读起来像断了一半。
    const tail = chars.length - cut;
    if (tail > 0 && tail < minChars) {
      const shrink = minChars - tail;
      const canShrink = cut - shrink >= i + Math.max(4, Math.floor(target * 0.4));
      if (canShrink && !SOFT_CUT.includes(chars[cut - shrink] ?? "")) cut -= shrink;
      else if (!canShrink) {
        out.push(chars.slice(i).join("").trim());
        break;
      }
    }
    out.push(chars.slice(i, cut).join("").trim());
    i = cut;
  }
  return out.filter(Boolean);
}

/** 合并时补空格：拉丁词之间要空格，中文之间不要 */
function joinPiece(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const aEnd = a[a.length - 1];
  const bStart = b[0];
  const needSpace = /[A-Za-z0-9%）]/.test(aEnd) && /[A-Za-z0-9（]/.test(bStart);
  return needSpace ? `${a} ${b}` : `${a}${b}`;
}

/**
 * 英文/数字为主的分句：按词做一次动态规划，让每屏长度尽量接近目标。
 * 简单贪心会切出 "English" / "readable" 这种一屏一个词的碎片字幕。
 */
function packLatinWords(words: string[], soft: number, max: number): string[] {
  const n = words.length;
  if (!n) return [];
  const best = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
  const next = new Array<number>(n + 1).fill(n);
  best[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    let len = 0;
    for (let j = i; j < n; j++) {
      len += words[j].length + (j > i ? 1 : 0);
      if (len > max) break;
      const cost = (soft - len) ** 2 + best[j + 1];
      if (cost < best[i]) {
        best[i] = cost;
        next[i] = j + 1;
      }
    }
  }
  const out: string[] = [];
  for (let i = 0; i < n; i = next[i]) out.push(words.slice(i, next[i]).join(" "));
  return out;
}

/** 短句并到邻句（只在同一个硬边界内做，跨句/跨段绝不合并） */
function packClauses(clauses: string[], opts: { max: number; soft: number; min: number }): string[] {
  const { max, soft, min } = opts;
  if (!clauses.length) return [];
  // 全英文（没有 CJK）走 DP 打包，贪心在英文上会切出单词碎片
  if (clauses.every((c) => !/[\u4e00-\u9fff]/.test(c))) {
    const words = clauses.join(" ").split(/\s+/).filter(Boolean);
    return packLatinWords(words, soft, max);
  }
  const merged: string[] = [];
  for (const c of clauses) {
    if (!merged.length) {
      merged.push(c);
      continue;
    }
    const prev = merged[merged.length - 1];
    const short = charLen(prev) < min || charLen(c) < min;
    const joint = joinPiece(prev, c);
    if (short && charLen(joint) <= (charLen(prev) < min ? max : soft)) {
      merged[merged.length - 1] = joint;
      continue;
    }
    merged.push(c);
  }
  return merged;
}

/**
 * 字幕拆段主函数：原始文本 → 上屏用的短句数组。
 *
 * 处理顺序：清标点（硬边界→分段，软边界→分句）→ 分句过长按语义切 → 段内短句合并。
 * 段与段之间（句号/分号/问号/换行）绝不合并：那是作者划的句界。
 */
export function splitSubtitleText(raw: string, opts: SplitOptions = {}): string[] {
  const { max, soft, min } = ctx(opts);
  const cleaned = prepareText(raw);
  if (!cleaned) return [];

  const out: string[] = [];
  for (const paragraph of cleaned.split("\n")) {
    const clauses: string[] = [];
    for (const token of paragraph.split(/\s+/)) {
      const t = token.trim();
      if (!t) continue;
      clauses.push(...hardSplit(t, soft, max, min));
    }
    out.push(...packClauses(clauses, { max, soft, min }));
  }
  return out.map(restoreNum).map((x) => x.trim()).filter(Boolean);
}

/** 单句是否超标 */
export const isSubtitleTooLong = (line: string, max = SUBTITLE_LIMITS.max) => charLen(line) > max;

/** 是否还有标点残留（老工程直接写进 subtitle 的那种） */
export const hasSubtitlePunct = (line: string) => /[。，、；：！？…,;:!?]/.test(line);

export type NormalizeResult = {
  /** 拆好的上屏短句 */
  lines: string[];
  /** 是否做过实质改动 */
  changed: boolean;
  /** 拆分前后字数（不含空白），便于在工具返回里说明 */
  before: number;
  after: number;
  warnings: string[];
};

/**
 * 规范化 + 拆段，并给出可读告警（工具返回里直接用）。
 * `maxChars` 按画幅/字号传：竖屏大字建议 12–14，横屏 16–18。
 */
export function normalizeSubtitle(raw: string, opts: SplitOptions = {}): NormalizeResult {
  const max = opts.maxChars ?? SUBTITLE_LIMITS.max;
  const source = String(raw ?? "").trim();
  const lines = splitSubtitleText(source, { ...opts, maxChars: max });
  const warnings: string[] = [];
  const over = lines.filter((l) => charLen(l) > max);
  if (over.length) {
    warnings.push(
      `${over.length} 句仍超过 ${max} 字（长英文词或无标点长句）：${over
        .slice(0, 2)
        .map((x) => `「${x}」`)
        .join("")}——建议改稿，字幕不是用来塞长句的`,
    );
  }
  if (hasSubtitlePunct(source)) {
    warnings.push("原文带标点，已按上屏规则清掉（标点只用于断句，不上屏）");
  }
  const after = lines.reduce((n, l) => n + charLen(l), 0);
  return {
    lines,
    changed: lines.join("\n") !== source,
    before: charLen(source.replace(/\s/g, "")),
    after,
    warnings,
  };
}

/** 拆段结果 → 存进 scene.subtitle 的形式（一行一屏） */
export const subtitleToField = (lines: string[]) => lines.join("\n");
