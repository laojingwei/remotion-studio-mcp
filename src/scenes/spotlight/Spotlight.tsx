import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBackdropFx, useBare, useMotion } from "../ui";
import { clampInt, rnd } from "../fx";

export type SpotlightProps = {
  theme: Theme;
  /** 光色：暖（金）/ 冷（蓝） */
  tone: "暖" | "冷";
  /** 摆动幅度 0–1，0 = 定住 */
  sway: number;
  /** 亮度 0–1 */
  intensity: number;
  /** 光柱数量 1–3 */
  beams: number;
};

/**
 * 聚光扫射：几道光柱从顶上打下来，缓慢左右摆，地面留一圈光斑。
 *
 * 和「光晕呼吸」的区别：光晕是**没有方向**的雾，聚光有明确的光源和落点，
 * 画面一下就"有舞台"了 —— 适合口播的强结论、产品亮相、颁奖/排名。
 *
 * 光色用的是**光本身的颜色**（金 / 冰蓝），不是主题色。
 * 这一点踩过坑：漏光当初用主题色混，暖色主题下整条光带变成橄榄绿，
 * 看起来像渲染出错而不是打光。
 *
 * 光柱宽度是**抽帧调出来的**：第一版按画面宽的 62% 做底宽，结果三道叠起来
 * 把整屏糊成一片土黄，看着像渐变蒙版而不是打光。现在底宽只占画面 30%，
 * 并且每道光再叠一根更窄更亮的芯 —— 有芯才有"光"的边缘。
 */
const LIGHT = {
  暖: "#FFD9A0",
  冷: "#C6E6FF",
} as const;

export const SpotlightScene: React.FC<SpotlightProps> = ({
  theme,
  tone = "暖",
  sway = 0.7,
  intensity = 0.6,
  beams = 2,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height, u, isPortrait } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const { speed: timeScale } = useBackdropFx();
  const c = theme.palette;

  const t = (frame / fps) * timeScale;
  const light = LIGHT[tone] ?? LIGHT["暖"];
  const n = clampInt(beams, 1, 3);
  const k = Math.max(0, Math.min(1, intensity));
  // 底宽 ≈ 画面宽的 30%（竖屏）/ 17%（横屏），顶宽由 clipPath 收成一个点附近
  const coneW = width * (isPortrait ? 0.3 : 0.17);
  const swing = m === 0 ? 0 : Math.max(0, Math.min(1, sway));

  return (
    <AbsoluteFill
      style={{
        backgroundColor: bare ? "transparent" : c.background,
        overflow: "hidden",
      }}
    >
      {/* screen 混合：光应该"加"到画面上，而不是盖一层半透明棕 */}
      <AbsoluteFill style={{ mixBlendMode: "screen" }}>
      {Array.from({ length: n }, (_, i) => {
        // 基准角度把 n 道光均匀铺开，再各摆各的相位
        const base = (i - (n - 1) / 2) * (isPortrait ? 22 : 16);
        const ang = base + Math.sin(t * 0.32 + i * 1.7) * 20 * swing;
        // 落点跟光柱同向偏移，否则光柱在摆、地上那圈不动，像两张图叠在一起
        const poolX = 50 + Math.sin(t * 0.32 + i * 1.7) * 13 * swing + base * 1.1;

        return (
          <React.Fragment key={`sp-${i}`}>
            {/* 外层柔光：范围大、亮度低，负责"空气被照亮" */}
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "-6%",
                width: coneW,
                height: "112%",
                marginLeft: -coneW / 2,
                transformOrigin: "50% 0%",
                transform: `rotate(${ang}deg)`,
                clipPath: "polygon(42% 0%, 58% 0%, 100% 100%, 0% 100%)",
                /*
                 * 光柱的三层做法（每一层都踩过坑）：
                 *
                 * 1. 横向渐变代替纯色填充 —— 光柱中间亮、两边透明。
                 *    纯色填充 + clipPath 抽帧出来是"两条边笔直的灰棕梯形"，像贴色纸。
                 * 2. 纵向渐隐走 mask，不能和横向渐变塞进同一个 background：
                 *    两层 background 是叠加(并集)不是相乘，叠出来是"横条 ∪ 竖条"。
                 * 3. blur 收边 + mixBlendMode:screen。
                 *    screen 让光"加"到画面上而不是盖一层棕 —— 这是它看起来是光、
                 *    而不是一条半透明胶带的关键。
                 */
                maskImage: "linear-gradient(180deg, #000 0%, #000 58%, transparent 96%)",
                WebkitMaskImage: "linear-gradient(180deg, #000 0%, #000 58%, transparent 96%)",
                filter: `blur(${u(2.2)}px)`,
                background: `linear-gradient(90deg, ${withColorAlpha(light, 0)} 0%, ${withColorAlpha(
                  light,
                  0.52 * k,
                )} 50%, ${withColorAlpha(light, 0)} 100%)`,
              }}
            />
            {/* 内层光芯：范围小、亮度高，让光柱有边界而不是一团雾 */}
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "-6%",
                width: coneW * 0.42,
                height: "112%",
                marginLeft: -(coneW * 0.42) / 2,
                transformOrigin: "50% 0%",
                transform: `rotate(${ang}deg)`,
                clipPath: "polygon(30% 0%, 70% 0%, 100% 100%, 0% 100%)",
                maskImage: "linear-gradient(180deg, #000 0%, #000 64%, transparent 98%)",
                WebkitMaskImage: "linear-gradient(180deg, #000 0%, #000 64%, transparent 98%)",
                filter: `blur(${u(1.2)}px)`,
                background: `linear-gradient(90deg, ${withColorAlpha(light, 0)} 0%, ${withColorAlpha(
                  light,
                  0.82 * k,
                )} 50%, ${withColorAlpha(light, 0)} 100%)`,
              }}
            />
            {/* 地面光斑：横向压扁的椭圆，跟光柱一起摆 */}
            <div
              style={{
                position: "absolute",
                left: `${poolX}%`,
                bottom: "-4%",
                width: coneW * 1.9,
                height: u(13),
                marginLeft: -(coneW * 1.9) / 2,
                borderRadius: "50%",
                background: `radial-gradient(ellipse at center, ${withColorAlpha(light, 0.6 * k)} 0%, ${withColorAlpha(
                  light,
                  0.2 * k,
                )} 44%, transparent 76%)`,
              }}
            />
          </React.Fragment>
        );
      })}
      </AbsoluteFill>

      {/* 空气里的尘：几个极淡的亮点，光柱才不像 PPT 的渐变块 */}
      {Array.from({ length: 16 }, (_, i) => {
        const x = rnd(i, 1) * 100;
        const y = 10 + rnd(i, 2) * 82;
        const s = u(0.4 + rnd(i, 3) * 0.9);
        return (
          <div
            key={`dust-${i}`}
            style={{
              position: "absolute",
              left: `${x}%`,
              top: `${y}%`,
              width: s,
              height: s,
              borderRadius: "50%",
              background: withColorAlpha(light, 0.55 * (0.4 + k)),
              opacity: m === 0 ? 0.45 : 0.2 + Math.sin(t * 1.4 + i) * 0.3,
            }}
          />
        );
      })}

      {/* 压边：不打灯的角落暗下去，光才显得亮 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(115% 85% at 50% 32%, transparent 46%, ${withColorAlpha("#000000", 0.34)})`,
        }}
      />
    </AbsoluteFill>
  );
};
