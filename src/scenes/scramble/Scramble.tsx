import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useMotion } from "../ui";

export type ScrambleProps = {
  theme: Theme;
  /** 主文案 */
  text: string;
  /** 副标题 */
  sub: string;
  /** 每个字解码所需帧数 */
  revealFrames: number;
  /** 相邻字的错峰帧数 */
  stagger: number;
};

/** 解码过程中交替出现的字符（不要用中文，乱码要一眼看出"不是字"） */
const GLYPHS = "0123456789ABCDEF#$%&*+=<>/\\|";

/**
 * 乱码解码：每个字先显示随机字符，逐字"解"成真字。
 *
 * 关键技术点是**必须确定性**：不能用 Math.random()。
 * Remotion 逐帧渲染，同一帧可能被渲两次（预览 + 正式），
 * 用随机数会导致两次结果不同、甚至同一帧抖动乱跳。
 * 这里用 (字符下标, 帧号) 的整数运算造伪随机，同一个 (i, frame) 永远同一个字符。
 */
export const ScrambleScene: React.FC<ScrambleProps> = ({
  theme,
  text = "",
  sub = "",
  revealFrames = 14,
  stagger = 2,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, h, b, isPortrait } = useSceneLayout();
  const m = useMotion();
  const c = theme.palette;

  const chars = [...String(text ?? "")];
  const fontSize = h(isPortrait ? 8.6 : 7);

  const glyphFor = (i: number, f: number) => {
    // 整数哈希：不同 (i,f) 组合打散，且同输入必同输出
    const n = (i * 7919 + f * 104729 + i * f * 31) % 9973;
    return GLYPHS[n % GLYPHS.length];
  };

  return (
    <SceneFrame theme={theme} justify="center" align="left">
      <Editable id="text" title="主文案" style={{ maxWidth: isPortrait ? u(88) : "74%" }}>
        <div
          style={{
            fontFamily: theme.font.heading,
            fontSize,
            fontWeight: 800,
            lineHeight: 1.24,
            letterSpacing: u(0.1),
            color: c.text,
            whiteSpace: "pre-wrap",
            // 等宽能减少解码时字宽跳动；中文等宽无副作用
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {chars.map((ch, i) => {
            if (ch === "\n") return <br key={`br-${i}`} />;
            if (ch === " ") return <span key={`sp-${i}`}> </span>;
            const settle = m === 0 ? 0 : i * stagger + revealFrames;
            const locked = frame >= settle;
            // 每 2 帧换一次乱码，太快会像噪点、太慢看不出在"解"
            const scramble = glyphFor(i, Math.floor(frame / 2));
            const justLocked = frame - settle >= 0 && frame - settle < 3;
            return (
              <span
                key={`c-${i}`}
                style={{
                  display: "inline-block",
                  color: locked ? c.text : c.primary,
                  opacity: locked ? 1 : 0.75,
                  // 刚解出来时给一点强调，视线会跟着"逐字落定"走
                  textShadow: justLocked ? `0 0 ${u(2)}px ${c.primary}66` : undefined,
                }}
              >
                {locked ? ch : scramble}
              </span>
            );
          })}
        </div>
      </Editable>

      {sub ? (
        <Editable id="sub" title="副标题" style={{ marginTop: u(3.4), maxWidth: isPortrait ? u(78) : "66%" }}>
          <div
            style={{
              fontFamily: theme.font.body,
              fontSize: b(2.3),
              color: c.textMuted,
              lineHeight: 1.6,
              opacity: m === 0 ? 1 : Math.min(1, Math.max(0, (frame / fps - (chars.length * stagger + revealFrames) / fps) / 0.4)),
            }}
          >
            {sub}
          </div>
        </Editable>
      ) : null}
    </SceneFrame>
  );
};
