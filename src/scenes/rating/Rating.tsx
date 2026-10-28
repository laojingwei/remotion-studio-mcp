import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type RatingProps = {
  theme: Theme;
  heading: string;
  quote: string;
  author: string;
  stars: number;
};

/** 星级评价：星星 + 用户原话 */
export const RatingScene: React.FC<RatingProps> = ({ theme, heading, quote, author, stars }) => {
  const { u, h } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;
  const n = Math.max(1, Math.min(5, Math.round(stars)));

  return (
    <SceneFrame theme={theme} justify="center">
      <div style={{ display: "flex", flexDirection: "column", gap: u(2.4), opacity: enter.opacity, transform: `translateY(${enter.y * u(1)}px)` }}>
        {heading ? (
          <Editable id="heading" title="标题">
            <div style={{ fontFamily: theme.font.heading, fontSize: h(4), fontWeight: 800, color: c.text }}>
              {heading}
            </div>
          </Editable>
        ) : null}

        <div style={{ display: "flex", gap: u(1), color: c.primary, fontSize: h(4.4), lineHeight: 1 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <span key={i} style={{ opacity: i < n ? 1 : 0.22 }}>★</span>
          ))}
        </div>

        <Editable id="quote" title="评价">
          <div style={{ fontFamily: theme.font.heading, fontSize: h(2.8), lineHeight: 1.45, color: c.text }}>
            “{quote}”
          </div>
        </Editable>

        <Editable id="author" title="署名">
          <div style={{ fontFamily: theme.font.body, fontSize: h(1.8), color: c.textMuted }}>— {author}</div>
        </Editable>
      </div>
    </SceneFrame>
  );
};
