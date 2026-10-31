import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBackdropFx, useBare, useMotion } from "../ui";
import { clampInt, rnd } from "../fx";

export type SmokeProps = {
  theme: Theme;
  /** 团数 3–8 */
  blobs: number;
  /** 上升速度倍率 0.3–2 */
  rise: number;
  /** 浓度 0–1 */
  intensity: number;
  /** 烟色：灰（跟着墨色走）/ 主色（环境光染色） */
  tone: "灰" | "主色";
};

/**
 * 烟雾：几大团柔雾从底部缓缓升起，边升边膨胀、边散。
 *
 * 和「流体色块 liquid」的区别（不分开就是同一个东西的两个名字）：
 * liquid 是**彩色、原地变形**（高级质感）；smoke 是**单色、向上走**
 * （压情绪、悬疑、转场缓冲）。烟的"活"来自上升 + 膨胀 + 出画，
 * 不靠形状变来变去。
 *
 * 烟色默认跟 c.text：深色主题是灰白烟、浅色主题是深灰烟，
 * 白烟在浅底上会隐身（下雪 snow 同一个坑）。
 */
export const SmokeScene: React.FC<SmokeProps> = ({
  theme,
  blobs = 5,
  rise = 0.8,
  intensity = 0.5,
  tone = "灰",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height, u } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const { speed: timeScale } = useBackdropFx();
  const c = theme.palette;

  const t = (frame / fps) * timeScale;
  const n = clampInt(blobs, 3, 8);
  const v = Math.max(0.3, Math.min(2, Number(rise) || 0.8));
  const k = Math.max(0, Math.min(1, intensity));
  const base = Math.min(width, height);
  const tint = tone === "主色" ? c.primary : c.text;

  return (
    <AbsoluteFill style={{ backgroundColor: bare ? "transparent" : c.background, overflow: "hidden" }}>
      {Array.from({ length: n }, (_, i) => {
        // 0→1 是一朵烟的一生：从底部升到顶部，越升越大越散
        const phase = rnd(i, 1);
        const sp = 0.7 + rnd(i, 2) * 0.6;
        const age = m === 0 ? phase * 0.5 + 0.25 : (((phase + t * 0.03 * sp * v) % 1) + 1) % 1;
        const d = base * (0.75 + rnd(i, 3) * 0.6) * (0.7 + age * 0.9);
        const x = (0.12 + rnd(i, 4) * 0.76) * width + Math.sin(age * Math.PI * 1.5 + phase * 8) * width * 0.05;
        const y = height * (1.12 - age * 1.5);
        // 生命两端淡出：刚冒头、快出画时都几乎看不见
        const envelope = Math.sin(Math.min(1, Math.max(0, age)) * Math.PI);
        const alpha = envelope * (0.16 + k * 0.22);
        const rot = t * (4 + rnd(i, 5) * 5) * (rnd(i, 6) > 0.5 ? 1 : -1) + phase * 180;

        return (
          <div
            key={`sm-${i}`}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: d,
              height: d,
              marginLeft: -d / 2,
              marginTop: -d / 2,
              borderRadius: "50%",
              transform: `rotate(${rot}deg) scaleY(1.15)`,
              /*
               * 必须 `circle closest-side`：默认按最远角算 100%，远角那两条边
               * 没走到透明就被 div 边界硬切 —— 抽帧出来是几块灰圆盘（液态
               * liquid 当初同一个坑）。closest-side 才化得开。
               */
              background: `radial-gradient(circle closest-side at 50% 48%, ${withColorAlpha(tint, alpha)} 0%, ${withColorAlpha(
                tint,
                alpha * 0.66,
              )} 38%, ${withColorAlpha(tint, alpha * 0.26)} 64%, transparent 96%)`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
