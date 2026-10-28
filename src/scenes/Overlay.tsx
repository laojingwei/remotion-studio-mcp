import React from "react";
import { AbsoluteFill, Audio, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig, Video } from "remotion";
import { transitionStyle } from "../../shared/transitions";
import type { OverlayElement } from "../../shared/schema";
import { editRegistry } from "./ui";

/**
 * SVG 内容是 agent / 素材库给的，这里只做最小净化：
 * 去掉脚本、内联事件和 foreignObject。渲染在 Chromium 沙箱里，
 * 但仍不该让一段素材拿到执行能力。
 */
const sanitize = (svg: string) =>
  svg
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<\s*foreignObject[\s\S]*?<\s*\/\s*foreignObject\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");

const resolveSrc = (src: string) =>
  /^(https?:)?\/\//.test(src) || src.startsWith("data:")
    ? src
    : staticFile(src.replace(/^\/+/, ""));

/**
 * 工程级叠加层：盖在所有场景之上，按 `from` / `durationInFrames` 落在时间轴上。
 * 每个元素把自己登记进 editRegistry（key `ov:<id>`），编辑层就能像编辑模板元素一样选中/拖动它。
 */
export const OverlayLayer: React.FC<{ elements?: OverlayElement[] }> = ({ elements }) => {
  if (!elements?.length) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {elements.map((el) => (
        <Sequence
          key={el.id}
          from={Math.max(0, el.from ?? 0)}
          durationInFrames={el.durationInFrames}
          name={`元素 ${el.name}`}
        >
          <OneElement el={el} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

const OneElement: React.FC<{ el: OverlayElement }> = ({ el }) => {
  const { width, height } = useVideoConfig();
  const frame = useCurrentFrame();
  const ref = React.useRef<HTMLDivElement>(null);

  // 入场 / 出场特效：入场在元素开头正向播放，出场在结束前反向播放
  const totalDur = el.durationInFrames ?? 9999;
  const enterT = el.enter;
  const enterDur = enterT && enterT.type !== "none" ? enterT.durationInFrames : 0;
  const exitT = el.exit;
  const exitDur = exitT && exitT.type !== "none" ? exitT.durationInFrames : 0;
  const enterStyle: Record<string, string | number> =
    enterDur > 0 ? transitionStyle(enterT!.type, frame, enterDur, totalDur) : {};
  const exitStyle: Record<string, string | number> =
    exitDur > 0
      ? transitionStyle(
          exitT!.type,
          Math.max(0, exitDur - Math.max(0, frame - (totalDur - exitDur))),
          exitDur,
          totalDur,
        )
      : {};

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const key = `ov:${el.id}`;
    editRegistry.set(key, node);
    return () => {
      if (editRegistry.get(key) === node) editRegistry.delete(key);
    };
  }, [el.id]);

  const unit = Math.min(width, height);
  const px = (unit * el.size) / 100;
  const isText = el.kind === "text";

  return (
    <div
      ref={ref}
      data-edit-id={`ov:${el.id}`}
      style={{
        position: "absolute",
        left: `${el.x}%`,
        top: `${el.y}%`,
        transform: `translate(-50%, -50%) rotate(${el.rotate}deg) scale(${el.scale})`,
        transformOrigin: "center",
        opacity: el.hidden ? 0 : el.opacity,
        zIndex: 100 + Math.round(el.z),
        width: isText ? undefined : px,
        display: isText ? "block" : undefined,
        whiteSpace: isText ? "pre" : undefined,
        pointerEvents: "none",
        ...(el.bg
          ? {
              background: el.bg,
              padding: px * 0.26,
              boxSizing: "border-box" as const,
            }
          : {}),
        ...(el.radius !== undefined
          ? { borderRadius: (px * el.radius) / 100 }
          : el.bg
            ? { borderRadius: px * 0.4 }
            : {}),
        ...(el.border
          ? {
              borderWidth: (px * el.border) / 100,
              borderStyle: "solid",
              borderColor: el.borderColor ?? el.fill,
            }
          : {}),
        ...(el.shadow ? { boxShadow: el.shadow } : {}),
        ...(el.filter ? { filter: el.filter } : {}),
        ...(el.clipPath ? { clipPath: el.clipPath } : {}),
        ...(el.blendMode
          ? { mixBlendMode: el.blendMode as React.CSSProperties["mixBlendMode"] }
          : {}),
        // 自定义内联样式最后应用：agent 可以用它做任何上面没预设的视觉效果
        ...((el.style ?? {}) as React.CSSProperties),
      }}
    >
      <div style={{ width: "100%", ...enterStyle, ...exitStyle }}>
      {el.kind === "svg" ? (
        <svg
          viewBox={el.viewBox}
          width="100%"
          style={{ display: "block", overflow: "visible" }}
          fill={el.stroke ? "none" : el.fill}
          stroke={el.stroke ? el.fill : "none"}
          strokeWidth={el.strokeWidth}
          strokeLinecap={el.strokeLinecap ?? "round"}
          strokeLinejoin={el.strokeLinejoin ?? "round"}
          dangerouslySetInnerHTML={{ __html: sanitize(el.svg ?? "") }}
        />
      ) : el.kind === "audio" ? (
        // 场景内音频（如 TTS 语音）：不可见，只出声；时间轴/选中框仍可操作
        <Audio
          src={resolveSrc(el.src ?? "")}
          volume={el.muted ? 0 : el.audioVolume ?? 1}
          trimBefore={el.startFrom || undefined}
          useWebAudioApi
        />
      ) : el.kind === "image" ? (
        <Img
          src={resolveSrc(el.src ?? "")}
          style={{ width: "100%", display: "block", objectFit: el.fit ?? "cover" }}
        />
      ) : el.kind === "video" ? (
        // 用 <Video> 而不是 OffthreadVideo：贴纸视频需要 loop，OffthreadVideo 不支持循环
        <Video
          src={resolveSrc(el.src ?? "")}
          muted={el.muted}
          loop={el.loop}
          startFrom={el.startFrom}
          style={{ width: "100%", display: "block", objectFit: el.fit ?? "cover" }}
        />
      ) : (
        <span
          style={{
            display: "inline-block",
            color: el.fill,
            fontFamily: el.fontFamily ?? '"Microsoft YaHei", "PingFang SC", sans-serif',
            fontSize: px,
            fontWeight: el.weight,
            lineHeight: el.lineHeight ?? 1.15,
            letterSpacing: `${el.letterSpacing ?? 0.02}em`,
            textAlign: el.textAlign,
            fontStyle: el.fontStyle,
            textDecoration: el.underline ? "underline" : undefined,
            ...(el.maxWidth
              ? { maxWidth: (unit * el.maxWidth) / 100, whiteSpace: "normal" }
              : {}),
          }}
        >
          {el.text}
        </span>
      )}
      </div>
    </div>
  );
};
