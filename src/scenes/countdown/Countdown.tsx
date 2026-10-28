import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type CountdownProps = {
  theme: Theme;
  value: string;
  title: string;
  subtitle: string;
};

/** 倒计时/大数字：超大数字 + 说明，适合直播、促销 */
export const CountdownScene: React.FC<CountdownProps> = ({
  theme,
  value,
  title,
  subtitle,
}) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;

  return (
    <SceneFrame theme={theme} justify="center" align="center">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: u(2.4),
          opacity: enter.opacity,
          transform: `scale(${0.96 + enter.progress * 0.04})`,
        }}
      >
        <Editable id="value" title="大数字">
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(isPortrait ? 18 : 14),
              fontWeight: 900,
              lineHeight: 1,
              letterSpacing: "-0.04em",
              color: c.primary,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {value}
          </div>
        </Editable>
        <Editable id="title" title="标题">
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(3.4),
              fontWeight: 800,
              color: c.text,
            }}
          >
            {title}
          </div>
        </Editable>
        {subtitle ? (
          <Editable id="subtitle" title="说明">
            <div style={{ fontFamily: theme.font.body, fontSize: h(2), color: c.textMuted }}>
              {subtitle}
            </div>
          </Editable>
        ) : null}
      </div>
    </SceneFrame>
  );
};
