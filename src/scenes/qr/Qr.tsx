import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type QrProps = {
  theme: Theme;
  heading: string;
  sub: string;
  qrText: string;
};

/** 关注页：二维码占位 + 引导文案 */
export const QrScene: React.FC<QrProps> = ({ theme, heading, sub, qrText }) => {
  const { u, h } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;
  const size = u(30);

  return (
    <SceneFrame theme={theme} justify="center" align="center">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: u(2.4),
          opacity: enter.opacity,
          transform: `translateY(${enter.y * u(1)}px)`,
        }}
      >
        <div
          style={{
            width: size,
            height: size,
            borderRadius: u(1.6),
            background: "#fff",
            display: "grid",
            placeItems: "center",
            padding: u(2.4),
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              borderRadius: u(0.8),
              background: `repeating-conic-gradient(#111 0 25%, #fff 0 50%) 0 0 / ${u(2.4)}px ${u(2.4)}px`,
              opacity: 0.85,
            }}
          />
        </div>
        <Editable id="heading" title="标题">
          <div style={{ fontFamily: theme.font.heading, fontSize: h(3.4), fontWeight: 800, color: c.text }}>
            {heading}
          </div>
        </Editable>
        <Editable id="sub" title="说明">
          <div style={{ fontFamily: theme.font.body, fontSize: h(1.9), color: c.textMuted }}>{sub}</div>
        </Editable>
        <Editable id="qrText" title="底部小字">
          <div style={{ fontFamily: theme.font.body, fontSize: h(1.6), color: c.primary, letterSpacing: u(0.12) }}>
            {qrText}
          </div>
        </Editable>
      </div>
    </SceneFrame>
  );
};
