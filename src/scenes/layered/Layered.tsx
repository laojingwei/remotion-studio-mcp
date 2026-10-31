import React from "react";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";
import { rnd } from "../fx";

export type LayeredProps = {
  theme: Theme;
  /** 卡片 2–4 张，最后一张在最前面 */
  items: { title: string; text: string }[];
};

/**
 * 层叠卡片：几张卡片错位叠放，最前一张讲重点，后面几张露出边角当"库存"。
 *
 * 和 cards（网格）的分工：cards 是"条目很多"（并列平铺）；
 * layered 是"一张重点 + 背书"（焦点式）—— 最多 4 张，超过就是网格的事了。
 *
 * hooks 纪律：每张卡的 useEnter 住在 Card 子组件里，不能写在 map 回调里
 * （racebars/funnel 同一个教训）。
 */
const Card: React.FC<{
  theme: Theme;
  title: string;
  text: string;
  index: number;
  total: number;
  front: boolean;
  rot: number;
  dx: number;
  dy: number;
}> = ({ theme, title, text, index, total, front, rot, dx, dy }) => {
  const { u, h, isPortrait } = useSceneLayout();
  const c = theme.palette;
  const enter = useEnter(index * 6);
  // 越靠后的卡越小、越暗：露出边角即可，不抢前面的戏
  const depth = front ? 1 : 1 - ((total - 1 - index) * 0.055);
  return (
    <div
      style={{
        position: front ? "relative" : "absolute",
        // 前卡撑满：SceneFrame align:left 下 shrink-to-fit 会缩成一行字宽
        width: front ? "100%" : "100%",
        inset: front ? undefined : 0,
        transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(${depth.toFixed(3)})`,
        opacity: enter.opacity * (front ? 1 : 0.95 - (total - 1 - index) * 0.18),
        zIndex: front ? 10 + index : index,
        borderRadius: u(1.8),
        padding: u(3),
        display: "flex",
        flexDirection: "column",
        gap: u(1.4),
        justifyContent: "center",
        // 前卡保底体量：纯一行字时卡会缩成一条，层叠感全无
        minHeight: front ? (isPortrait ? u(36) : u(28)) : undefined,
        background: front
          ? withColorAlpha(c.surface, 0.94)
          : withColorAlpha(c.surface, 0.72),
        // 背景卡用主色描边：深底上 surface 卡和不透明度再高也糊在一起，
        // 一圈主色边才是"这里还有牌"的信号
        border: `1px solid ${withColorAlpha(c.primary, front ? 0.45 : 0.55)}`,
        boxShadow: front
          ? `0 ${u(2)} ${u(5)} ${withColorAlpha("#000000", 0.32)}`
          : `0 ${u(1)} ${u(2)} ${withColorAlpha("#000000", 0.2)}`,
        // 后面的卡是"背景"，不给编辑入口（点到的是前面这张）
        pointerEvents: front ? undefined : "none",
      }}
    >
      {front ? (
        <>
          <Editable
            id={`card${index + 1}-title`}
            title="标题"
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(isPortrait ? 3.8 : 3.2),
              fontWeight: 800,
              color: c.text,
              lineHeight: 1.3,
            }}
          >
            {title}
          </Editable>
          <Editable
            id={`card${index + 1}-text`}
            title="正文"
            style={{
              fontFamily: theme.font.body,
              fontSize: h(2.2),
              color: c.textMuted,
              lineHeight: 1.65,
            }}
          >
            {text}
          </Editable>
        </>
      ) : null}
    </div>
  );
};

export const LayeredScene: React.FC<LayeredProps> = ({ theme, items }) => {
  const { u, isPortrait } = useSceneLayout();
  const list = (items ?? []).filter((it) => it && (it.title || it.text)).slice(0, 4);
  const cards = list.length >= 1 ? list : [{ title: "卡片标题", text: "写一句话说明这张卡片讲什么" }];
  const back = cards.slice(0, -1); // 背景卡
  const frontCard = cards[cards.length - 1];
  const spread = u(4.5);

  return (
    <SceneFrame theme={theme} align="left">
      <div
        style={{
          position: "relative",
          width: "100%",
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: isPortrait ? u(60) : u(44),
          maxWidth: isPortrait ? "100%" : u(78),
          margin: "0 auto",
        }}
      >
        {/* 背景卡：位置从序号用 rnd 算（确定性），带一点手放的错位感 */}
        {back.map((it, i) => {
          const rot = (rnd(i, 3) - 0.5) * 8;
          const dx = (rnd(i, 1) - 0.5) * spread * 2;
          const dy = (rnd(i, 2) - 0.5) * spread * 2;
          return (
            <Card
              key={`ly-${i}`}
              theme={theme}
              title={it.title}
              text={it.text}
              index={i}
              total={cards.length}
              front={false}
              rot={rot}
              dx={dx}
              dy={dy}
            />
          );
        })}
        <Card
          theme={theme}
          title={frontCard.title}
          text={frontCard.text}
          index={cards.length - 1}
          total={cards.length}
          front
          rot={(rnd(cards.length, 3) - 0.5) * 1.5}
          dx={0}
          dy={0}
        />
      </div>
    </SceneFrame>
  );
};
