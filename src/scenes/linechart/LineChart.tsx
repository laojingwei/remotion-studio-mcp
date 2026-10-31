import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, scaleNumericText, useMotion } from "../ui";
import { clamp01, easeOut } from "../fx";

export type LineChartProps = {
  theme: Theme;
  /** 顶部标题 */
  heading: string;
  /** 数值单位（如 万、%），标在最高点上 */
  unit: string;
  /** 数据点，按 x 轴顺序传（3–8 个） */
  data: { label: string; value: number; display: string }[];
  /** 平滑曲线（关掉就是折线） */
  smooth: boolean;
  /** 线下方铺一层渐变 */
  area: boolean;
};

type Pt = { x: number; y: number; frac: number };

/**
 * 折线图：线从左往右画出来，数据点跟着线头依次亮起。
 *
 * 「画出来」用 `pathLength={1}` 归一化 + dasharray：SVG 的 pathLength 属性
 * 把整条路径的长度规定成 1，dasharray 就可以直接写进度百分比，
 * 不用先 get getTotalLength() 再换算（headless 里时序还容易踩坑）。
 *
 * 平滑曲线是 Catmull-Rom 转三次贝塞尔：相邻两点做控制点，
 * 曲线保证过每个数据点（不做插值近似，数据点必须真的在线上）。
 */
export const LineChartScene: React.FC<LineChartProps> = ({
  theme,
  heading = "",
  unit = "",
  data = [],
  smooth = true,
  area = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height, u, h, isPortrait } = useSceneLayout();
  const m = useMotion();
  const c = theme.palette;

  const list = (data ?? []).filter((d) => d && Number.isFinite(d.value)).slice(0, 8);
  const n = list.length;
  const chartW = width - u(isPortrait ? 16 : 14);
  const chartH = u(isPortrait ? 46 : 36);
  const yTop = u(7);
  const yBottom = chartH - u(7);

  const max = Math.max(1, ...list.map((d) => Math.abs(d.value))) * 1.12;
  const pts: Pt[] = list.map((d, i) => {
    const frac = n === 1 ? 0.5 : i / (n - 1);
    return {
      x: u(5) + frac * (chartW - u(10)),
      y: yBottom - (Math.abs(d.value) / max) * (yBottom - yTop),
      frac,
    };
  });

  // 平滑：Catmull-Rom → 三次贝塞尔。n=1/2 退化为直线
  const linePath = (() => {
    if (n === 0) return "";
    if (n === 1) return `M ${pts[0].x} ${pts[0].y}`;
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < n - 1; i++) {
      if (!smooth) {
        d += ` L ${pts[i + 1].x} ${pts[i + 1].y}`;
        continue;
      }
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(n - 1, i + 2)];
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
    }
    return d;
  })();

  const drawP = m === 0 ? 1 : easeOut(interpolate(frame, [6, 6 + Math.round(fps * 1.0)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));

  // 每个点的进度跟着线头走：线画到它的横坐标附近它才亮
  const pointP = (frac: number) =>
    m === 0 ? 1 : easeOut(clamp01((drawP - frac * 0.85) / 0.15));

  const fontSize = u(1.7);
  const valueSize = u(2.1);
  const showValues = n <= 6;

  return (
    <SceneFrame theme={theme} justify="center">
      <div style={{ display: "flex", flexDirection: "column", gap: u(2.6), width: "100%" }}>
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

        <svg width={chartW} height={chartH} viewBox={`0 0 ${chartW} ${chartH}`}>
          <defs>
            <linearGradient id="linechart-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={withColorAlpha(c.primary, 0.3)} />
              <stop offset="100%" stopColor={withColorAlpha(c.primary, 0)} />
            </linearGradient>
          </defs>

          {/* 横向网格：三道就够，多了变表格 */}
          {[0.25, 0.5, 0.75].map((g) => (
            <line
              key={`g-${g}`}
              x1={u(4)}
              x2={chartW - u(4)}
              y1={yTop + (yBottom - yTop) * g}
              y2={yTop + (yBottom - yTop) * g}
              stroke={withColorAlpha(c.text, 0.09)}
              strokeWidth={1}
              strokeDasharray={`${u(0.8)} ${u(1.2)}`}
            />
          ))}

          {n > 1 ? (
            <>
              {area ? (
                <path
                  d={`${linePath} L ${pts[n - 1].x} ${yBottom} L ${pts[0].x} ${yBottom} Z`}
                  fill="url(#linechart-area)"
                  opacity={drawP}
                />
              ) : null}
              <path
                d={linePath}
                fill="none"
                stroke={c.primary}
                strokeWidth={u(0.55)}
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength={1}
                strokeDasharray={`${drawP} 1`}
              />
            </>
          ) : null}

          {pts.map((p, i) => {
            const pr = pointP(p.frac);
            const d = list[i];
            const text = d.display
              ? scaleNumericText(d.display, pr)
              : `${Math.round(d.value).toLocaleString("en-US")}${unit}`;
            return (
              <g key={`pt-${i}`} opacity={pr}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={u(0.55) * (0.6 + pr * 0.4)}
                  fill={c.background}
                  stroke={c.primary}
                  strokeWidth={u(0.35)}
                />
                {showValues ? (
                  <text
                    x={p.x}
                    y={p.y - u(2.4)}
                    textAnchor="middle"
                    fill={c.text}
                    style={{
                      fontFamily: theme.font.heading,
                      fontSize: valueSize,
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {text}
                  </text>
                ) : null}
                {/* x 轴标签：点太多时隔一个显示一个，不然互相压 */}
                {isPortrait && n > 6 && i % 2 === 1 ? null : (
                  <text
                    x={p.x}
                    y={chartH - u(2)}
                    textAnchor="middle"
                    fill={c.textMuted}
                    style={{ fontFamily: theme.font.body, fontSize }}
                  >
                    {d.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </SceneFrame>
  );
};
