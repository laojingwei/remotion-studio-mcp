import React from "react";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type TagsProps = {
  theme: Theme;
  heading: string;
  items: string[];
};

/** 标签云：大小交错的标签，适合关键词/话题 */
export const TagsScene: React.FC<TagsProps> = ({ theme, heading, items }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: u(3),
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
                fontSize: h(isPortrait ? 4 : 4.6),
                fontWeight: 800,
                color: c.text,
              }}
            >
              {heading}
            </div>
          </Editable>
        ) : null}

        {/* 横屏：整行两端对齐铺满，标签云才像云；竖屏照旧左对齐流式排列 */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: u(1.4),
            rowGap: u(isPortrait ? 1.4 : 2.4),
            alignItems: "center",
            justifyContent: isPortrait ? "flex-start" : "space-between",
            width: isPortrait ? undefined : "100%",
          }}
        >
          {items.slice(0, 8).map((tag, i) => {
            const big = i % 3 === 0;
            return (
              <span
                key={`${tag}-${i}`}
                style={{
                  fontFamily: theme.font.heading,
                  fontSize: h(big ? (isPortrait ? 3.4 : 4.6) : isPortrait ? 2.2 : 3.0),
                  fontWeight: big ? 800 : 600,
                  color: big ? c.primary : c.text,
                  /**
                   * 两种大小必须有一样的「容器感」，否则拉开间距之后
                   * 小标签没有边、只剩几个散字，看着像排版没对齐。
                   * 所以小的也给一层浅底 + 极淡描边，只是不抢色。
                   */
                  background: big ? withColorAlpha(c.primary, 0.07) : c.surface,
                  border: `1px solid ${big ? c.primary : withColorAlpha(c.textMuted, 0.2)}`,
                  borderRadius: 999,
                  padding: `${u(big ? 1.1 : 0.9)}px ${u(big ? 2.6 : 2.2)}px`,
                  lineHeight: 1.2,
                  opacity: big ? 1 : 0.9,
                  whiteSpace: "nowrap",
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
