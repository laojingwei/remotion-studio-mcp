import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, Eyebrow, Highlighted, SceneFrame, useEnter } from "../ui";

export type TitleProps = {
  theme: Theme;
  eyebrow: string;
  title: string;
  subtitle: string;
  highlight: string;
  align: "left" | "center";
};

export const TitleScene: React.FC<TitleProps> = ({
  theme,
  eyebrow,
  title,
  subtitle,
  highlight,
  align,
}) => {
  const { u, h, isPortrait } = useSceneLayout();
  const a = useEnter(1);
  const b = useEnter(7);
  const c = useEnter(16);

  // 标题长了就自动降号，别让它折行把版式撑破
  const len = (title ?? "").length;
  const titleSize = len <= 8 ? 9.4 : len <= 12 ? 7.4 : len <= 18 ? 6.0 : 5.0;

  return (
    <SceneFrame theme={theme} align={align}>
      <Editable
        id="eyebrow"
        style={{ opacity: a.opacity, transform: `translateY(${a.y * u(1)}px)` }}
        title="顶部小标签"
      >
        <Eyebrow text={eyebrow} theme={theme} />
      </Editable>

      <Editable
        id="title"
        as="h1"
        title="主标题"
        style={{
          margin: 0,
          fontFamily: theme.font.heading,
          fontSize: h(isPortrait ? titleSize * 0.79 : titleSize),
          lineHeight: 1.08,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          color: theme.palette.text,
          maxWidth: isPortrait ? "100%" : "88%",
          opacity: b.opacity,
          transform: `translateY(${b.y * u(1)}px)`,
        }}
      >
        <Highlighted text={title} highlight={highlight} color={theme.palette.primary} />
      </Editable>

      {subtitle ? (
        <Editable
          id="subtitle"
          as="p"
          title="副标题"
          style={{
            margin: 0,
            marginTop: u(3.2),
            fontFamily: theme.font.body,
            fontSize: h(isPortrait ? 2.5 : 2.2),
            lineHeight: 1.5,
            color: theme.palette.textMuted,
            maxWidth: isPortrait ? "92%" : "62%",
            opacity: c.opacity,
            transform: `translateY(${c.y * u(1)}px)`,
          }}
        >
          {subtitle}
        </Editable>
      ) : null}
    </SceneFrame>
  );
};
