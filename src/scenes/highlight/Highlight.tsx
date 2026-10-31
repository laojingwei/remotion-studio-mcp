import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useMotion } from "../ui";
import { clamp01, easeOut } from "../fx";

export type HighlightProps = {
  theme: Theme;
  /** 主文案，支持 \n 换行 */
  text: string;
  /** 要扫亮的词，必须在 text 里，否则这句话就是普通文字 */
  highlight: string;
  /** 副标题，扫完才出现 */
  sub: string;
  /** 标记样式：荧光笔 / 色块反白 / 下划线 */
  mark: "荧光笔" | "色块" | "下划线";
};

/**
 * 荧光扫亮：一句话里，关键词被一支笔从左扫过。
 *
 * 和「弹跳字 / 打字机」的区别是**谁在动** —— 那两个是字在动，
 * 这个是笔在动、字不动。所以它不抢"读"这件事，适合长句里抬一个词出来
 * （"平台先切一刀，**公会**再分一截"）。
 *
 * 实现上刻意不测量文字宽度：一旦用 `getBoundingClientRect` 去算关键词的位置，
 * 换字号 / 换画幅 / 字体回退都会让标记偏几像素，而 Remotion 是逐帧渲染，
 * 偏了就是每帧都偏。改成「给关键词包一层 span，宽度按百分比长」，就与字体无关了。
 */
export const HighlightScene: React.FC<HighlightProps> = ({
  theme,
  text = "",
  highlight = "",
  sub = "",
  mark = "荧光笔",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, h, b, isPortrait } = useSceneLayout();
  const m = useMotion();
  const c = theme.palette;

  const full = String(text ?? "");
  const word = String(highlight ?? "");
  const at = word ? full.indexOf(word) : -1;
  const hasMark = at >= 0;

  const before = hasMark ? full.slice(0, at) : full;
  const marked = hasMark ? word : "";
  const after = hasMark ? full.slice(at + word.length) : "";
  const chars = Array.from(marked);

  // 整句先淡入上浮，落定之后笔才扫 —— 同时做会糊成一团
  const enter = m === 0 ? 1 : clamp01(frame / Math.max(1, fps * 0.42));
  const start = Math.round(fps * 0.5);
  // 字多的词扫得久一点，但两头的上限下限夹住：太短像闪一下，太长像慢镜头
  const sweepDur = Math.max(Math.round(fps * 0.36), chars.length * Math.round(fps * 0.1));
  const p = m === 0 ? 1 : easeOut(clamp01((frame - start) / Math.max(1, sweepDur)));

  const fontSize = isPortrait ? h(6.4) : h(5.4);

  /**
   * 标记条：三种样式只是高度与颜色不同，扫的进度是同一个。
   *
   * 尺寸一律用 **em**（相对字号），不用百分比：外层 span 的高度是 line-height
   * （1.45em），按百分比算出来的 58% 其实是 0.84em —— 比字还高，看着像给字加了个
   * 色块底，不像荧光笔扫过下三分之一。em 与字号绑定，换画幅 / 换字号都不会跑。
   */
  const barStyle: React.CSSProperties =
    mark === "荧光笔"
      ? {
          bottom: "0.12em",
          height: "0.52em",
          background: withColorAlpha(c.primary, 0.46),
          borderRadius: Math.max(2, u(0.35)),
        }
      : mark === "色块"
        ? {
            bottom: "-0.02em",
            height: "0.92em",
            background: c.primary,
            borderRadius: Math.max(2, u(0.45)),
          }
        : {
            bottom: "0.02em",
            height: "0.09em",
            background: c.primary,
            borderRadius: 99,
          };

  return (
    <SceneFrame theme={theme} justify="center" align="left">
      <Editable
        id="text"
        title="主文案"
        style={{
          maxWidth: isPortrait ? u(86) : "78%",
          opacity: enter,
          transform: `translateY(${(1 - enter) * u(2)}px)`,
        }}
      >
        <div
          style={{
            fontFamily: theme.font.heading,
            fontSize,
            lineHeight: 1.45,
            fontWeight: 800,
            color: c.text,
            whiteSpace: "pre-wrap",
            letterSpacing: u(0.02),
          }}
        >
          {before}
          {hasMark ? (
            <span
              style={{
                position: "relative",
                display: "inline-block",
                // 让标记条比字略宽一点，两端才不像被裁掉
                padding: `0 ${u(0.25)}px`,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  width: `${p * 100}%`,
                  ...barStyle,
                }}
              />
              <span style={{ position: "relative" }}>
                {chars.map((ch, i) => {
                  /*
                   * 色块样式要"反白"：字被色块盖住时换成背景色，才有"被涂掉再照亮"的感觉。
                   * 逐字判断而不是给整段设一个 class —— 色块是长过去的，不是整段一起变色。
                   */
                  const covered = mark === "色块" && (i + 0.5) / chars.length <= p;
                  return (
                    <span key={`h-${i}`} style={{ color: covered ? c.background : "inherit" }}>
                      {ch}
                    </span>
                  );
                })}
              </span>
            </span>
          ) : null}
          {after}
        </div>
      </Editable>

      {sub ? (
        <Editable id="sub" title="副标题" style={{ marginTop: u(4), maxWidth: isPortrait ? u(80) : "66%" }}>
          <div
            style={{
              fontFamily: theme.font.body,
              fontSize: b(2.4),
              color: c.textMuted,
              lineHeight: 1.6,
              // 扫完才出来：提前出来会和"笔"抢注意力
              opacity: m === 0 ? 1 : clamp01((frame - (start + sweepDur)) / Math.max(1, fps * 0.3)),
            }}
          >
            {sub}
          </div>
        </Editable>
      ) : null}
    </SceneFrame>
  );
};
