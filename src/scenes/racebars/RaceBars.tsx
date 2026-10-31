import React from "react";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, scaleNumericText, useEnter } from "../ui";

export type RaceBarsProps = {
  theme: Theme;
  /** 顶部标题 */
  heading: string;
  /** 条目，按 value 从大到小自动排序 */
  items: { label: string; value: number; display: string }[];
  /** 数字后缀（如 %、万），display 写了就以 display 为准 */
  suffix: string;
};

type Row = { label: string; value: number; display: string };

/**
 * 单行。hooks 必须住在组件里，不能写在 map 回调里 ——
 * 行数在两次渲染之间必须稳定，抽成组件才能保证这一点。
 */
const RaceRow: React.FC<{
  theme: Theme;
  row: Row;
  rank: number;
  max: number;
  suffix: string;
  barH: number;
  valueSize: number;
}> = ({ theme, row, rank, max, suffix, barH, valueSize }) => {
  const { u, b } = useSceneLayout();
  const c = theme.palette;
  const enter = useEnter(6 + rank * 5);
  const first = rank === 0;
  const pct = Math.max(2, (Math.abs(row.value) / max) * 100);
  const text = row.display
    ? scaleNumericText(row.display, enter.progress)
    : `${Math.round(row.value).toLocaleString("en-US")}${suffix}`;

  return (
    <Editable
      id={`row${rank + 1}`}
      title="每一行"
      style={{
        display: "flex",
        alignItems: "center",
        gap: u(2),
        opacity: enter.opacity,
      }}
    >
      {/* 名次徽标：第一名用主题色填满，其余描边 */}
      <div
        style={{
          width: barH,
          height: barH,
          borderRadius: "50%",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: theme.font.heading,
          fontSize: b(1.8),
          fontWeight: 700,
          background: first ? c.primary : "transparent",
          border: first ? "none" : `1px solid ${withColorAlpha(c.text, 0.3)}`,
          color: first ? c.background : c.textMuted,
        }}
      >
        {rank + 1}
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: u(0.8) }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span
            style={{
              fontFamily: theme.font.body,
              fontSize: valueSize,
              color: first ? c.text : c.textMuted,
              fontWeight: first ? 700 : 400,
            }}
          >
            {row.label}
          </span>
          <span
            style={{
              fontFamily: theme.font.heading,
              fontSize: valueSize,
              fontWeight: 700,
              color: first ? c.primary : c.text,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {text}
          </span>
        </div>
        <div
          style={{
            height: barH * 0.52,
            borderRadius: 99,
            background: withColorAlpha(c.text, 0.08),
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${pct * enter.progress}%`,
              height: "100%",
              borderRadius: 99,
              // 第一名用双色渐变（最亮），其余统一用主色的半透明 —— 层次一眼分出来
              background: first
                ? `linear-gradient(90deg, ${c.primary}, ${c.secondary})`
                : withColorAlpha(c.primary, 0.42),
            }}
          />
        </div>
      </div>
    </Editable>
  );
};

/**
 * 竞速条形：横条从左往右长，第一名最长最亮，下面按值排序。
 *
 * 和「进度条组 bars」的区别：bars 是并列的完成度（彼此无关），
 * 这个是**排出来的名次**——自动排序、第一名强调、右侧带值。
 * 数据不该自己排好序再传进来：agent 手排容易错，而且改一个值名次就得重排。
 *
 * 条的宽度是相对**最大值**的百分比，不是相对总和 ——
 * 排行榜看的是"第一名有多遥不可及"，占比图才用总和。
 */
export const RaceBarsScene: React.FC<RaceBarsProps> = ({
  theme,
  heading = "",
  items = [],
  suffix = "",
}) => {
  const { u, h, isPortrait } = useSceneLayout();
  const c = theme.palette;

  const list = [...(items ?? [])]
    .filter((it) => it && Number.isFinite(it.value))
    .sort((a, b2) => b2.value - a.value)
    .slice(0, 5);
  const max = Math.max(1, ...list.map((it) => Math.abs(it.value)));
  const rowGap = u(2.2);
  const barH = u(isPortrait ? 4.6 : 3.8);
  const valueSize = h(isPortrait ? 2.5 : 2.1);

  return (
    <SceneFrame theme={theme} justify="center">
      <div style={{ display: "flex", flexDirection: "column", gap: u(3), width: "100%" }}>
        {heading ? (
          <Editable id="heading" title="标题">
            <div
              style={{
                fontFamily: theme.font.heading,
                fontSize: h(isPortrait ? 4 : 3.6),
                fontWeight: 800,
                color: c.text,
              }}
            >
              {heading}
            </div>
          </Editable>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: rowGap }}>
          {list.map((it, i) => (
            <RaceRow
              key={`rb-${i}`}
              theme={theme}
              row={it}
              rank={i}
              max={max}
              suffix={suffix}
              barH={barH}
              valueSize={valueSize}
            />
          ))}
        </div>
      </div>
    </SceneFrame>
  );
};
