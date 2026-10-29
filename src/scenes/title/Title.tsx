import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, Eyebrow, Highlighted, SceneFrame, useEnter } from "../ui";

export type TitleProps = {
  theme: Theme;
  eyebrow: string;
  title: string;
  subtitle: string;
  highlight: string;
  align: "left" | "center";
};

export const TitleScene: React.FC<TitleProps> = ({
  theme,
  eyebrow,
  title,
  subtitle,
  highlight,
  align,
}) => {
  const { u, h, b, isPortrait, width, unit, headScale, safe } = useSceneLayout();
  const a = useEnter(1);
  const sub = useEnter(7);
  const c = useEnter(16);

  // 标题长了就自动降号，别让它折行把版式撑破
  const len = (title ?? "").length;
  const titleSize = len <= 8 ? 9.4 : len <= 12 ? 7.4 : len <= 18 ? 6.0 : 5.0;

  /**
   * 横屏且带副标题时走「双栏跨页」。
   *
   * 为什么：竖屏的标题页是「上标签 / 中标题 / 下副标题」的竖排，搬进 16:9 之后
   * 整块内容只占左边 50%、右边整片空 —— 这不是留白，是没排完。
   * 横屏有横向空间，就把副标题挪到右栏、中间加一条竖发丝线，
   * 用现有内容撑成左右对话的两栏，而不是靠放大字号硬填（字号放大到能填满时必然折行炸版）。
   */
  const spread = !isPortrait && !!subtitle;

  /**
   * 横屏标题字号 = min(想要的放大倍数, 一行放得下的最大字号)。
   *
   * 只放大不管宽度，10 个字就开始折行，而且中文折行会断在词中间
   * （「完播 / 率」「剪 / 辑」），比小一号更难看。所以先算一行能放多少：
   * 可用宽度 ≈ 画面宽 × 0.92（两侧安全区），再除字数。
   * 上限 1.35 倍是不想让它变成大字报，下限 4.4 单位是保证远处也读得清。
   */
  const fitSize = len > 0 ? ((width - 2 * u(safe.x)) * 0.96) / (len * unit * headScale) : 99;
  const landscapeSize = spread ? Math.max(4.4, Math.min(titleSize * 1.35, fitSize)) : titleSize;

  const headBlock = (
    <>
      <Editable
        id="eyebrow"
        style={{ opacity: a.opacity, transform: `translateY(${a.y * u(1)}px)` }}
        title="顶部小标签"
      >
        <Eyebrow text={eyebrow} theme={theme} />
      </Editable>

      <Editable
        id="title"
        as="h1"
        title="主标题"
        style={{
          margin: 0,
          fontFamily: theme.font.heading,
          fontSize: h(isPortrait ? titleSize * 0.79 : landscapeSize),
          lineHeight: 1.08,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          color: theme.palette.text,
          maxWidth: isPortrait || spread ? "100%" : "88%",
          opacity: sub.opacity,
          transform: `translateY(${sub.y * u(1)}px)`,
        }}
      >
        <Highlighted text={title} highlight={highlight} color={theme.palette.primary} />
      </Editable>
    </>
  );

  const subBlock = subtitle ? (
    <Editable
      id="subtitle"
      as="p"
      title="副标题"
      style={{
        margin: 0,
        marginTop: spread ? 0 : u(3.2),
        fontFamily: theme.font.body,
        fontSize: b(isPortrait ? 2.5 : 2.8),
        lineHeight: 1.62,
        color: theme.palette.textMuted,
        maxWidth: isPortrait ? "92%" : "100%",
        opacity: c.opacity,
        transform: `translateY(${c.y * u(1)}px)`,
      }}
    >
      {subtitle}
    </Editable>
  ) : null;

  if (spread) {
    return (
      <SceneFrame theme={theme} align="left">
        {/**
         * 对角构图：标题占上方 74%（够一行放下 12–14 字），副标题落到右下角 38%。
         *
         * 试过左右平分两栏：标题只能给到 54% 宽，13 个字必然折成「11+2」两行，
         * 断在词中间（「剪辑」被切开），比不折还难看。让标题吃满上方，
         * 副标题往右下角去，反而既有横向铺满、又有对角线的呼吸感。
         */}
        <div style={{ width: "100%", display: "flex", flexDirection: "column" }}>
          <div style={{ width: "100%" }}>{headBlock}</div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: u(7),
            }}
          >
            <div style={{ width: "42%", minWidth: 0 }}>{subBlock}</div>
          </div>
        </div>
      </SceneFrame>
    );
  }

  return (
    <SceneFrame theme={theme} align={align}>
      {headBlock}
      {subBlock}
    </SceneFrame>
  );
};
