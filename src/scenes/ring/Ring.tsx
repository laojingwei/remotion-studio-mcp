import React from "react";
import type { Theme } from "../../../shared/schema";
import { parseNumeric } from "../../../shared/numeric";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, scaleNumericText, useCountUp, useEnter } from "../ui";

export type RingProps = {
  theme: Theme;
  heading: string;
  percent: string;
  label: string;
  sub: string;
};

/** 环形数据：大圆环展示百分比，适合成果/进度 */
export const RingScene: React.FC<RingProps> = ({ theme, heading, percent, label, sub }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;
  // percent 是字符串字段，用户会写成「72%」；直接 Number() 会得到 NaN，
  // 圆环填 0 而数字照旧显示 72% —— 图和字对不上（见 shared/numeric.ts parseNumeric）
  const pct = Math.max(0, Math.min(100, parseNumeric(percent, 0)));
  // 显示时去掉用户自己写的 %，组件统一补一个带色的小 %（否则就是 72%%）
  const shown = String(percent ?? "").replace(/%/g, "").trim();
  // 环形填充与中间的数字一起从 0 涨到目标值（motion=0 时 useCountUp 直接返回目标值）
  const pctNow = useCountUp(pct, 8);
  const growRatio = pct > 0 ? Math.min(1, pctNow / pct) : 1;
  const size = u(isPortrait ? 52 : 44);

  return (
    <SceneFrame theme={theme} justify="center" align="center">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: u(3),
          width: "100%",
          opacity: enter.opacity,
          transform: `translateY(${enter.y * u(1)}px)`,
        }}
      >
        {heading ? (
          <Editable id="heading" title="标题">
            <div
              style={{
                fontFamily: theme.font.heading,
                fontSize: h(3.8),
                fontWeight: 800,
                color: c.text,
              }}
            >
              {heading}
            </div>
          </Editable>
        ) : null}

        <div style={{ position: "relative", width: size, height: size }}>
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              background: `conic-gradient(${c.primary} ${pctNow}%, ${c.surface} 0)`,
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: u(4),
              borderRadius: "50%",
              background: c.background,
              display: "grid",
              placeItems: "center",
            }}
          >
            <Editable id="percent" title="百分比">
              <span
                style={{
                  fontFamily: theme.font.heading,
                  fontSize: h(9),
                  fontWeight: 900,
                  color: c.text,
                  letterSpacing: "-0.03em",
                }}
              >
                {scaleNumericText(shown, growRatio)}
                <span style={{ fontSize: h(3.4), color: c.primary }}>%</span>
              </span>
            </Editable>
          </div>
        </div>

        <Editable id="label" title="说明">
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(2.6),
              fontWeight: 700,
              color: c.text,
            }}
          >
            {label}
          </div>
        </Editable>
        {sub ? (
          <Editable id="sub" title="补充">
            <div style={{ fontFamily: theme.font.body, fontSize: h(1.9), color: c.textMuted }}>
              {sub}
            </div>
          </Editable>
        ) : null}
      </div>
    </SceneFrame>
  );
};
