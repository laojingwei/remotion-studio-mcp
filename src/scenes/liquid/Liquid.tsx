import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBackdropFx, useBare, useMotion } from "../ui";
import { clampInt, rnd } from "../fx";

export type LiquidProps = {
  theme: Theme;
  /** 色块数量 3–7 */
  blobs: number;
  /** 配色：双色最热闹，单色更克制 */
  tone: "双色" | "主色" | "次色";
  /** 边缘柔和度 0–1（越大越像水，越小越像浆） */
  soft: number;
  /** 流动速度倍率 0.3–2.5 */
  speed: number;
};

/**
 * 流体色块：几团缓慢变形的色块在画面里挤、被挤，边界一直不成形。
 *
 * 和「光晕呼吸」的区别：光晕是**雾**（无边界、均匀、静态构图），
 * 流体是**液**（有轮廓、在变形、互相挤压）。所以它更适合"高级质感"的需求
 * （美妆、汽车、SaaS 开场），而光晕适合情绪缓冲。
 *
 * 变形不用 `filter: blur`：大面积模糊在 headless 里逐帧渲染会掉到 1–2 帧/秒。
 * 改成「径向渐变做柔边 + scale 在两个轴上不同步的呼吸」，
 * 轮廓就一直在变，看起来仍是流体的。
 */
export const LiquidScene: React.FC<LiquidProps> = ({
  theme,
  blobs = 4,
  tone = "双色",
  soft = 0.6,
  speed = 1,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height, u } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const { speed: timeScale } = useBackdropFx();
  const c = theme.palette;

  const t = (frame / fps) * timeScale;
  const n = clampInt(blobs, 3, 7);
  const s = Math.max(0, Math.min(1, Number(soft)));
  const v = Math.max(0.3, Math.min(2.5, Number(speed) || 1));
  /*
   * 柔和度决定渐变的"平台"有多宽：平台越宽越像液体，越窄越像硬边色块。
   * 但平台再宽也要留够长的尾巴 —— 第一版 0.34α 在 81% 处直接跳到 0（96%），
   * 中间那段斜率太陡，抽帧出来是四个边缘清晰的实心椭圆，像叠了几张色纸。
   * 现在多插两级（0.62 / 0.26 / 0.07），末端永远收到透明。
   */
  const plateau = 14 + s * 10;
  const base = Math.min(width, height);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: bare ? "transparent" : c.background,
        overflow: "hidden",
      }}
    >
      {Array.from({ length: n }, (_, i) => {
        const d = base * (0.7 + rnd(i, 1) * 0.7);
        const cx = rnd(i, 2) * 100;
        const cy = rnd(i, 3) * 100;
        const phase = rnd(i, 4) * Math.PI * 2;

        const tint =
          tone === "主色" ? c.primary : tone === "次色" ? c.secondary : rnd(i, 5) > 0.5 ? c.primary : c.secondary;
        // 单块就压到 0.3 以下：四块叠起来才刚好，再高就糊成一片
        const alpha = 0.3 + rnd(i, 6) * 0.18;

        // 两个轴不同步地缩放 + 缓慢自转 = 一直在变形但不会翻转
        const sx = m === 0 ? 1 : 1 + Math.sin(t * 0.42 * v + phase) * 0.22;
        const sy = m === 0 ? 1 : 1 + Math.cos(t * 0.33 * v + phase * 1.4) * 0.2;
        const rot = m === 0 ? 0 : Math.sin(t * 0.18 * v + phase) * 24;
        const dx = m === 0 ? 0 : Math.sin(t * 0.26 * v + phase * 0.7) * u(6);
        const dy = m === 0 ? 0 : Math.cos(t * 0.31 * v + phase * 1.1) * u(5);

        return (
          <div
            key={`lq-${i}`}
            style={{
              position: "absolute",
              left: `${cx}%`,
              top: `${cy}%`,
              width: d,
              height: d,
              marginLeft: -d / 2 + dx,
              marginTop: -d / 2 + dy,
              transform: `rotate(${rot}deg) scale(${sx}, ${sy})`,
              /*
               * 必须显式写 `circle closest-side`。
               *
               * radial-gradient 默认按 **farthest-corner** 算 100%：那意味着
               * 靠近远角的那两条边还没走到 100% 就撞上 div 边界，于是被硬切一刀
               * —— 抽帧出来是几块"带圆角的方块"。改成 closest-side 后
               * 100% 只到最近的一条边，整块完全落在 div 内部，边界才真的化开。
               */
              background: `radial-gradient(circle closest-side at 50% 50%, ${withColorAlpha(
                tint,
                alpha * 1.25,
              )} 0%, ${withColorAlpha(tint, alpha)} ${plateau}%, ${withColorAlpha(
                tint,
                alpha * 0.66,
              )} ${plateau + 16}%, ${withColorAlpha(tint, alpha * 0.3)} ${plateau + 32}%, ${withColorAlpha(
                tint,
                alpha * 0.08,
              )} ${plateau + 48}%, transparent 100%)`,
            }}
          />
        );
      })}

      {/* 一层极淡的纵向渐变，给液体一个"打光"方向，否则整屏是平的 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(160deg, ${withColorAlpha(c.text, 0.05)} 0%, transparent 42%, ${withColorAlpha(c.background, 0.35)} 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};
