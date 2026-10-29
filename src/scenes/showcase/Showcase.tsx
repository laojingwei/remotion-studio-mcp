import React from "react";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { clampHeadSize } from "../../../shared/textFit";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

/** 题材场景的装饰色：不同题材一眼能区分 */
const ACCENTS: Record<string, string> = {
  life: "#F2C46D",
  game: "#7CE0FF",
  tech: "#8B7CFF",
  edu: "#FFB347",
  live: "#FF6B81",
  shop: "#C6F24E",
};

const BADGES: Record<string, string> = {
  life: "VLOG",
  game: "GAME",
  tech: "TECH",
  edu: "COURSE",
  live: "LIVE",
  shop: "SHOP",
};

export type ShowcaseProps = {
  theme: Theme;
  /** 场景类型，用来选装饰色/默认标签 */
  type?: string;
  badge?: string;
  title: string;
  subtitle?: string;
  items?: string[];
};

/** 题材场景：生活 / 游戏 / 科技 / 教学 / 直播 / 电商共用一套版式，配色区分 */
export const ShowcaseScene: React.FC<ShowcaseProps> = ({
  theme,
  type = "life",
  badge,
  title,
  subtitle,
  items = [],
}) => {
  const { u, h, b, unit, width, headScale, safe, isPortrait } = useSceneLayout();
  const accent = ACCENTS[type] ?? theme.palette.primary;
  const label = badge || BADGES[type] || "";
  const enter = useEnter(0);
  const tags = items.slice(0, 4);

  const tagPills = (fontSize: number, align: "flex-start" | "flex-end") =>
    tags.length ? (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: align,
          gap: u(1.2),
          minWidth: 0,
        }}
      >
        {tags.map((item, i) => (
          <Editable key={`${item}-${i}`} id={`item${i + 1}`} title="标签">
            <span
              style={{
                display: "inline-block",
                fontFamily: theme.font.body,
                fontSize,
                color: accent,
                border: `1px solid ${withColorAlpha(accent, 0.55)}`,
                borderRadius: 999,
                padding: `${u(0.75)}px ${u(1.7)}px`,
                whiteSpace: "nowrap",
              }}
            >
              {item}
            </span>
          </Editable>
        ))}
      </div>
    ) : null;

  /**
   * ── 横屏：报头 / 标题 / 页脚，三段贴边 ──
   *
   * 竖屏那套「标签—标题—副标题—胶囊」是一列往下堆的，直接搬进 16:9 就只剩左边
   * 三分之一，右边整片黑 —— 测下来 26%–45% 宽。根因不是字号小，是**每一行都短**：
   * 标题 7 个字、副标题一行、胶囊三个，谁都没法把横向撑开。
   *
   * 横屏给了横向余地，就按封面的排法分成三段、各占一条边：
   *   1) 报头贴顶：题材标签 + 一条横贯到右边缘的细线（细线是排版意图，不是装饰，
   *      它把左上角那个孤立单词和右边连起来，眼睛才认为这页排满了）
   *   2) 标题居中：按「一行放得下」算字号顶满宽度，不折行
   *   3) 页脚压底：副标题靠左、标签靠右，一左一右把底边也撑开
   *
   * 三段用 space-between 撑满整个安全区高度，而不是整体居中——
   * 居中会让 45% 的高度变成上下一对黑边，页脚那排胶囊也会飘在半空（改版前就是这样）。
   *
   * 为什么不让标题折两行填空：中文折行会断在词中间（「发呆」被切开），
   * 比小一号难看；宁可一行铺满。
   */
  if (!isPortrait) {
    // 一行放得下的字号，夹在 [4.6, 14] 之间：下限保证远处读得清，
    // 上限防止四五个字的短标题变成标语墙（等效字数换算见 shared/textFit.ts）
    const size = clampHeadSize(title, width - 2 * u(safe.x), unit, headScale, 4.6, 14);

    return (
      <SceneFrame theme={theme} justify="start">
        <div
          style={{
            flex: 1,
            width: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            opacity: enter.opacity,
            transform: `translateY(${enter.y * u(1)}px)`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: u(2.6) }}>
            {label ? (
              <span
                style={{
                  fontFamily: theme.font.heading,
                  fontSize: b(1.7),
                  letterSpacing: u(0.18),
                  fontWeight: 700,
                  color: accent,
                  flex: "0 0 auto",
                }}
              >
                {label}
              </span>
            ) : null}
            <div
              style={{
                flex: 1,
                height: Math.max(1, u(0.16)),
                background: `linear-gradient(90deg, ${withColorAlpha(accent, 0.7)}, ${withColorAlpha(accent, 0.06)})`,
              }}
            />
          </div>

          <Editable id="title" title="主标题">
            <div
              style={{
                fontFamily: theme.font.heading,
                fontSize: h(size),
                fontWeight: 800,
                lineHeight: 1.12,
                color: theme.palette.text,
                letterSpacing: "-0.03em",
              }}
            >
              {title}
            </div>
          </Editable>

          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              gap: u(4),
              width: "100%",
            }}
          >
            <div style={{ maxWidth: "46%", minWidth: 0 }}>
              {subtitle ? (
                <Editable id="subtitle" title="副标题">
                  <div
                    style={{
                      fontFamily: theme.font.body,
                      fontSize: b(2.2),
                      lineHeight: 1.5,
                      color: theme.palette.textMuted,
                      letterSpacing: u(0.02),
                    }}
                  >
                    {subtitle}
                  </div>
                </Editable>
              ) : null}
            </div>
            <div style={{ maxWidth: "50%", minWidth: 0 }}>
              {tagPills(b(1.9), "flex-end")}
            </div>
          </div>
        </div>
      </SceneFrame>
    );
  }

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: u(2.2),
          opacity: enter.opacity,
          transform: `translateY(${enter.y * u(1)}px)`,
        }}
      >
        {label ? (
          <span
            style={{
              fontFamily: theme.font.body,
              fontSize: h(1.7),
              letterSpacing: u(0.16),
              color: accent,
              fontWeight: 700,
            }}
          >
            {label}
          </span>
        ) : null}

        <Editable id="title" title="主标题">
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(6.0),
              fontWeight: 800,
              lineHeight: 1.2,
              color: theme.palette.text,
              letterSpacing: "-0.02em",
            }}
          >
            {title}
          </div>
        </Editable>

        {subtitle ? (
          <Editable id="subtitle" title="副标题">
            <div
              style={{
                fontFamily: theme.font.body,
                fontSize: h(2.1),
                color: theme.palette.textMuted,
                letterSpacing: u(0.02),
              }}
            >
              {subtitle}
            </div>
          </Editable>
        ) : null}

        {tags.length ? (
          <div style={{ marginTop: u(1.4) }}>{tagPills(h(1.8), "flex-start")}</div>
        ) : null}
      </div>
    </SceneFrame>
  );
};
