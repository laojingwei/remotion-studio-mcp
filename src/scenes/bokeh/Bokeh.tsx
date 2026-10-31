import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBackdropFx, useBare, useMotion } from "../ui";

export type BokehProps = {
  theme: Theme;
  /** 光斑数量 6–28 */
  count: number;
  /** 光斑尺寸（短边百分比） */
  sizePct: number;
  /** 亮度 0–1 */
  glow: number;
  /** 缓慢漂浮 */
  drift: boolean;
};

/** 确定性伪随机：同一 i 永远同一个值（Remotion 逐帧渲染，不能用 Math.random） */
const rnd = (i: number, salt: number) => {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** hex → rgba，支持 #rrggbb；其它格式原样返回 */
const fade = (color: string, a: number) => {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
};

/**
 * 散景光斑：一堆失焦的柔光圆，缓慢漂浮。
 *
 * 和「光晕呼吸」的区别：光晕是 2–3 个大色团，铺满整屏、压得住画面；
 * 散景是十几二十个小圆，有**前后层次**（大的淡、小的亮），像夜里的镜头虚焦。
 * 用在需要"城市夜景 / 节日 / 回忆"语气的段落。
 *
 * 所有圆都是 radial-gradient 直接画出来的柔边，**不用 filter: blur**
 * —— 十几层大面积 blur 会让渲染掉到 1–2 帧/秒。
 */
export const BokehScene: React.FC<BokehProps> = ({
  theme,
  count = 14,
  sizePct = 9,
  glow = 0.5,
  drift = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height, u, isPortrait } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const { speed: timeScale } = useBackdropFx();
  const c = theme.palette;

  const t = (frame / fps) * timeScale;
  const move = drift && m > 0 ? m : 0;
  const n = Math.max(0, Math.min(28, Math.round(count)));
  // 横屏画面宽，同样的数量会显得稀，补 40%
  const total = isPortrait ? n : Math.round(n * 1.4);

  return (
    <AbsoluteFill style={{ backgroundColor: bare ? "transparent" : c.background, overflow: "hidden" }}>
      {Array.from({ length: total }, (_, i) => {
        const big = rnd(i, 1) > 0.68;
        const size = u(sizePct) * (big ? 1.7 : 0.55 + rnd(i, 2) * 0.6);
        const baseX = rnd(i, 3) * 100;
        const baseY = rnd(i, 4) * 100;
        // 大圆更淡（在后），小圆更亮（在前）—— 这是"景深"
        // 大圆在后要淡、小圆在前要亮；这一档（0.14 / 0.24–0.46）是抽帧调出来的下限，
        // 再淡就只剩黑屏上几个看不清的点，失去「景深」的意义
        // 这一档是「当氛围层叠在标题下面」时调出来的：再淡就只剩一片黑，看不出是散景
        const opacity = (big ? 0.2 : 0.34 + rnd(i, 5) * 0.26) * (0.55 + glow * 0.9);
        const tint =
          rnd(i, 6) > 0.72 ? c.secondary : rnd(i, 7) > 0.4 ? c.primary : c.text;
        const phase = rnd(i, 8) * Math.PI * 2;
        const amp = big ? 1.6 : 2.6;

        const dx = move ? Math.sin(t * 0.28 + phase) * amp : 0;
        const dy = move ? Math.cos(t * 0.21 + phase * 1.3) * amp : 0;
        // 呼吸：极缓的缩放，让人分不清是光在动还是镜头在动
        const breathe = move ? 1 + Math.sin(t * 0.5 + phase) * 0.06 : 1;

        return (
          <div
            key={`b-${i}`}
            style={{
              position: "absolute",
              left: `${baseX}%`,
              top: `${baseY}%`,
              width: size * breathe,
              height: size * breathe,
              marginLeft: (-size * breathe) / 2,
              marginTop: (-size * breathe) / 2,
              borderRadius: "50%",
              // 4 停：中心亮 → 一段「平台」（这才是失焦圆盘）→ 柔边 → 透明。
              // 只写两停（opacity → transparent）会画成边缘清晰的小圆点，像粒子不像散景。
              background: `radial-gradient(circle, ${fade(tint, Math.min(1, opacity * 1.25))} 0%, ${fade(
                tint,
                opacity,
              )} 42%, ${fade(tint, opacity * 0.32)} 64%, transparent 94%)`,
            }}
          />
        );
      })}

      {/* 底部压边：光斑全屏飘容易"浮"，压一下地面感更强 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: `${Math.round((u(30) / height) * 100)}%`,
          background: `linear-gradient(180deg, transparent, ${fade(c.background, 0.85)})`,
        }}
      />
      {/* 顶部略压，避免最上面的光斑顶到画框 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: `${Math.round((u(12) / height) * 100)}%`,
          background: `linear-gradient(0deg, transparent, ${fade(c.background, 0.6)})`,
          width,
        }}
      />
    </AbsoluteFill>
  );
};
