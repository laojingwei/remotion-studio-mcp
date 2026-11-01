import React from "react";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, scaleNumericText, useEnter } from "../ui";

export type FunnelProps = {
  theme: Theme;
  /** 顶部标题 */
  heading: string;
  /** 漏斗各层，按流程顺序传（第一层最大），不要自己排序 */
  stages: { label: string; value: number; display: string }[];
  /** 层间是否显示转化率（默认关）：没给转化数据时自动算=凭空造数 */
  showConversion?: boolean;
};

type Stage = { label: string; value: number; display: string };

/*
 * 条上的文字颜色不能写死。
 *
 * 条是「主题色按透明度叠在页面底色上」的混合结果：同一个 c.background 当文字色，
 * 在亮绿条上是深底浅字（看不清），换个主题又可能刚好反着。按混合后的实际亮度
 * 挑深字或浅字，两种主题、两种强调色都成立。
 */
const readableOn = (
  barColor: string,
  barAlpha: number,
  pageBg: string,
  lightText: string,
  darkText: string,
): string => {
  const luma = (hex: string): number => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return 0.5;
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const mix = (fg: string) => {
    const f = luma(fg);
    const bgL = luma(pageBg);
    return f * barAlpha + bgL * (1 - barAlpha);
  };
  return mix(barColor) > 0.45 ? darkText : lightText;
};

/**
 * 单层 + 层间转化率。hooks 住在组件里，不能写在 map 回调里。
 */
const FunnelStage: React.FC<{
  theme: Theme;
  stage: Stage;
  index: number;
  /** 相对第一层的宽度百分比 */
  widthPct: number;
  /** 上一层到这一层的转化率，第一层为 null（不显示） */
  conv: number | null;
  barH: number;
  valueSize: number;
  stages: number;
}> = ({ theme, stage, index, widthPct, conv, barH, valueSize, stages }) => {
  const { u, isPortrait } = useSceneLayout();
  const c = theme.palette;
  const enter = useEnter(8 + index * 6);
  const text = stage.display
    ? scaleNumericText(stage.display, enter.progress)
    : Math.round(stage.value).toLocaleString("en-US");

  // 越往下越淡：漏斗的"收窄"要同时读出"递减"，纯同色会变成一摞等宽色块
  const alpha = Math.max(0.32, 0.92 - index * (0.55 / Math.max(1, stages - 1)));
  // 两端各判一次：标签在 primary 端，数值在 secondary 端，深浅可能不一样
  const pick = (end: string) => readableOn(end, alpha, c.background, c.text, c.background);
  const textColor = pick(c.primary);
  const valueColor = pick(c.secondary);

  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
      {conv !== null ? (
        <div
          style={{
            fontFamily: theme.font.body,
            fontSize: u(1.7),
            color: c.textMuted,
            marginBottom: u(0.9),
            opacity: enter.opacity,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          ↓ {Math.round(conv * 100)}%
        </div>
      ) : null}
      <Editable
        id={`stage${index + 1}`}
        title="每一层"
        style={{
          width: `${widthPct * enter.progress}%`,
          minWidth: u(30),
          height: barH,
          borderRadius: u(1),
          background: `linear-gradient(90deg, ${withColorAlpha(c.primary, alpha)}, ${withColorAlpha(
            c.secondary,
            alpha * 0.85,
          )})`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: `0 ${u(2.2)}px`,
          boxSizing: "border-box",
        }}
      >
        <span
          style={{
            fontFamily: theme.font.body,
            fontSize: valueSize,
            fontWeight: 600,
            color: textColor,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {stage.label}
        </span>
        <span
          style={{
            fontFamily: theme.font.heading,
            fontSize: valueSize,
            fontWeight: 700,
            color: valueColor,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {text}
        </span>
      </Editable>
    </div>
  );
};

/**
 * 漏斗：几层横条逐层收窄，层与层之间标转化率。
 *
 * 直播电商的核心图：曝光 → 进直播间 → 下单 → 复购。
 * 每一层的宽度是相对**第一层**的百分比（不是相对上一层的）——
 * 转化率另起一行放在层间，两个信息不挤在一起才读得清。
 *
 * 数据按流程顺序传（第一层最大），**不做自动排序**：
 * 漏斗的层是流程节点，排序会破坏流程含义，和竞速条形正好相反。
 */
export const FunnelScene: React.FC<FunnelProps> = ({
  theme,
  heading = "",
  stages = [],
  showConversion = false,
}) => {
  const { u, h, isPortrait } = useSceneLayout();
  const c = theme.palette;

  const list = (stages ?? []).filter((s) => s && Number.isFinite(s.value)).slice(0, 5);
  const top = Math.max(1, list[0]?.value ?? 1);
  /*
   * 层宽用**开方刻度**而不是线性比例。
   * 线性比例下 2,400 / 120,000 = 2%，再怎么夹下限，第 2、3、4 层也全是同宽，
   * 「漏斗」就只剩一个名字。开方之后 32% → 56%、9.6% → 50%、2% → 40%，
   * 收窄的形状读得出来，窄层也放得下文字。代价是宽度不再严格等于数值比 ——
   * 精确比值已经写在层间的转化率里了，两边各司其职。
   */
  const widthOf = (v: number) => 34 + 66 * Math.sqrt(Math.max(0, v) / top);
  const barH = u(isPortrait ? 6.4 : 5.2);
  const valueSize = h(isPortrait ? 2.6 : 2.2);

  return (
    <SceneFrame theme={theme} justify="center">
      <div style={{ display: "flex", flexDirection: "column", gap: u(3.4), width: "100%" }}>
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

        <div style={{ display: "flex", flexDirection: "column", gap: u(1.6) }}>
          {list.map((s, i) => (
            <FunnelStage
              key={`fs-${i}`}
              theme={theme}
              stage={s}
              index={i}
              widthPct={widthOf(s.value)}
              conv={
                showConversion && i > 0 && list[i - 1].value > 0 ? s.value / list[i - 1].value : null
              }
              barH={barH}
              valueSize={valueSize}
              stages={list.length}
            />
          ))}
        </div>
      </div>
    </SceneFrame>
  );
};
