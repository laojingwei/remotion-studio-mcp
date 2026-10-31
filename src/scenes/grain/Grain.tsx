import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBackdropFx, useBare, useMotion } from "../ui";

export type GrainProps = {
  theme: Theme;
  /** 0–1，颗粒浓度 */
  intensity: number;
  /** 压边暗角 */
  vignette: number;
  /** 颗粒逐帧跳动（关掉 = 一张静态颗粒图） */
  flicker: boolean;
};

/**
 * 胶片颗粒：给画面做旧、压掉数码感。
 *
 * 四个工程约束（第一版踩过的坑写在注释里，别再走一遍）：
 *  1. **确定性**：Remotion 可并行逐帧渲染，Math.random() 会让同一帧两次出图不一样。
 *     这里用 feTurbulence + seed，seed 由帧号推出。
 *  2. **按像素密度出噪点**：第一版给了 viewBox="0 0 100 100" + preserveAspectRatio="none"，
 *     噪点被拉成 10px 的大块，看着像脏玻璃而不是颗粒。现在宽高直接取画面像素。
 *  3. **screen 而不是 overlay**：overlay 在近黑底上等于什么都没加 —— 第一版渲出来整屏全黑。
 *     screen 是「加光」，深底上才像胶片。
 *  4. **不能每帧重算**：full-screen turbulence 很贵，seed 每 3 帧换一次，肉眼仍是跳动的。
 */
export const GrainScene: React.FC<GrainProps> = ({
  theme,
  intensity = 0.5,
  vignette = 0.55,
  flicker = true,
}) => {
  const frame = useCurrentFrame();
  const { u, width, height } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const { speed: timeScale } = useBackdropFx();
  const p = theme.palette;

  // 颗粒没有周期，倍率只影响"多久换一次噪点"：1 倍时每 3 帧换，2 倍时更快
  const seed = 1 + (Math.floor((frame * timeScale) / 3) % 97);
  const amount = Math.max(0, Math.min(1, intensity));
  const opacity = amount * (flicker && m > 0 ? 0.5 : 0.42);
  const fid = `grain-${seed}`;

  return (
    <AbsoluteFill style={{ background: bare ? "transparent" : p.background, overflow: "hidden" }}>
      <svg
        width={width}
        height={height}
        style={{ position: "absolute", inset: 0, opacity, mixBlendMode: "screen" }}
      >
        <filter id={fid} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} seed={seed} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
          {/* 提对比：turbulence 本身是中间调，不提对比就是一层灰雾 */}
          <feComponentTransfer>
            <feFuncR type="linear" slope="2.2" intercept="-0.55" />
            <feFuncG type="linear" slope="2.2" intercept="-0.55" />
            <feFuncB type="linear" slope="2.2" intercept="-0.55" />
          </feComponentTransfer>
        </filter>
        <rect width="100%" height="100%" filter={`url(#${fid})`} />
      </svg>

      {/* 暗角：颗粒铺满整屏会让边角发脏，压暗之后视线回到中间 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          // 用 ellipse 而不是 circle：circle 的半径按"对角/2"算，
          // 横屏 16:9 里圆会顶出上下边界 —— 结果是左右压得很重、上下几乎没有暗角（横屏抽帧实测）。
          background: `radial-gradient(ellipse at 50% 50%, transparent 46%, rgba(0,0,0,${Math.max(0, Math.min(0.9, vignette))}) 100%)`,
        }}
      />

      {/* 极淡扫描线：只给一点点模拟质感，重了就成显示器故障 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `repeating-linear-gradient(0deg, rgba(255,255,255,0.05) 0px, rgba(255,255,255,0.05) 1px, transparent 1px, transparent ${Math.max(3, Math.round(u(0.6)))}px)`,
          opacity: 0.35,
        }}
      />
    </AbsoluteFill>
  );
};
