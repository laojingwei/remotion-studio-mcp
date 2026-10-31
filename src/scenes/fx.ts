/**
 * 动效版式共用的小工具。
 *
 * 为什么单独一份：新增的动效版式里到处要「确定性伪随机」和「缓动」，
 * 复制到每个组件里，将来改一个手感要改八个地方。
 */

/**
 * 确定性伪随机：同一 (i, salt) 永远同一个值。
 *
 * Remotion 是逐帧独立渲染的，`Math.random()` 会让每一帧的粒子位置全变
 * —— 表现出来不是"随机感"，是整屏雪花噪声。
 */
export const rnd = (i: number, salt: number) => {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export const clamp01 = (p: number) => Math.max(0, Math.min(1, p));

/** 三次缓出：起步快、收尾稳，文字类动效最常用的一档 */
export const easeOut = (p: number) => 1 - Math.pow(1 - clamp01(p), 3);

/** 两端缓入缓出：色带擦除、遮罩推拉用它才不会"一顿一冲" */
export const easeInOut = (p: number) => {
  const t = clamp01(p);
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
};

/** 整数夹取，用于 count / cells 这类数量参数（agent 可能传小数） */
export const clampInt = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : lo)));
