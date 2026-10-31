import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame } from "../ui";
import { clamp01, easeOut } from "../fx";

export type SlotProps = {
  theme: Theme;
  /** 顶部标题，可留空 */
  heading: string;
  /** 转轮符号池（2–8 个，用 emoji 或单字） */
  symbols: string[];
  /** 中奖符号（必须在符号池里；留空 = 随机取第一个） */
  result: string;
  /** 底部说明，可留空 */
  note: string;
};

const REELS = 3;
/** 转轮从起转到停稳的帧数 */
const SPIN_FRAMES = 55;

/**
 * 老虎机：三列符号滚轮依次减速停稳，停一列亮一列。
 *
 * 直播抽奖 / 开奖场景的"仪式感"来源是**依次停下**：三列同时停就是换页，
 * 一列一列停才是开奖。全部用确定性计算（帧号 → 位置），不用随机数。
 *
 * countdown 的分工：countdown 是"还有多久"（等待），slot 是"开什么"（揭晓）。
 */
export const SlotScene: React.FC<SlotProps> = ({ theme, heading = "", symbols, result = "", note = "" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, h, isPortrait } = useSceneLayout();
  const c = theme.palette;

  const pool = (symbols ?? []).filter((s) => typeof s === "string" && s.trim()).slice(0, 8);
  const sym = pool.length >= 2 ? pool : ["🎁", "💎", "🔥", "⭐"]; // 兜底：少于 2 个转不起来
  const win = sym.includes(result) ? result : sym[0];
  const winIdx = sym.indexOf(win);

  const cellSize = isPortrait ? h(11) : h(8.5);
  const gap = u(1.6);

  return (
    <SceneFrame theme={theme} align="center">
      {heading ? (
        <Editable
          id="heading"
          title="标题"
          style={{
            fontFamily: theme.font.heading,
            fontSize: h(isPortrait ? 4.6 : 3.8),
            fontWeight: 800,
            color: c.text,
            marginBottom: u(3),
          }}
        >
          {heading}
        </Editable>
      ) : null}

      {/* 机身：一台圆角机器，内嵌三个观察窗 */}
      <div
        style={{
          display: "flex",
          gap,
          padding: u(2.2),
          borderRadius: u(2),
          background: withColorAlpha(c.surface, 0.65),
          border: `1px solid ${withColorAlpha(c.text, 0.12)}`,
        }}
      >
        {Array.from({ length: REELS }, (_, r) => {
          // 每列错开 8 帧依次停：停稳的时刻 = (r+1) * 8 + SPIN_FRAMES？不 ——
          // 让第一列最快停，逐列变慢才有"快要出了"的悬念：停稳帧 = 40 + r * 14
          const stopAt = 40 + r * 14;
          const p = clamp01(frame / stopAt);
          const settled = p >= 1;
          // 位移：转 many 圈再 easeOut 收到中奖符号；收得越慢停得越"肉"
          const laps = 3 + r; // 后面的列多转一圈，视觉上"更纠结"
          const strip = [...sym, ...sym, ...sym];
          const cellPx = cellSize + gap;
          const total = laps * sym.length * cellPx;
          const offset = (1 - easeOut(p)) * total + winIdx * cellPx;
          // 停稳后的一下"落定"回弹（0.1 个格子，60ms 内收掉）
          const bounce = settled ? Math.sin(clamp01((frame - stopAt) / 6) * Math.PI) * cellPx * 0.08 : 0;

          return (
            <div
              key={`slot-${r}`}
              style={{
                width: cellSize,
                height: cellSize * 1.25,
                borderRadius: u(0.8),
                overflow: "hidden",
                position: "relative",
                background: withColorAlpha(c.background, 0.55),
                border: `1px solid ${withColorAlpha(c.text, 0.1)}`,
                // 观察窗上下压暗：转轮的"洞"感
                boxShadow: `inset 0 ${u(1.4)} ${u(1.6)} ${withColorAlpha("#000000", 0.28)}, inset 0 -${u(
                  1.4,
                )} ${u(1.6)} ${withColorAlpha("#000000", 0.28)}`,
              }}
            >
              <div style={{ position: "absolute", left: 0, right: 0, top: `${(-offset - bounce).toFixed(1)}px` }}>
                {strip.map((s, i) => (
                  <div
                    key={`sym-${r}-${i}`}
                    style={{
                      height: cellSize,
                      marginBottom: gap,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: cellSize * 0.6,
                      lineHeight: 1,
                      fontFamily: theme.font.heading,
                    }}
                  >
                    {s}
                  </div>
                ))}
              </div>
              {/* 中线：两侧的细线标记中奖位置 */}
              <div
                style={{
                  position: "absolute",
                  left: u(0.5),
                  right: u(0.5),
                  top: "50%",
                  borderTop: `1px dashed ${withColorAlpha(c.primary, 0.4)}`,
                }}
              />
              {settled ? (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    border: `2px solid ${withColorAlpha(c.primary, 0.55 * (1 - clamp01((frame - stopAt - 8) / 20)))}`,
                    borderRadius: u(0.8),
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {note ? (
        <Editable
          id="note"
          title="说明"
          style={{
            marginTop: u(3),
            fontFamily: theme.font.body,
            fontSize: h(isPortrait ? 2.4 : 2.1),
            color: c.textMuted,
            maxWidth: isPortrait ? u(76) : "70%",
          }}
        >
          {note}
        </Editable>
      ) : null}
    </SceneFrame>
  );
};
