import React from "react";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type ListProps = {
  theme: Theme;
  heading: string;
  items: { title: string; note: string }[];
};

/** 单行：hooks 放在组件里，别在 map 里调用 useEnter */
const Row: React.FC<{
  theme: Theme;
  index: number;
  title: string;
  note: string;
  /** 横屏走「目录行」：注释推到右边缘，中间留白，上下加发丝线 */
  toc: boolean;
}> = ({ theme, index, title, note, toc }) => {
  const { u, h, b } = useSceneLayout();
  const row = useEnter(index * 5 + 6);

  return (
    <Editable
      id={`item${index + 1}`}
      title="条目"
      style={{
        display: "flex",
        alignItems: toc ? "center" : "baseline",
        gap: toc ? u(3.4) : u(2),
        width: "100%",
        paddingBottom: toc ? u(3.2) : 0,
        borderBottom: toc ? `1px solid ${withColorAlpha(theme.palette.textMuted, 0.16)}` : undefined,
        opacity: row.opacity,
        transform: `translateY(${row.y * u(0.8)}px)`,
      }}
    >
      <span
        style={{
          fontFamily: theme.font.heading,
          fontSize: h(toc ? 3.2 : 2.6),
          fontWeight: 800,
          color: theme.palette.primary,
          minWidth: u(toc ? 7 : 6),
          flex: "0 0 auto",
        }}
      >
        {String(index + 1).padStart(2, "0")}
      </span>
      <span
        style={{
          fontFamily: theme.font.heading,
          fontSize: h(toc ? 3.8 : 3.2),
          fontWeight: 700,
          color: theme.palette.text,
          flex: toc ? "0 1 auto" : undefined,
          minWidth: 0,
        }}
      >
        {title}
      </span>
      {toc ? <span style={{ flex: 1 }} /> : null}
      <span
        style={{
          fontFamily: theme.font.body,
          fontSize: b(toc ? 2.1 : 1.9),
          color: theme.palette.textMuted,
          flex: toc ? "0 1 auto" : undefined,
          textAlign: toc ? "right" : undefined,
          minWidth: 0,
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
  const toc = !isPortrait;

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: toc ? 0 : u(1.4),
          width: "100%",
          // 竖屏条目短，右侧会空一大块，限宽居中让两侧留白均匀。
          // 横屏相反：走目录行，注释顶到右边缘，越宽越像一份清单
          maxWidth: isPortrait ? "100%" : undefined,
          opacity: enter.opacity,
        }}
      >
        {heading ? (
          <Editable id="heading" title="标题">
            <div
              style={{
                fontFamily: theme.font.heading,
                fontSize: h(isPortrait ? 4.6 : 5.2),
                fontWeight: 800,
                color: theme.palette.text,
                marginBottom: toc ? u(3) : u(2),
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
            toc={toc}
          />
        ))}
      </div>
    </SceneFrame>
  );
};
