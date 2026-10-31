import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame } from "../ui";
import { clampInt } from "../fx";

export type WaveProps = {
  theme: Theme;
  title: string;
  /** 波浪幅度（字号的百分比 0–60） */
  amplitude: number;
  /** 一秒内起伏几个波峰（0.2–2） */
  waves: number;
};

/**
 * 波浪字：一行大字逐字起伏，正弦波沿字符位置推进。
 *
 * 和 kinetic（逐字弹入，动一次就停）的分工：wave 是**持续**的律动，
 * 适合口号悬停段、音乐节奏段 —— 字一直在呼吸，不是入场动画。
 */
export const WaveScene: React.FC<WaveProps> = ({ theme, title, amplitude = 30, waves = 0.8 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, h, isPortrait } = useSceneLayout();
  const c = theme.palette;

  const chars = Array.from(title || " ");
  const amp = Math.max(0, Math.min(60, Number(amplitude) || 30)) / 100;
  const freq = Math.max(0.2, Math.min(2, Number(waves) || 0.8));
  const fontSize = isPortrait ? h(7.2) : h(6);

  const t = frame / fps;
  const cols = Math.max(1, clampInt(chars.length, 1, 24));

  return (
    <SceneFrame theme={theme} align="center">
      <Editable
        id="title"
        title="标题"
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          maxWidth: "100%",
          // 波谷要往下探，给上下留出被裁的余量
          paddingTop: u(3),
          paddingBottom: u(3),
        }}
      >
        {chars.map((ch, i) => {
          // 正弦沿字符位置推进：相邻字符错开相位，才是"波浪"而不是"齐跳"
          const phase = (i / cols) * freq * Math.PI * 2;
          const lift = Math.sin(t * freq * Math.PI * 2 + phase);
          return (
            <span
              key={`w-${i}`}
              style={{
                display: "inline-block",
                fontFamily: theme.font.heading,
                fontSize,
                fontWeight: 900,
                lineHeight: 1.15,
                whiteSpace: "pre",
                // 幅度按字号算，波峰波谷都不出安全区
                transform: `translateY(${(-lift * amp * fontSize).toFixed(2)}px) rotate(${(
                  lift * 3
                ).toFixed(2)}deg)`,
                color: i % 3 === 1 ? c.primary : c.text,
                textShadow: `0 ${u(1)} ${u(2.4)} ${withColorAlpha(c.primary, 0.25 + lift * 0.15)}`,
              }}
            >
              {ch}
            </span>
          );
        })}
      </Editable>
    </SceneFrame>
  );
};
