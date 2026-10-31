import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBackdropFx, useBare, useMotion } from "../ui";

export type LightLeakProps = {
  theme: Theme;
  /** 暖（橙金）/ 冷（青蓝） */
  tone: "暖" | "冷";
  /** 一次扫过用几秒 */
  periodSec: number;
  /** 0–1，光带强度 */
  intensity: number;
  /** 斜角，越小越接近横向 */
  angle: number;
};

const alpha = (color: string, a: number) => {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  return `${color}${Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0")}`;
};

/**
 * 漏光扫过：一束光带周期性划过画面，模拟镜头漏光 / 转场补光。
 *
 * 用 mix-blend-mode: screen 而不是叠一层半透明色块：
 * screen 在深底上几乎等于"加光"，不会把底下的画面压灰 —— 这也是它能直接压在
 * 别的幕上当前景层用的原因。
 */
export const LightLeakScene: React.FC<LightLeakProps> = ({
  theme,
  tone = "暖",
  periodSec = 4,
  intensity = 0.6,
  angle = 18,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const { speed: timeScale, once } = useBackdropFx();
  const p = theme.palette;

  const warm = tone === "暖";
  // 光色**不跟主题色走**：主题主色可能是柠檬绿，混进暖光就变成一坨橄榄色
  // （第一版就是这样，整屏发脏）。漏光就该是光本身的颜色。
  const core = warm ? "#FFF3DE" : "#E8F8FF";
  // 边缘色不要用饱和橙：暗底 + screen 混合会把 #FFA23A 压成"棕"，
  // 加大明度、降低 alpha 才读得出是暖金光而不是一块脏色。
  const edge = warm ? "#FFC473" : "#6FD2FF";
  const period = Math.max(1.5, periodSec) * fps;
  /*
   * 倍速：直接缩放帧号（等价于缩短周期），lightleak 是唯一"时间轴"就是全部语义的动效。
   * once：走到 phase=1 就停住 —— 此时光带已经移出画面右侧，等于"扫一次就没了"，
   *       而不是停在画面中间亮着一条光。区间剩下的时间保持这个状态。
   */
  const tt = frame * timeScale;
  const phase = once ? Math.min(1, tt / period) : (tt % period) / period;

  // 从左侧外扫到右侧外；motion=0 时停在偏左的静态位置（不留空白画面）
  const x = m > 0 ? interpolate(phase, [0, 1], [-70, 170]) : 30;
  // 留一个下限：sin 曲线两端接近 0，光带会「忽明忽暗」像坏灯
  const flash = m > 0 ? 0.55 + 0.45 * Math.sin(phase * Math.PI) : 0.8;

  return (
    <AbsoluteFill style={{ background: bare ? "transparent" : p.background, overflow: "hidden" }}>
      {/* 底：一点点常驻的角光，避免"没扫到时全黑" */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(70% 55% at ${warm ? "18%" : "82%"} 12%, ${alpha(edge, 0.14)}, transparent 68%)`,
        }}
      />

      {/* 主光带 */}
        <div
          style={{
            position: "absolute",
            inset: "-25%",
            // 光带宽度必须写死成 px（按短边百分比给），不能用渐变百分比 stop：
            // 百分比是"沿渐变轴的比例"，轴长随画幅变 —— 横屏 1920 下同一条光带会宽出 44%，
            // 读起来不是"一道光"而是一块橙布（横屏抽帧实测）。
            background:
              `linear-gradient(${90 + angle}deg,` +
              ` transparent calc(50% - ${u(14)}px),` +
              ` ${alpha(edge, 0.45 * intensity * flash)} calc(50% - ${u(6.5)}px),` +
              ` ${alpha(core, 0.55 * intensity * flash)} calc(50% - ${u(1.6)}px),` +
              ` ${alpha(core, 1 * intensity * flash)} 50%,` +
              ` ${alpha(core, 0.55 * intensity * flash)} calc(50% + ${u(1.6)}px),` +
              ` ${alpha(edge, 0.45 * intensity * flash)} calc(50% + ${u(6.5)}px),` +
              ` transparent calc(50% + ${u(14)}px))`,
            transform: `translateX(${x}%)`,
            mixBlendMode: "screen",
          }}
        />

      {/* 第二条细光带，错开半个周期：单条扫过太像"进度条" */}
      <div
        style={{
          position: "absolute",
          inset: "-25%",
            background:
              `linear-gradient(${90 + angle * 1.6}deg,` +
              ` transparent calc(50% - ${u(8)}px), ${alpha(core, 0.42 * intensity * flash)} 50%, transparent calc(50% + ${u(8)}px))`,
          transform: `translateX(${m > 0 ? x - 46 : -16}%)`,
          mixBlendMode: "screen",
          opacity: 0.45,
        }}
      />

      {/* 顶部渗光，模拟机身缝隙漏进来的光 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: u(28),
          background: `linear-gradient(180deg, ${alpha(core, 0.18 * intensity)}, transparent)`,
          mixBlendMode: "screen",
        }}
      />
    </AbsoluteFill>
  );
};
