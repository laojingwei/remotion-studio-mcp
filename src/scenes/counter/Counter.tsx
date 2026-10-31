import React from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useMotion } from "../ui";

export type CounterProps = {
  theme: Theme;
  /** 目标数字（可以用小数，比如 1.2 表示 1.2 万） */
  value: number;
  /** 前缀，如「¥」「+」 */
  prefix: string;
  /** 后缀，如「万」「元」「%」 */
  suffix: string;
  /** 数字下面的说明 */
  label: string;
  /** 小数位 */
  decimals: number;
};

/**
 * 数字滚动：从 0 弹到目标值。
 *
 * 适合「一万音浪」「370 元」这类**要让人记住的量**。数字用 tabular-nums，
 * 否则滚动过程中位宽会跳、整行左右抖 —— 这是数字动画最常见的一个丑。
 *
 * 为什么不做"每一位独立滚动"（像老虎机）：那需要等宽位槽，中文语境里
 * 常和「万/元」混排，位槽会错位。整体弹到位更稳，也更好读。
 */
export const CounterScene: React.FC<CounterProps> = ({
  theme,
  value = 0,
  prefix = "",
  suffix = "",
  label = "",
  decimals = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, h, b, isPortrait } = useSceneLayout();
  const m = useMotion();
  const c = theme.palette;

  const p = m === 0 ? 1 : spring({ frame: frame - 3, fps, config: { damping: 200, mass: 0.9, stiffness: 60 } });
  // easeOut 收尾，避免最后几位数字"磨"很久
  const eased = 1 - Math.pow(1 - Math.min(1, p), 2.2);
  const shown = Number(value) * (m === 0 ? 1 : eased);

  const text = shown.toLocaleString("zh-CN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  const numSize = h(isPortrait ? 26 : 21);

  return (
    <SceneFrame theme={theme} justify="center" align="left">
      <Editable id="value" title="数字">
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: u(0.4),
            fontFamily: theme.font.heading,
            fontWeight: 900,
            color: c.text,
            // 不加 tabular-nums 的话，滚动时每位数宽不同，整块会左右抖
            fontVariantNumeric: "tabular-nums",
            fontFeatureSettings: '"tnum"',
            letterSpacing: u(-0.2),
          }}
        >
          {prefix ? (
            <span style={{ fontSize: numSize * 0.55, color: c.primary, fontWeight: 800 }}>{prefix}</span>
          ) : null}
          <span style={{ fontSize: numSize, lineHeight: 1 }}>{text}</span>
          {suffix ? (
            <span style={{ fontSize: numSize * 0.42, color: c.textMuted, fontWeight: 700 }}>{suffix}</span>
          ) : null}
        </div>
      </Editable>

      {/* 数字下面的一条强调线：先长出来，再把视线交给 label */}
      <div
        style={{
          marginTop: u(2.2),
          height: Math.max(4, u(0.65)),
          width: m === 0 ? u(34) : u(34) * Math.min(1, Math.max(0, (frame / fps - 0.4) / 0.6)),
          background: `linear-gradient(90deg, ${c.primary}, ${c.secondary})`,
          borderRadius: 99,
          opacity: 0.9,
        }}
      />

      {label ? (
        <Editable id="label" title="说明" style={{ marginTop: u(2.4) }}>
          <div
            style={{
              fontFamily: theme.font.body,
              fontSize: b(2.2),
              color: c.textMuted,
              letterSpacing: u(0.06),
              opacity: m === 0 ? 1 : Math.min(1, Math.max(0, (frame / fps - 0.6) / 0.5)),
            }}
          >
            {label}
          </div>
        </Editable>
      ) : null}
    </SceneFrame>
  );
};
