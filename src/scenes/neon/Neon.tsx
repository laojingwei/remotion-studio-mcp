import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type NeonProps = {
  theme: Theme;
  text: string;
  sub: string;
};

/** 霓虹标题：网格背景 + 发光描边大字 */
export const NeonScene: React.FC<NeonProps> = ({ theme, text, sub }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;

  return (
    <SceneFrame theme={theme} justify="center" align="center">
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `linear-gradient(${c.surface}66 1px, transparent 1px), linear-gradient(90deg, ${c.surface}66 1px, transparent 1px)`,
          backgroundSize: `${u(7)}px ${u(7)}px`,
          opacity: 0.4,
          maskImage: "radial-gradient(circle at 50% 50%, #000 30%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(circle at 50% 50%, #000 30%, transparent 75%)",
        }}
      />
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: u(2.6),
          opacity: enter.opacity,
        }}
      >
        <Editable id="text" title="霓虹字">
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(isPortrait ? 13 : 11),
              fontWeight: 900,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
              color: "#ffffff",
              textAlign: "center",
              textShadow: `0 0 ${u(1.2)}px #fff, 0 0 ${u(4)}px ${c.primary}, 0 0 ${u(9)}px ${c.primary}aa, 0 0 ${u(18)}px ${c.primary}66`,
              WebkitTextStroke: `${Math.max(1, u(0.12))}px ${c.primary}66`,
            }}
          >
            {text}
          </div>
        </Editable>
        {sub ? (
          <Editable id="sub" title="副标题">
            <div
              style={{
                fontFamily: theme.font.body,
                fontSize: h(2),
                letterSpacing: u(0.3),
                color: c.textMuted,
                textTransform: "uppercase",
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
