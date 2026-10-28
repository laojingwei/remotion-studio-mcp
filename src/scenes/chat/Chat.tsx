import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type ChatProps = {
  theme: Theme;
  heading: string;
  messages: { side: "left" | "right"; text: string }[];
};

const Bubble: React.FC<{
  theme: Theme;
  index: number;
  side: "left" | "right";
  text: string;
}> = ({ theme, index, side, text }) => {
  const { u, h } = useSceneLayout();
  const enter = useEnter(index * 5 + 3);
  const c = theme.palette;
  const right = side === "right";

  return (
    <Editable
      id={`msg${index + 1}`}
      title="消息"
      style={{
        alignSelf: right ? "flex-end" : "flex-start",
        maxWidth: "82%",
        padding: `${u(1.4)}px ${u(2)}px`,
        borderRadius: u(1.6),
        borderBottomRightRadius: right ? u(0.4) : u(1.6),
        borderBottomLeftRadius: right ? u(1.6) : u(0.4),
        background: right ? c.primary : c.surface,
        color: right ? c.background : c.text,
        fontFamily: theme.font.body,
        fontSize: h(2),
        lineHeight: 1.5,
        opacity: enter.opacity,
        transform: `translateY(${enter.y * u(1)}px)`,
      }}
    >
      {text}
    </Editable>
  );
};

/** 对话气泡：像聊天记录，适合教学/答疑/生活 */
export const ChatScene: React.FC<ChatProps> = ({ theme, heading, messages }) => {
  const { u, h } = useSceneLayout();
  const enter = useEnter(0);

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: u(1.6),
          width: "100%",
          opacity: enter.opacity,
        }}
      >
        {heading ? (
          <Editable id="heading" title="标题">
            <div
              style={{
                fontFamily: theme.font.heading,
                fontSize: h(3.6),
                fontWeight: 800,
                color: theme.palette.text,
                marginBottom: u(1.4),
              }}
            >
              {heading}
            </div>
          </Editable>
        ) : null}

        {messages.map((m, i) => (
          <Bubble
            key={`${m.text}-${i}`}
            theme={theme}
            index={i}
            side={m.side}
            text={m.text}
          />
        ))}
      </div>
    </SceneFrame>
  );
};
