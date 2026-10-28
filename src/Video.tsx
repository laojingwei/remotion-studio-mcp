import React from "react";
import {
  AbsoluteFill,
  Audio,
  Freeze,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { AudioClip, Project, Scene, Theme } from "../shared/schema";
import { sceneSpans } from "../shared/schema";
import { sceneBoxCss, type SceneBox } from "../shared/sceneBox";
import { seamOverlaps, transitionStyle } from "../shared/transitions";
import { effectFrameStyle, type EffectClip } from "../shared/effects";
import { SCENE_COMPONENTS } from "./scenes/components";
import { OverlayLayer } from "./scenes/Overlay";
import { MotionContext, SceneEditContext, sceneBoxRegistry } from "./scenes/ui";
import { sceneSubtitleLines } from "../shared/subtitle";
import { curveGainAt, duckGainAt, voiceSpans } from "../shared/audio";
import { parseColor, withColorAlpha } from "../shared/color";

const SceneWrap: React.FC<{
  children: React.ReactNode;
  scene: Scene;
  durationInFrames: number;
  /** 接缝已经交给下一幕的入场转场时，本幕的出场要关掉（否则叠化会双重变暗） */
  ignoreOut?: boolean;
}> = ({ children, scene, durationInFrames, ignoreOut }) => {
  const frame = useCurrentFrame();
  const inT = scene.transitionIn;
  const outT = scene.transitionOut;
  const d = inT && inT.type !== "none" ? inT.durationInFrames : 0;
  const od = !ignoreOut && outT && outT.type !== "none" ? outT.durationInFrames : 0;
  if (d <= 0 && od <= 0) return <>{children}</>;

  // 具体样式在 shared/transitions.ts（纯函数，可单测；新增转场只改那一处）
  const style: Record<string, string | number> = {};
  if (d > 0) Object.assign(style, transitionStyle(inT!.type, frame, d, durationInFrames));
  if (od > 0) {
    // 出场 = 反向播放同一套转场：结束前 od 帧内，进度从 1 走到 0
    const x = frame - (durationInFrames - od);
    Object.assign(
      style,
      transitionStyle(outT!.type, Math.max(0, od - Math.max(0, x)), od, durationInFrames),
    );
  }
  return <AbsoluteFill style={style}>{children}</AbsoluteFill>;
};

/**
 * 画面框（画中画）：把整个场景容器缩放/平移到指定位置。
 * 全屏时**不加任何样式**，渲染结果与多轨改造之前逐像素一致。
 */
const SceneFrame: React.FC<{ sceneId: string; box?: SceneBox; children: React.ReactNode }> = ({
  sceneId,
  box,
  children,
}) => {
  const { width, height } = useVideoConfig();
  const css = sceneBoxCss(box, width, height);
  const ref = React.useRef<HTMLDivElement>(null);

  // 登记给编辑器：画布上的画中画框要靠它量位置（渲染端没人读，无副作用）
  React.useEffect(() => {
    if (!css) return;
    const node = ref.current;
    if (!node) return;
    const key = `sc:${sceneId}`;
    sceneBoxRegistry.set(key, node);
    return () => {
      if (sceneBoxRegistry.get(key) === node) sceneBoxRegistry.delete(key);
    };
  }, [css, sceneId]);

  if (!css) return <>{children}</>;
  return (
    <AbsoluteFill ref={ref} style={css as React.CSSProperties}>
      {children}
    </AbsoluteFill>
  );
};

/**
 * 特效容器：把「整个画面」包起来做 transform / filter（震动、冲击、模糊）。
 *
 * **没有激活特效时不包这一层** —— 多一个 AbsoluteFill 也会多一层堆叠上下文，
 * 老工程必须逐像素不变。覆盖类特效（闪白 / 暗角）不在这一层，见 EffectOverlays。
 */
const EffectWrap: React.FC<{ effects?: EffectClip[]; children: React.ReactNode }> = ({
  effects,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const style = effectFrameStyle(effects, frame, fps);
  if (!style.transform && !style.filter && style.opacity === undefined) return <>{children}</>;
  return (
    <AbsoluteFill style={{ transform: style.transform, filter: style.filter, opacity: style.opacity }}>
      {children}
    </AbsoluteFill>
  );
};

/** 特效覆盖层：闪白 / 暗角这类「盖在画面上」的特效，必须压在所有场景之上 */
const EffectOverlays: React.FC<{ effects?: EffectClip[] }> = ({ effects }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { overlays } = effectFrameStyle(effects, frame, fps);
  if (!overlays.length) return null;
  return (
    <>
      {overlays.map((o) => (
        <AbsoluteFill
          key={o.key}
          style={{
            background: o.background,
            opacity: o.opacity,
            mixBlendMode: (o.blend ?? undefined) as React.CSSProperties["mixBlendMode"],
            pointerEvents: "none",
          }}
        />
      ))}
    </>
  );
};

/** 字幕烧录层：按 scene.subtitle 的字数比例分配，幕内逐句显示（与导出的 SRT 同一套逻辑） */
const SubtitleLayer: React.FC<{ scene: Scene; theme: Theme }> = ({ scene, theme }) => {  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const lines = sceneSubtitleLines(scene);
  if (!lines.length) return null;
  const cur = lines.find((l) => frame >= l.start && frame < l.end);
  if (!cur) return null;

  const unit = Math.min(width, height);
  const st = scene.subtitleStyle ?? {};
  // 字幕默认配色按主题背景亮度推导：浅色主题用纸底墨字，深色主题用黑底白字
  const bgRgb = parseColor(theme.palette.background ?? "#000000");
  const lum = bgRgb ? (0.299 * bgRgb.r + 0.587 * bgRgb.g + 0.114 * bgRgb.b) / 255 : 0;
  const light = lum > 0.62;
  const defBg = light ? "#FFFFFF" : "#000000";
  const defColor = light ? "#111111" : "#FFFFFF";
  const fontSize = (((st.fontSize ?? 2.6) * unit) / 100);
  const bottom = (((st.bottom ?? 6.5) * unit) / 100);
  const strokeW = (((st.stroke ?? 0) * unit) / 100);
  const bg = withColorAlpha(st.bg ?? defBg, st.bgOpacity ?? (light ? 0.9 : 0.55));
  const padV = unit * 0.014;
  const padH = unit * 0.024;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: bottom,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          background: bg,
          color: st.color ?? defColor,
          fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
          fontSize,
          fontWeight: st.bold ?? 600,
          lineHeight: st.lineHeight ?? 1.35,
          letterSpacing: `${st.letterSpacing ?? 0.01}em`,
          textAlign: st.align ?? "center",
          ...(strokeW > 0
            ? { WebkitTextStroke: `${strokeW}px ${st.strokeColor ?? "#000000"}` }
            : {}),
          textShadow: st.shadow ?? "0 1px 2px rgba(0,0,0,0.4)",
          padding: `${padV}px ${padH}px`,
          borderRadius: unit * 0.014,
          maxWidth: `${st.maxWidth ?? 86}%`,
          ...((st.css ?? {}) as React.CSSProperties),
        }}
      >
        {cur.text}
      </div>
    </AbsoluteFill>
  );
};

