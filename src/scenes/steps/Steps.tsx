import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

type Step = { title: string; desc: string };

const Circle: React.FC<{ index: number; theme: Theme; progress: number }> = ({
  index,
  theme,
  progress,
}) => {
  const { u, h } = useSceneLayout();
  const size = u(5.4);
  return (
    <div
      style={{
        width: size,
        height: size,
        flex: "0 0 auto",
        borderRadius: "50%",
        background: progress > 0.5 ? theme.palette.primary : theme.palette.surface,
        border: `1px solid ${theme.palette.primary}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: theme.font.heading,
        fontSize: h(1.9),
        fontWeight: 700,
        color: progress > 0.5 ? "#10120A" : theme.palette.primary,
        transform: `scale(${0.6 + progress * 0.4})`,
        opacity: progress,
      }}
    >
      {index + 1}
    </div>
  );
};

/* ───────────── 竖屏：纵向时间线 ───────────── */

const VerticalStep: React.FC<{
  step: Step;
  index: number;
  last: boolean;
  delay: number;
  theme: Theme;
}> = ({ step, index, last, delay, theme }) => {
  const { u, h } = useSceneLayout();
  const e = useEnter(delay);
  const line = useEnter(delay + 6);

  return (
    <Editable
      id={`step${index + 1}`}
      title={`步骤 ${index + 1}`}
      style={{ display: "flex", gap: u(2.4), alignItems: "stretch" }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Circle index={index} theme={theme} progress={e.progress} />
        {last ? null : (
          <div
            style={{
              flex: 1,
              width: Math.max(1, u(0.14)),
              marginTop: u(0.8),
              background: theme.palette.textMuted,
              opacity: line.progress * 0.35,
              minHeight: u(3),
            }}
          />
        )}
      </div>

      <div
        style={{
          paddingBottom: last ? 0 : u(3.4),
          opacity: e.opacity,
          transform: `translateY(${e.y * u(1)}px)`,
        }}
      >
        <div
          style={{
            fontFamily: theme.font.heading,
            fontSize: h(3.0),
            fontWeight: 600,
            color: theme.palette.text,
            lineHeight: 1.25,
          }}
        >
          {step.title}
        </div>
        {step.desc ? (
          <div
            style={{
              marginTop: u(0.7),
              fontFamily: theme.font.body,
              fontSize: h(1.9),
              lineHeight: 1.5,
              color: theme.palette.textMuted,
            }}
          >
            {step.desc}
          </div>
        ) : null}
      </div>
    </Editable>
  );
};

/* ───────────── 横屏：横向流程 ───────────── */

const HorizontalStep: React.FC<{
  step: Step;
  index: number;
  delay: number;
  last: boolean;
  theme: Theme;
}> = ({ step, index, delay, last, theme }) => {
  const { u, h } = useSceneLayout();
  const e = useEnter(delay);

  return (
    <Editable
      id={`step${index + 1}`}
      title={`步骤 ${index + 1}`}
      style={{
        position: "relative",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: u(1.6),
        opacity: e.opacity,
        transform: `translateY(${e.y * u(1)}px)`,
        minWidth: 0,
      }}
    >
      <Circle index={index} theme={theme} progress={e.progress} />

      {/* 连接线：从圆右缘延伸到下一列圆的左缘 */}
      {last ? null : (
        <div
          style={{
            position: "absolute",
            top: u(2.7),
            left: u(5.4),
            width: `calc(100% - ${u(5.4)}px + ${u(4)}px)`,
            height: Math.max(1, u(0.12)),
            background: theme.palette.textMuted,
            opacity: e.progress * 0.4,
          }}
        />
      )}

      <div
        style={{
          fontFamily: theme.font.heading,
          fontSize: h(2.8),
          fontWeight: 600,
          color: theme.palette.text,
          lineHeight: 1.25,
        }}
      >
        {step.title}
      </div>
      {step.desc ? (
        <div
          style={{
            fontFamily: theme.font.body,
            fontSize: h(2.0),
            lineHeight: 1.5,
            color: theme.palette.textMuted,
          }}
        >
          {step.desc}
        </div>
      ) : null}
    </Editable>
  );
};

export type StepsProps = {
  theme: Theme;
  heading: string;
  items: Step[];
};

export const StepsScene: React.FC<StepsProps> = ({ theme, heading, items }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const head = useEnter(0);

  return (
    <SceneFrame theme={theme} justify="center">
      {heading ? (
        <Editable
          id="heading"
          title="流程标题"
          style={{
            fontFamily: theme.font.heading,
            fontSize: h(isPortrait ? 3.2 : 2.8),
            fontWeight: 600,
            color: theme.palette.text,
            marginBottom: u(4.4),
            opacity: head.opacity,
            transform: `translateY(${head.y * u(1)}px)`,
          }}
        >
          {heading}
        </Editable>
      ) : null}

      {isPortrait ? (
        <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
          {items.map((step, i) => (
            <VerticalStep
              key={i}
              step={step}
              index={i}
              last={i === items.length - 1}
              delay={8 + i * 10}
              theme={theme}
            />
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              width: "84%",
              gap: u(4),
            }}
          >
            {items.map((step, i) => (
              <HorizontalStep
                key={i}
                step={step}
                index={i}
                delay={8 + i * 10}
                last={i === items.length - 1}
                theme={theme}
              />
            ))}
          </div>
        </div>
      )}
    </SceneFrame>
  );
};
