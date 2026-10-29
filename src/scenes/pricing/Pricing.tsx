import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type PricingProps = {
  theme: Theme;
  heading: string;
  items: { name: string; price: string; note: string }[];
};

/** 价格表：2-3 档，中间那档高亮 */
export const PricingScene: React.FC<PricingProps> = ({ theme, heading, items }) => {
  const { u, h, b, isPortrait } = useSceneLayout();
  const enter = useEnter(0);
  const mid = Math.floor(items.length / 2);

  return (
    <SceneFrame theme={theme} justify="center">
      <div style={{ display: "flex", flexDirection: "column", gap: u(3), width: "100%", opacity: enter.opacity }}>
        {heading ? (
          <Editable id="heading" title="标题">
            <div style={{ fontFamily: theme.font.heading, fontSize: h(4.2), fontWeight: 800, color: theme.palette.text }}>
              {heading}
            </div>
          </Editable>
        ) : null}

        <div
          style={{
            display: "flex",
            flexDirection: isPortrait ? "column" : "row",
            gap: u(isPortrait ? 2 : 2.6),
            alignItems: "stretch",
          }}
        >
          {items.map((item, i) => {
            const highlight = i === mid;
            return (
              <Editable
                key={`${item.name}-${i}`}
                id={`item${i + 1}`}
                title="档位"
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  // 横屏给卡片一个高度，三段内容上下撑开：档名贴顶、价格居中、说明压底
                  justifyContent: isPortrait ? "flex-start" : "space-between",
                  gap: u(1),
                  minHeight: isPortrait ? undefined : u(32),
                  padding: u(isPortrait ? 2.4 : 3.2),
                  borderRadius: u(1.4),
                  border: `1px solid ${highlight ? theme.palette.primary : theme.palette.surface}`,
                  background: theme.palette.surface,
                  boxSizing: "border-box",
                }}
              >
                <span style={{ fontFamily: theme.font.body, fontSize: b(isPortrait ? 1.8 : 2.1), color: theme.palette.textMuted }}>
                  {item.name}
                </span>
                <span
                  style={{
                    fontFamily: theme.font.heading,
                    fontSize: h(highlight ? (isPortrait ? 5 : 6.6) : isPortrait ? 4 : 5.6),
                    fontWeight: 800,
                    lineHeight: 1.1,
                    color: highlight ? theme.palette.primary : theme.palette.text,
                  }}
                >
                  {item.price}
                </span>
                <span style={{ fontFamily: theme.font.body, fontSize: b(isPortrait ? 1.8 : 2.1), color: theme.palette.textMuted }}>
                  {item.note}
                </span>
              </Editable>
            );
          })}
        </div>
      </div>
    </SceneFrame>
  );
};
