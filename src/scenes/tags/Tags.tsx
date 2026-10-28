import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type TagsProps = {
  theme: Theme;
  heading: string;
  items: string[];
};

/** 标签云：大小交错的标签，适合关键词/话题 */
export const TagsScene: React.FC<TagsProps> = ({ theme, heading, items }) => {
  const { u, h } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;

  return (
    <SceneFrame theme={theme} justify="center">
      <div style={{ display: "flex", flexDirection: "column", gap: u(3), opacity: enter.opacity, transform: `translateY(${enter.y * u(1)}px)` }}>
        {heading ? (
          <Editable id="heading" title="标题">
            <div style={{ fontFamily: theme.font.heading, fontSize: h(4), fontWeight: 800, color: c.text }}>
              {heading}
            </div>
          </Editable>
        ) : null}

        <div style={{ display: "flex", flexWrap: "wrap", gap: u(1.4), alignItems: "center" }}>
          {items.slice(0, 8).map((tag, i) => {
            const big = i % 3 === 0;
            return (
              <span
                key={`${tag}-${i}`}
                style={{
                  fontFamily: theme.font.heading,
                  fontSize: h(big ? 3.4 : 2.2),
                  fontWeight: big ? 800 : 600,
                  color: big ? c.primary : c.text,
                  border: `1px solid ${big ? c.primary : c.surface}`,
                  borderRadius: 999,
                  padding: `${u(0.9)}px ${u(2.2)}px`,
                  lineHeight: 1.2,
                  opacity: big ? 1 : 0.85,
                }}
              >
                {tag}
              </span>
            );
          })}
        </div>
      </div>
    </SceneFrame>
  );
};
