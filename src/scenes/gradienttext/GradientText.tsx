import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useMotion } from "../ui";

export type GradientTextProps = {
  theme: Theme;
  /** 主文案，支持 \n 换行 */
  text: string;
  /** 副标题 */
  sub: string;
  /** 渐变方向：横向扫过 / 斜向 */
  direction: "横向" | "斜向";
  /** 渐变流动（关掉 = 静态渐变） */
  flow: boolean;
};

/**
 * 渐变字：标题用主题色渐变填充，从左向右"刷"出来。
 *
 * 这里负责把渐变真正落在**文字元素自身**上 ——
 * 之前的教训是 freeform 把 style 挂在外层盒子上，`background-clip:text`
 * 作用到了方块上，整块变成一个色斑。三件事必须同时成立：
 *  backgroundImage + backgroundClip:"text" + color:"transparent"，
 * 且这个 style 必须挂在直接包含文字的节点上。
 */
export const GradientTextScene: React.FC<GradientTextProps> = ({
  theme,
  text = "",
  sub = "",
  direction = "横向",
  flow = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, h, b, isPortrait } = useSceneLayout();
  const m = useMotion();
  const c = theme.palette;

  const enter = m === 0 ? 1 : spring({ frame: frame - 2, fps, config: { damping: 200, mass: 0.8 } });
  // 背景尺寸放大到 200%，靠 backgroundPosition 移动 —— 比动 transform 便宜，也不会把文字拖糊
  const shift = flow && m > 0 ? interpolate(frame / fps, [0, 6], [0, 100], { extrapolateRight: "extend" }) : 0;

  const fontSize = h(isPortrait ? 11 : 9.5);
  const angle = direction === "斜向" ? 118 : 92;

  return (
    <SceneFrame theme={theme} justify="center" align="left">
      <Editable id="text" title="主文案" style={{ maxWidth: isPortrait ? u(88) : "76%" }}>
        <div
          style={{
            fontFamily: theme.font.heading,
            fontSize,
            fontWeight: 900,
            lineHeight: 1.16,
            letterSpacing: u(-0.15),
            whiteSpace: "pre-wrap",
            backgroundImage: `linear-gradient(${angle}deg, ${c.primary} 0%, ${c.secondary} 48%, ${c.primary} 100%)`,
            backgroundSize: "220% 100%",
            backgroundPosition: `${shift}% 0`,
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
            // 入场：轻微上移 + 字距从松到紧，像"落定"
            opacity: enter,
            transform: `translateY(${(1 - enter) * u(3)}px)`,
          }}
        >
          {text}
        </div>
      </Editable>

      {sub ? (
        <Editable id="sub" title="副标题" style={{ marginTop: u(3.6), maxWidth: isPortrait ? u(76) : "62%" }}>
          <div
            style={{
              fontFamily: theme.font.body,
              fontSize: b(2.3),
              color: c.textMuted,
              lineHeight: 1.6,
              letterSpacing: u(0.04),
              opacity: m === 0 ? 1 : Math.min(1, Math.max(0, (frame / fps - 0.5) / 0.6)),
            }}
          >
            {sub}
          </div>
        </Editable>
      ) : null}
    </SceneFrame>
  );
};
