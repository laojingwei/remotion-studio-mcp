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
    : { top: 8, bottom: 8, x: 9 };

  // 大字号在横屏略微放大，避免视觉上"变轻"
  const headScale = isPortrait ? 1 : 1.22;

  return {
    width,
    height,
    unit,
    orientation,
    isPortrait,
    isLandscape: !isPortrait,
    safe,
    headScale,
    /** unit 换算 */
    u: (n: number) => n * unit,
    /** 大字号换算 */
    h: (n: number) => n * unit * headScale,
  };
};
