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
  const { u, h, isPortrait } = useSceneLayout();
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

        <div style={{ display: "flex", flexDirection: isPortrait ? "column" : "row", gap: u(2), alignItems: "stretch" }}>
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
                  gap: u(1),
                  padding: u(2.4),
                  borderRadius: u(1.4),
                  border: `1px solid ${highlight ? theme.palette.primary : theme.palette.surface}`,
                  background: theme.palette.surface,
                }}
              >
                <span style={{ fontFamily: theme.font.body, fontSize: h(1.8), color: theme.palette.textMuted }}>{item.name}</span>
                <span style={{ fontFamily: theme.font.heading, fontSize: h(highlight ? 5 : 4), fontWeight: 800, color: highlight ? theme.palette.primary : theme.palette.text }}>
                  {item.price}
                </span>
                <span style={{ fontFamily: theme.font.body, fontSize: h(1.8), color: theme.palette.textMuted }}>{item.note}</span>
              </Editable>
            );
          })}
        </div>
      </div>
    </SceneFrame>
  );
};
