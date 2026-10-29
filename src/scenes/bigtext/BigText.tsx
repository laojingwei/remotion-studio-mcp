import React from "react";
import type { Theme } from "../../../shared/schema";
import { clampHeadSize } from "../../../shared/textFit";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, Highlighted, SceneFrame, useEnter } from "../ui";

export type BigTextProps = {
  theme: Theme;
  text: string;
  sub: string;
  highlight: string;
};

/** 大字报：一句超大字，适合情绪/态度/金句 */
export const BigTextScene: React.FC<BigTextProps> = ({ theme, text, sub, highlight }) => {
  const { u, h, unit, width, headScale, safe, isPortrait } = useSceneLayout();
  const enter = useEnter(0);

  /**
   * 竖屏 12 单位；横屏按「一行塞进整幅宽度」算，夹在 [7, 16]。
   *
   * 原来横屏固定 10 单位，六个字的大字报只占 48% 宽，右边一半黑着 ——
   * 大字报本来就该顶到两边（海报的常识），所以这里宁可用字号换宽度；
   * 太长的句子会被下限 7 挡住，自然折成两行，也不会缩成看不清的小字。
   */
  const size = isPortrait ? 12 : clampHeadSize(text, width - 2 * u(safe.x), unit, headScale, 7, 16);

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: u(3),
          opacity: enter.opacity,
          transform: `translateY(${enter.y * u(1)}px)`,
        }}
      >
        <Editable id="text" title="大字">
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(size),
              fontWeight: 900,
              lineHeight: 1.08,
              letterSpacing: "-0.03em",
              color: theme.palette.text,
            }}
          >
            <Highlighted text={text} highlight={highlight} color={theme.palette.primary} />
          </div>
        </Editable>
        {sub ? (
          <Editable id="sub" title="小字">
            <div
              style={{
                fontFamily: theme.font.body,
                fontSize: h(2.1),
                color: theme.palette.textMuted,
              }}
            >
              {sub}
            </div>
          </Editable>
        ) : null}
      </div>
    </SceneFrame>
  );
};
