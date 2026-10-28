import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { useSceneLayout } from "../layout/useSceneLayout";
import { withColorAlpha } from "../../shared/color";
import type { Theme } from "../../shared/schema";

/* ────────────────────────── 动效强度 ────────────────────────── */

/**
 * 整体动效强度：0 = 关 / 1 = 标准 / 2 = 更强。不设就是 1。
 *
 * 管的是**统一动效层**：入场位移与淡入、数字滚动、氛围光斑。
 * 不管各版式自带的细节动画（柱图生长、环形填充这类"版式本身就是动画"的东西）——
 * 那属于版式表现，关掉反而让图表看起来像坏了。
 *
 *  - 0：统一层全部关掉（入场一帧到位、不渲染光斑、数字直接是终值）
 *  - 1：入场与升级前**完全相同**（spring 参数、位移幅度、时长都没动），
 *       但多出两样：数字滚动、一层极淡的氛围光斑
 *  - 2：入场位移 ×1.7 + 轻微回弹，数字滚动更快，光斑更亮
 */
export const MotionContext = React.createContext<number>(1);
export const useMotion = () => React.useContext(MotionContext);

/** m=0 时的入场：一帧到位，不能有半透明闪烁 */
const STATIC_ENTER = { progress: 1, opacity: 1, y: 0, scale: 1 };

/* ────────────────────────── 入场动画 ────────────────────────── */

export const useEnter = (delay = 0) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const m = useMotion();
  if (m <= 0) return STATIC_ENTER;

  // 2 档：轻微回弹 + 更大位移，让"入场"真正看得出来
  const punch = m > 1;
  const p = spring({
    frame: frame - delay,
    fps,
    config: punch
      ? { damping: 13, mass: 0.6, stiffness: 110 }
      : { damping: 200, mass: 0.55, stiffness: 90 },
    durationInFrames: Math.round(fps * (punch ? 0.62 : 0.7)),
  });
  const clamped = Math.max(0, Math.min(1, p));
  return {
    progress: clamped,
    opacity: clamped,
    y: (1 - clamped) * 2.4 * (punch ? 1.7 : 1),
    /** 新增字段：位移到位前的轻微缩放。标准档恒为 1，老调用方忽略它即可 */
    scale: punch ? 1 - (1 - clamped) * 0.022 : 1,
  };
};

/**
 * 数字滚动：从 0 数到 target。
 *
 * 只有"数字类"版式该用（统计大数、百分比、评分、价格）。
 * 返回的是**当前该显示的数值**，格式化（千分位 / 单位 / 小数位）仍由调用方决定。
 */
export const useCountUp = (target: number, delay = 0) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const m = useMotion();
  if (m <= 0 || !Number.isFinite(target)) return target;
  const dur = Math.round(fps * (m > 1 ? 0.7 : 0.9));
  const p = interpolate(frame - delay, [0, dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // easeOutCubic：开头跑得快、结尾稳下来，比线性更像真的在"计数"
  return target * (1 - Math.pow(1 - p, 3));
};

/**
 * 数字滚动的数值格式化放在 shared/numeric.ts（纯函数，单测能直接跑）。
 * 这里 re-export，版式按 `from "../ui"` 统一引，不用记两个路径。
 */
export { scaleNumericText } from "../../shared/numeric";

export const useFadeOut = (holdFrames: number, tail = 10) => {
  const frame = useCurrentFrame();
  return interpolate(frame, [holdFrames - tail, holdFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
};

/* ────────────────────────── 基础版式 ────────────────────────── */

type FrameProps = {
  children: React.ReactNode;
  theme: Theme;
  align?: "left" | "center";
  justify?: "center" | "start" | "end";
};

/** 所有场景的统一外框：负责安全区、留白与背景 */
export const SceneFrame: React.FC<FrameProps> = ({
  children,
  theme,
  align = "left",
  justify = "center",
}) => {
  const { safe, u, isPortrait } = useSceneLayout();
  const m = useMotion();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  /**
   * 氛围光斑：一层极淡的径向渐变，随秒数缓慢漂移。
   *
   * 为什么单独做成一层、而不是给内容加 transform：
   * 编辑层的选框靠 `getBoundingClientRect` 测量，一旦整体被 scale，拖动换算会引入误差；
   * 这一层是 absolute + pointer-events:none，只画，不参与布局与测量。
   * motion=0 时**根本不渲染**（不是 opacity:0）—— 关动效就应该是真的关干净。
   */
  const t = frame / fps;
  const drift = m > 0
    ? {
        x: Math.sin(t * 0.42) * 2.4,
        y: Math.cos(t * 0.31) * 1.8,
        alpha: 0.045 + m * 0.018,
      }
    : null;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        paddingTop: u(safe.top),
        paddingBottom: u(safe.bottom),
        paddingLeft: u(safe.x),
        paddingRight: u(safe.x),
        display: "flex",
        flexDirection: "column",
        justifyContent: justify === "center" ? "center" : justify === "start" ? "flex-start" : "flex-end",
        alignItems: align === "center" ? "center" : "flex-start",
        textAlign: align,
        fontFamily: theme.font.body,
        boxSizing: "border-box",
      }}
    >
      {drift ? (
        <div
          style={{
            position: "absolute",
            inset: "-14%",
            pointerEvents: "none",
            transform: `translate(${drift.x}%, ${drift.y}%)`,
            background: `radial-gradient(circle at 32% 26%, ${withColorAlpha(
              theme.palette.primary,
              drift.alpha,
            )} 0%, transparent 58%)`,
          }}
        />
      ) : null}
      {children}
      <div
        style={{
          position: "absolute",
          left: u(safe.x),
          right: u(safe.x),
          bottom: u(safe.bottom / 2),
          height: 1,
          background: `linear-gradient(90deg, ${theme.palette.textMuted}, transparent)`,
          opacity: 0.15,
        }}
      />
      {isPortrait ? null : null}
    </AbsoluteFill>
  );
};

