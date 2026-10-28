/**
 * 场景级「画面框」：把一整幕缩成小窗压在别的画面上（画中画）。
 *
 * 坐标系与自由元素完全一致：x / y 是**画面百分比、中心点定位**，`scale: 1` 即全屏。
 * 这样编辑器可以复用画布上那套拖拽/缩放手势，不用为画中画另造一套坐标。
 *
 * 渲染方式是对**整个场景容器**做一次 CSS transform，故意不去改 `useVideoConfig()`：
 * 场景内部排版仍按整幅画面计算，最后整体缩小 —— 字号与间距的比例不变，
 * 这才是画中画该有的样子（而不是把字号也一起改小，导致小窗里挤成一团）。
 *
 * 这里不 import react / remotion：返回的就是普通样式对象，纯函数好测，
 * 也不会把 shared 绑到渲染环境上。
 */
import { z } from "zod";

export const sceneBoxSchema = z.object({
  x: z.number().describe("中心 x（画面百分比 0-100，默认 50）"),
  y: z.number().describe("中心 y（画面百分比 0-100，默认 50）"),
  scale: z.number().describe("缩放，1 = 全屏（0.05-1）"),
  rotate: z.number().optional().describe("旋转角度（度）"),
  radius: z.number().optional().describe("圆角（画面短边百分比）"),
  opacity: z.number().optional().describe("不透明度 0-1，默认 1"),
  shadow: z.boolean().optional().describe("投影，默认开"),
});
export type SceneBox = z.infer<typeof sceneBoxSchema>;

const clampNum = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** 落库前归一：所有值都夹到合法区间，避免手写 / agent 传入越界值把画面推到画外 */
export const normalizeSceneBox = (raw: Partial<SceneBox>): SceneBox => ({
  x: Number(clampNum(raw.x, 0, 100, 50).toFixed(2)),
  y: Number(clampNum(raw.y, 0, 100, 50).toFixed(2)),
  scale: Number(clampNum(raw.scale, 0.05, 1, 1).toFixed(4)),
  rotate: Number(clampNum(raw.rotate, -180, 180, 0).toFixed(2)),
  radius: Number(clampNum(raw.radius, 0, 50, 0).toFixed(2)),
  opacity: Number(clampNum(raw.opacity, 0, 1, 1).toFixed(3)),
  shadow: raw.shadow ?? true,
});

/**
 * 是否等价于「全屏直出」。
 * 全屏时**什么样式都不加**，渲染结果与多轨改造之前逐像素一致 —— 这是旧工程零迁移的保证。
 */
export const isFullFrameBox = (box?: SceneBox | null): boolean => {
  if (!box) return true;
  const b = box;
  return (
    Math.abs(b.x - 50) < 0.01 &&
    Math.abs(b.y - 50) < 0.01 &&
    Math.abs(b.scale - 1) < 0.001 &&
    Math.abs(b.rotate ?? 0) < 0.01 &&
    Math.abs(b.radius ?? 0) < 0.01 &&
    Math.abs((b.opacity ?? 1) - 1) < 0.001
  );
};

/** 一句话描述画面框（给 summary / 面板用），全屏返回空串 */
export const describeSceneBox = (box?: SceneBox | null): string => {
  if (isFullFrameBox(box)) return "";
  const b = box!;
  const parts = [`${Math.round(b.x)}% / ${Math.round(b.y)}%`, `缩放 ${Math.round(b.scale * 100)}%`];
  if (b.rotate) parts.push(`旋转 ${Math.round(b.rotate)}°`);
  if (b.radius) parts.push(`圆角 ${b.radius}%`);
  if ((b.opacity ?? 1) < 1) parts.push(`不透明度 ${Math.round((b.opacity ?? 1) * 100)}%`);
  return parts.join("，");
};

/**
 * 画面框 → CSS。宽高传合成尺寸（`useVideoConfig()`），用来把百分比换算成 px。
 *
 * 圆角要**除以 scale**：容器先缩放再显示，若直接写 radius px，小窗上的圆角会被一起缩小
 * （设 3% 只剩 1%，看起来永远不够圆）。这里预先放大，让屏幕上看到的圆角就是设定值。
 */
export const sceneBoxCss = (
  box: SceneBox | undefined,
  width: number,
  height: number,
): Record<string, string | number> | null => {
  if (isFullFrameBox(box)) return null;
  const b = box!;
  const unit = Math.min(width, height);
  const scale = Math.max(0.05, b.scale);
  const radius = ((b.radius ?? 0) * unit) / 100 / scale;
  const shadow = b.shadow === false ? undefined : `${(unit * 0.008) / scale}px ${(unit * 0.03) / scale}px ${(unit * 0.06) / scale}px rgba(0,0,0,0.45)`;
  return {
    // translate 的百分比按元素自身边框盒算 = 整幅画面，所以位移量与 scale 无关
    transform: `translate(${(b.x - 50).toFixed(3)}%, ${(b.y - 50).toFixed(3)}%) rotate(${(b.rotate ?? 0).toFixed(2)}deg) scale(${scale})`,
    transformOrigin: "50% 50%",
    borderRadius: radius,
    overflow: "hidden",
    opacity: b.opacity ?? 1,
    ...(shadow ? { boxShadow: shadow } : {}),
  };
};
