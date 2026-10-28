import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type VersusProps = {
  theme: Theme;
  leftTitle: string;
  leftText: string;
  rightTitle: string;
  rightText: string;
};

/** VS 对战：左右两强对比，中间 VS 徽标 */
export const VersusScene: React.FC<VersusProps> = ({
  theme,
  leftTitle,
  leftText,
  rightTitle,
  rightText,
}) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;

  const side = (id: string, title: string, text: string, accent: string) => (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: u(1),
        padding: u(2.6),
        borderRadius: u(1.8),
        border: `1px solid ${accent}`,
        background: `${accent}14`,
      }}
    >
      <Editable id={`${id}Title`} title="阵营">
        <span style={{ fontFamily: theme.font.heading, fontSize: h(3.2), fontWeight: 800, color: accent }}>
          {title}
        </span>
      </Editable>
      <Editable id={`${id}Text`} title="说明">
        <div
          style={{
            fontFamily: theme.font.body,
            fontSize: h(1.9),
            lineHeight: 1.5,
            color: c.textMuted,
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
    <SceneFrame theme={theme} justify="center" align="center">
      <div style={{ display: "flex", flexDirection: "column", gap: u(3), width: "100%", opacity: enter.opacity, transform: `translateY(${enter.y * u(1)}px)` }}>
        <div style={{ display: "flex", flexDirection: isPortrait ? "column" : "row", gap: u(2), alignItems: "center", width: "100%" }}>
          {side("left", leftTitle, leftText, c.primary)}
          {isPortrait ? (
            <div style={{ fontFamily: theme.font.heading, fontSize: h(2.4), fontWeight: 900, color: c.textMuted, letterSpacing: u(0.2) }}>
              VS
            </div>
          ) : null}
          {side("right", rightTitle, rightText, "#FF6B81")}
        </div>
        {!isPortrait ? (
          <div style={{ fontFamily: theme.font.heading, fontSize: h(2.4), fontWeight: 900, color: c.textMuted, letterSpacing: u(0.2) }}>
            VS
          </div>
        ) : null}
      </div>
    </SceneFrame>
  );
};