/* ────────────────────────── 文字 ────────────────────────── */

export const Eyebrow: React.FC<{ text: string; theme: Theme; accent?: boolean }> = ({
  text,
  theme,
  accent = true,
}) => {
  const { u, h } = useSceneLayout();
  if (!text) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: u(1.2),
        marginBottom: u(2),
        fontFamily: theme.font.heading,
        fontSize: h(1.5),
        letterSpacing: u(0.22),
        textTransform: "uppercase",
        color: theme.palette.textMuted,
      }}
    >
      {accent ? (
        <span
          style={{
            display: "inline-block",
            width: u(2.4),
            height: Math.max(2, u(0.22)),
            background: theme.palette.primary,
            borderRadius: 99,
          }}
        />
      ) : null}
      {text}
    </div>
  );
};

/** 支持把 highlight 词染色 */
export const Highlighted: React.FC<{
  text: string;
  highlight?: string;
  color: string;
}> = ({ text, highlight, color }) => {
  if (!highlight) return <>{text}</>;
  const idx = text.indexOf(highlight);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span style={{ color }}>{highlight}</span>
      {text.slice(idx + highlight.length)}
    </>
  );
};

/* ────────────────────────── 可编辑元素 ────────────────────────── */

/**
 * 编辑器里元素节点的登记表。
 *
 * key 是 `sceneId::elementId` —— 转场期间 Remotion 会同时挂两个场景，
 * 只用 elementId 会互相覆盖。
 * 渲染端（renderStill / headless）也会写进来，但没人读，无副作用。
 */
export const editRegistry = new Map<string, HTMLElement>();

/**
 * 场景级「画面框」节点的登记表（画中画用），key 是 `sc:<sceneId>`。
 *
 * 和 `editRegistry` 分开：那个装的是**元素**（谁在场景里、走 transforms），
 * 这里装的是**整幕那块画面**（走 scene.box）。混在一张表里，
 * 编辑层会把场景容器当成一个可拖元素，位置和含义全乱。
 */
export const sceneBoxRegistry = new Map<string, HTMLElement>();

export const SceneEditContext = React.createContext<{
  sceneId: string;
  transforms?: Record<string, import("../../shared/schema").Transform>;
} | null>(null);

/**
 * 包裹一个可拖动的元素。
 *
 * 关键设计：**叠加**偏移，不接管定位。
 * 元素自己的 style（含入场动画的 transform）原样保留，
 * 我们把位移/旋转/缩放拼在它后面 —— 所以模板排版和自动动画都不会被破坏。
 */
export const Editable: React.FC<{
  id: string;
  as?: keyof React.JSX.IntrinsicElements;
  style?: React.CSSProperties;
  children?: React.ReactNode;
  title?: string;
}> = ({ id, as = "div", style, children, title }) => {
  const { width, height } = useVideoConfig();
  const ctx = React.useContext(SceneEditContext);
  const ref = React.useRef<HTMLElement | null>(null);
  const t = ctx?.transforms?.[id];

  React.useEffect(() => {
    if (typeof window === "undefined" || !ctx) return;
    const node = ref.current;
    if (!node) return;
    const key = `${ctx.sceneId}::${id}`;
    editRegistry.set(key, node);
    return () => {
      // 只有当前登记的还是自己才删，避免转场重叠时误删另一个实例
      if (editRegistry.get(key) === node) editRegistry.delete(key);
    };
  }, [ctx?.sceneId, id, ctx]);

  const offset =
    t && (t.x || t.y || t.rotate || t.scale !== 1)
      ? `translate(${((t.x ?? 0) / 100) * width}px, ${((t.y ?? 0) / 100) * height}px) rotate(${t.rotate ?? 0}deg) scale(${t.scale ?? 1})`
      : "";

  const merged: React.CSSProperties = { ...(style ?? {}) };
  if (offset) {
    merged.transform = [style?.transform, offset].filter(Boolean).join(" ");
    merged.transformOrigin = style?.transformOrigin ?? "center";
  }
  // 图层顺序：只有被调整过才动，且保留模板原本的定位方式。
  // 注意必须钳在非负：负 z-index 会让元素画到场景背景之下，看起来像"整块消失"
  if (t?.z && t.z > 0) {
    merged.zIndex = Math.min(999, Math.round(t.z));
    merged.position = style?.position ?? "relative";
  }

  const Comp = as as React.ElementType;
  return (
    <Comp ref={ref} style={merged} data-edit-id={id} title={title}>
      {children}
    </Comp>
  );
};
