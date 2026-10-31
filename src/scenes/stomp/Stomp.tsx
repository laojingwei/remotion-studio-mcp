import React from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useMotion } from "../ui";
import { clamp01 } from "../fx";

export type StompProps = {
  theme: Theme;
  /** 主文案，一行砸下来；超过 8 字会自动缩小 */
  text: string;
  /** 副标题，砸完之后出现 */
  sub: string;
  /** 顶部小标签，可留空 */
  kicker: string;
};

/**
 * 冲击字：一个字块从"很近"砸到正常大小，落地瞬间画面震一下、底部炸开一道横线。
 *
 * 与「弹跳字」的区别是**力度**：弹跳字是逐字轻快入场（口号、活泼），
 * 冲击字是一整块砸下来（"重点！这钱不是你的"）。所以它必须整块动，
 * 逐字砸会变成乱码感，反而没劲。
 *
 * 字号是**按字长算出来的**，不是固定的：这类版式一旦折行就彻底没气势，
 * 宁可字小一点也要保证一行放得下。
 */
export const StompScene: React.FC<StompProps> = ({
  theme,
  text = "",
  sub = "",
  kicker = "",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, u, h, b, isPortrait, safe } = useSceneLayout();
  const m = useMotion();
  const c = theme.palette;

  const full = String(text ?? "");
  const len = Math.max(1, Array.from(full).length);

  // 可用宽（px）÷ 字长 = 一行的极限字号，再夹在"够大"和"别溢出"之间
  const avail = isPortrait ? width - u(safe.x) * 2 : width * 0.82;
  const fit = avail / (len * 1.02);
  const fontSize = Math.max(h(3.2), Math.min(h(isPortrait ? 16.5 : 14.5), fit));

  const pop = spring({
    frame,
    fps,
    config: m > 1 ? { damping: 9, mass: 0.5, stiffness: 260 } : { damping: 13, mass: 0.55, stiffness: 200 },
    durationInFrames: Math.round(fps * 0.42),
  });
  const s = Math.max(0, Math.min(1, pop));

  // m=0 时一帧到位，不能有"从大到小"的过程
  const scale = m === 0 ? 1 : 1 + (1 - s) * 0.85;
  const opacity = m === 0 ? 1 : clamp01(s * 2.6);

  /*
   * 震动只在落地后十来帧里发生，并且**逐帧衰减到 0**。
   * 不衰减的话整段都在抖，观众会觉得渲染坏了而不是"有力"。
   */
  const land = Math.round(fps * 0.26);
  const k = Math.max(0, (frame - land) / Math.max(1, fps * 0.22));
  const decay = m === 0 ? 0 : Math.max(0, 1 - k);
  const amp = u(1.15) * (m > 1 ? 1.5 : 1) * decay;
  const shakeX = Math.sin(k * Math.PI * 2.6) * amp;
  const shakeY = Math.cos(k * Math.PI * 3.4) * amp * 0.55;

  // 落地那道横线：炸开 10 帧，再 14 帧淡掉
  const burst = m === 0 ? 0 : clamp01((frame - land) / 10);
  const burstFade = m === 0 ? 0 : Math.max(0, 1 - Math.max(0, frame - land) / 14);

  return (
    <SceneFrame theme={theme} justify="center" align="center">
      <div style={{ transform: `translate(${shakeX}px, ${shakeY}px)`, width: "100%", textAlign: "center" }}>
        {kicker ? (
          <Editable id="kicker" title="小标签" style={{ marginBottom: u(2.6) }}>
            <div
              style={{
                fontFamily: theme.font.heading,
                fontSize: b(1.7),
                letterSpacing: u(0.3),
                color: c.primary,
                opacity: m === 0 ? 1 : clamp01(s * 1.4),
              }}
            >
              {kicker}
            </div>
          </Editable>
        ) : null}

        <Editable id="text" title="主文案">
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize,
              lineHeight: 1.1,
              fontWeight: 900,
              color: c.text,
              whiteSpace: "nowrap",
              letterSpacing: u(-0.12),
              transform: `scale(${scale})`,
              opacity,
            }}
          >
            {full}
          </div>
        </Editable>

        {/* 冲击线：宽度从中间炸开，不参与布局，所以绝对定位 */}
        <div
          style={{
            position: "relative",
            height: Math.max(2, u(0.5)),
            marginTop: u(2.2),
          }}
        >
          <div
            style={{
              position: "absolute",
              left: "50%",
              transform: "translateX(-50%)",
              width: `${burst * 100}%`,
              height: "100%",
              borderRadius: 99,
              background: `linear-gradient(90deg, transparent, ${c.primary}, transparent)`,
              opacity: burstFade,
            }}
          />
        </div>

        {sub ? (
          <Editable id="sub" title="副标题" style={{ marginTop: u(3.4) }}>
            <div
              style={{
                fontFamily: theme.font.body,
                fontSize: b(2.5),
                color: c.textMuted,
                lineHeight: 1.55,
                letterSpacing: u(0.04),
                opacity: m === 0 ? 1 : clamp01((frame - land - 6) / Math.max(1, fps * 0.32)),
              }}
            >
              {sub}
            </div>
          </Editable>
        ) : null}
      </div>

      {/* 落地时整屏一记极淡的补光，让"砸"有光感；盖在最上层但不吃点击 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background: `radial-gradient(60% 40% at 50% 52%, ${withColorAlpha(c.primary, 0.22 * burstFade)}, transparent 70%)`,
        }}
      />
    </SceneFrame>
  );
};
