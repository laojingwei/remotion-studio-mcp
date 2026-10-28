import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type ListProps = {
  theme: Theme;
  heading: string;
  items: { title: string; note: string }[];
};

/** 单行：hooks 放在组件里，别在 map 里调用 useEnter */
const Row: React.FC<{ theme: Theme; index: number; title: string; note: string }> = ({
  theme,
  index,
  title,
  note,
}) => {
  const { u, h, isPortrait } = useSceneLayout();
  const row = useEnter(index * 5 + 6);

  return (
    <Editable
      id={`item${index + 1}`}
      title="条目"
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: u(2),
        opacity: row.opacity,
        transform: `translateY(${row.y * u(0.8)}px)`,
      }}
    >
      <span
        style={{
          fontFamily: theme.font.heading,
          fontSize: h(2.6),
          fontWeight: 800,
          color: theme.palette.primary,
          minWidth: u(6),
        }}
      >
        {String(index + 1).padStart(2, "0")}
      </span>
      <span
        style={{
          fontFamily: theme.font.heading,
          fontSize: h(3.2),
          fontWeight: 700,
          color: theme.palette.text,
        }}
      >
        {title}
      </span>
      <span
        style={{
          fontFamily: theme.font.body,
          fontSize: h(1.9),
          color: theme.palette.textMuted,
        }}
      >
        {note}
      </span>
    </Editable>
  );
};

/** 榜单/清单：带序号的条目，逐行入场 */
export const ListScene: React.FC<ListProps> = ({ theme, heading, items }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: u(1.4),
          width: "100%",
          // 横屏时条目短，右侧会空一大块：限宽居中，两侧留白均匀
          maxWidth: isPortrait ? "100%" : "82%",
          margin: isPortrait ? undefined : "0 auto",
          opacity: enter.opacity,
        }}
      >
        {heading ? (
          <Editable id="heading" title="标题">
            <div
              style={{
                fontFamily: theme.font.heading,
                fontSize: h(4.6),
                fontWeight: 800,
                color: theme.palette.text,
                marginBottom: u(2),
              }}
            >
              {heading}
            </div>
          </Editable>
        ) : null}

        {items.map((item, i) => (
          <Row
            key={`${item.title}-${i}`}
            theme={theme}
            index={i}
            title={item.title}
            note={item.note}
          />
        ))}
      </div>
    </SceneFrame>
  );
};
