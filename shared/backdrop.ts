/**
 * 氛围层的「出现区间」窗口计算。
 *
 * 单独放一个文件是为了能在 Node 里直接单测：渲染组件（Backdrop.tsx）依赖
 * remotion 的 AbsoluteFill / Sequence，在测试进程里 import 进来会被 React/浏览器
 * 环境拖下水。这里的纯函数是两边共用的唯一口径 —— 渲染端和校验端算错了，
 * 表现是"设了 4 秒只放了 2 秒"这种极难归因的偏差。
 */

export type BackdropWindow = {
  /** 幕内起始帧（0 起） */
  from: number;
  /** 持续帧数 */
  duration: number;
  fadeIn: number;
  fadeOut: number;
  /** 柔化是"算出来的"还是"用户写的"——面板要显示「跟随入场转场」而不是一个数字 */
  autoIn: boolean;
  autoOut: boolean;
};

export type BackdropWindowOpts = {
  /** 幕的入场转场帧数（0 = 这一幕本身是硬切入场） */
  sceneInFrames?: number;
  /** 幕的出场转场帧数（0 = 硬切出场） */
  sceneOutFrames?: number;
  /** 幕没有任何转场时自己的兜底柔化，默认 8 帧*/
  autoFade?: number;
};

/**
 * 截断到幕长。
 *
 * 越界不当场报错的地方就用它兜底：手改 json、把幕改短之后，旧数据可能
 * from+duration 超过幕长，直接算会得到负的剩余帧 → 整幕什么都没渲染。
 *
 * ## 柔化为什么不能一律给 0
 *
 * 区间落在幕中间时，0 柔化就是一帧硬切（实测：0 → 723 个亮点，下一帧 → 0）。
 * 但区间**贴着幕首/幕尾**时又不能加柔化 —— 幕自己的入场/出场转场已经带着这一层
 * 一起淡了，再叠一次会变成双重淡入（前 12 帧明显偏暗）。
 *
 * 所以规则是「谁边上谁负责」：
 *   贴幕首 → 幕有入场转场就交给幕（0），没有才自己柔化
 *   贴幕尾 → 幕有出场转场就交给幕（0），没有才自己柔化
 *   在中间 → 取 max(幕转场时长, 兜底)，和这个工程的节奏保持一致
 *
 * 铺满整幕（不设区间）时一律 0，与加这个功能之前逐像素一致。
 */
export function backdropWindow(
  bd: { from?: number; duration?: number; fadeIn?: number; fadeOut?: number },
  sceneDuration: number,
  opts: BackdropWindowOpts = {},
): BackdropWindow {
  const span = Math.max(1, Math.round(sceneDuration));
  const from = Math.max(0, Math.min(span - 1, Math.round(bd.from ?? 0)));
  const rest = Math.max(1, span - from);
  const duration = Math.max(1, Math.min(rest, Math.round(bd.duration ?? rest)));

  const atStart = from === 0;
  const atEnd = from + duration >= span;
  /** 铺满整幕 = 没有"出入场"可言，柔化保持 0 */
  const full = atStart && atEnd;

  const inF = Math.max(0, Math.round(opts.sceneInFrames ?? 0));
  const outF = Math.max(0, Math.round(opts.sceneOutFrames ?? 0));
  const soft = Math.max(1, Math.round(opts.autoFade ?? 8));

  let fadeIn = Math.max(0, Math.round(bd.fadeIn ?? 0));
  let fadeOut = Math.max(0, Math.round(bd.fadeOut ?? 0));
  const autoIn = !full && bd.fadeIn === undefined;
  const autoOut = !full && bd.fadeOut === undefined;

  if (autoIn) fadeIn = atStart ? (inF > 0 ? 0 : soft) : Math.max(inF, soft);
  if (autoOut) fadeOut = atEnd ? (outF > 0 ? 0 : soft) : Math.max(outF, soft);

  // 淡入吃掉太多时，淡出只能拿剩下的 —— 两个加起来不能超过总长，否则永远是半透明
  fadeIn = Math.min(fadeIn, duration);
  fadeOut = Math.min(fadeOut, duration - fadeIn);

  return { from, duration, fadeIn, fadeOut, autoIn, autoOut };
}

/** 是不是「铺满整幕、不柔化」—— 渲染端据此省掉一层 Sequence（存量画面逐像素不变） */
export const isFullWindow = (w: BackdropWindow, sceneDuration: number) =>
  w.from === 0 &&
  w.duration === Math.max(1, Math.round(sceneDuration)) &&
  w.fadeIn === 0 &&
  w.fadeOut === 0;
