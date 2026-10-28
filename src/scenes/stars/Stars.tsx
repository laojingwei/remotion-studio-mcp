import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type StarsProps = {
  theme: Theme;
  title: string;
  sub: string;
};

/** 星光页：散布星点 + 光晕，适合结尾/品牌 */
export const StarsScene: React.FC<StarsProps> = ({ theme, title, sub }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;

  // 固定伪随机星点，避免每帧抖动
  const stars = React.useMemo(
    () =>
      Array.from({ length: 34 }).map((_, i) => {
        const x = (i * 37) % 100;
        const y = (i * 53 + 11) % 100;
        const r = (i % 3) * 0.35 + 0.5;
        return { x, y, r, o: 0.25 + (i % 5) * 0.15 };
      }),
    [],
  );

  return (
    <SceneFrame theme={theme} justify="center" align="center">
      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(60% 45% at 50% 40%, ${c.primary}26, transparent 60%)`,
          }}
        />
        {stars.map((s, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${s.x}%`,
              top: `${s.y}%`,
              width: u(s.r),
              height: u(s.r),
              borderRadius: "50%",
              background: i % 4 === 0 ? c.primary : "#ffffff",
              opacity: s.o * (0.4 + enter.progress * 0.6),
              boxShadow: `0 0 ${u(1.2)}px ${i % 4 === 0 ? c.primary : "#ffffff"}`,
            }}
          />
        ))}
      </div>
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: u(2.2),
          opacity: enter.opacity,
          transform: `translateY(${enter.y * u(1)}px)`,
        }}
      >
        <Editable id="title" title="标题">
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(isPortrait ? 7.4 : 6),
              fontWeight: 900,
              letterSpacing: "-0.02em",
              color: c.text,
              textAlign: "center",
              textShadow: `0 0 ${u(4)}px ${c.primary}55`,
            }}
          >
            {title}
          </div>
        </Editable>
        {sub ? (
          <Editable id="sub" title="副标题">
            <div style={{ fontFamily: theme.font.body, fontSize: h(2), color: c.textMuted, textAlign: "center" }}>
              {sub}
            </div>
          </Editable>
        ) : null}
      </div>
    </SceneFrame>
  );
};