/** 站内素材走 staticFile()，外链/data URI 原样 */
const resolveAudioSrc = (src: string) =>
  /^(https?:)?\/\//.test(src) || src.startsWith("data:") ? src : staticFile(src.replace(/^\/+/, ""));

/** 背景音乐：支持淡入淡出 + 人声避让，音量随时间插值 */
const SoundTrack: React.FC<{ audio: NonNullable<Project["audio"]>; fps: number; scenes: Scene[] }> = ({
  audio,
  fps,
  scenes,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fadeIn = Math.max(1, Math.round(audio.fadeIn * fps));
  const fadeOut = Math.max(1, Math.round(audio.fadeOut * fps));

  const baseVolume = interpolate(
    frame,
    [0, fadeIn, Math.max(fadeIn + 1, durationInFrames - fadeOut), durationInFrames],
    [0, audio.volume, audio.volume, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const start = Math.max(0, audio.from ?? 0);
  const length = Math.min(
    durationInFrames - start,
    audio.durationInFrames ?? Math.max(1, durationInFrames - start),
  );

  /**
   * 人声避让：本组件在 `<Sequence from={start}>` 内部，`useCurrentFrame()` 是**相对帧**，
   * 而人声区间是时间轴绝对时间 —— 所以加回 start 再去查增益。
   * spans 只依赖 scenes，useMemo 一下避免每帧重算。
   */
  const duck = audio.ducking;
  const voice = React.useMemo(
    () => (duck && duck.enabled === false ? [] : voiceSpans(scenes, fps)),
    [scenes, fps, duck?.enabled],
  );
  /**
   * 动态增益曲线（压缩）：同样按绝对时间查 —— 曲线是从素材第 0 秒开始量的，
   * 所以要拿「相对帧 + start」再减去 `startFrom` 之外的偏移，这里按时间轴时间即可。
   */
  const curve = audio.gainCurve;
  const volume =
    (duck && duck.enabled !== false && voice.length
      ? baseVolume * duckGainAt(frame + start, voice, duck, fps)
      : baseVolume) * curveGainAt(curve, (frame + start) / fps);

  if (length <= 0) return null;

  return (
    <Sequence from={start} durationInFrames={length}>
      {/* useWebAudioApi：音量 >1 时预览靠 GainNode 放大；不加的话浏览器把 volume 夹到 1，
          会出现"面板写着 300%、预览没变、只有成片变大" */}
      <Audio src={resolveAudioSrc(audio.src)} volume={volume} loop={audio.loop} useWebAudioApi />
    </Sequence>
  );
};

/** 音效轨：挂在 Sequence 里，帧号是相对的，所以淡入从 0 开始算就行 */
const TrackAudio: React.FC<{ clip: AudioClip; fps: number }> = ({ clip, fps }) => {
  const frame = useCurrentFrame();
  const fadeIn = Math.max(0, Math.round(clip.fadeIn * fps));
  const base =
    fadeIn > 0
      ? interpolate(frame, [0, fadeIn], [0, clip.volume], { extrapolateRight: "clamp" })
      : clip.volume;
  const volume = base * curveGainAt(clip.gainCurve, frame / fps);
  return <Audio src={resolveAudioSrc(clip.src)} volume={volume} useWebAudioApi />;
};

export type VideoProps = Project & { formatKey: string };

/**
 * 唯一渲染入口：Project + formatKey → 画面。
 * 与画幅无关，画幅只决定 useVideoConfig() 的 width/height。
 */
export const Video: React.FC<VideoProps> = ({ scenes, theme, audio, audioTracks, effects, fps }) => {
  const spans = sceneSpans(scenes);
  /**
   * 接缝重叠：第 i 幕要**往后再多渲染几帧**，好让下一幕的入场转场跨过接缝。
   * 不改时间轴数学（spans / 总时长一律不动），只是渲染窗口变长 —— 见
   * `shared/transitions.ts#seamOverlaps`。
   */
  const overlaps = seamOverlaps(scenes, spans);
  const scenesLayer = (
    <MotionContext.Provider value={theme?.motion ?? 1}>
    <>
      {audio?.src ? <SoundTrack audio={audio} fps={fps} scenes={scenes} /> : null}
      {(audioTracks ?? []).map((clip) => (
        <Sequence
          key={clip.id}
          from={Math.max(0, Math.round(clip.from))}
          durationInFrames={clip.durationInFrames}
          name={`♪ ${clip.name}`}
        >
          <TrackAudio clip={clip} fps={fps} />
        </Sequence>
      ))}

      {scenes.map((scene, i) => {
        const Comp = SCENE_COMPONENTS[scene.type];
        if (!Comp) return null;
        const span = spans[i];
        const overlap = overlaps[i] ?? 0;
        const body = (
          <SceneWrap
            scene={scene}
            durationInFrames={scene.durationInFrames}
            ignoreOut={overlap > 0}
          >
            <SceneFrame sceneId={scene.id} box={scene.box}>
              {/* 元素偏移要按场景隔离，转场重叠时两边的 id 才不打架 */}
              <SceneEditContext.Provider
                value={{ sceneId: scene.id, transforms: scene.transforms }}
              >
                <Comp {...scene.props} type={scene.type} theme={theme} sceneId={scene.id} />
                {/* 场景内的自由元素：各自有场景内的 from / duration，跟着这个场景转场进出 */}
                <OverlayLayer elements={scene.elements} />
                {/* 字幕只烧主轨：画中画的小窗里再糊一行字，画面就废了 */}
                {span.track === 0 ? <SubtitleLayer scene={scene} theme={theme} /> : null}
              </SceneEditContext.Provider>
            </SceneFrame>
          </SceneWrap>
        );
        return (
          <Sequence
            key={scene.id}
            from={span.start}
            durationInFrames={span.dur + overlap}
            name={`${i + 1}. ${scene.name}`}
            // 轨道号就是叠放层号：轨道大的（画中画）盖在上面。
            // 主轨不加 z-index —— 旧工程因此与多轨改造前逐像素一致（不额外造层叠上下文）
            style={span.track > 0 ? { zIndex: span.track } : undefined}
          >
            {/*
              接缝重叠区里本幕已经"播完"了，内容要定格在最后一帧：
              否则动画会继续推进/过冲，而它只是被下一幕渐显盖住的底图。
            */}
            {overlap > 0 ? (
              <Freeze frame={span.dur - 1} active={(f) => f >= span.dur}>
                {body}
              </Freeze>
            ) : (
              body
            )}
          </Sequence>
        );
      })}
    </>
    </MotionContext.Provider>
  );
  return (
    <AbsoluteFill style={{ backgroundColor: theme.palette.background }}>
      <EffectWrap effects={effects}>{scenesLayer}</EffectWrap>
      <EffectOverlays effects={effects} />
    </AbsoluteFill>
  );
};
