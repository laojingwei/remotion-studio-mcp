import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { useBackdropFx, useBare, useMotion } from "../ui";

export type GlowProps = {
  theme: Theme;
  /** 双色最热闹，单色更克制 */
  tone: "双色" | "主色" | "次色";
  /** 0–1，光斑浓度 */
  intensity: number;
  /** 光斑缓慢漂移（关掉 = 完全静止） */
  drift: boolean;
  /** 极淡网格，给画面一点结构 */
  grid: boolean;
};

/** hex 色值加透明度；不是 #rrggbb 就原样返回（不猜用户传了什么） */
const alpha = (color: string, a: number) => {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : "";
  if (!hex) return color;
  const v = Math.max(0, Math.min(1, a));
  return `${hex}${Math.round(v * 255).toString(16).padStart(2, "0")}`;
};

/**
 * 光晕呼吸：整屏氛围层。
 *
 * 为什么做成独立版式而不是给每个版式加背景开关：
 * 那次返工里「背景太单调」是第一条意见，而当时所有版式的背景都由 SceneFrame 统一给一层极淡光斑，
 * 改不动、也调不浓。把它拆成一种幕，好处是「这一幕想要强氛围」可以直接插一幕，
 * 而不是去改所有版式的默认值。
 *
 * 尺寸全部走 unit（短边百分比），竖屏横屏都成立，不依赖 1280×720 这类固定画布。
 */
export const GlowScene: React.FC<GlowProps> = ({
  theme,
  tone = "双色",
  intensity = 0.55,
  drift = true,
  grid = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, isPortrait } = useSceneLayout();
  const m = useMotion();
  const bare = useBare();
  const { speed: timeScale } = useBackdropFx();
  const p = theme.palette;

  const t = (frame / fps) * timeScale;
  const move = drift && m > 0 ? m : 0;
  const pulse = 1 + Math.sin(t * 0.9) * 0.06 * move;

  const blobs =
    tone === "主色"
      ? [{ c: p.primary, x: 22, y: 18, r: 78, o: 1 }]
      : tone === "次色"
        ? [{ c: p.secondary, x: 78, y: 26, r: 82, o: 1 }]
        : [
            { c: p.primary, x: 22, y: 18, r: 78, o: 1 },
            { c: p.secondary, x: 78, y: 26, r: 82, o: 0.85 },
            { c: p.primary, x: 62, y: 88, r: 70, o: 0.5 },
          ];

  return (
    <AbsoluteFill style={{ background: bare ? "transparent" : p.background, overflow: "hidden" }}>
      {blobs.map((b, i) => {
        const dx = Math.sin(t * 0.35 + i * 2.1) * 6 * move;
        const dy = Math.cos(t * 0.28 + i * 1.7) * 5 * move;
        return (
          <div
            key={`glow-${i}`}
            style={{
              position: "absolute",
              left: `${b.x + dx}%`,
              top: `${b.y + dy}%`,
              width: u(b.r * (isPortrait ? 1.1 : 0.9)),
              height: u(b.r * (isPortrait ? 1.1 : 0.9)),
              transform: `translate(-50%, -50%) scale(${pulse})`,
              borderRadius: "50%",
              // 用 radial-gradient 而不是 filter:blur —— 模糊层在 1080×1920 上很贵，
              // 渐变本身就能出软边，渲染快一截
              background: `radial-gradient(circle at 50% 50%, ${alpha(b.c, 0.55 * intensity * b.o)} 0%, ${alpha(b.c, 0.26 * intensity)} 38%, transparent 70%)`,
              mixBlendMode: "screen",
            }}
          />
        );
      })}

      {grid ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            // 网格步长按短边给（u），所以横屏列数会更多、看着更"密"。
            // 横屏把线条压淡一档：同样的 alpha 在 1920 宽的画面里比竖屏抢眼得多。
            backgroundImage: `linear-gradient(${alpha(p.text, isPortrait ? 0.06 : 0.025)} 1px, transparent 1px), linear-gradient(90deg, ${alpha(p.text, isPortrait ? 0.06 : 0.025)} 1px, transparent 1px)`,
            backgroundSize: `${u(9)}px ${u(9)}px`,
            maskImage: "radial-gradient(circle at 50% 45%, #000 30%, transparent 78%)",
            WebkitMaskImage: "radial-gradient(circle at 50% 45%, #000 30%, transparent 78%)",
          }}
        />
      ) : null}

      {/* 压边：不让光斑糊到画面四角，主体区更干净 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle at 50% 50%, transparent 45%, ${alpha(p.background, 0.85)} 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};
