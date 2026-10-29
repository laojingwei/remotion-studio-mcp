/**
 * 一行字能放多大 —— 横屏版式的共用算法。
 *
 * 为什么需要：unit 锁的是短边，横屏里同样的字号「看着小」，于是各版式都想放大。
 * 但只放大不管宽度，中文就会折行，而中文折行会断在词中间（「完播 / 率」），
 * 比小一号更难看。所以正确顺序是：先算「一行能放多大」，再在它和「想放多大」之间取小。
 *
 * 第二个坑是字数：`agent` 五个字母加起来才一个半汉字宽，按 5 个汉字去缩字号，
 * 混排标题会白白小一号、右边空一块（实测「三小时学会用 agent 做动画」只铺到 64%，
 * 按等效字数加权后 84%）。
 */

/** 单个字符占几个汉字的宽度。拉丁字母、数字、半角标点按 0.55 */
export function charWidth(ch: string): number {
  if (ch === " ") return 0.3;
  const c = ch.codePointAt(0) ?? 0;
  // 0x2E80 以下基本是拉丁/数字/半角符号；中日韩、全角标点都在其上，按整字算
  return c < 0x2e80 ? 0.55 : 1;
}

/** 等效字数：把「字符串长度」换成「占几个汉字宽」 */
export function weightedLength(text: string): number {
  let n = 0;
  for (const ch of text) n += charWidth(ch);
  return n;
}

/**
 * 一行塞进 avail（像素）能到的最大字号，返回值可直接喂给 `h()`。
 *
 * @param avail  可用宽度（像素），通常是 `width - 2 * u(safe.x)`
 * @param unit   短边单位（`useSceneLayout().unit`）
 * @param headScale 显示字系数（`useSceneLayout().headScale`）
 * @param factor 字面留白：行盒里字形本身比 em 窄一点点，0.96 给一点余量
 */
export function fitHeadSize(
  text: string,
  avail: number,
  unit: number,
  headScale: number,
  factor = 0.96,
): number {
  const w = weightedLength(text);
  if (w <= 0 || unit <= 0 || headScale <= 0) return Number.POSITIVE_INFINITY;
  return (avail * factor) / (w * unit * headScale);
}

/** 先算一行放得下的字号，再夹到 [min, max] —— 各版式最常用的两句合成一句 */
export function clampHeadSize(
  text: string,
  avail: number,
  unit: number,
  headScale: number,
  min: number,
  max: number,
): number {
  const fit = fitHeadSize(text, avail, unit, headScale);
  return Math.max(min, Math.min(max, fit));
}
