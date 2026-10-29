/**
 * 数字滚动用的纯函数（渲染端与测试共用，不 import 任何 React / DOM）。
 */

/**
 * 把「3.2x / 86% / 1.2万 / -12%」这类带单位的数值按比例缩小。
 *
 * 只改**第一个**数字，前缀后缀（%, x, 万, 元…）原样保留，小数位数也保留 ——
 * 否则滚动过程中会出现 3.1789999x 这种脏数字。
 *
 * factor >= 1 时原样返回（滚动结束帧必须是原值，不能因为浮点误差变成 86.00000001）。
 */
export function scaleNumericText(text: string, factor: number): string {
  if (!(factor < 1)) return text;
  const m = text.match(/-?\d+(?:\.\d+)?/);
  if (!m) return text;
  const raw = m[0];
  const decimals = (raw.split(".")[1] ?? "").length;
  const n = Number(raw);
  if (!Number.isFinite(n)) return text;
  // 纯 4 位整数基本是年份（2024 / 1998），滚起来像乱码，干脆不动
  if (decimals === 0 && /^[12]\d{3}$/.test(raw) && text.replace(raw, "") === "") return text;
  const scaled = n * factor;
  const out = decimals > 0 ? scaled.toFixed(decimals) : String(Math.round(scaled));
  return text.replace(raw, out);
}

/** 缓出三次方：数字滚动用，开头快、结尾稳（线性看起来像"跳表"） */
export const easeOutCubic = (p: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, p)), 3);

/**
 * 从一段可能带单位/符号的文字里取出数值：`"72%"` → 72、`"-12.5 万"` → -12.5。
 *
 * 为什么需要：场景里的百分比是个**字符串**字段（`RingProps.percent`），
 * 用户/agent 很自然会把 `%` 一起写进去。直接 `Number("72%")` 得到 NaN，
 * 于是圆环填充成 0、数字却照样显示 72% —— 图和字对不上，而且没人会怀疑是这里错了。
 * 取不到数字时返回 fallback（默认 0），调用方不必再兜一层。
 */
export function parseNumeric(text: unknown, fallback = 0): number {
  if (typeof text === "number") return Number.isFinite(text) ? text : fallback;
  if (typeof text !== "string") return fallback;
  const m = text.match(/-?\d+(?:\.\d+)?/);
  if (!m) return fallback;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 柱状图的柱高比例（0-1）。
 *
 * linear：直接 value/max。数据跨数量级时（3 和 6800 同屏），3 的柱子矮到看不见，
 * 观众会以为数据丢了 —— 这时应该用 log。
 * log：log10(1+v) / log10(1+max)，加 1 是让 0 值归 0、小值也有可见的高度；
 * 取对数后「看起来矮」不再等于「数值小」，所以组件要在图上标明对数轴。
 *
 * 负值一律按 0 处理（对数没有负数，线性图里负值也不该画出柱子）。
 */
export function barRatio(
  value: number,
  max: number,
  scale: "linear" | "log" = "linear",
): number {
  const v = Math.max(0, Number.isFinite(value) ? value : 0);
  const m = Math.max(0, Number.isFinite(max) ? max : 0);
  if (m <= 0) return 0;
  if (scale === "log") {
    const denom = Math.log10(1 + m);
    if (denom <= 0) return 0;
    return Math.log10(1 + v) / denom;
  }
  return v / m;
}
