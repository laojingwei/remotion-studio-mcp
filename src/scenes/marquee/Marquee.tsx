import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, useBare, useMotion } from "../ui";

export type MarqueeProps = {
  theme: Theme;
  /** 跑马灯内容，1–3 行 */
  rows: string[];
  /** 每秒滚过多少（一个文案宽度为 100%，推荐 10–30） */
  speed: number;
  /** 方向：左 = 内容往左走 */
  direction: "左" | "右" | "交替";
  /** 文案之间的分隔符，可留空 */
  separator: string;
};

/**
 * 跑马灯：几行大字不停往一侧滚，行与行方向可以相反。
 *
 * 这类版式在直播/电商里非常常见（信息流、卖点罗列、活动氛围），
 * 作用是**制造"信息很多"的体感**而不是让人逐条读 ——
 * 所以字号必须过线（小了就变成滚动条），行数也限制在 3 行以内。
 *
 * 无缝循环靠"两份内容并排 + 位移一个副本宽度"实现，不用 JS 测量宽度：
 * 位移用整条轨道的百分比表达，`-50%` 正好等于一份内容的宽度，
 * 于是在 0 → -50% 之间循环时接缝处画面完全相同。
 * 前提是**每一份内容都要比屏幕宽**，所以一份里重复 12 遍。
 */
const REPEAT = 12;

export const MarqueeScene: React.FC<MarqueeProps> = ({
  theme,
  rows = [],
  speed = 14,
  direction = "交替",
  separator = " · ",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, h, isPortrait } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const c = theme.palette;

  const list = (rows ?? []).filter((r) => String(r).length > 0).slice(0, 3);
  const t = frame / fps;
  const vel = Math.max(1, Math.min(80, Number(speed) || 14));
  // 一份内容滚过去要 vel 秒：位移百分比 = (秒 × vel) 对 100 取模，再换算成整条轨道（2 份）的百分比
  const shift = (((t * vel) % 100) + 100) % 100;
  // 三行加起来要占住画面大半：太小就成了"滚动条"，失去「信息很多」的体感
  const fontSize = isPortrait ? h(10.4) : h(8.6);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: bare ? "transparent" : c.background,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        overflow: "hidden",
        fontFamily: theme.font.heading,
      }}
    >
      {list.map((row, i) => {
        const dir = direction === "左" ? 1 : direction === "右" ? -1 : i % 2 === 0 ? 1 : -1;
        // dir=1（往左走）：0 → -50%；dir=-1（往右走）：-50% → 0
        const x = dir === 1 ? -shift * 0.5 : -50 + shift * 0.5;
        const unit = `${row}${separator}`;
        const copy = unit.repeat(REPEAT);
        const color = i % 2 === 0 ? c.text : withColorAlpha(c.primary, 0.92);

        return (
          <div
            key={`m-${i}`}
            style={{
              overflow: "hidden",
              whiteSpace: "nowrap",
              // 行与行之间留一道细缝，三行时才看得出是三条轨道
              paddingTop: u(0.6),
              paddingBottom: u(0.6),
              borderTop: i === 0 ? "none" : `1px solid ${withColorAlpha(c.text, 0.1)}`,
            }}
          >
            {/*
             * 位移必须挂在**轨道本身**（两块内容并排的那一层）。
             * 挂在外层行 div 上时，百分比是按屏幕宽算的 —— 于是 -50% 只走半屏，
             * 接缝就会露出空白。挂在轨道上，-50% 恰好等于一份内容的宽度。
             */}
            <Editable
              id={`row${i + 1}`}
              title="每一行"
              style={{
                display: "inline-block",
                transform: `translateX(${m === 0 ? 0 : x}%)`,
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  fontSize,
                  fontWeight: 900,
                  lineHeight: 1.18,
                  letterSpacing: u(-0.05),
                  color,
                }}
              >
                {copy}
                {copy}
              </span>
            </Editable>
          </div>
        );
      })}

      {/* 两端渐隐：硬边裁切会让字"突然出现"，压一层背景色过渡掉 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background: `linear-gradient(90deg, ${withColorAlpha(c.background, bare ? 0 : 0.95)} 0%, transparent 12%, transparent 88%, ${withColorAlpha(c.background, bare ? 0 : 0.95)} 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};
