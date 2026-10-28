import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

/** 题材场景的装饰色：不同题材一眼能区分 */
const ACCENTS: Record<string, string> = {
  life: "#F2C46D",
  game: "#7CE0FF",
  tech: "#8B7CFF",
  edu: "#FFB347",
  live: "#FF6B81",
  shop: "#C6F24E",
};

const BADGES: Record<string, string> = {
  life: "VLOG",
  game: "GAME",
  tech: "TECH",
  edu: "COURSE",
  live: "LIVE",
  shop: "SHOP",
};

export type ShowcaseProps = {
  theme: Theme;
  /** 场景类型，用来选装饰色/默认标签 */
  type?: string;
  badge?: string;
  title: string;
  subtitle?: string;
  items?: string[];
};

/** 题材场景：生活 / 游戏 / 科技 / 教学 / 直播 / 电商共用一套版式，配色区分 */
export const ShowcaseScene: React.FC<ShowcaseProps> = ({
  theme,
  type = "life",
  badge,
  title,
  subtitle,
  items = [],
}) => {
  const { u, h, isPortrait } = useSceneLayout();
  const accent = ACCENTS[type] ?? theme.palette.primary;
  const label = badge || BADGES[type] || "";
  const enter = useEnter(0);

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: u(2.2),
          opacity: enter.opacity,
          transform: `translateY(${enter.y * u(1)}px)`,
        }}
      >
        {label ? (
          <span
            style={{
              fontFamily: theme.font.body,
              fontSize: h(1.7),
              letterSpacing: u(0.16),
              color: accent,
              fontWeight: 700,
            }}
          >
            {label}
          </span>
        ) : null}

        <Editable id="title" title="主标题">
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(isPortrait ? 6.0 : 4.8),
              fontWeight: 800,
              lineHeight: 1.2,
              color: theme.palette.text,
              letterSpacing: "-0.02em",
            }}
          >
            {title}
          </div>
        </Editable>

        {subtitle ? (
          <Editable id="subtitle" title="副标题">
            <div
              style={{
                fontFamily: theme.font.body,
                fontSize: h(2.1),
                color: theme.palette.textMuted,
                letterSpacing: u(0.02),
              }}
            >
              {subtitle}
            </div>
          </Editable>
        ) : null}

        {items.length ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: u(1.2),
              marginTop: u(1.4),
            }}
          >
            {items.slice(0, 4).map((item, i) => (
              <Editable key={`${item}-${i}`} id={`item${i + 1}`} title="标签">
                <span
                  style={{
                    display: "inline-block",
                    fontFamily: theme.font.body,
                    fontSize: h(1.8),
                    color: accent,
                    border: `1px solid ${accent}`,
                    borderRadius: 999,
                    padding: `${u(0.8)}px ${u(1.7)}px`,
                    opacity: 0.9,
                  }}
                >
                  {item}
                </span>
              </Editable>
            ))}
          </div>
        ) : null}
      </div>
    </SceneFrame>
  );
};
