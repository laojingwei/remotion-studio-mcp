/**
 * 文案体检（机械层）。
 *
 * 查四类机器查得出、且确实拉低观感的问题：
 *   1. 空洞词（显著/全面/极致…）——形容词零信息量，观众听不出差别
 *   2. 数字没有参照系——孤立数字不构成信息
 *   3. 句子太长——屏幕上读不完、口播一口气念不完
 *   4. AI 味（见 `aiFlavor.ts`）——翻案腔、三项排比、官腔黑话、结尾升华、念不出来的符号
 *
 * 查不出「没意思」「没观点」，那只能靠 `get_guide("content")` 的三问自己判断。
 * 所以这里全部是提醒级，不阻断任何流程。
 */

import { detectFlavor, detectScriptFlavor } from "./aiFlavor";

/** 纯形容词：补不出数字就该删。商业黑话在 aiFlavor 的 A6 里，这里不重复列 */
const HOLLOW = [
  "显著",
  "全面",
  "大力",
  "进一步",
  "持续",
  "深度",
  "高效",
  "优质",
  "领先",
  "颠覆",
  "极致",
  "精准",
  "丰富",
  "完善",
];

/** 对比词：有它，数字才算有参照系 */
const REFERENCE = /(倍|行业|均值|平均|去年|同期|上月|目标|相比|对比|以上|以下|从|vs)/i;

export type CopyIssue = { level: "warn" | "info"; msg: string };

const charLen = (s: string) => [...s].length;

/** 屏幕大字：一屏最多一句、≤18 字、最多一个停顿 */
function lintScreen(text: string): CopyIssue[] {
  const out: CopyIssue[] = [];
  const t = text.trim();
  if (!t) return out;
  if (charLen(t) > 18) {
    out.push({
      level: "warn",
      msg: `屏幕文字 ${charLen(t)} 字：「${t.slice(0, 20)}${charLen(t) > 20 ? "…" : ""}」——一屏超过 18 字就读不完了，拆成两屏或砍成关键词`,
    });
  }
  const pauses = (t.match(/[，,、]/g) ?? []).length;
  if (pauses >= 2) {
    out.push({ level: "info", msg: `屏幕文字有 ${pauses + 1} 个停顿：屏幕上最多留一个停顿，其余断成两屏` });
  }
  return out;
}

/** 口播：一句一口气念得完（>32 字基本要换气） */
function lintVoice(text: string): CopyIssue[] {
  const out: CopyIssue[] = [];
  for (const sentence of text.split(/[。！？!?\n]/).map((x) => x.trim()).filter(Boolean)) {
    if (charLen(sentence) > 32) {
      out.push({
        level: "warn",
        msg: `口播一句 ${charLen(sentence)} 字：「${sentence.slice(0, 24)}…」——一口气念不完，拆成两句（配音会在这里断气）`,
      });
    }
  }
  return out;
}

/** 数字缺参照：说「增长 37%」但没说跟谁比 */
function lintNumbers(text: string): CopyIssue[] {
  const out: CopyIssue[] = [];
  for (const sentence of text.split(/[。！？!?\n]/).map((x) => x.trim()).filter(Boolean)) {
    if (!/\d/.test(sentence)) continue;
    if (!/(增长|提升|提高|下降|降低|节省|省下|涨|跌|翻了)/.test(sentence)) continue;
    if (REFERENCE.test(sentence)) continue;
    out.push({
      level: "info",
      msg: `数字缺参照系：「${sentence.slice(0, 22)}${charLen(sentence) > 22 ? "…" : ""}」——补一个对照（行业均值 / 去年 / 目标 / 换成钱）`,
    });
  }
  return out;
}

/** 空洞词：每个词只报一次，避免满屏重复 */
function lintHollow(text: string): CopyIssue[] {
  const hits = HOLLOW.filter((w) => text.includes(w));
  if (!hits.length) return [];
  return [
    {
      level: "info",
      msg: `空洞词：${hits.slice(0, 5).join("、")}${hits.length > 5 ? ` 等 ${hits.length} 个` : ""}——每个后面补一个数字或事实，补不出来就删`,
    },
  ];
}

/**
 * 体检一段文案。
 * `kind`：screen = 屏幕上显示的字；voice = 口播/旁白。
 */
export function lintCopy(text: string, kind: "screen" | "voice" = "voice"): CopyIssue[] {
  if (!text || !text.trim()) return [];
  const issues = [...lintHollow(text), ...lintNumbers(text)];
  issues.push(...(kind === "screen" ? lintScreen(text) : lintVoice(text)));
  for (const hit of detectFlavor(text, kind)) issues.push({ level: hit.level, msg: hit.msg });
  return issues;
}

/** 批量体检，同类问题只留前 N 条（返回可直接拼进工具输出的行） */
export function lintCopyLines(
  items: { text: string; kind?: "screen" | "voice"; label?: string }[],
  maxPerKind = 3,
): string[] {
  const seen = new Map<string, number>();
  const lines: string[] = [];
  for (const item of items) {
    for (const issue of lintCopy(item.text, item.kind ?? "voice")) {
      const key = issue.msg.slice(0, 24);
      const n = seen.get(key) ?? 0;
      if (n >= maxPerKind) continue;
      seen.set(key, n + 1);
      lines.push(`${item.label ? `${item.label}：` : ""}${issue.msg}`);
    }
  }
  return lines;
}

/**
 * 整篇体检：逐条 + 跨条。
 * 单条读着都没问题、连着读才发现「没有一个数字」「句子一样长」，只有整篇看才暴露。
 */
export function lintScriptLines(
  items: { text: string; kind?: "screen" | "voice"; label?: string }[],
  maxPerKind = 3,
): string[] {
  const lines = lintCopyLines(items, maxPerKind);
  for (const hit of detectScriptFlavor(items.map((i) => i.text))) lines.push(hit.msg);
  return lines;
}
