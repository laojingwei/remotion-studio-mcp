import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useMotion } from "../ui";

export type TypewriterProps = {
  theme: Theme;
  /** 主文案，支持 \n 换行 */
  text: string;
  /** 副标题，打完字才出现 */
  sub: string;
  /** 每秒打几个字 */
  speed: number;
  /** 显示闪烁光标 */
  cursor: boolean;
};

/**
 * 打字机：逐字出现 + 光标闪烁。
 *
 * 与「弹跳字」的区别是语气 —— 弹跳字用于口号，打字机用于**要被读完的信息**
 * （一句话结论、条款、步骤）。所以它左对齐、不居中，行宽限制在 86%，
 * 让人顺着字走，而不是扫一眼。
 *
 * 光标只在"还在打字"时闪；打完字后慢速闪两下就停 —— 一直闪很吵，
 * 但完全不出又不像打字机。
 */
export const TypewriterScene: React.FC<TypewriterProps> = ({
  theme,
  text = "",
  sub = "",
  speed = 10,
  cursor = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, h, b, isPortrait } = useSceneLayout();
  const m = useMotion();
  const c = theme.palette;

  const full = String(text ?? "");
  // 关动效 = 直接给全文，不是"打得更快"
  const shown = m === 0 ? full.length : Math.min(full.length, Math.floor((frame / fps) * Math.max(1, speed)));
  const done = shown >= full.length;
  const typedText = full.slice(0, shown);

  // 打字中 6Hz 硬闪；打完后 1.6Hz 慢闪，且只在前 3 秒出现
  const blink = !cursor
    ? false
    : done
      ? frame / fps > 3 && Math.sin((frame / fps) * 1.6 * Math.PI) > 0
      : Math.sin((frame / fps) * 6 * Math.PI) > -0.3;

  const lines = typedText.split("\n");
  const fontSize = h(isPortrait ? 6.2 : 5.4);

  return (
    <SceneFrame theme={theme} justify="center" align="left">
      <Editable id="text" title="主文案" style={{ maxWidth: isPortrait ? u(86) : "72%" }}>
        <div
          style={{
            fontFamily: theme.font.heading,
            fontSize,
            lineHeight: 1.5,
            fontWeight: 700,
            color: c.text,
            whiteSpace: "pre-wrap",
            textAlign: "left",
          }}
        >
          {lines.map((line, i) => (
            <div key={`l-${i}`}>
              {line}
              {/* 光标只挂在最后一行末尾 */}
              {i === lines.length - 1 ? (
                <span
                  style={{
                    display: "inline-block",
                    width: Math.max(2, u(0.45)),
                    height: `${fontSize}px`,
                    marginLeft: u(0.3),
                    verticalAlign: "text-bottom",
                    backgroundColor: c.primary,
                    opacity: blink ? 1 : 0,
                  }}
                />
              ) : null}
            </div>
          ))}
        </div>
      </Editable>

      {sub && done ? (
        <Editable id="sub" title="副标题" style={{ marginTop: u(4), maxWidth: isPortrait ? u(80) : "64%" }}>
          <div
            style={{
              fontFamily: theme.font.body,
              fontSize: b(2.4),
              color: c.textMuted,
              lineHeight: 1.6,
              letterSpacing: u(0.05),
              // 打完字才淡入，别跟正文抢
              opacity: m === 0 ? 1 : Math.min(1, (frame / fps - full.length / Math.max(1, speed)) / 0.5),
            }}
          >
            {sub}
          </div>
        </Editable>
      ) : null}
    </SceneFrame>
  );
};
