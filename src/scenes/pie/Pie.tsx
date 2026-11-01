import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useMotion } from "../ui";
import { clamp01, easeOut } from "../fx";

export type PieProps = {
  theme: Theme;
  /** 顶部标题 */
  heading: string;
  /** 切片，2–6 块；按大小排（图例按同样顺序显示） */
  data: { label: string; value: number; display: string }[];
  /** 圆心文字（如「总 GMV」），可留空 */
  centerLabel: string;
};

/**
 * 占比饼图：环形多切片，逐块依序扫出，右侧（竖屏在下方）配图例。
 *
 * 和「环形数据 ring」的分工：ring 是**一个值**的百分比进度；
 * 这个是**多个值**的占比构成。两者长得像但问题不同——
 * "完成了多少"用 ring，"都是由什么组成的"用 pie。
 *
 * 切片动画用 `pathLength={1}` + dasharray/dashoffset：
 * 每片在自己的起始角「从零长到自己的份额」，接缝天然对齐，
 * 不用算扇形路径的 arc 大小标志位（>180° 的片还要翻转 large-arc，容易错）。
 */
export const PieScene: React.FC<PieProps> = ({
  theme,
  heading = "",
  data = [],
  centerLabel = "",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, u, h, b, isPortrait } = useSceneLayout();
  const m = useMotion();
  const c = theme.palette;

  const list = (data ?? []).filter((d) => d && Number.isFinite(d.value) && d.value > 0).slice(0, 6);
  const total = list.reduce((acc, d) => acc + d.value, 0) || 1;
  const colors = [
    c.primary,
    c.secondary,
    c.accent,
    withColorAlpha(c.primary, 0.5),
    withColorAlpha(c.secondary, 0.5),
    withColorAlpha(c.text, 0.35),
  ];

  const globalP = m === 0
    ? 1
    : easeOut(interpolate(frame, [8, 8 + Math.round(fps * 1.0)], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      }));

  const chartD = Math.min(width * (isPortrait ? 0.72 : 0.4), u(46));
  const R = 100;
  const hole = 0.6; // 环形：内孔占半径的比例
  const sw = R * (1 - hole);

  // 图例：横屏在右、竖屏在下
  const legend = list.map((d, i) => {
    const frac = d.value / total;
    const start = list.slice(0, i).reduce((acc, x) => acc + x.value / total, 0);
    const sliceP = m === 0 ? 1 : easeOut(clamp01((globalP - start) / Math.max(0.001, frac)));
    return { d, i, frac, start, sliceP };
  });

  const pie = (
    <svg width={chartD} height={chartD} viewBox="0 0 200 200" style={{ flexShrink: 0 }}>
      {/* 底环：让"还有哪些没亮"有轮廓 */}
      <circle
        cx={100}
        cy={100}
        r={R - sw / 2}
        fill="none"
        stroke={withColorAlpha(c.text, 0.08)}
        strokeWidth={sw}
      />
      {legend.map(({ d, i, frac, start, sliceP }) => (
        <circle
          key={`pie-${i}`}
          cx={100}
          cy={100}
          r={R - sw / 2}
          fill="none"
          stroke={colors[i % colors.length]}
          strokeWidth={sw}
          pathLength={1}
          strokeDasharray={`${frac * sliceP} ${1 - frac * sliceP}`}
          strokeDashoffset={-start}
          transform="rotate(-90 100 100)"
        />
      ))}
      {centerLabel ? (
        <text
          x={100}
          y={104}
          textAnchor="middle"
          dominantBaseline="central"
          fill={c.textMuted}
          style={{ fontFamily: theme.font.body, fontSize: 15 }}
        >
          {centerLabel}
        </text>
      ) : null}
    </svg>
  );

  const legendEl = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: u(1.6),
        /*
         * 不能 flex:1 占满剩余宽度：横屏下剩余宽度很大，行内 space-between
         * 会把数值推到画布最右缘，图例中间空出一大条。让它只占内容宽，
         * 和饼图一起作为一个整体居中。
         */
        flex: isPortrait ? "1 1 100%" : "0 0 auto",
        minWidth: isPortrait ? "100%" : u(26),
      }}
    >
      {legend.map(({ d, i, frac, sliceP }) => (
        <Editable
          key={`lg-${i}`}
          id={`legend${i + 1}`}
          title="图例行"
          style={{
            display: "flex",
            alignItems: "center",
            gap: u(1.6),
            opacity: sliceP,
          }}
        >
          <span
            style={{
              width: u(1.8),
              height: u(1.8),
              borderRadius: u(0.5),
              background: colors[i % colors.length],
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontFamily: theme.font.body,
              fontSize: b(2.2),
              color: c.text,
              flex: 1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {d.label}
          </span>
          <span
            style={{
              fontFamily: theme.font.heading,
              fontSize: b(2.2),
              fontWeight: 700,
              color: c.text,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {d.display || Math.round(d.value).toLocaleString("en-US")}
            {/* display 里已经带了百分比就不再补一个：否则图例变成「80% 80%」 */}
            {/\d\s*%/.test(d.display) ? null : (
              <span style={{ color: c.textMuted, fontWeight: 400, marginLeft: u(0.8) }}>
                {Math.round(frac * 100)}%
              </span>
            )}
          </span>
        </Editable>
      ))}
    </div>
  );

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

        <div
          style={{
            display: "flex",
            flexDirection: isPortrait ? "column" : "row",
            alignItems: "center",
            // 图例改成内容宽之后，整组（饼图+图例）要在横屏里居中，不能贴左
            justifyContent: "center",
            gap: u(4),
            width: "100%",
          }}
        >
          {pie}
          {legendEl}
        </div>
      </div>
    </SceneFrame>
  );
};
