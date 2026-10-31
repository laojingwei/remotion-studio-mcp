import React from "react";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type DiagonalSplitProps = {
  theme: Theme;
  titleA: string;
  textA: string;
  titleB: string;
  textB: string;
  imageSrcA: string;
  imageSrcB: string;
  /** 斜切错位量（画面短边的百分比 0–25） */
  slant: number;
};

/** 半屏内容块：图 + 文案，图片缺失时用主题渐变占位 */
const Panel: React.FC<{
  theme: Theme;
  title: string;
  text: string;
  imageSrc: string;
  editablePrefix: string;
  enter: { opacity: number };
  horizontal: boolean;
}> = ({ theme, title, text, imageSrc, editablePrefix, enter, horizontal }) => {
  const { u, h } = useSceneLayout();
  const c = theme.palette;
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: horizontal ? "row" : "column",
        alignItems: horizontal ? "center" : "stretch",
        gap: u(2.4),
        opacity: enter.opacity,
        minWidth: 0,
      }}
    >
      <div
        style={{
          flex: horizontal ? "0 0 34%" : 1,
          minHeight: horizontal ? u(26) : u(34),
          borderRadius: u(1.6),
          overflow: "hidden",
          background: imageSrc
            ? undefined
            : `linear-gradient(135deg, ${c.primary}44, ${c.secondary}22)`,
          display: "grid",
          placeItems: "center",
        }}
      >
        {imageSrc ? (
          <img src={imageSrc} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <span style={{ fontFamily: theme.font.body, fontSize: h(1.7), color: c.textMuted }}>IMAGE</span>
        )}
      </div>
      <div
        style={{
          flex: horizontal ? 1 : 0,
          display: "flex",
          flexDirection: "column",
          gap: u(1.2),
          justifyContent: "center",
          minWidth: 0,
        }}
      >
        <Editable
          id={`${editablePrefix}title`}
          title="标题"
          style={{
            fontFamily: theme.font.heading,
            fontSize: h(3.6),
            fontWeight: 800,
            color: c.text,
            lineHeight: 1.25,
          }}
        >
          {title}
        </Editable>
        <Editable
          id={`${editablePrefix}text`}
          title="正文"
          style={{
            fontFamily: theme.font.body,
            fontSize: h(2.1),
            color: c.textMuted,
            lineHeight: 1.6,
          }}
        >
          {text}
        </Editable>
      </div>
    </div>
  );
};

/**
 * 斜切分屏：一条斜线把画面分成两半，各讲各的。
 *
 * 和 split（直切分栏）的分工：split 是并列陈述；diagonal 的斜线本身带
 * "势"—— 适合对比、交锋、"从 A 到 B"的转折。斜线两侧各压一层主题色雾，
 * 分界不用画线就看得出来。
 */
export const DiagonalSplitScene: React.FC<DiagonalSplitProps> = ({
  theme,
  titleA = "",
  textA = "",
  titleB = "",
  textB = "",
  imageSrcA = "",
  imageSrcB = "",
  slant = 10,
}) => {
  const { u, h, isPortrait } = useSceneLayout();
  const c = theme.palette;
  const enterA = useEnter(0);
  const enterB = useEnter(6);
  const s = Math.max(0, Math.min(25, Number(slant) || 10));

  // 竖屏上下两块，横屏左右两块；斜线用 polygon 裁在各自的雾层上
  const diagonal = isPortrait
    ? `polygon(0 0, 100% 0, 100% ${28 + s}%, 0 ${28 - s}%)`
    : `polygon(0 0, ${52 + s}% 0, ${52 - s}% 100%, 0 100%)`;

  return (
    <SceneFrame theme={theme} align="left">
      {/* 斜切雾层：竖屏铺上半、横屏铺左半，主色渐隐 —— 分界靠它，不用画线 */}
      <div
        style={{
          position: "absolute",
          // 必须传数字（React 自动补 px）：模板字符串会生成无单位 "-38.4"，
          // 是无效 CSS —— 整个雾层缩成零尺寸，什么都不画（矩阵 top 同一个坑）
          inset: -u(2),
          clipPath: diagonal,
          /*
           * 渐变必须**沿斜边的法向**衰减，且在 polygon 裁切线附近收到 ≈0：
           * 之前 0.65 一路铺到底，裁切线两侧 0.65→0 硬碰硬，是块绿墙加刀边；
           * 现在靠近斜边最亮、向上淡出，裁切线落在 alpha≈0 处就没有边界感。
           */
          background: `linear-gradient(${isPortrait ? "175deg" : "92deg"}, ${withColorAlpha(
            c.primary,
            0.22,
          )} 0%, ${withColorAlpha(c.primary, 0.07)} ${isPortrait ? 30 : 42}%, transparent ${isPortrait ? 46 : 58}%)`,
          opacity: enterA.opacity,
        }}
      />
      <div
        style={{
          // SceneFrame 内层是 flex + align:left → 子元素 shrink-to-fit，
          // 不显式撑满的话整组内容只有最长一行文字那么宽
          width: "100%",
          display: "flex",
          flexDirection: isPortrait ? "column" : "row",
          gap: isPortrait ? u(3) : u(5),
          flex: 1,
          alignItems: "stretch",
          // 竖屏上半给斜切让位，往下挪一点
          paddingTop: isPortrait ? u(5) : 0,
        }}
      >
        <Panel
          theme={theme}
          title={titleA}
          text={textA}
          imageSrc={imageSrcA}
          editablePrefix="a"
          enter={enterA}
          horizontal={!isPortrait}
        />
        <Panel
          theme={theme}
          title={titleB}
          text={textB}
          imageSrc={imageSrcB}
          editablePrefix="b"
          enter={enterB}
          horizontal={!isPortrait}
        />
      </div>
    </SceneFrame>
  );
};
