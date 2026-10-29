import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, Highlighted, SceneFrame, useEnter } from "../ui";

export type QuoteProps = {
  theme: Theme;
  text: string;
  author: string;
  highlight: string;
};

export const QuoteScene: React.FC<QuoteProps> = ({ theme, text, author, highlight }) => {
  const { u, h, b, isPortrait, width, unit, headScale, safe } = useSceneLayout();
  /**
   * 横屏字号：优先一行放下。
   *
   * 金句折行最容易出「交付。」这种两字孤儿行，一句话的节奏被打断，
   * 停顿感全无。所以先算一行能放多大：容器 84% × 内层 92%，再除字数。
   * 太长的句子（>30 字）算出来会很小，那就不逼它，落到 3.6 单位正常折行。
   */
  const len = [...(text ?? "")].length;
  // 可用宽度要减掉两侧安全区再乘容器与内层的百分比，不能用画面宽直接乘 ——
  // 少算这 8%，21 个字就会差一个字挤到下一行（实测「付。」单独一行）
  const avail = (width - 2 * u(safe.x)) * 0.84 * 0.92 * 0.96;
  // 0.96 是留给字体 advance 的余量：中文字面宽通常 > 1em（实测约 1.02em），
  // 不留这点余量就会「刚好差一个字」折行，最后一行只剩一个「付。」
  const fit = len ? avail / (len * unit * headScale) : 99;
  const quoteSize = isPortrait ? 5.0 : Math.max(3.6, Math.min(4.4, fit));

  const bar = useEnter(0);
  const body = useEnter(6);
  const sign = useEnter(20);

  return (
    <SceneFrame theme={theme} justify="center">
      {/* 外层必须 width:100%：竖线 + 正文是一个 flex row，
          若让它按内容收缩，正文里的 max-width 百分比会跟着一起缩，
          金句就会「9 个字就折行」 */}
      <div
        style={{
          display: "flex",
          gap: u(3),
          alignItems: "stretch",
          // 横屏收成 76% 并居中：一行字横在左边 60% 的位置，右边空着，
          // 看着像忘了排版。收窄居中之后两侧留白是匀的，才像「故意的停顿」
          width: isPortrait ? "100%" : "84%",
          margin: isPortrait ? 0 : "0 auto",
        }}
      >
        {/* 引用块左侧的竖线，比引号字形更稳、不受字体影响 */}
        <div
          style={{
            width: Math.max(3, u(0.55)),
            background: theme.palette.primary,
            borderRadius: 99,
            transform: `scaleY(${bar.progress})`,
            transformOrigin: "top",
            opacity: 0.9,
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minWidth: 0 }}>
          <Editable
            id="quote"
            title="金句正文"
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(quoteSize),
              lineHeight: 1.42,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              color: theme.palette.text,
              maxWidth: isPortrait ? "100%" : "92%",
              opacity: body.opacity,
              transform: `translateY(${body.y * u(1)}px)`,
            }}
          >
            <Highlighted text={text} highlight={highlight} color={theme.palette.primary} />
          </Editable>

          {author ? (
            <Editable
              id="author"
              title="署名"
              style={{
                display: "flex",
                alignItems: "center",
                gap: u(1.4),
                marginTop: u(3.4),
                opacity: sign.opacity,
              }}
            >
              <div
                style={{
                  fontFamily: theme.font.body,
                  fontSize: b(1.9),
                  color: theme.palette.textMuted,
                  letterSpacing: u(0.06),
                }}
              >
                — {author}
              </div>
            </Editable>
          ) : null}
        </div>
      </div>
    </SceneFrame>
  );
};
