import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBackdropFx, useBare, useMotion } from "../ui";
import { clampInt, rnd } from "../fx";

export type FireworksProps = {
  theme: Theme;
  /** 一轮多长（秒），一轮 = 一组齐放 */
  periodSec: number;
  /** 一轮齐放几发 1–3 */
  bursts: number;
  /** 亮度 0–1 */
  intensity: number;
};

/** 每发烟花的粒子数。太多会卡，太少不像「炸开」 */
const PARTICLES = 64;
/** 单发从炸开到熄灭的时长（秒） */
const LIFE = 2.2;

/**
 * 烟花：一组一组地放，每发炸开成一圈光点，边扩边坠边熄。
 *
 * 关键是**确定性**：炸点位置、每颗粒子的角度和速度都从
 * 「第几轮 + 第几发 + 第几颗粒子」用 rnd() 算出来 —— Remotion 逐帧独立渲染，
 * 用 Math.random() 每帧的烟花长得都不一样，表现就是"整屏噪声"。
 *
 * once（氛围层"只放一轮"）对它是有意义的：一轮放完就停。
 * 它因此进了 PERIODIC_BACKDROP_TYPES，面板上会给"播放次数"选项。
 */
export const FireworksScene: React.FC<FireworksProps> = ({
  theme,
  periodSec = 5,
  bursts = 2,
  intensity = 0.7,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height, u, isPortrait } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const { speed: timeScale, once } = useBackdropFx();
  const c = theme.palette;

  const period = Math.max(2, Math.min(12, Number(periodSec) || 5));
  const nBurst = clampInt(bursts, 1, 3);
  const k = Math.max(0, Math.min(1, intensity));
  const colors = [c.primary, c.secondary, c.accent];
  const t = (frame / fps) * timeScale;

  const cycle = once ? 0 : Math.floor(t / period);
  const pieces: React.ReactNode[] = [];

  // 画当前轮 + 上一轮（轮尾的余烬还在熄灭，不画上一轮会突然消失）
  for (let ci = 0; ci < 2; ci++) {
    const cyc = cycle - ci;
    if (cyc < 0) continue;
    const cycleT = t - cyc * period;
    for (let b = 0; b < nBurst; b++) {
      // 每发在一轮内错开时间，别真"齐放"——同时炸开只会糊成一团
      const start = (b / nBurst) * period * 0.7 + rnd(cyc * 7 + b, 20) * period * 0.15;
      const tau = (cycleT - start) / LIFE;
      if (tau < 0 || tau > 1) continue;
      if (m === 0 && tau > 0.35) continue; // 关动效 = 定格在炸开最亮的一瞬

      const cx = (0.12 + rnd(cyc * 7 + b, 1) * 0.76) * width;
      const cy = (0.12 + rnd(cyc * 7 + b, 2) * 0.42) * height;
      const color = colors[(cyc + b) % colors.length];
      const maxR = Math.min(width, height) * (0.2 + rnd(cyc * 7 + b, 3) * 0.1);
      /* pow(x,0.7) 让亮度前段撑住、后段才收 —— 线性衰减的烟花半秒就看不见了 */
      const fade = Math.pow(1 - tau, 0.7);

      // 中心的余晖：炸开时最亮，随整个烟花一起熄灭 —— 没有它，散开的点没有"出处"
      pieces.push(
        <div
          key={`fw-g-${cyc}-${b}`}
          style={{
            position: "absolute",
            left: cx,
            top: cy,
            width: maxR * 0.8,
            height: maxR * 0.8,
            marginLeft: -(maxR * 0.8) / 2,
            marginTop: -(maxR * 0.8) / 2,
            borderRadius: "50%",
            background: `radial-gradient(circle closest-side, ${withColorAlpha("#FFFFFF", 0.36 * fade * fade * k)} 0%, ${withColorAlpha(
              color,
              0.2 * fade * k,
            )} 40%, transparent 100%)`,
          }}
        />,
      );

      // 炸开瞬间的闪光（小而白，一闪而过）
      if (tau < 0.14) {
        pieces.push(
          <div
            key={`fw-f-${cyc}-${b}`}
            style={{
              position: "absolute",
              left: cx,
              top: cy,
              width: u(6) * (tau / 0.14),
              height: u(6) * (tau / 0.14),
              marginLeft: -u(3) * (tau / 0.14),
              marginTop: -u(3) * (tau / 0.14),
              borderRadius: "50%",
              background: `radial-gradient(circle, ${withColorAlpha("#FFFFFF", 0.75 * k)}, ${withColorAlpha(
                color,
                0.3 * k,
              )} 55%, transparent 100%)`,
            }}
          />,
        );
      }

      for (let i = 0; i < PARTICLES; i++) {
        const ang = (i / PARTICLES) * Math.PI * 2 + rnd(cyc * 7 + b, 10 + i) * 0.14;
        // 先快后慢地扩（easeOut），同时整体下坠 —— 只有扩张没有下坠像风筝不像烟花
        const r = maxR * (1 - Math.pow(1 - tau, 2)) * (0.6 + rnd(cyc * 7 + b, 30 + i) * 0.62);
        const drop = height * 0.06 * tau * tau;
        // 余烬是一根**指向远方的光条**，不是圆点：圆点围一圈就是"点状圆环"，
        // 光条才有「炸开」的方向感。越到后期条越短（烧尽了）
        const len = u(1.4 + rnd(cyc * 7 + b, 60 + i) * 2.2) * (1 - tau * 0.45);
        const w = Math.max(1.5, u(0.22) * (1 + (1 - tau) * 0.5));
        const deg = (ang * 180) / Math.PI;
        pieces.push(
          <div
            key={`fw-${cyc}-${b}-${i}`}
            style={{
              position: "absolute",
              left: cx + Math.cos(ang) * (r - len),
              top: cy + Math.sin(ang) * (r - len) * 0.94 + drop,
              width: len,
              height: w,
              borderRadius: 999,
              transformOrigin: "0 50%",
              transform: `rotate(${deg}deg)`,
              background: `linear-gradient(90deg, ${withColorAlpha(
                i % 4 === 0 ? "#FFFFFF" : color,
                Math.min(1, fade * (0.95 + k * 0.2)),
              )}, ${withColorAlpha(color, 0)})`,
            }}
          />,
        );
      }
    }
  }

  return (
    <AbsoluteFill style={{ backgroundColor: bare ? "transparent" : c.background, overflow: "hidden" }}>
      {pieces}
    </AbsoluteFill>
  );
};
