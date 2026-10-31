import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBackdropFx, useBare, useMotion } from "../ui";
import { clampInt, rnd } from "../fx";

export type SnowProps = {
  theme: Theme;
  /** 雪花数量 40–200 */
  count: number;
  /** 下落速度倍率 0.4–2 */
  speed: number;
  /** 左右飘摆幅度 0–1 */
  drift: number;
};

/**
 * 下雪：柔边雪花慢落，大的在前、小的在后。
 *
 * 颜色用 c.text 而不是固定白色：雪是白的没错，但浅色主题下页面底也是浅的，
 * 白雪直接隐身。c.text 在深色主题接近白、浅色主题接近黑，
 * 「雪的颜色跟着墨色走」在两种画幅下都成立（雨幕 rain 同理）。
 *
 * 前后景深：大约六分之一的雪花更大、更快、更实 —— 是"贴着镜头"的那层；
 * 其余小而慢。两层一起动，画面才有纵深，不然就是一面雪花墙。
 */
export const SnowScene: React.FC<SnowProps> = ({
  theme,
  count = 120,
  speed = 1,
  drift = 0.6,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, isPortrait } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const { speed: timeScale } = useBackdropFx();
  const c = theme.palette;

  const t = (frame / fps) * timeScale;
  const n = clampInt(count, 40, 200);
  const total = Math.round(n * (isPortrait ? 1 : 1.3));
  const v = Math.max(0.4, Math.min(2, Number(speed) || 1));
  const amp = Math.max(0, Math.min(1, drift));

  return (
    <AbsoluteFill style={{ backgroundColor: bare ? "transparent" : c.background, overflow: "hidden" }}>
      {Array.from({ length: total }, (_, i) => {
        const near = rnd(i, 1) > 0.84;
        const size = near ? u(1.1 + rnd(i, 2) * 0.9) : u(0.28 + rnd(i, 3) * 0.55);
        const sp = (near ? 0.85 : 0.5) + rnd(i, 4) * 0.5;
        const phase = rnd(i, 5);
        const y = ((((phase + (m === 0 ? 0 : t * 0.05 * sp * v)) % 1) + 1) % 1) * 118 - 9;
        const baseX = rnd(i, 6) * 106 - 3;
        const x = baseX + Math.sin(t * (0.3 + rnd(i, 7) * 0.3) + phase * 9) * (1.5 + amp * 4);
        // 柔边雪片：radial-gradient 三停（实心小核 → 半透 → 透明），不用 blur
        const alpha = (near ? 0.75 : 0.4 + rnd(i, 8) * 0.25);
        return (
          <div
            key={`sn-${i}`}
            style={{
              position: "absolute",
              left: `${x}%`,
              top: `${y}%`,
              width: size,
              height: size,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${withColorAlpha(c.text, alpha)} 0%, ${withColorAlpha(
                c.text,
                alpha * 0.55,
              )} 55%, transparent 100%)`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
