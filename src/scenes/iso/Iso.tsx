import React, { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, useEnter } from "../ui";

export type IsoFocus = { part: string; at: number; dur: number; label?: string };

export type IsoProps = {
  theme: Theme;
  /** /assets/projects/<id>/iso/<名>.svg —— 用 external-tools 技能画出来 */
  src: string;
  kicker: string;
  caption: string;
  fit: "contain" | "cover";
  scrim: number;
  /** 按帧高亮零件；不填就是一张安静的图 */
  focus: IsoFocus[];
  /** 推镜：from→to 是整体缩放，x/y 是画布比例的平移（-1..1） */
  camera: { from: number; to: number; x: number; y: number };
  /** 高亮时其余零件压到多暗（0=全压黑 1=不压） */
  dim: number;
  sceneId?: string;
};

/** /assets/x.svg → staticFile("assets/x.svg")；http/data 原样返回 */
const resolveSrc = (src: string) => {
  if (/^(https?:)?\/\//.test(src) || src.startsWith("data:")) return src;
  return staticFile(src.replace(/^\/+/, ""));
};

/**
 * 渲染端也过一遍净化，和服务端 iso-embed 是同一套规则。
 * 不是重复劳动：素材可能绕过 embed 直接放进 assets（用户手传、别的工具产出），
 * 内联 SVG 之后里面的 <script> 会真的执行 —— 这条必须长在渲染层里。
 */
const sanitize = (svg: string) =>
  svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");

export const IsoScene: React.FC<IsoProps> = ({
  theme,
  src,
  kicker,
  caption,
  fit,
  scrim,
  focus,
  camera,
  dim,
  sceneId,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const { u, h, safe, isPortrait } = useSceneLayout();
  const text = useEnter(12);

  /**
   * SVG 必须内联（不能 <img>）：高亮和聚焦要碰到 SVG 内部的 [data-part]，
   * 而 <img> 里的 SVG 是独立文档，外面任何 CSS 都进不去。
   * 读文件用 delayRender —— Remotion 会等它完成再截帧，这正是"异步素材"的正规做法；
   * 同一个 URL 内容不变，逐帧确定性不受影响。
   */
  const [svgText, setSvgText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!src) {
      setSvgText(null);
      return;
    }
    let alive = true;
    let done = false;
    const handle = delayRender(`iso:${src}`);
    const finish = () => {
      if (!done) {
        done = true;
        continueRender(handle);
      }
    };
    fetch(resolveSrc(src))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => {
        if (alive) setSvgText(sanitize(t));
      })
      .catch(() => {
        if (alive) setFailed(true);
      })
      .finally(finish);
    return () => {
      alive = false;
      finish();
    };
  }, [src]);

  /** 当前帧该亮谁：窗口内的全部亮（允许多个零件同时处于讲解段） */
  const active = (focus ?? [])
    .filter((f) => f.part && frame >= f.at && frame < f.at + Math.max(1, f.dur))
    .map((f) => f.part);

  const hostId = `iso-${(sceneId ?? "x").replace(/[^a-zA-Z0-9_-]/g, "")}`;
  /**
   * 高亮是**帧的纯函数**（不是 CSS transition）：
   * 每帧重算一段 <style>，跳帧渲染、随机 seek 都不会出现"高亮没跟上"的残影。
   * dim 规则只作用于带 data-part 的元素 —— 底座/标尺这些没标记的保持原样，
   * 它们本来就是"环境"，压黑了图反而读不懂。
   */
  const focusCss = active.length
    ? `#${hostId} [data-part]{opacity:${dim}}` +
      active
        .map(
          (p) =>
            `#${hostId} [data-part="${p}"]{opacity:1;filter:brightness(1.55) drop-shadow(0 0 12px rgba(255,255,255,.28))}`,
        )
        .join("")
    : "";

  const zoom = interpolate(
    frame,
    [0, durationInFrames],
    [camera?.from ?? 1, camera?.to ?? camera?.from ?? 1],
    { extrapolateRight: "clamp" },
  );
  const panX = (camera?.x ?? 0) * zoom * 2;
  const panY = (camera?.y ?? 0) * zoom * 2;

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
        还没有插图（先用 external-tools 技能画一张，再把 /assets/… 填进来）
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ backgroundColor: theme.palette.background, overflow: "hidden" }}>
      {/* 极浅的晕影：让插图的"桌面"和片子的底色接上，不出现硬边 */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 90% at 50% 42%, ${theme.palette.surface}66 0%, transparent 62%)`,
        }}
      />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: u(isPortrait ? 6 : 8),
        }}
      >
        <div
          id={hostId}
          className="iso-host"
          style={{
            width: fit === "contain" ? "100%" : `${(100 / Math.max(zoom, 1)) * 1.12}%`,
            transform: `scale(${zoom}) translate(${panX}%, ${panY}%)`,
            transformOrigin: "50% 50%",
            lineHeight: 0,
          }}
          dangerouslySetInnerHTML={{ __html: svgText ?? "" }}
        />
      </div>

      {focusCss ? <style dangerouslySetInnerHTML={{ __html: focusCss }} /> : null}

      {failed ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: theme.palette.textMuted,
            fontFamily: theme.font.body,
            fontSize: h(2),
          }}
        >
          插图加载失败（{src}）
        </div>
      ) : null}

      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, rgba(0,0,0,${scrim * 0.4}) 0%, rgba(0,0,0,0) 32%, rgba(0,0,0,${scrim}) 100%)`,
          pointerEvents: "none",
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
            title="图解标题"
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(isPortrait ? 4.2 : 3.8),
              lineHeight: 1.2,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: "#FFFFFF",
              maxWidth: isPortrait ? "100%" : "72%",
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
