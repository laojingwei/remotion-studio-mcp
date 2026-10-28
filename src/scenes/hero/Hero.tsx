import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, Highlighted, SceneFrame, useEnter } from "../ui";

export type HeroProps = {
  theme: Theme;
  badge: string;
  title: string;
  subtitle: string;
  highlight: string;
};

/** 视觉封面：渐变光斑 + 超大标题，适合开场/产品发布 */
export const HeroScene: React.FC<HeroProps> = ({ theme, badge, title, subtitle, highlight }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle at 18% 12%, ${c.primary}33, transparent 52%), radial-gradient(circle at 88% 82%, ${c.secondary}22, transparent 48%)`,
        }}
      />
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: u(2.4),
          opacity: enter.opacity,
          transform: `translateY(${enter.y * u(1)}px)`,
        }}
      >
        {badge ? (
          <Editable id="badge" title="小标签">
            <span
              style={{
                fontFamily: theme.font.body,
                fontSize: h(1.7),
                letterSpacing: u(0.2),
                color: c.primary,
                fontWeight: 700,
              }}
            >
              {badge}
            </span>
          </Editable>
        ) : null}

        <Editable id="title" title="主标题">
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(isPortrait ? 9.5 : 7.6),
              fontWeight: 900,
              lineHeight: 1.04,
              letterSpacing: "-0.035em",
              color: c.text,
            }}
          >
            <Highlighted text={title} highlight={highlight} color={c.primary} />
          </div>
        </Editable>

        {subtitle ? (
          <Editable id="subtitle" title="副标题">
            <div
              style={{
                fontFamily: theme.font.body,
                fontSize: h(2.2),
                color: c.textMuted,
                maxWidth: isPortrait ? "100%" : "70%",
              }}
            >
              {subtitle}
            </div>
          </Editable>
        ) : null}
      </div>
    </SceneFrame>
  );
};
