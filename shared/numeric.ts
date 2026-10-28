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
