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
  /** stack = 编号在上、文字在下（横屏三栏对比用）；row = 编号在左（竖排列表用） */
  layout: "row" | "stack";
}> = ({ item, index, delay, theme, basis, layout }) => {
  const { u, h, b } = useSceneLayout();
  const e = useEnter(delay);
  const stacked = layout === "stack";
  return (
    <Editable
      id={`item${index + 1}`}
      title={`要点 ${index + 1}`}
      style={{
        display: "flex",
        flexDirection: stacked ? "column" : "row",
        alignItems: "flex-start",
        gap: stacked ? u(2.2) : u(2.4),
        flex: `1 1 ${basis}`,
        minWidth: 0,
        opacity: e.opacity,
        transform: `translateY(${e.y * u(1)}px)`,
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          width: u(stacked ? 6.4 : 5.6),
          height: u(stacked ? 6.4 : 5.6),
          borderRadius: u(1.2),
          background: theme.palette.surface,
          border: `1px solid ${theme.palette.primary}33`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: theme.font.heading,
          fontSize: h(stacked ? 2.2 : 1.9),
          fontWeight: 700,
          color: theme.palette.primary,
          letterSpacing: "0.02em",
        }}
      >
        {String(index + 1).padStart(2, "0")}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: u(stacked ? 1 : 0.7),
          paddingTop: stacked ? 0 : u(0.4),
          minWidth: 0,
        }}
      >
        <div
          style={{
            fontFamily: theme.font.heading,
            fontSize: h(stacked ? 3.4 : 3.1),
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
              fontSize: b(1.9),
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
  const { u, h, b, isPortrait } = useSceneLayout();
  const head = useEnter(0);

  const list = items ?? [];
  /**
   * 列数。竖屏永远单列（要点是顺着往下读的）。
   * 横屏按条数分：2 条 2 列、3 条 3 列、4 条 2×2、5 条以上 3 列。
   * 之前固定 2 列，3 条会排成 2+1，右下角空出半格，整页看着缺一块。
   */
  const columns = isPortrait
    ? 1
    : list.length <= 1
      ? 1
      : list.length === 4
        ? 2
        : Math.min(3, list.length);
  const colGap = u(isPortrait ? 0 : 5);
  const rowGap = u(columns >= 3 ? 5 : 3.4);
  const basis = `calc((100% - ${colGap * (columns - 1)}px) / ${columns})`;

  return (
    <SceneFrame theme={theme} justify="center">
      {heading ? (
        <Editable
          id="heading"
          title="小标题"
          style={{
            fontFamily: theme.font.heading,
            fontSize: b(isPortrait ? 2.2 : 2.0),
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
            layout={columns >= 3 ? "stack" : "row"}
          />
        ))}
      </div>
    </SceneFrame>
  );
};
