import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type CardsProps = {
  theme: Theme;
  heading: string;
  items: { title: string; desc: string }[];
};

const Card: React.FC<{
  theme: Theme;
  index: number;
  title: string;
  desc: string;
  basis: string;
}> = ({ theme, index, title, desc, basis }) => {
  const { u, h } = useSceneLayout();
  const enter = useEnter(index * 6 + 4);
  const c = theme.palette;

  return (
    <Editable
      id={`item${index + 1}`}
      title="卡片"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: u(1),
        padding: u(2.2),
        borderRadius: u(1.6),
        border: `1px solid ${c.surface}`,
        background: c.surface,
        // flex-basis 给出每列宽度；最后一行只剩一张时它会被拉满整行
        flex: `1 1 ${basis}`,
        minWidth: 0,
        boxSizing: "border-box",
        opacity: enter.opacity,
        transform: `translateY(${enter.y * u(1)}px)`,
      }}
    >
      <span
        style={{
          display: "grid",
          placeItems: "center",
          width: u(5),
          height: u(5),
          borderRadius: u(1.2),
          background: `${c.primary}22`,
          color: c.primary,
          fontFamily: theme.font.heading,
          fontSize: h(2.2),
          fontWeight: 800,
        }}
      >
        {index + 1}
      </span>
      <span
        style={{
          fontFamily: theme.font.heading,
          fontSize: h(2.7),
          fontWeight: 700,
          color: c.text,
          lineHeight: 1.3,
        }}
      >
        {title}
      </span>
      <span
        style={{
          fontFamily: theme.font.body,
          fontSize: h(1.85),
          color: c.textMuted,
          lineHeight: 1.5,
        }}
      >
        {desc}
      </span>
    </Editable>
  );
};

/**
 * 列数：3 张排一行（不再 2+1 留个空格子），4 张排 2×2，更多按 3 列。
 */
const columnCount = (n: number) => {
  if (n <= 3) return Math.max(1, n);
  return n % 3 === 1 ? 2 : 3;
};

/** 卡片网格：2-4 张卡片，带序号图标 */
export const CardsScene: React.FC<CardsProps> = ({ theme, heading, items }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);

  const list = items ?? [];
  const cols = isPortrait ? 1 : columnCount(list.length);
  const gap = u(2);
  const basis = `calc((100% - ${gap * (cols - 1)}px) / ${cols})`;

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: u(2.6),
          width: "100%",
          opacity: enter.opacity,
        }}
      >
        {heading ? (
          <Editable id="heading" title="标题">
            <div
              style={{
                fontFamily: theme.font.heading,
                fontSize: h(4.4),
                fontWeight: 800,
                color: theme.palette.text,
              }}
            >
              {heading}
            </div>
          </Editable>
        ) : null}

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap,
            width: "100%",
          }}
        >
          {list.map((item, i) => (
            <Card
              key={`${item.title}-${i}`}
              theme={theme}
              index={i}
              title={item.title}
              desc={item.desc}
              basis={basis}
            />
          ))}
        </div>
      </div>
    </SceneFrame>
  );
};
