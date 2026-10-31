import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBackdropFx, useBare, useMotion } from "../ui";
import { clampInt, rnd } from "../fx";

export type ConfettiProps = {
  theme: Theme;
  /** 纸屑数量 30–160 */
  count: number;
  /** 下落速度倍率 0.4–2 */
  speed: number;
  /** 左右飘摆幅度 0–1 */
  sway: number;
};

/**
 * 五彩纸屑：小纸片翻着跟头往下落。
 *
 * 和「上升火花 sparks」正好是一对：sparks 向上（能量、开场），
 * confetti 向下（庆祝、开奖、成交播报）。颜色固定用主题四色轮转
 * （primary / secondary / accent / text），纸屑要"杂"才像撒出来的，
 * 单色就成了落叶。
 *
 * 翻滚的立体感靠 `scaleY` 随相位摆动模拟：一张纸在空中翻，
 * 投影宽度周期性变窄又变宽，rotate 只负责转圈，scaleY 负责"翻面"。
 */
export const ConfettiScene: React.FC<ConfettiProps> = ({
  theme,
  count = 90,
  speed = 1,
  sway = 0.6,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, u, isPortrait } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const { speed: timeScale } = useBackdropFx();
  const c = theme.palette;

  const t = (frame / fps) * timeScale;
  const n = clampInt(count, 30, 160);
  const total = Math.round(n * (isPortrait ? 1 : 1.35));
  const v = Math.max(0.4, Math.min(2, Number(speed) || 1));
  const colors = [c.primary, c.secondary, c.accent, c.text];

  return (
    <AbsoluteFill style={{ backgroundColor: bare ? "transparent" : c.background, overflow: "hidden" }}>
      {Array.from({ length: total }, (_, i) => {
        const sp = 0.7 + rnd(i, 1) * 0.7;
        const phase = rnd(i, 2);
        // 一轮的行程 118%，从 -9% 起，接缝才不露出一排"同时出发"的纸片
        const y = ((((phase + (m === 0 ? 0 : t * 0.14 * sp * v)) % 1) + 1) % 1) * 118 - 9;
        const baseX = rnd(i, 3) * 108 - 4;
        const swayAmp = (2 + rnd(i, 4) * 4) * Math.max(0, Math.min(1, sway));
        const x = baseX + Math.sin(t * (0.6 + rnd(i, 5) * 0.5) + phase * 9) * swayAmp;
        const w = u(0.8 + rnd(i, 6) * 0.9);
        const h = w * (0.55 + rnd(i, 7) * 0.35);
        const rot = t * (90 + rnd(i, 8) * 160) * (rnd(i, 9) > 0.5 ? 1 : -1) + phase * 360;
        // 翻面：投影高度周期性压扁，宽高比在变，看起来就是一张纸在转
        const flip = 0.25 + Math.abs(Math.sin(t * (1.4 + rnd(i, 10)) + phase * 7)) * 0.75;
        const color = colors[i % colors.length];
        return (
          <div
            key={`cf-${i}`}
            style={{
              position: "absolute",
              left: `${x}%`,
              top: `${y}%`,
              width: w,
              height: h * flip,
              background: withColorAlpha(color, 0.85 + rnd(i, 11) * 0.15),
              borderRadius: Math.max(1, u(0.12)),
              transform: `rotate(${rot}deg)`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
