import React from "react";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { clampHeadSize } from "../../../shared/textFit";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, Highlighted, SceneFrame, useEnter } from "../ui";

export type HeroProps = {
  theme: Theme;
  badge: string;
  title: string;
  subtitle: string;
  highlight: string;
};

/** 视觉封面：渐变光斑 + 超大标题，适合开场/产品发布 */
export const HeroScene: React.FC<HeroProps> = ({ theme, badge, title, subtitle, highlight }) => {
  const { u, h, b, unit, width, headScale, safe, isPortrait } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;

  /**
   * 横屏 = 报头 / 满宽标题 / 页脚，和题材封面（showcase）同一套骨架。
   * 竖屏仍是原来的「标签—标题—副标题」竖排。
   *
   * 原来横屏只把标题从 9.5 降到 7.6，其余照旧，结果整块内容 35% 宽、
   * 右边三分之二黑着 —— 问题不在字号，在没有一条横贯的元素。
   */
  const size = isPortrait
    ? 9.5
    : clampHeadSize(title, width - 2 * u(safe.x), unit, headScale, 5.2, 12.6);

  const heading = (
    <Editable id="title" title="主标题">
      <div
        style={{
          fontFamily: theme.font.heading,
          fontSize: h(size),
          fontWeight: 900,
          lineHeight: 1.04,
          letterSpacing: "-0.035em",
          color: c.text,
        }}
      >
        <Highlighted text={title} highlight={highlight} color={c.primary} />
      </div>
    </Editable>
  );

  const glow = (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: `radial-gradient(circle at 18% 12%, ${c.primary}33, transparent 52%), radial-gradient(circle at 88% 82%, ${c.secondary}22, transparent 48%)`,
      }}
    />
  );

  if (!isPortrait) {
    return (
      <SceneFrame theme={theme} justify="start">
        {glow}
        <div
          style={{
            position: "relative",
            flex: 1,
            width: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            opacity: enter.opacity,
            transform: `translateY(${enter.y * u(1)}px)`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: u(2.6) }}>
            {badge ? (
              <Editable id="badge" title="小标签">
                <span
                  style={{
                    fontFamily: theme.font.body,
                    fontSize: b(1.7),
                    letterSpacing: u(0.2),
                    color: c.primary,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  {badge}
                </span>
              </Editable>
            ) : null}
            <div
              style={{
                flex: 1,
                height: Math.max(1, u(0.16)),
                background: `linear-gradient(90deg, ${withColorAlpha(c.primary, 0.7)}, ${withColorAlpha(c.primary, 0.06)})`,
              }}
            />
          </div>

          {heading}

          <div style={{ minHeight: u(1) }}>
            {subtitle ? (
              <Editable id="subtitle" title="副标题">
                <div
                  style={{
                    fontFamily: theme.font.body,
                    fontSize: b(2.4),
                    lineHeight: 1.55,
                    color: c.textMuted,
                    maxWidth: "64%",
                  }}
                >
                  {subtitle}
                </div>
              </Editable>
            ) : null}
          </div>
        </div>
      </SceneFrame>
    );
  }

  return (
    <SceneFrame theme={theme} justify="center">
      {glow}
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: u(2.4),
          opacity: enter.opacity,
          transform: `translateY(${enter.y * u(1)}px)`,
        }}
      >
        {badge ? (
          <Editable id="badge" title="小标签">
            <span
              style={{
                fontFamily: theme.font.body,
                fontSize: h(1.7),
                letterSpacing: u(0.2),
                color: c.primary,
                fontWeight: 700,
              }}
            >
              {badge}
            </span>
          </Editable>
        ) : null}

        {heading}

        {subtitle ? (
          <Editable id="subtitle" title="副标题">
            <div
              style={{
                fontFamily: theme.font.body,
                fontSize: h(2.2),
                color: c.textMuted,
                maxWidth: "100%",
              }}
            >
              {subtitle}
            </div>
          </Editable>
        ) : null}
      </div>
    </SceneFrame>
  );
};
