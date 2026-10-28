import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, Highlighted, SceneFrame, useEnter } from "../ui";

export type AuroraProps = {
  theme: Theme;
  badge: string;
  title: string;
  subtitle: string;
  highlight: string;
};

/** 极光封面：多层径向光斑铺底，像霓虹云雾 */
export const AuroraScene: React.FC<AuroraProps> = ({ theme, badge, title, subtitle, highlight }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: [
            `radial-gradient(62% 46% at 18% 8%, ${c.primary}4d, transparent 62%)`,
            `radial-gradient(54% 42% at 88% 18%, ${c.secondary}40, transparent 60%)`,
            `radial-gradient(70% 55% at 70% 96%, ${c.primary}2b, transparent 58%)`,
            `radial-gradient(40% 30% at 45% 55%, ${c.secondary}1f, transparent 70%)`,
          ].join(", "),
        }}
      />
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: u(2.2),
          opacity: enter.opacity,
          transform: `translateY(${enter.y * u(1)}px)`,
        }}
      >
        {badge ? (
          <Editable id="badge" title="小标签">
            <span
              style={{
                fontFamily: theme.font.body,
                fontSize: h(1.6),
                letterSpacing: u(0.22),
                color: c.primary,
                fontWeight: 700,
                textShadow: `0 0 ${u(2)}px ${c.primary}88`,
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
              fontSize: h(isPortrait ? 8.6 : 7),
              fontWeight: 900,
              lineHeight: 1.06,
              letterSpacing: "-0.03em",
              color: c.text,
              textShadow: `0 0 ${u(3)}px ${c.primary}40`,
            }}
          >
            <Highlighted text={title} highlight={highlight} color={c.primary} />
          </div>
        </Editable>
        {subtitle ? (
          <Editable id="subtitle" title="副标题">
            <div style={{ fontFamily: theme.font.body, fontSize: h(2.1), color: c.textMuted }}>{subtitle}</div>
          </Editable>
        ) : null}
      </div>
    </SceneFrame>
  );
};
