import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useMotion } from "../ui";
import { clamp01, easeInOut } from "../fx";

export type WipeProps = {
  theme: Theme;
  /** 顶部小标签，可留空 */
  kicker: string;
  /** 文案行，行数不限（行多时字号自动缩小） */
  lines: string[];
  /** 要用主题色擦的那一行，可留空 */
  accentLine: string;
};

/**
 * 色带擦除：每行文案前面盖一条色带，色带横向推开，字就露出来。
 *
 * 和「遮罩上翻」是同一件事的横竖两版 —— 上翻是纵向升起（有庄重感，适合结论），
 * 擦除是横向推进（有速度感，适合清单、步骤、原因）。选哪个看语气，不看内容。
 *
 * 色带的**前沿**比本体亮一档：纯色块推过去像 PPT 动画，
 * 前沿带一道高光才像"擦"出来的。
 */
export const WipeScene: React.FC<WipeProps> = ({
  theme,
  kicker = "",
  lines = [],
  accentLine = "",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, h, b, isPortrait } = useSceneLayout();
  const m = useMotion();
  const c = theme.palette;

  const rows = (lines ?? []).filter((l) => String(l).length > 0);
  // 行数不设上限：超过基准（3 行）按 3/N 缩小字号和行距，多少行都排得进画面
  const fit = Math.min(1, 3 / Math.max(1, rows.length));
  const fontSize = (isPortrait ? h(5.6) : h(4.8)) * fit;

  const kickerIn = m === 0 ? 1 : clamp01(frame / Math.max(1, fps * 0.3));

  return (
    <SceneFrame theme={theme} justify="center" align="left">
      {kicker ? (
        <Editable id="kicker" title="小标签" style={{ marginBottom: u(3), opacity: kickerIn }}>
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: b(1.6),
              letterSpacing: u(0.26),
              textTransform: "uppercase",
              color: c.textMuted,
              display: "flex",
              alignItems: "center",
              gap: u(1.2),
            }}
          >
            <span
              style={{
                width: u(2.6),
                height: Math.max(2, u(0.22)),
                background: c.primary,
                borderRadius: 99,
              }}
            />
            {kicker}
          </div>
        </Editable>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: u(2.4) * fit, width: "100%" }}>
        {rows.map((line, i) => {
          const start = Math.round(fps * (0.16 + i * 0.17));
          const dur = Math.round(fps * 0.44);
          const p = m === 0 ? 1 : easeInOut(clamp01((frame - start) / Math.max(1, dur)));
          const accent = accentLine && line === accentLine;
          const band = accent ? c.primary : withColorAlpha(c.text, 0.16);

          return (
            <Editable
              key={`w-${i}`}
              id={`line${i + 1}`}
              title="每一行"
              style={{
                position: "relative",
                overflow: "hidden",
                // 必须撑满一整行宽：色带是按"容器宽度"位移的，
                // 容器如果只有文字的宽度，扫到 70% 就被裁掉，画面上只剩一道孤零零的高光
                width: "100%",
                paddingTop: u(0.4),
                paddingBottom: u(0.4),
              }}
            >
              <div
                style={{
                  fontFamily: theme.font.heading,
                  fontSize,
                  fontWeight: 800,
                  lineHeight: 1.32,
                  color: accent ? c.primary : c.text,
                  letterSpacing: u(0.02),
                  // 字自己往左让一点点，擦开时有"被带出来"的手感
                  transform: `translateX(${(1 - p) * -8}%)`,
                }}
              >
                {line}
              </div>

              {/*
                色带宽度就用 100%，位移写 p*100% —— 这样「色带的左边缘」与下面那道
                高光的 `left: p*100%` 是同一个坐标。早先给色带写了 112% 宽再位移 112%，
                而 transform 的百分比是按**自身宽度**算的，实际走了 125%，
                高光就飞到色带前面去了（抽帧里那道孤零零的白线）。
              */}
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: "100%",
                  background: band,
                  // 扫完之后直接不画：translateX(100%) 在亚像素上仍会漏出 1px 的色边
                  // （抽帧时是每行右端一道 1px 竖线，颜色正好是色带色），加个显隐最省事
                  opacity: p >= 1 ? 0 : 1,
                  /*
                   * 不加 skewX：斜切是按元素自身中心做的，扫完之后右边会留下一条
                   * 几像素的斜边（表现为每一行右端一道竖线，颜色还正好是色带色）。
                   * 斜切带来的"速度感"抵不上这道穿帮。
                   */
                  transform: `translateX(${p * 100}%)`,
                }}
              />
              {/* 前沿高光：色带的行进边就是它的左边缘 */}
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `${p * 100}%`,
                  width: u(0.6),
                  background: withColorAlpha(accent ? c.background : c.text, 0.85),
                  opacity: p > 0 && p < 1 ? 0.85 : 0,
                }}
              />
            </Editable>
          );
        })}
      </div>
    </SceneFrame>
  );
};
