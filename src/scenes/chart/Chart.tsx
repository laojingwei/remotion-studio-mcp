import React from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
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
}> = ({ datum, max, delay, unit, theme, highlight }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, h, isPortrait } = useSceneLayout();

  const p = spring({
    frame: frame - delay,
    fps,
    config: { damping: 20, mass: 0.9, stiffness: 80 },
    durationInFrames: Math.round(fps * 1.1),
  });
  const grow = Math.max(0, Math.min(1, p));
  const pct = (datum.value / max) * grow;

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
          fontSize: h(1.7),
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
  data: Datum[];
};

export const ChartScene: React.FC<ChartProps> = ({ theme, heading, unit, data }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const head = useEnter(0);
  const axis = useEnter(2);
  const max = Math.max(...data.map((d) => d.value), 1);
  const peakIdx = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);

  return (
    <SceneFrame theme={theme} justify="center">
      {/* 横屏收窄并居中，避免柱子被拉散、右侧留一块不对称空白 */}
      <div style={{ width: isPortrait ? "100%" : "80%", margin: isPortrait ? 0 : "0 auto" }}>
        <Editable
          id="heading"
          title="图表标题"
          style={{
            fontFamily: theme.font.heading,
            fontSize: h(isPortrait ? 3.4 : 2.8),
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

        <Editable
          id="chart"
          title="图表"
          style={{
            width: "100%",
            height: u(isPortrait ? 34 : 30),
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
            />
          ))}
        </Editable>
      </div>
    </SceneFrame>
  );
};
