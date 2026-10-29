import React from "react";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { clampHeadSize } from "../../../shared/textFit";
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
  const { u, h, b, unit, width, headScale, safe, isPortrait } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;
  const n = Math.max(1, Math.min(5, Math.round(stars)));

  /**
   * 横屏把「原话」当主角：一句话按宽度定字号，最多两行铺满。
   *
   * 原来全片统一 2.8 单位，一句 25 字的评价只占 50% 宽，标题和星星都比它抢眼 ——
   * 证言页的重点是那句话本身。上限 6.4 是为了别让它大过标题页的标题。
   */
  const quoteSize = isPortrait
    ? 2.8
    : clampHeadSize(quote, (width - 2 * u(safe.x)) / 2, unit, headScale, 4.2, 6.4);

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: u(isPortrait ? 2.4 : 3.2),
          width: isPortrait ? undefined : "100%",
          opacity: enter.opacity,
          transform: `translateY(${enter.y * u(1)}px)`,
        }}
      >
        {heading ? (
          <Editable id="heading" title="标题">
            <div
              style={{
                fontFamily: theme.font.heading,
                fontSize: h(isPortrait ? 4 : 3.4),
                fontWeight: 800,
                color: c.textMuted,
                letterSpacing: u(0.06),
              }}
            >
              {heading}
            </div>
          </Editable>
        ) : null}

        <div style={{ display: "flex", gap: u(1), color: c.primary, fontSize: h(isPortrait ? 4.4 : 5), lineHeight: 1 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <span key={i} style={{ opacity: i < n ? 1 : 0.22 }}>
              ★
            </span>
          ))}
        </div>

        <Editable id="quote" title="评价">
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(quoteSize),
              fontWeight: 700,
              lineHeight: 1.34,
              letterSpacing: "-0.01em",
              color: c.text,
              maxWidth: isPortrait ? "100%" : "92%",
            }}
          >
            <span style={{ color: withColorAlpha(c.primary, 0.55) }}>“</span>
            {quote}
            <span style={{ color: withColorAlpha(c.primary, 0.55) }}>”</span>
          </div>
        </Editable>

        <Editable id="author" title="署名">
          <div style={{ fontFamily: theme.font.body, fontSize: b(isPortrait ? 1.8 : 2), color: c.textMuted }}>
            — {author}
          </div>
        </Editable>
      </div>
    </SceneFrame>
  );
};
