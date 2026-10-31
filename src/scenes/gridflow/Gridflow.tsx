import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBackdropFx, useBare, useMotion } from "../ui";
import { clampInt } from "../fx";

export type GridflowProps = {
  theme: Theme;
  /** 地平线高度（画面高度的百分比）12–55 */
  horizon: number;
  /** 每侧竖线数量 6–22 */
  cells: number;
  /** 亮度 0–1 */
  glow: number;
  /** 流动速度倍率 0.3–3 */
  flow: number;
};

/** 横向格线同时在跑几条（少了会看到空隙，多了挤成一团） */
const RUNGS = 16;

/**
 * 赛博网格：地面是一张往观众脚下流的透视网格，地平线上一圈发光。
 *
 * 为什么不用 CSS 3D（`perspective + rotateX`）：
 * 逐帧渲染下，3D 变换的合成结果和层的 `transform-origin` 极易在两种画幅里
 * 跑出不同的透视强度，横屏看着正常、竖屏就塌了；而且它一旦被塞进
 * 氛围层的 Sequence 里，父级的 transform 会改写 perspective 的参考点。
 * 这里全部用**三角函数算出的坐标**画线，画幅怎么变都是同一个透视公式。
 */
export const GridflowScene: React.FC<GridflowProps> = ({
  theme,
  horizon = 42,
  cells = 12,
  glow = 0.6,
  flow = 1,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height, u } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const { speed: timeScale } = useBackdropFx();
  const c = theme.palette;

  const t = (frame / fps) * timeScale;
  const hz = Math.max(0.12, Math.min(0.55, (Number(horizon) || 42) / 100));
  const horizonY = height * hz;
  const n = clampInt(cells, 6, 22);
  const g = Math.max(0, Math.min(1, glow));
  const cx = width / 2;
  // 竖线的底端铺到画面宽度的 1.6 倍：视线越靠下越张开，不留边
  const spread = width * 0.8;
  const lineColor = withColorAlpha(c.primary, 0.16 + g * 0.5);
  const rungColor = withColorAlpha(c.primary, 0.12 + g * 0.42);

  // 流动相位：0 → 1 表示"一条格线从地平线走到脚下"
  const phase = m === 0 ? 0 : (((t * 0.3 * Math.max(0.3, flow)) % 1) + 1) % 1;
  const sunD = Math.min(width, height) * 0.5;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: bare ? "transparent" : c.background,
        overflow: "hidden",
      }}
    >
      {/*
       * 地平线光晕：**跨过地平线**画（不是只画在天上）。
       * 早先是"天空渐变到地平线最亮"，于是地面那边没有对应的一层，
       * 接缝处出现一条硬边 —— 叠在标题下面时正好横穿文字，像加了个黑条。
       */}
      <div
        style={{
          position: "absolute",
          left: "-15%",
          right: "-15%",
          top: horizonY - height * 0.22,
          height: height * 0.44,
          background: `radial-gradient(ellipse at center, ${withColorAlpha(c.primary, 0.1 + g * 0.22)} 0%, ${withColorAlpha(
            c.primary,
            0.03 + g * 0.05,
          )} 42%, transparent 72%)`,
        }}
      />

      {/* 落日：只露地平线以上那半个 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: horizonY,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: cx - sunD / 2,
            top: horizonY - sunD,
            width: sunD,
            height: sunD,
            borderRadius: "50%",
            /* 中心靠下（50% 62%）= 快落山的太阳：亮部贴着地平线，往上迅速变淡。
               掺主题的次要色会变成一圈灰蓝，看着像肥皂泡，所以只用主色铺。 */
            background: `radial-gradient(circle at 50% 62%, ${withColorAlpha(c.primary, 0.62 + g * 0.28)} 0%, ${withColorAlpha(
              c.primary,
              0.34 + g * 0.18,
            )} 24%, ${withColorAlpha(c.primary, 0.1)} 52%, transparent 72%)`,
          }}
        />
      </div>

      {/* 地平线：一条亮线把天与地切开 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: horizonY - Math.max(1, u(0.12)),
          height: Math.max(1.5, u(0.2)),
          background: `linear-gradient(90deg, transparent, ${withColorAlpha(c.primary, 0.35 + g * 0.5)}, transparent)`,
        }}
      />

      {/* 竖线：从灭点 (cx, horizonY) 发出的一条条细三角 */}
      {Array.from({ length: n * 2 + 1 }, (_, i) => {
        const xb = cx + ((i - n) / n) * spread;
        const w = Math.max(0.6, u(0.09));
        return (
          <div
            key={`v-${i}`}
            style={{
              position: "absolute",
              inset: 0,
              clipPath: `polygon(${cx}px ${horizonY}px, ${xb - w}px ${height}px, ${xb + w}px ${height}px)`,
              background: lineColor,
              opacity: 0.5,
            }}
          />
        );
      })}

      {/* 横线：按二次曲线聚在地平线附近，越近越疏、越亮 */}
      {Array.from({ length: RUNGS }, (_, j) => {
        const k = ((j / RUNGS + phase) % 1 + 1) % 1;
        const y = horizonY + (height - horizonY) * Math.pow(k, 2.4);
        const half = spread * Math.pow(k, 1.5);
        const thick = Math.max(1, u(0.14) * (0.4 + k * 1.3));
        return (
          <div
            key={`r-${j}`}
            style={{
              position: "absolute",
              left: cx - half,
              top: y,
              width: half * 2,
              height: thick,
              background: rungColor,
              opacity: 0.15 + k * 0.8,
            }}
          />
        );
      })}

      {/* 地面压暗：脚下最暗，视线自然被拉到地平线 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: `${(1 - hz) * 100}%`,
          background: `linear-gradient(180deg, transparent 0%, ${withColorAlpha(c.background, 0.6)} 74%)`,
        }}
      />
    </AbsoluteFill>
  );
};
