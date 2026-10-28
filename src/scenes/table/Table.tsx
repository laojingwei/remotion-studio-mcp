import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type TableProps = {
  theme: Theme;
  heading: string;
  columns?: string[];
  rows: { a: string; b: string; c: string }[];
};

/** 数据表：3 列 2-3 行，适合对比/参数 */
export const TableScene: React.FC<TableProps> = ({ theme, heading, columns, rows }) => {
  const { u, h } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;
  const cell = { fontFamily: theme.font.body, fontSize: h(1.85), color: c.text } as const;
  const headCell = { ...cell, color: c.textMuted, fontSize: h(1.6) } as const;

  // 表头可配；缺省沿用原来的三列
  const head = columns && columns.length === 3 ? columns : ["项目", "基础版", "进阶版"];

  return (
    <SceneFrame theme={theme} justify="center">
      <div style={{ display: "flex", flexDirection: "column", gap: u(2.2), width: "100%", opacity: enter.opacity }}>
        {heading ? (
          <Editable id="heading" title="标题">
            <div style={{ fontFamily: theme.font.heading, fontSize: h(4.2), fontWeight: 800, color: c.text }}>
              {heading}
            </div>
          </Editable>
        ) : null}

        <div style={{ border: `1px solid ${c.surface}`, borderRadius: u(1.2), overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", background: c.surface }}>
            <div style={{ ...headCell, padding: u(1.6) }}>{head[0]}</div>
            <div style={{ ...headCell, padding: u(1.6) }}>{head[1]}</div>
            <div style={{ ...headCell, padding: u(1.6), color: c.primary }}>{head[2]}</div>
          </div>
          {rows.map((row, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "1.2fr 1fr 1fr",
                borderTop: `1px solid ${c.surface}`,
                opacity: 1,
              }}
            >
              <Editable id={`row${i + 1}a`} title="第一列">
                <div style={{ ...cell, padding: u(1.6) }}>{row.a}</div>
              </Editable>
              <Editable id={`row${i + 1}b`} title="第二列">
                <div style={{ ...cell, padding: u(1.6), color: c.textMuted }}>{row.b}</div>
              </Editable>
              <Editable id={`row${i + 1}c`} title="第三列">
                <div style={{ ...cell, padding: u(1.6), color: c.primary }}>{row.c}</div>
              </Editable>
            </div>
          ))}
        </div>
      </div>
    </SceneFrame>
  );
};
