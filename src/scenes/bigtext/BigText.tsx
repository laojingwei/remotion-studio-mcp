import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, Highlighted, SceneFrame, useEnter } from "../ui";

export type BigTextProps = {
  theme: Theme;
  text: string;
  sub: string;
  highlight: string;
};

/** 大字报：一句超大字，适合情绪/态度/金句 */
export const BigTextScene: React.FC<BigTextProps> = ({ theme, text, sub, highlight }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: u(3),
          opacity: enter.opacity,
          transform: `translateY(${enter.y * u(1)}px)`,
        }}
      >
        <Editable id="text" title="大字">
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(isPortrait ? 12 : 10),
              fontWeight: 900,
              lineHeight: 1.08,
              letterSpacing: "-0.03em",
              color: theme.palette.text,
            }}
          >
            <Highlighted text={text} highlight={highlight} color={theme.palette.primary} />
          </div>
        </Editable>
        {sub ? (
          <Editable id="sub" title="小字">
            <div
              style={{
                fontFamily: theme.font.body,
                fontSize: h(2.1),
                color: theme.palette.textMuted,
              }}
            >
              {sub}
            </div>
          </Editable>
        ) : null}
      </div>
    </SceneFrame>
  );
};
