import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, Highlighted, SceneFrame, useEnter } from "../ui";

export type CaptionProps = {
  theme: Theme;
  text: string;
  speaker: string;
  highlight: string;
};

/** 字幕场景：大号字幕 + 说话人，适合口播/解说 */
export const CaptionScene: React.FC<CaptionProps> = ({ theme, text, speaker, highlight }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);

  return (
    <SceneFrame theme={theme} justify="end" align={isPortrait ? "center" : "left"}>
      <div
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: u(1.8),
          alignItems: isPortrait ? "center" : "flex-start",
          paddingBottom: u(7),
          opacity: enter.opacity,
          transform: `translateY(${enter.y * u(1)}px)`,
        }}
      >
        {speaker ? (
          <Editable id="speaker" title="说话人">
            <span
              style={{
                fontFamily: theme.font.body,
                fontSize: h(1.7),
                letterSpacing: u(0.12),
                color: theme.palette.primary,
                fontWeight: 600,
                textTransform: "uppercase",
              }}
            >
              {speaker}
            </span>
          </Editable>
        ) : null}

        <Editable id="caption" title="字幕">
          <div
            style={{
              fontFamily: theme.font.heading,
              // 横屏是摊在两米外看的，字幕要更大；竖屏原本 5.2 已经够
              fontSize: h(isPortrait ? 5.2 : 5.6),
              fontWeight: 700,
              lineHeight: 1.32,
              color: theme.palette.text,
              textAlign: isPortrait ? "center" : "left",
              maxWidth: isPortrait ? "100%" : "88%",
            }}
          >
            <Highlighted text={text} highlight={highlight} color={theme.palette.primary} />
          </div>
        </Editable>
      </div>
    </SceneFrame>
  );
};
