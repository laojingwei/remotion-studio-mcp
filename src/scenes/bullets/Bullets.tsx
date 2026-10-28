import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

type Item = { text: string; note: string };

const BulletRow: React.FC<{
  item: Item;
  index: number;
  delay: number;
  theme: Theme;
  basis: string;
}> = ({ item, index, delay, theme, basis }) => {
  const { u, h } = useSceneLayout();
  const e = useEnter(delay);
  return (
    <Editable
      id={`item${index + 1}`}
      title={`要点 ${index + 1}`}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: u(2.4),
        flex: `1 1 ${basis}`,
        minWidth: 0,
        opacity: e.opacity,
        transform: `translateY(${e.y * u(1)}px)`,
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          width: u(5.6),
          height: u(5.6),
          borderRadius: u(1.2),
          background: theme.palette.surface,
          border: `1px solid ${theme.palette.primary}33`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: theme.font.heading,
          fontSize: h(1.9),
          fontWeight: 700,
          color: theme.palette.primary,
          letterSpacing: "0.02em",
        }}
      >
        {String(index + 1).padStart(2, "0")}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: u(0.7), paddingTop: u(0.4) }}>
        <div
          style={{
            fontFamily: theme.font.heading,
            fontSize: h(3.1),
            lineHeight: 1.25,
            fontWeight: 600,
            color: theme.palette.text,
            letterSpacing: "-0.01em",
          }}
        >
          {item.text}
        </div>
        {item.note ? (
          <div
            style={{
              fontFamily: theme.font.body,
              fontSize: h(1.9),
              lineHeight: 1.5,
              color: theme.palette.textMuted,
            }}
          >
            {item.note}
          </div>
        ) : null}
      </div>
    </Editable>
  );
};

export type BulletsProps = {
  theme: Theme;
  heading: string;
  items: Item[];
};

export const BulletsScene: React.FC<BulletsProps> = ({ theme, heading, items }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const head = useEnter(0);

  const list = items ?? [];
  // 3 条以内竖排（要点本来就是从上往下读的），4 条起两列。
  // 用 flex 而不是 grid：最后一行只剩一条时它会被拉满整行，不会留孤儿格
  const columns = !isPortrait && list.length >= 3 ? 2 : 1;
  const colGap = u(isPortrait ? 0 : 5);
  const rowGap = u(3.4);
  const basis = `calc((100% - ${colGap * (columns - 1)}px) / ${columns})`;

  return (
    <SceneFrame theme={theme} justify="center">
      {heading ? (
        <Editable
          id="heading"
          title="小标题"
          style={{
            fontFamily: theme.font.heading,
            fontSize: h(isPortrait ? 2.2 : 2.0),
            letterSpacing: u(0.18),
            textTransform: "uppercase",
            color: theme.palette.primary,
            marginBottom: u(4),
            opacity: head.opacity,
            transform: `translateY(${head.y * u(1)}px)`,
          }}
        >
          {heading}
        </Editable>
      ) : null}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          columnGap: colGap,
          rowGap,
          width: "100%",
        }}
      >
        {list.map((item, i) => (
          <BulletRow
            key={i}
            item={item}
            index={i}
            delay={8 + i * 9}
            theme={theme}
            basis={basis}
          />
        ))}
      </div>
    </SceneFrame>
  );
};
