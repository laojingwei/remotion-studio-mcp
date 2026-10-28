import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type SplitProps = {
  theme: Theme;
  title: string;
  text: string;
  imageSrc: string;
};

/** 图文分栏：竖屏上图下文，横屏左文右图；没有图就用渐变块占位 */
export const SplitScene: React.FC<SplitProps> = ({ theme, title, text, imageSrc }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;

  const visual = (
    <div
      style={{
        flex: 1,
        minHeight: isPortrait ? u(48) : 0,
        borderRadius: u(2),
        overflow: "hidden",
        background: imageSrc
          ? undefined
          : `linear-gradient(135deg, ${c.primary}33, ${c.secondary}22)`,
        border: `1px solid ${c.surface}`,
        display: "grid",
        placeItems: "center",
      }}
    >
      {imageSrc ? (
        <img src={imageSrc} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <span
          style={{
            fontFamily: theme.font.body,
            fontSize: h(1.8),
            color: c.textMuted,
            letterSpacing: u(0.1),
          }}
        >
          IMAGE
        </span>
      )}
    </div>
  );

  const copy = (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: u(2),
        justifyContent: "center",
      }}
    >
      <Editable id="title" title="标题">
        <div
          style={{
            fontFamily: theme.font.heading,
            fontSize: h(isPortrait ? 5.4 : 4.6),
            fontWeight: 800,
            lineHeight: 1.18,
            color: c.text,
          }}
        >
          {title}
        </div>
      </Editable>
      <Editable id="text" title="正文">
        <div
          style={{
            fontFamily: theme.font.body,
            fontSize: h(2.1),
            lineHeight: 1.6,
            color: c.textMuted,
          }}
        >
          {text}
        </div>
      </Editable>
    </div>
  );

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          display: "flex",
          flexDirection: isPortrait ? "column" : "row",
          gap: u(3),
          width: "100%",
          opacity: enter.opacity,
          transform: `translateY(${enter.y * u(1)}px)`,
        }}
      >
        {isPortrait ? (
          <>
            {visual}
            {copy}
          </>
        ) : (
          <>
            {copy}
            {visual}
          </>
        )}
      </div>
    </SceneFrame>
  );
};
