import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useMotion } from "../ui";
import { clamp01 } from "../fx";


/** 画布上下要给标题和说明留的位置（unit 倍数） */
const safePad = () => 30;

export type GaugeProps = {
  theme: Theme;
  /** 顶部标题 */
  heading: string;
  /** 数值 0–100 */
  value: number;
  /** 数值后的单位 */
  unit: string;
  /** 仪表下方的说明 */
  label: string;
};

/**
 * 仪表盘：270° 圆弧从 0 扫到目标值，中间大数字跟着滚。
 *
 * 为什么用 SVG 而不是 div 拼圆弧：CSS 的圆弧要么靠 conic-gradient（边界是
 * 锯齿状的硬切，两种画幅下粗细不一致），要么靠多层遮罩（嵌三层 div 才能做出
 * 环形进度，编辑层的元素测量也跟着乱）。SVG 一条 stroke-dasharray 就够了，
 * 而且粗细、圆头、渐变都是矢量属性，缩放不走样。
 *
 * 圆弧扫到哪儿，尖端那颗亮点就跟到哪儿 —— 仪表盘有了"指针"，扫的过程才
 * 读得出进度，而不是一团颜色慢慢变多。
 */
const R = 78;
/** 270° 扫过的弧长（圆周 × 0.75） */
const ARC = 2 * Math.PI * R * 0.75;

export const GaugeScene: React.FC<GaugeProps> = ({
  theme,
  heading = "",
  value = 0,
  unit = "%",
  label = "",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height, u, h, b, isPortrait } = useSceneLayout();
  const m = useMotion();
  const c = theme.palette;

  const target = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  // 弧先扫 0.9s，数字同时从 0 滚
  const p = m === 0 ? 1 : interpolate(frame, [8, 8 + Math.round(fps * 0.9)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const prog = 1 - Math.pow(1 - clamp01(p), 3);
  const shown = target * prog;

  // 画布尺寸：竖屏宽的一半多一点，横屏吃画面高
  const svg = Math.min(width * (isPortrait ? 0.66 : 0.4), (height - u(safePad())) * 0.62);
  const tipAngle = ((135 + 270 * prog) * Math.PI) / 180;
  const tipX = 100 + R * Math.cos(tipAngle);
  const tipY = 100 + R * Math.sin(tipAngle);

  return (
    <SceneFrame theme={theme} justify="center" align="center">
      {heading ? (
        <Editable id="heading" title="标题" style={{ marginBottom: u(2.4) }}>
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(isPortrait ? 4 : 3.6),
              fontWeight: 800,
              color: c.text,
            }}
          >
            {heading}
          </div>
        </Editable>
      ) : null}

      <svg
        width={svg}
        height={svg * 0.72}
        viewBox="0 0 200 144"
        style={{ overflow: "visible", display: "block" }}
      >
        <defs>
          <linearGradient id="gauge-arc" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={c.primary} />
            <stop offset="100%" stopColor={c.secondary} />
          </linearGradient>
        </defs>
        {/* 底轨：完整 270°，很淡，让人知道「满格」在哪儿 */}
        <circle
          cx={100}
          cy={100}
          r={R}
          fill="none"
          stroke={withColorAlpha(c.text, 0.12)}
          strokeWidth={13}
          strokeLinecap="round"
          strokeDasharray={`${ARC} ${2 * Math.PI * R}`}
          transform="rotate(135 100 100)"
        />
        {/* 进度弧：从 0 扫到目标 */}
        <circle
          cx={100}
          cy={100}
          r={R}
          fill="none"
          stroke="url(#gauge-arc)"
          strokeWidth={13}
          strokeLinecap="round"
          strokeDasharray={`${ARC * prog} ${2 * Math.PI * R}`}
          transform="rotate(135 100 100)"
        />
        {/* 尖端亮点 = 指针 */}
        <circle cx={tipX} cy={tipY} r={7} fill={c.secondary} opacity={prog > 0.02 ? 1 : 0} />
        <circle cx={tipX} cy={tipY} r={13} fill={withColorAlpha(c.secondary, 0.28 * prog)} />

        <text
          x={100}
          y={92}
          textAnchor="middle"
          dominantBaseline="central"
          fill={c.text}
          style={{ fontFamily: theme.font.heading, fontWeight: 800, fontSize: 44 }}
        >
          {Math.round(shown)}
          <tspan style={{ fontSize: 22, fontWeight: 500 }} fill={c.textMuted}>
            {unit}
          </tspan>
        </text>
      </svg>

      {label ? (
        <Editable id="label" title="说明" style={{ marginTop: u(4.6), maxWidth: isPortrait ? u(78) : "70%" }}>
          <div
            style={{
              fontFamily: theme.font.body,
              fontSize: b(2.4),
              color: c.textMuted,
              textAlign: "center",
              lineHeight: 1.55,
            }}
          >
            {label}
          </div>
        </Editable>
      ) : null}
    </SceneFrame>
  );
};

