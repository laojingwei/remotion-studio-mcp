import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBackdropFx, useBare, useMotion } from "../ui";

export type SparksProps = {
  theme: Theme;
  /** 粒子数量 20–160 */
  count: number;
  /** 上升速度倍率 0.4–2.5 */
  speed: number;
  /** 亮度 0–1 */
  glow: number;
  /** 只在下半屏飘（像地面的火星） */
  ground: boolean;
};

const rnd = (i: number, salt: number) => {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

const fade = (color: string, a: number) => {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
};

/**
 * 上升火花：小亮点从下往上飘，越往上越淡。
 *
 * 每个粒子的进度是 `(t / life + phase) % 1`，所以它们是**错峰循环**的：
 * 任何一帧都有粒子在底部刚生成、有粒子在中段、有粒子在顶部消失。
 * 如果所有粒子用同一个周期从 0 开始，会变成"整体一起上浮"，一眼假。
 *
 * 粒子的横摆用 sin(t·k + phase)，不同 k 让它们不会同步摆动。
 */
export const SparksScene: React.FC<SparksProps> = ({
  theme,
  count = 60,
  speed = 1,
  glow = 0.55,
  ground = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, isPortrait } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const { speed: timeScale } = useBackdropFx();
  const c = theme.palette;

  const n = Math.max(0, Math.min(160, Math.round(count)));
  const total = isPortrait ? n : Math.round(n * 1.35);
  const life = 4.2 / Math.max(0.4, speed);
  // timeScale 是"整层倍速"（氛围层给的），speed 是"粒子寿命"（版式自己的参数）
  const t = (frame / fps) * timeScale;

  return (
    <AbsoluteFill style={{ backgroundColor: bare ? "transparent" : c.background, overflow: "hidden" }}>
      {Array.from({ length: total }, (_, i) => {
        const phase = rnd(i, 1);
        const cycle = (t / life + phase) % 1;
        // ground=true：只在下半屏活动，像地面扬起的火星
        const span = ground ? 62 : 118;
        const top = (ground ? 46 : 4) + (1 - cycle) * span;
        const baseX = rnd(i, 2) * 100;
        const sway = Math.sin(t * (0.8 + rnd(i, 3) * 1.6) + phase * 12) * (1.2 + rnd(i, 4) * 2.2);
        const size = u(0.28 + rnd(i, 5) * 0.7) * (1 + glow * 0.6);
        // 生在底部、灭在顶部：两侧淡、中间亮
        const fadeIn = Math.min(1, cycle / 0.12);
        const fadeOut = Math.min(1, (1 - cycle) / 0.35);
        const opacity = (m === 0 ? 0.8 : fadeIn * fadeOut) * (0.4 + rnd(i, 6) * 0.55) * (0.45 + glow);
        const tint = rnd(i, 7) > 0.78 ? c.secondary : c.primary;
        // 偶尔几颗是"亮点"，其余是细屑 —— 全一样大就没有层次
        const bright = rnd(i, 8) > 0.86;

        return (
          <div
            key={`s-${i}`}
            style={{
              position: "absolute",
              left: `${baseX + sway * 0.6}%`,
              top: `${top}%`,
              width: size,
              height: size,
              borderRadius: "50%",
              background: fade(bright ? c.text : tint, bright ? 0.9 : 0.75),
              opacity,
              boxShadow: bright ? `0 0 ${u(1.6)}px ${fade(tint, 0.7)}` : undefined,
            }}
          />
        );
      })}

      {/* 底部一层暖光：没有它，粒子像浮在空里，不像"从某处升起" */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: "34%",
          background: `linear-gradient(180deg, transparent, ${fade(c.primary, 0.07 * (0.5 + glow))})`,
        }}
      />
    </AbsoluteFill>
  );
};
