import React from "react";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, scaleNumericText, useCountUp, useEnter } from "../ui";

export type StatsProps = {
  theme: Theme;
  heading: string;
  items: { value: string; label: string }[];
};

/**
 * 列数：3 个以内按个数分（3 个排一行，不再是 2+1 孤儿行），
 * 4 个排 2×2，更多按 3 列。
 */
const columnCount = (n: number) => {
  if (n <= 3) return Math.max(1, n);
  return n % 3 === 1 ? 2 : 3;
};

/** 单个数字：入场后从 0 滚到目标值（motion=0 时直接显示原值） */
const StatValue: React.FC<{ value: string; delay: number }> = ({ value, delay }) => {
  const p = useCountUp(1, delay);
  return <>{scaleNumericText(value, p)}</>;
};

/** 数据大字：2-4 个关键数字 */
export const StatsScene: React.FC<StatsProps> = ({ theme, heading, items }) => {
  const { u, h, b, isPortrait } = useSceneLayout();
  const enter = useEnter(0);

  const list = items ?? [];
  const cols = isPortrait ? 1 : columnCount(list.length);
  const gap = u(2.6);
  // 用 flex 而不是 grid：最后一行只剩一项时它会被自动拉满整行，
  // grid 做不到 —— 那个空格子就是「孤儿行」
  const basis = `calc((100% - ${gap * (cols - 1)}px) / ${cols})`;
  // 列多了数字要小一号，否则三个大数字挤在一行
  // 横屏可以放开：16:9 横向空间够，数字小了整页就没分量
  const valueSize = isPortrait
    ? cols >= 3
      ? 6.6
      : cols === 2
        ? 8
        : 8.5
    : cols >= 3
      ? 8.4
      : cols === 2
        ? 9.6
        : 10;

  return (
    <SceneFrame theme={theme} justify="center">
      <div style={{ display: "flex", flexDirection: "column", gap: u(4), width: "100%" }}>
        {heading ? (
          <Editable id="heading" title="标题">
            <div
              style={{
                fontFamily: theme.font.heading,
                fontSize: h(isPortrait ? 4 : 3.6),
                fontWeight: 800,
                color: theme.palette.text,
              }}
            >
              {heading}
            </div>
          </Editable>
        ) : null}

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap,
            width: "100%",
          }}
        >
          {list.map((it, i) => (
            <Editable
              key={`${it.value}-${i}`}
              id={`num${i + 1}`}
              title="数字"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: u(0.8),
                flex: `1 1 ${basis}`,
                minWidth: 0,
                /**
                 * 横屏每列顶上加一条发丝线。
                 *
                 * 只有数字和标签时，一列里真正有墨水的只有左边那一小截
                 * （「0」就一个字符），右半列全是空 —— 两个数字并排却只占半幅宽。
                 * 顶线把每列的实际宽度画出来，眼睛读到的是一条横向的数据栏，
                 * 而不是半空中飘着两个数字。
                 */
                paddingTop: isPortrait ? 0 : u(2.4),
                borderTop: isPortrait
                  ? undefined
                  : `1px solid ${withColorAlpha(theme.palette.primary, 0.45)}`,
                opacity: enter.opacity,
                transform: `translateY(${enter.y * u(1)}px)`,
              }}
            >
              <span
                style={{
                  fontFamily: theme.font.heading,
                  fontSize: h(valueSize),
                  fontWeight: 800,
                  lineHeight: 1,
                  color: theme.palette.primary,
                  letterSpacing: "-0.02em",
                }}
              >
                <StatValue value={it.value} delay={12 + i * 7} />
              </span>
              <span
                style={{
                  fontFamily: theme.font.body,
                  fontSize: b(2),
                  color: theme.palette.textMuted,
                }}
              >
                {it.label}
              </span>
            </Editable>
          ))}
        </div>
      </div>
    </SceneFrame>
  );
};
