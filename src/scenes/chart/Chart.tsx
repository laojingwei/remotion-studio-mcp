import React from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { barRatio } from "../../../shared/numeric";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter, scaleNumericText } from "../ui";

type Datum = { label: string; value: number; color?: string };

const Bar: React.FC<{
  datum: Datum;
  max: number;
  delay: number;
  unit: string;
  theme: Theme;
  highlight: boolean;
  scale: "linear" | "log";
}> = ({ datum, max, delay, unit, theme, highlight, scale }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, h, b, isPortrait } = useSceneLayout();

  const p = spring({
    frame: frame - delay,
    fps,
    config: { damping: 20, mass: 0.9, stiffness: 80 },
    durationInFrames: Math.round(fps * 1.1),
  });
  const grow = Math.max(0, Math.min(1, p));
  // 柱高比例统一走 shared/numeric.ts 的 barRatio（linear / log 两种口径）
  const pct = barRatio(datum.value, max, scale) * grow;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        height: "100%",
        minWidth: 0,
      }}
    >
      {/* 柱子上方留出的空间，柱子从底部生长 */}
      <div
        style={{
          flex: 1,
          width: "100%",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          minHeight: 0,
        }}
      >
        <div
          style={{
            position: "relative",
            width: isPortrait ? "72%" : "58%",
            height: `${pct * 100}%`,
          }}
        >
          {/* 数值贴着柱顶，而不是飘在格子顶部 */}
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: "50%",
              transform: "translateX(-50%)",
              marginBottom: u(1),
              fontFamily: theme.font.heading,
              fontSize: h(1.8),
              fontWeight: 600,
              color:
                datum.color ?? (highlight ? theme.palette.primary : theme.palette.textMuted),
              opacity: grow,
              whiteSpace: "nowrap",
            }}
          >
            {scaleNumericText(String(datum.value), grow)}
            {unit}
          </div>

          <div
            style={{
              height: "100%",
              width: "100%",
              borderRadius: `${u(0.8)}px ${u(0.8)}px ${u(0.2)}px ${u(0.2)}px`,
              background: datum.color
                ? `linear-gradient(180deg, ${datum.color}, ${datum.color}CC)`
                : highlight
                  ? `linear-gradient(180deg, ${theme.palette.primary}, ${theme.palette.primary}CC)`
                  : theme.palette.surface,
              border: datum.color
                ? "none"
                : highlight
                  ? "none"
                  : `1px solid ${theme.palette.textMuted}33`,
            }}
          />
        </div>
      </div>

      <div
        style={{
          marginTop: u(1.4),
          fontFamily: theme.font.body,
          fontSize: b(1.7),
          color: theme.palette.textMuted,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: "100%",
        }}
      >
        {datum.label}
      </div>
    </div>
  );
};

export type ChartProps = {
  theme: Theme;
  heading: string;
  unit: string;
  scale: "linear" | "log";
  data: Datum[];
};

export const ChartScene: React.FC<ChartProps> = ({ theme, heading, unit, scale = "linear", data }) => {
  const { u, h, b, isPortrait } = useSceneLayout();
  const head = useEnter(0);
  const axis = useEnter(2);
  const max = Math.max(...data.map((d) => d.value), 1);
  const peakIdx = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);

  return (
    <SceneFrame theme={theme} justify="center">
      {/* 横屏也铺满内容区：收窄到 80% 会把图表压成中间一小块，上下再留大片空 */}
      <div style={{ width: "100%", position: "relative" }}>
        <Editable
          id="heading"
          title="图表标题"
          style={{
            fontFamily: theme.font.heading,
            fontSize: b(isPortrait ? 3.4 : 2.8),
            fontWeight: 600,
            letterSpacing: "-0.01em",
            color: theme.palette.text,
            marginBottom: u(5),
            opacity: head.opacity,
            transform: `translateY(${head.y * u(1)}px)`,
          }}
        >
          {heading}
        </Editable>

        {/* 对数轴必须标出来：柱子长短不再和数值成正比，不标就是误导读者 */}
        {scale === "log" ? (
          <div
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              fontFamily: theme.font.body,
              fontSize: b(1.6),
              letterSpacing: u(0.08),
              color: theme.palette.textMuted,
              opacity: 0.9,
            }}
          >
            对数轴
          </div>
        ) : null}

        <Editable
          id="chart"
          title="图表"
          style={{
            width: "100%",
            // 图表高度：竖屏 34 单位已经是画面的三分之一强；横屏原来只有 30，
            // 在 16:9 里只占 3 成高，看着像缩略图。给到 46 才撑得住整页
            height: u(isPortrait ? 34 : 46),
            display: "flex",
            gap: u(isPortrait ? 2 : 3),
            borderBottom: `1px solid ${theme.palette.textMuted}44`,
            paddingBottom: u(0.6),
            boxSizing: "border-box",
            opacity: axis.opacity,
          }}
        >
          {data.map((d, i) => (
            <Bar
              key={i}
              datum={d}
              max={max}
              delay={8 + i * 6}
              unit={unit}
              theme={theme}
              highlight={i === peakIdx}
              scale={scale}
            />
          ))}
        </Editable>
      </div>
    </SceneFrame>
  );
};
