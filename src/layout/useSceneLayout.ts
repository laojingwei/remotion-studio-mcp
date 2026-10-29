import { useVideoConfig } from "remotion";

export type Orientation = "portrait" | "landscape";

/**
 * 多规格同源的唯一布局入口。
 *
 * 规则（见设计方案 §4.1）：
 *  1. 禁止写 px，全部走 unit
 *  2. unit = min(width, height) / 100 —— 锁短边，文字物理尺寸在两种画幅下一致
 *  3. 结构差异走 orientation 分支，不靠缩放硬扛
 */
export const useSceneLayout = () => {
  const { width, height } = useVideoConfig();
  const unit = Math.min(width, height) / 100;
  const orientation: Orientation = width >= height ? "landscape" : "portrait";
  const isPortrait = orientation === "portrait";

  // 安全区（unit 倍数）：竖屏避开顶部状态栏与底部平台 UI
  const safe = isPortrait
    ? { top: 13, bottom: 19, x: 8 }
    : { top: 9, bottom: 9, x: 7 };

  /**
   * 字号系数。
   *
   * 为什么横屏要放大：unit 锁的是短边，所以两种画幅下文字的「像素高度」一样。
   * 但横屏是摊在显示器/TV 上看，画面面积是竖屏的 3 倍多，同样的字在 16:9 里
   * 显得又轻又小，内容挤在左边一小块、右边整片空 —— 这是「填充率低」的真正原因，
   * 不是版式写错了，是字号没跟着画幅走。
   *
   * 显示字（标题/数字/金句）放大得多，正文只略微放大：正文放太大会失去从容感，
   * 也会把版面撑破。
   */
  const headScale = isPortrait ? 1 : 1.42;
  const bodyScale = isPortrait ? 1 : 1.1;

  return {
    width,
    height,
    unit,
    orientation,
    isPortrait,
    isLandscape: !isPortrait,
    safe,
    headScale,
    bodyScale,
    /** unit 换算 */
    u: (n: number) => n * unit,
    /** 显示字换算（标题、大数字、金句） */
    h: (n: number) => n * unit * headScale,
    /** 正文换算（说明、注释、轴标签、署名） */
    b: (n: number) => n * unit * bodyScale,
  };
};
