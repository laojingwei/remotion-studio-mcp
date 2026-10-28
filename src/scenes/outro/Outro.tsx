import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, Eyebrow, SceneFrame, useEnter } from "../ui";

export type OutroProps = {
  theme: Theme;
  eyebrow?: string;
  title: string;
  action: string;
  handle: string;
};

export const OutroScene: React.FC<OutroProps> = ({ theme, eyebrow = "THE END", title, action, handle }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = useEnter(0);
  const b = useEnter(10);
  const c = useEnter(18);

  // 呼吸感的强调块
  const pulse = interpolate(Math.sin((frame / fps) * Math.PI * 0.6), [-1, 1], [0.65, 1]);

  return (
    <SceneFrame theme={theme} align="center" justify="center">
      <Editable
        id="eyebrow"
        title="顶部小标签"
        style={{ opacity: a.opacity, transform: `translateY(${a.y * u(1)}px)` }}
      >
        <Eyebrow text={eyebrow} theme={theme} />
      </Editable>

      <Editable
        id="title"
        title="主标题"
        style={{
          fontFamily: theme.font.heading,
          fontSize: h(isPortrait ? 8.2 : 9.6),
          fontWeight: 700,
          letterSpacing: "-0.025em",
          lineHeight: 1.1,
          color: theme.palette.text,
          opacity: b.opacity,
          transform: `translateY(${b.y * u(1)}px)`,
          maxWidth: isPortrait ? "96%" : "76%",
        }}
      >
        {title}
      </Editable>

      <div
        style={{
          marginTop: u(2.6),
          width: u(9),
          height: Math.max(3, u(0.5)),
          borderRadius: 99,
          background: theme.palette.primary,
          opacity: b.progress * pulse,
          transform: `scaleX(${b.progress})`,
        }}
      />

      {action ? (
        <Editable
          id="action"
          title="行动号召"
          style={{
            marginTop: u(3),
            fontFamily: theme.font.body,
            fontSize: h(2.3),
            color: theme.palette.textMuted,
            opacity: c.opacity,
          }}
        >
          {action}
        </Editable>
      ) : null}

      {handle ? (
        <div
          style={{
            marginTop: u(4.2),
            padding: `${u(1.2)}px ${u(2.8)}px`,
            borderRadius: 99,
            border: `1px solid ${theme.palette.textMuted}44`,
            fontFamily: theme.font.heading,
            fontSize: h(1.8),
            letterSpacing: u(0.08),
            color: theme.palette.text,
            opacity: c.opacity,
          }}
        >
          {handle}
        </div>
      ) : null}
    </SceneFrame>
  );
};
