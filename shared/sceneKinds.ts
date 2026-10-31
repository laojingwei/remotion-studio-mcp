/**
 * 场景的「性质」分类 —— 与版式定义分开的一张表。
 *
 * 为什么单独一个文件：设计锁（designLock）要读它，场景元信息（sceneMetas）也要读它，
 * 而 sceneMetas 依赖 zod 与 freeform，designLock 不该为了一个 Set 去拖那一串。
 */

/**
 * 动效场景：画面主体是**运动本身**（光晕、颗粒、漏光、逐字弹跳、遮罩上翻），
 * 不是版面。它们不参与「一屏文字元素数 / 标题字号」这类版式审计 ——
 * 一个逐字动画天然有几十个 span，按版面口径算就是每条必违规。
 *
 * 注意：它们仍然参与**转场审计**（转场时长与白名单跟版式无关）。
 */
export const MOTION_SCENE_TYPES = new Set([
  "glow",
  "grain",
  "lightleak",
  "kinetic",
  "maskreveal",
  // 第二批：文字强调
  "typewriter",
  "counter",
  "gradienttext",
  "scramble",
  // 第二批：背景氛围（本来就一堆粒子/光斑，按版面口径算必违规）
  "bokeh",
  "sparks",
  "vhs",
]);

export const isMotionScene = (type?: string): boolean =>
  !!type && MOTION_SCENE_TYPES.has(type);

/**
 * 可以当「氛围层」叠在版式底下的动效类型（Scene.backdrop.type 只能填这些）。
 *
 * 只有纯氛围的 6 个在名单里。另外 4 个（打字机 / 数字滚动 / 渐变字 / 乱码）
 * 本身带正文，垫在别的版式下面会同时出现两套字 —— 那不是"氛围"，是事故。
 *
 * 为什么单独一张表而不是复用 MOTION_SCENE_TYPES：
 * MOTION 是"不参与版面审计"的性质，BACKDROP 是"能不能当背景"的能力，
 * 两者刚好在这 6 个上重合，但语义不同，将来会分叉（比如加一个纯几何图形版式，
 * 它可能是氛围但仍是版式，要做审计）。
 */
export const BACKDROP_TYPES = ["glow", "grain", "lightleak", "bokeh", "sparks", "vhs"] as const;

export type BackdropType = (typeof BACKDROP_TYPES)[number];

export const isBackdropType = (type?: string): boolean =>
  !!type && (BACKDROP_TYPES as readonly string[]).includes(type);
