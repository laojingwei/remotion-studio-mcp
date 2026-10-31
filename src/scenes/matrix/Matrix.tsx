import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBare, useBackdropFx } from "../ui";
import { clampInt, rnd } from "../fx";

export type MatrixProps = {
  theme: Theme;
  /** 字符列数 10–36 */
  cols: number;
  /** 下落速度倍率 0.4–2.5 */
  speed: number;
  /** 亮头占比 0–1（每列最亮的那个字符有多扎眼） */
  glow: number;
};

const GLYPHS = "アイウエオカキクケコサシスセソ0123456789ABCDEF<>[]{}$#";
/** 每列尾巴多少个字符（定长，别按高度算 —— 列在画面里走，露不露由位置决定） */
const TRAIL = 16;

/**
 * 字符雨：竖列片假名/十六进制持续下落，亮头 + 渐隐尾。
 *
 * Matrix 的确定性约束（和烟花同一个道理，逐帧渲染各帧独立进 Chrome）：
 * 列位置、字符序列、下落相位全部从 rnd(列号, salt) 算，不用随机数。
 *
 * 和 rain 的分工：rain 是情绪（压下去），matrix 是科技感（黑客/终端/数据流）。
 * 深色主题最出彩；浅色主题字符用 c.text，依然可读但味道打折。
 */
export const MatrixScene: React.FC<MatrixProps> = ({ theme, cols = 22, speed = 1, glow = 0.7 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { height, u, isPortrait } = useSceneLayout();
  const bare = useBare();
  const { speed: timeScale } = useBackdropFx();
  const c = theme.palette;

  const n = clampInt(cols, 10, 36);
  const v = Math.max(0.4, Math.min(2.5, Number(speed) || 1));
  const g = Math.max(0, Math.min(1, Number(glow) || 0.7));
  const t = (frame / fps) * timeScale * v;
  const fontSize = u(2.2);
  const step = fontSize * 1.15; // 行距 = 字号 × 行高
  // 走完全程用画面高的 1.3 倍：出下沿之后还有一段"完全离开"，回绕时才不突兀
  const travel = height * 1.3 + TRAIL * step;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {Array.from({ length: n }, (_, col) => {
        const x = ((col + 0.5) / n) * 100 + (rnd(col, 9) - 0.5) * (100 / n / 2);
        const sp = 0.6 + rnd(col, 1) * 0.8;
        const phase = rnd(col, 2);
        // 亮头的像素 y：走过 travel 回绕
        const head = (((phase + t * sp * 0.55) % 1) + 1) % 1 * travel - TRAIL * step;
        return (
          <div
            key={`mx-${col}`}
            style={{
              position: "absolute",
              left: `${x.toFixed(2)}%`,
              top: 0,
              bottom: 0,
              width: fontSize * 1.2,
              overflow: "hidden",
            }}
          >
            {Array.from({ length: TRAIL }, (_, k) => {
              const fade = Math.max(0, 1 - k / TRAIL);
              const alpha = fade * fade * (0.28 + g * 0.42);
              // 字符随时间缓慢翻动；同一 (列,格,时刻) 每次渲染相同
              const glyph =
                GLYPHS[Math.floor(rnd(col * 97 + k, Math.floor(t * 2.5 + col)) * GLYPHS.length)];
              const isHead = k === 0;
              return (
                <span
                  key={`mx-${col}-${k}`}
                  style={{
                    position: "absolute",
                    // 必须带 px：字符串数字是无效 CSS（React 只给 number 自动补 px），
                    // 全部字符就会叠在 top:auto 的原点上 —— 抽帧时整幅字都堆在顶边
                    top: `${(head - k * step).toFixed(1)}px`,
                    left: 0,
                    fontFamily: "monospace",
                    fontSize,
                    lineHeight: 1.15,
                    whiteSpace: "pre",
                    color: isHead
                      ? withColorAlpha("#FFFFFF", 0.85 * (0.5 + g * 0.5))
                      : withColorAlpha(c.text, alpha),
                    textShadow: isHead ? `0 0 ${u(1.2)} ${withColorAlpha(c.primary, 0.9)}` : "none",
                  }}
                >
                  {glyph}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
