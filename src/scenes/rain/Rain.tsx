import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBackdropFx, useBare, useMotion } from "../ui";
import { clampInt, rnd } from "../fx";

export type RainProps = {
  theme: Theme;
  /** 雨丝数量 40–220 */
  count: number;
  /** 倾斜角（度），正数往右下 */
  angle: number;
  /** 下落速度倍率 0.4–2.5 */
  speed: number;
  /** 底部水汽浓度 0–1 */
  fog: number;
};

/**
 * 雨幕：斜雨丝持续下落，底部一层水汽。
 *
 * 三种粒子效果的分工（别乱用，语气完全不同）：
 *   火花 sparks —— 向上、暖、有能量（开场、强势段落）
 *   散景 bokeh —— 不动、前景后景（夜景、回忆）
 *   雨幕 rain  —— 向下、密、压情绪（困境、沉下来的一段）
 *
 * 整层**只旋转一次**而不是给每根雨丝算角度：雨的方向是统一的，
 * 逐根算既慢又会在接缝处出现"雨丝互相穿插"的穿帮。
 */
export const RainScene: React.FC<RainProps> = ({
  theme,
  count = 90,
  angle = 14,
  speed = 1,
  fog = 0.5,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height, u, isPortrait } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const { speed: timeScale } = useBackdropFx();
  const c = theme.palette;

  const t = (frame / fps) * timeScale;
  /*
   * 容器要放大才能扛住旋转（±30° 时四角会露白），放大后可见面积只剩 ~40%，
   * 所以粒子数要按面积补回来 —— 否则用户设了 90 根，看到的是三十几根，
   * 抽帧时就是"这哪是雨，这是漏电"。
   */
  const n = clampInt(count, 40, 220);
  const total = Math.round(n * (isPortrait ? 1 : 1.3));
  const tilt = Math.max(-30, Math.min(30, Number(angle) || 0));
  const v = Math.max(0.4, Math.min(2.5, Number(speed) || 1));
  const dropColor = withColorAlpha(c.text, 0.5);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: bare ? "transparent" : c.background,
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", inset: 0 }}>
        {Array.from({ length: total }, (_, i) => {
          const sp = 0.55 + rnd(i, 1) * 0.95;
          const len = u(4.5 + rnd(i, 2) * 8);
          // 逐根向右漂，起点往左多留 40%，画面右侧才不会空
          const x = rnd(i, 3) * 140 - 40;
          const phase = rnd(i, 4);
          // 走完一轮的长度是 118%，从 -9% 起，首尾才不会在地平线附近堆成一排
          const y = ((((phase + (m === 0 ? 0 : t * 0.5 * sp * v)) % 1) + 1) % 1) * 118 - 9;
          const alpha = 0.26 + rnd(i, 5) * 0.5;
          /*
           * 每根雨丝自己旋转，整层不转。
           *
           * 早先是把整层容器转角度，然后放大 inset 兜住露出的四角 ——
           * 结果容器旋转后的下边缘横穿画面，雨丝在那条线上突然消失，
           * 抽帧出来是一条横贯全屏的缝（像是画面接错了）。
           * 现在：雨丝各自倾斜，位置沿纵向走、横向按 tanθ 漂移，与真实下落方向一致。
           */
          const drift = (y / 100) * height * Math.tan((tilt * Math.PI) / 180);
          return (
            <div
              key={`rain-${i}`}
              style={{
                position: "absolute",
                left: `calc(${x}% + ${drift}px)`,
                top: `${y}%`,
                width: Math.max(1, u(0.1)),
                height: len,
                transform: `rotate(${tilt}deg)`,
                borderRadius: 99,
                // 头细尾淡：雨丝不是一根等粗的线
                background: `linear-gradient(180deg, transparent, ${withColorAlpha(c.text, alpha)} 62%, ${dropColor})`,
              }}
            />
          );
        })}
      </div>

      {/* 水汽：底部一层背景色，把画面"泡"进雾里 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: "46%",
          background: `linear-gradient(180deg, transparent, ${withColorAlpha(c.background, 0.9 * Math.max(0, Math.min(1, fog)))})`,
        }}
      />
    </AbsoluteFill>
  );
};
