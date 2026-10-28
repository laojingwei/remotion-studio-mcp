import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type BarsProps = {
  theme: Theme;
  heading: string;
  items: { label: string; percent: number }[];
};

const Bar: React.FC<{ theme: Theme; index: number; label: string; percent: number }> = ({
  theme,
  index,
  label,
  percent,
}) => {
  const { u, h } = useSceneLayout();
  const enter = useEnter(index * 6 + 4);
  const pct = Math.max(0, Math.min(100, percent));
  const c = theme.palette;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: u(0.8), opacity: enter.opacity }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <Editable id={`label${index + 1}`} title="标签">
          <span style={{ fontFamily: theme.font.body, fontSize: h(1.9), color: c.text }}>{label}</span>
        </Editable>
        <span style={{ fontFamily: theme.font.heading, fontSize: h(1.9), color: c.primary, fontWeight: 700 }}>
          {pct}%
        </span>
      </div>
      <div style={{ height: u(1.6), borderRadius: 99, background: c.surface, overflow: "hidden" }}>
        <div
          style={{
            width: `${pct * enter.progress}%`,
            height: "100%",
            borderRadius: 99,
            background: `linear-gradient(90deg, ${c.primary}, ${c.secondary})`,
          }}
        />
      </div>
    </div>
  );
};

/** 进度条组：2-4 项进度，适合技能/完成度 */
export const BarsScene: React.FC<BarsProps> = ({ theme, heading, items }) => {
  const { u, h } = useSceneLayout();
  const enter = useEnter(0);

  return (
    <SceneFrame theme={theme} justify="center">
      <div style={{ display: "flex", flexDirection: "column", gap: u(2.6), width: "100%", opacity: enter.opacity }}>
        {heading ? (
          <Editable id="heading" title="标题">
            <div style={{ fontFamily: theme.font.heading, fontSize: h(4.2), fontWeight: 800, color: theme.palette.text }}>
              {heading}
            </div>
          </Editable>
        ) : null}

        {items.map((it, i) => (
          <Bar key={`${it.label}-${i}`} theme={theme} index={i} label={it.label} percent={it.percent} />
        ))}
      </div>
    </SceneFrame>
  );
};
