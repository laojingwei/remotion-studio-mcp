import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBackdropFx, useBare, useMotion } from "../ui";

export type VhsProps = {
  theme: Theme;
  /** 主文案，可留空（留空 = 纯氛围层） */
  text: string;
  /** 故障强度 0–1 */
  intensity: number;
  /** 扫描线密度（越大越密） */
  lines: number;
};

const rnd = (i: number, salt: number) => {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * VHS 故障：扫描线 + 色差 + 周期性 tracking 错位。
 *
 * 只做了"能看出是磁带"的四个信号，没做过度特效：
 *  1. 水平扫描线（细、密、恒在）
 *  2. 缓慢下移的亮带（磁头扫过）
 *  3. 文字的红/青双色偏移（色差），偏移量随帧抖
 *  4. 不定期的横向错位条（tracking error）
 *
 * 注意：**不用 filter: blur / 大面积 mix-blend-mode 叠层**，
 * 十几层混合会让渲染直接掉速；这里的层次全靠透明度和渐变。
 */
export const VhsScene: React.FC<VhsProps> = ({
  theme,
  text = "",
  intensity = 0.5,
  lines = 5,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, h, isPortrait, height } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const { speed: timeScale } = useBackdropFx();
  const c = theme.palette;

  const amt = Math.max(0, Math.min(1, intensity));
  const t = (frame / fps) * timeScale;
  // 色差偏移：常态 1–2px，每 3–4 秒猛抖一下
  const jitter = m === 0 ? 0 : Math.sin(t * 37) * 0.6 + (rnd(Math.floor(t * 6), 1) > 0.86 ? 2.4 : 0);
  const dx = (0.8 + amt * 2.6 + Math.abs(jitter)) * (isPortrait ? 1 : 1.3);

  // tracking 错位带：每 1.4 秒换一次位置/高度
  const slot = Math.floor(t * 0.7);
  const bandActive = rnd(slot, 2) > 0.35;
  const bandTop = 8 + rnd(slot, 3) * 78;
  const bandH = 2.4 + rnd(slot, 4) * 6;

  const fontSize = h(isPortrait ? 10 : 8.4);

  return (
    <AbsoluteFill style={{ backgroundColor: bare ? "transparent" : c.background, overflow: "hidden" }}>
      {/* 0. 底亮：老磁带的黑不是纯黑，纯黑会让整帧像「关了机」 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(180deg, ${c.text}12, ${c.text}08 62%, ${c.text}0e)`,
        }}
      />

      {/* 1. 扫描线：恒定一层，密度可调 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          // 间距必须用 u()（像素）而不是固定 px：固定 12px 在 1080p 下会与像素网格打拍子，
          // 出现一段密一段疏的摩尔纹（竖屏抽帧就是这个毛病）
          backgroundImage: `repeating-linear-gradient(0deg, rgba(0,0,0,${0.26 + amt * 0.18}) 0px, rgba(0,0,0,${
            0.26 + amt * 0.18
          }) 1px, transparent 1px, transparent ${Math.max(2, Math.round(u((0.9 * 5) / Math.max(2, lines))))}px)`,
        }}
      />

      {/* 2. 缓慢下移的亮带（磁头） */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `${((t * 11) % 130) - 15}%`,
          height: `${Math.round((u(9) / height) * 100)}%`,
          background: `linear-gradient(180deg, transparent, ${c.text}0d 45%, ${c.text}14 55%, transparent)`,
        }}
      />

      {/* 3. tracking 错位条：一条带半透明色偏的横条，位置跳变 */}
      {bandActive ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: `${bandTop}%`,
            height: `${bandH}%`,
            background: `linear-gradient(90deg, ${c.primary}22, ${c.secondary}1f, ${c.primary}22)`,
            // 错位感来自这条带与画面的位移差，不是模糊
            transform: `translateX(${(rnd(slot, 5) - 0.5) * 4}%)`,
            opacity: 0.2 + amt * 0.26,
          }}
        />
      ) : null}

      {text ? (
        <AbsoluteFill
          style={{
            padding: `${u(10)}px ${u(8)}px`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              fontFamily: theme.font.heading,
              fontSize,
              fontWeight: 900,
              lineHeight: 1.15,
              letterSpacing: u(0.1),
              color: c.text,
              textAlign: "center",
              whiteSpace: "pre-wrap",
              // 色差：红/青各偏一侧，偏移量随 jitter 抖
              textShadow: `${-dx}px 0 ${c.primary}99, ${dx}px 0 ${c.secondary}99`,
              transform: `translateX(${jitter * 0.4}px)`,
            }}
          >
            {text}
          </div>
        </AbsoluteFill>
      ) : null}

      {/* 四角压边：老录像的画面不会顶满边 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at 50% 50%, transparent 74%, ${c.background}99 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};
