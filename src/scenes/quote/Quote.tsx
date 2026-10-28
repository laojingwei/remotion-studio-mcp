import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, Highlighted, SceneFrame, useEnter } from "../ui";

export type QuoteProps = {
  theme: Theme;
  text: string;
  author: string;
  highlight: string;
};

export const QuoteScene: React.FC<QuoteProps> = ({ theme, text, author, highlight }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const bar = useEnter(0);
  const body = useEnter(6);
  const sign = useEnter(20);

  return (
    <SceneFrame theme={theme} justify="center">
      {/* 外层必须 width:100%：竖线 + 正文是一个 flex row，
          若让它按内容收缩，正文里的 max-width 百分比会跟着一起缩，
          金句就会「9 个字就折行」 */}
      <div style={{ display: "flex", gap: u(3), alignItems: "stretch", width: "100%" }}>
        {/* 引用块左侧的竖线，比引号字形更稳、不受字体影响 */}
        <div
          style={{
            width: Math.max(3, u(0.55)),
            background: theme.palette.primary,
            borderRadius: 99,
            transform: `scaleY(${bar.progress})`,
            transformOrigin: "top",
            opacity: 0.9,
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minWidth: 0 }}>
          <Editable
            id="quote"
            title="金句正文"
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(isPortrait ? 5.0 : 4.4),
              lineHeight: 1.42,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              color: theme.palette.text,
              maxWidth: isPortrait ? "100%" : "88%",
              opacity: body.opacity,
              transform: `translateY(${body.y * u(1)}px)`,
            }}
          >
            <Highlighted text={text} highlight={highlight} color={theme.palette.primary} />
          </Editable>

          {author ? (
            <Editable
              id="author"
              title="署名"
              style={{
                display: "flex",
                alignItems: "center",
                gap: u(1.4),
                marginTop: u(3.4),
                opacity: sign.opacity,
              }}
            >
              <div
                style={{
                  fontFamily: theme.font.body,
                  fontSize: h(1.9),
                  color: theme.palette.textMuted,
                  letterSpacing: u(0.06),
                }}
              >
                — {author}
              </div>
            </Editable>
          ) : null}
        </div>
      </div>
    </SceneFrame>
  );
};
