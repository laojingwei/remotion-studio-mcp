import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type CompareProps = {
  theme: Theme;
  heading: string;
  leftTitle: string;
  leftText: string;
  rightTitle: string;
  rightText: string;
};

/** 前后对比：左右（竖屏上下）两栏 */
export const CompareScene: React.FC<CompareProps> = ({
  theme,
  heading,
  leftTitle,
  leftText,
  rightTitle,
  rightText,
}) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);

  const column = (id: string, title: string, text: string, accent: string) => (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: u(1.2),
        padding: u(2.6),
        borderRadius: u(1.6),
        border: `1px solid ${theme.palette.surface}`,
        background: theme.palette.surface,
        opacity: enter.opacity,
        transform: `translateY(${enter.y * u(1)}px)`,
      }}
    >
      <Editable id={`${id}Title`} title={`${title}标题`}>
        <span
          style={{
            fontFamily: theme.font.body,
            fontSize: h(1.8),
            letterSpacing: u(0.1),
            color: accent,
            fontWeight: 700,
          }}
        >
          {title}
        </span>
      </Editable>
      <Editable id={`${id}Text`} title={`${title}内容`}>
        <div
          style={{
            fontFamily: theme.font.heading,
            fontSize: h(isPortrait ? 3.4 : 3),
            lineHeight: 1.35,
            color: theme.palette.text,
            // pre-line：让文案里的 \n 真的换行（HTML 默认会把换行折叠成空格）
            whiteSpace: "pre-line",
          }}
        >
          {text}
        </div>
      </Editable>
    </div>
  );

  return (
    <SceneFrame theme={theme} justify="center">
      <div style={{ display: "flex", flexDirection: "column", gap: u(3), width: "100%" }}>
        {heading ? (
          <Editable id="heading" title="标题">
            <div
              style={{
                fontFamily: theme.font.heading,
                fontSize: h(isPortrait ? 4.2 : 3.8),
                fontWeight: 800,
                color: theme.palette.text,
              }}
            >
              {heading}
            </div>
          </Editable>
        ) : null}

        <div style={{ display: "flex", flexDirection: isPortrait ? "column" : "row", gap: u(2.4) }}>
          {column("left", leftTitle, leftText, theme.palette.textMuted)}
          {column("right", rightTitle, rightText, theme.palette.primary)}
        </div>
      </div>
    </SceneFrame>
  );
};
