import React from "react";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useCountUp, useEnter } from "../ui";

export type DeltaProps = {
  theme: Theme;
  /** 顶部小标签，说明这两个数是什么（如「到手金额」） */
  label: string;
  /** 数字前缀，如 ¥ */
  prefix: string;
  /** 之前的值 */
  before: number;
  /** 之后的值 */
  after: number;
  /** 数字后缀，如 万、% */
  suffix: string;
  /** 变化方向：涨 = 向上箭头，跌 = 向下箭头（颜色统一用主题色，语义由 note 说明） */
  tone: "涨" | "跌";
  /** 底部一句话解释 */
  note: string;
};

const fmt = (n: number, prefix: string, suffix: string) =>
  `${prefix}${Math.round(n).toLocaleString("en-US")}${suffix}`;

/**
 * 涨跌对比：一个数字从 before 到 after，中间一支箭头，下面给涨跌幅。
 *
 * 和「数字滚动 counter」的区别：counter 让人记住一个数；
 * 这个让人记住**变化**（"一万只剩三百七"）。所以 before 刻意做小做灰、
 * after 做大做亮 —— 视线应该先落在变化的结果上，再回头看原值。
 *
 * 箭头方向由 tone 决定，颜色统一用主题色：
 * 涨跌色（红涨绿跌）是行情软件的约定，硬编码进模板会和主题色打架；
 * "这个变化是好是坏"交给 note 那句话去说。
 */
export const DeltaScene: React.FC<DeltaProps> = ({
  theme,
  label = "",
  prefix = "",
  before = 0,
  after = 0,
  suffix = "",
  tone = "涨",
  note = "",
}) => {
  const { u, h, b, isPortrait } = useSceneLayout();
  const c = theme.palette;
  const enter = useEnter(0);

  const pBefore = useCountUp(before, 8);
  const pAfter = useCountUp(after, 16);
  // 涨跌幅基于**终值**算（滚动的中间值算出来的百分比会晃眼）
  const ratio = Math.abs(before) > 0 ? (after - before) / Math.abs(before) : null;
  const arrow = tone === "涨" ? "↑" : "↓";
  const deltaText = ratio === null ? "" : `${arrow} ${ratio > 0 ? "+" : ""}${Math.round(ratio * 100)}%`;

  const beforeSize = h(isPortrait ? 5.4 : 5.8);
  const afterSize = h(isPortrait ? 12.5 : 11.5);
  const column = isPortrait;

  return (
    <SceneFrame theme={theme} justify="center" align="center">
      {label ? (
        <Editable id="label" title="小标签" style={{ marginBottom: u(3) }}>
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: b(1.9),
              letterSpacing: u(0.24),
              color: c.textMuted,
            }}
          >
            {label}
          </div>
        </Editable>
      ) : null}

      <div
        style={{
          display: "flex",
          flexDirection: column ? "column" : "row",
          alignItems: "center",
          gap: column ? u(1.6) : u(4),
          width: "100%",
          justifyContent: "center",
          opacity: enter.opacity,
        }}
      >
        {/* before：小一号、灰 —— 它只是参照物 */}
        <Editable id="before" title="之前的值">
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: beforeSize,
              fontWeight: 600,
              color: withColorAlpha(c.text, 0.4),
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmt(pBefore, prefix, suffix)}
          </div>
        </Editable>

        {/*
          箭头只表示阅读流向（竖屏从上往下 / 横屏从左往右），不做涨跌翻转。
          早先给「跌」加了 scaleY(-1) 翻转，结果竖屏的 ↓ 被翻成 ↑，
          和胶囊里的 ↓ -63% 当场打架。涨跌语义只在胶囊里表达一次。
        */}
        <div
          style={{
            fontFamily: theme.font.heading,
            fontSize: h(isPortrait ? 6 : 5.5),
            color: c.primary,
            fontWeight: 700,
            opacity: enter.opacity,
          }}
        >
          {column ? "↓" : "→"}
        </div>

        {/* after：画面里最大的元素 */}
        <Editable id="after" title="之后的值">
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: afterSize,
              fontWeight: 900,
              color: c.primary,
              letterSpacing: u(-0.1),
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1.05,
            }}
          >
            {fmt(pAfter, prefix, suffix)}
          </div>
        </Editable>
      </div>

      {deltaText ? (
        <div
          style={{
            marginTop: u(3),
            padding: `${u(0.7)}px ${u(2.4)}px`,
            borderRadius: 99,
            background: withColorAlpha(c.primary, 0.14),
            fontFamily: theme.font.heading,
            fontSize: b(2.2),
            fontWeight: 700,
            color: c.primary,
            fontVariantNumeric: "tabular-nums",
            opacity: enter.opacity,
          }}
        >
          {deltaText}
        </div>
      ) : null}

      {note ? (
        <Editable id="note" title="说明" style={{ marginTop: u(2.6) }}>
          <div
            style={{
              fontFamily: theme.font.body,
              fontSize: b(2.4),
              color: c.textMuted,
              textAlign: "center",
              lineHeight: 1.55,
              maxWidth: isPortrait ? u(80) : "70%",
            }}
          >
            {note}
          </div>
        </Editable>
      ) : null}
    </SceneFrame>
  );
};
