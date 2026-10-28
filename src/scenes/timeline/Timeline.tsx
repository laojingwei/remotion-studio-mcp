import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type TimelineProps = {
  theme: Theme;
  heading: string;
  items: { time: string; text: string }[];
};

/** 单个节点：hooks 放在组件里，别在 map 里调用 useEnter */
const Node: React.FC<{
  theme: Theme;
  index: number;
  time: string;
  text: string;
  horizontal: boolean;
}> = ({ theme, index, time, text, horizontal }) => {
  const { u, h } = useSceneLayout();
  const node = useEnter(index * 6 + 4);

  if (horizontal) {
    // 横屏：节点横着排，中间一条贯穿的轨道 + 圆点
    return (
      <Editable
        id={`item${index + 1}`}
        title="节点"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: u(1.2),
          flex: "1 1 0",
          minWidth: 0,
          opacity: node.opacity,
        }}
      >
        <span
          style={{
            fontFamily: theme.font.body,
            fontSize: h(1.8),
            color: theme.palette.primary,
            fontWeight: 700,
            letterSpacing: u(0.06),
          }}
        >
          {time}
        </span>
        <span style={{ position: "relative", display: "block", height: u(1.4) }}>
          <span
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: u(1.3),
              height: u(1.3),
              borderRadius: 99,
              background: theme.palette.primary,
            }}
          />
        </span>
        <span
          style={{
            fontFamily: theme.font.heading,
            fontSize: h(2.6),
            color: theme.palette.text,
            lineHeight: 1.35,
          }}
        >
          {text}
        </span>
      </Editable>
    );
  }

  return (
    <Editable
      id={`item${index + 1}`}
      title="节点"
      style={{ display: "flex", flexDirection: "column", gap: u(0.5), opacity: node.opacity }}
    >
      <span
        style={{
          fontFamily: theme.font.body,
          fontSize: h(1.8),
          color: theme.palette.primary,
          fontWeight: 700,
          letterSpacing: u(0.06),
        }}
      >
        {time}
      </span>
      <span
        style={{
          fontFamily: theme.font.heading,
          fontSize: h(2.8),
          color: theme.palette.text,
          lineHeight: 1.35,
        }}
      >
        {text}
      </span>
    </Editable>
  );
};

/** 时间线：横屏横排（占满画面宽度）、竖屏竖排 */
export const TimelineScene: React.FC<TimelineProps> = ({ theme, heading, items }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);
  const horizontal = !isPortrait;

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: u(2),
          width: "100%",
          opacity: enter.opacity,
        }}
      >
        {heading ? (
          <Editable id="heading" title="标题">
            <div
              style={{
                fontFamily: theme.font.heading,
                fontSize: h(4.2),
                fontWeight: 800,
                color: theme.palette.text,
                marginBottom: u(1.6),
              }}
            >
              {heading}
            </div>
          </Editable>
        ) : null}

        {horizontal ? (
          <div style={{ position: "relative", display: "flex", flexDirection: "row", gap: u(3) }}>
            {/* 贯穿的横向轨道，落在圆点上 */}
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: `calc(${u(2.9)}px)`,
                height: Math.max(2, u(0.16)),
                background: theme.palette.surface,
              }}
            />
            {items.map((item, i) => (
              <Node
                key={`${item.time}-${i}`}
                theme={theme}
                index={i}
                time={item.time}
                text={item.text}
                horizontal
              />
            ))}
          </div>
        ) : (
          <div
            style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              gap: u(2.4),
              paddingLeft: u(3.4),
            }}
          >
            <div
              style={{
                position: "absolute",
                left: u(1.1),
                top: u(1),
                bottom: u(1),
                width: Math.max(2, u(0.3)),
                background: theme.palette.surface,
                borderRadius: 99,
              }}
            />
            {items.map((item, i) => (
              <Node
                key={`${item.time}-${i}`}
                theme={theme}
                index={i}
                time={item.time}
                text={item.text}
                horizontal={false}
              />
            ))}
          </div>
        )}
      </div>
    </SceneFrame>
  );
};
