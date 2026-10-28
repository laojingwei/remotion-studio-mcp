import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, useEnter } from "../ui";

export type ImageProps = {
  theme: Theme;
  src: string;
  kicker: string;
  caption: string;
  fit: "cover" | "contain";
  scrim: number;
};

/** /assets/x.png → staticFile("assets/x.png")；http/data 原样返回 */
const resolveSrc = (src: string) => {
  if (/^(https?:)?\/\//.test(src) || src.startsWith("data:")) return src;
  return staticFile(src.replace(/^\/+/, ""));
};

export const ImageScene: React.FC<ImageProps> = ({ theme, src, kicker, caption, fit, scrim }) => {
  const { u, h, safe, isPortrait } = useSceneLayout();
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const text = useEnter(12);

  // 缓慢推近，静止图也不死板
  const zoom = interpolate(frame, [0, durationInFrames], [1, 1.06], {
    extrapolateRight: "clamp",
  });

  if (!src) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: theme.palette.background,
          alignItems: "center",
          justifyContent: "center",
          color: theme.palette.textMuted,
          fontFamily: theme.font.body,
          fontSize: h(2),
        }}
      >
        还没有选择图片（右侧属性面板可上传）
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ backgroundColor: theme.palette.background, overflow: "hidden" }}>
      {/* 背景模糊层：任何画幅的图都不会被硬裁成一条，留白也有质感 */}
      <Img
        src={resolveSrc(src)}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          filter: "blur(48px) saturate(1.2)",
          transform: `scale(${1.18 + (zoom - 1) * 0.5})`,
          opacity: fit === "contain" ? 0.55 : 0,
        }}
      />

      <Img
        src={resolveSrc(src)}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: fit,
          transform: `scale(${zoom})`,
        }}
      />

      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, rgba(0,0,0,${scrim * 0.45}) 0%, rgba(0,0,0,0) 34%, rgba(0,0,0,${scrim}) 100%)`,
        }}
      />

      <div
        style={{
          position: "absolute",
          left: u(safe.x),
          right: u(safe.x),
          bottom: u(safe.bottom),
          display: "flex",
          flexDirection: "column",
          gap: u(1.4),
          opacity: text.opacity,
          transform: `translateY(${text.y * u(1)}px)`,
        }}
      >
        {kicker ? (
          <Editable
            id="kicker"
            title="顶部小标签"
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(1.5),
              letterSpacing: u(0.24),
              textTransform: "uppercase",
              color: theme.palette.primary,
            }}
          >
            {kicker}
          </Editable>
        ) : null}
        {caption ? (
          <Editable
            id="caption"
            title="图片标题"
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(isPortrait ? 4.4 : 4.0),
              lineHeight: 1.2,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: "#FFFFFF",
              maxWidth: isPortrait ? "100%" : "70%",
              textShadow: "0 2px 24px rgba(0,0,0,0.45)",
            }}
          >
            {caption}
          </Editable>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
