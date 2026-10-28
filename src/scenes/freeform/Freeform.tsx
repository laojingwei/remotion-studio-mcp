import React from "react";
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig, Video, staticFile } from "remotion";
import { evalAnim, type FreeEl, type FreeformProps } from "../../../shared/freeform";
import { editRegistry } from "../ui";
import type { Theme } from "../../../shared/schema";

/**
 * 自由画布：把「数据描述的画面」渲染出来。
 *
 * 模型只写 props（background + elements），这里负责：
 *  - 背景（纯色 / 渐变 / 光斑 / 网格 / 噪点 / 图片）
 *  - 元素（文字 / 形状 / 图片 / 视频 / SVG / 特效）
 *  - 关键帧动画（x/y/size/rotate/scale/opacity，带缓动）
 *
 * 一切由当前帧决定（确定性），不读 Date.now / Math.random。
 */
const resolveSrc = (src: string) =>
  /^(https?:)?\/\//.test(src) || src.startsWith("data:")
    ? src
    : staticFile(src.replace(/^\/+/, ""));

const NOISE_URL =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2"/></filter><rect width="240" height="240" filter="url(#n)" opacity="0.35"/></svg>',
  );

const BG: React.FC<{ bg?: FreeformProps["background"]; theme: Theme }> = ({ bg, theme }) => {
  const base = bg?.colors?.[0] ?? theme.palette.background;
  const second = bg?.colors?.[1] ?? theme.palette.primary;
  const opacity = bg?.opacity ?? 1;
  const kind = bg?.kind ?? "solid";

  if (kind === "gradient") {
    return <AbsoluteFill style={{ background: `linear-gradient(135deg, ${base}, ${second})`, opacity }} />;
  }
  if (kind === "glow") {
    // 渐变在 80% 处才收干净 + 默认 blur 加大：低对比下不再结成一坨坨的硬块
    return (
      <AbsoluteFill style={{ background: base, opacity }}>
        <div
          style={{
            position: "absolute",
            left: "18%",
            top: "8%",
            width: "70%",
            height: "45%",
            background: `radial-gradient(circle at 50% 50%, ${second}55, transparent 80%)`,
            filter: `blur(${bg?.blur ?? 60}px)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            right: "8%",
            bottom: "12%",
            width: "55%",
            height: "40%",
            background: `radial-gradient(circle at 50% 50%, ${second}33, transparent 82%)`,
            filter: `blur(${(bg?.blur ?? 60) * 1.4}px)`,
          }}
        />
      </AbsoluteFill>
    );
  }
  if (kind === "grid") {
    return (
      <AbsoluteFill
        style={{
          background: base,
          opacity,
          backgroundImage: `linear-gradient(${second}22 1px, transparent 1px), linear-gradient(90deg, ${second}22 1px, transparent 1px)`,
          backgroundSize: "48px 48px",
        }}
      />
    );
  }
  if (kind === "noise") {
    return (
      <AbsoluteFill style={{ background: base, opacity }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: `url("${NOISE_URL}")`, opacity: 0.5 }} />
      </AbsoluteFill>
    );
  }
  if (kind === "image" && bg?.image) {
    return (
      <AbsoluteFill style={{ opacity }}>
        <Img
          src={resolveSrc(bg.image)}
          draggable={false}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
    );
  }
  return <AbsoluteFill style={{ background: base, opacity }} />;
};

/** 特效原语：光斑 / 网格 / 噪点 / 粒子 / 星点 */
const Fx: React.FC<{ el: FreeEl; frame: number; unit: number }> = ({ el, frame, unit }) => {
  const color = el.color ?? "#5AC8FA";
  const w = (unit * el.size) / 100;
  const speed = el.speed ?? 1;

  if (el.kind === "glow") {
    return (
      <div
        style={{
          width: w,
          height: w,
          borderRadius: "50%",
          background: `radial-gradient(circle at 50% 50%, ${color}AA, transparent 70%)`,
          filter: `blur(${w * 0.18}px)`,
        }}
      />
    );
  }
  if (el.kind === "grid") {
    return (
      <div
        style={{
          width: w,
          height: w,
          backgroundImage: `linear-gradient(${color}44 1px, transparent 1px), linear-gradient(90deg, ${color}44 1px, transparent 1px)`,
          backgroundSize: `${Math.max(8, w / 12)}px ${Math.max(8, w / 12)}px`,
        }}
      />
    );
  }
  if (el.kind === "noise") {
    // 0.35 = 默认细腻颗粒；想更浓直接调元素级 opacity（两层相乘，1 = 最浓）
    return (
      <div
        style={{
          width: w,
          height: w,
          backgroundImage: `url("${NOISE_URL}")`,
          opacity: 0.35 * (el.opacity ?? 1),
        }}
      />
    );
  }
  if (el.kind === "wave") {
    return (
      <div
        style={{
          width: w * 1.6,
          height: w,
          background: `linear-gradient(100deg, transparent 20%, ${color}44 42%, ${color}88 50%, ${color}44 58%, transparent 80%)`,
          filter: `blur(${w * 0.05}px)`,
          opacity: 0.55,
          transform: `translateX(${Math.sin(frame * speed * 0.02) * w * 0.08}px)`,
        }}
      />
    );
  }
  if (el.kind === "meteor") {
    const n = Math.round(el.density ?? 5);
    return (
      <div style={{ position: "relative", width: w, height: w, overflow: "hidden" }}>
        {Array.from({ length: n }).map((_, i) => {
          const t = ((frame * speed * 0.6 + i * 37) % 120) / 120;
          const x = (i * 29 + t * 60) % 100;
          const len = 6 + ((i * 13) % 8);
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${x}%`,
                top: `${(i * 23 + t * 90) % 100}%`,
                width: `${len}%`,
                height: 2,
                background: `linear-gradient(90deg, transparent, ${color})`,
                opacity: 0.85,
                transform: "rotate(35deg)",
              }}
            />
          );
        })}
      </div>
    );
  }
  if (el.kind === "scanlines") {
    const gap = Math.max(3, w / 90);
    return (
      <div
        style={{
          width: w,
          height: w,
          backgroundImage: `repeating-linear-gradient(0deg, ${color}26 0px, ${color}26 ${gap}px, transparent ${gap}px, transparent ${gap * 2}px)`,
          backgroundPositionY: `${(frame * speed * 2) % (gap * 2)}px`,
          opacity: 0.6,
        }}
      />
    );
  }
  if (el.kind === "rings") {
    const n = Math.round(el.density ?? 4);
    return (
      <div style={{ position: "relative", width: w, height: w }}>
        {Array.from({ length: n }).map((_, i) => {
          const t = ((frame * speed * 0.01 + i / n) % 1);
          const scale = 0.3 + t * 1.1;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                width: w * 0.7,
                height: w * 0.7,
                marginLeft: -w * 0.35,
                marginTop: -w * 0.35,
                border: `2px solid ${color}`,
                borderRadius: "50%",
                transform: `scale(${scale})`,
                opacity: (1 - t) * 0.5,
              }}
            />
          );
        })}
      </div>
    );
  }
  if (el.kind === "beam") {
    return (
      <div
        style={{
          width: w,
          height: w * 1.6,
          background: `linear-gradient(115deg, transparent 28%, ${color}66 48%, transparent 68%)`,
          filter: `blur(${w * 0.06}px)`,
          opacity: 0.7,
          transform: `rotate(${frame * speed * 0.3}deg)`,
        }}
      />
    );
  }
  if (el.kind === "dust") {
    const n = Math.round(el.density ?? 24);
    return (
      <div style={{ position: "relative", width: w, height: w }}>
        {Array.from({ length: n }).map((_, i) => {
          const x = (i * 61 + frame * speed * 0.15) % 100;
          const y = (i * 43 + Math.sin(i * 1.7 + frame * 0.02) * 8 + 100) % 100;
          const r = 1 + ((i * 5) % 2);
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${x}%`,
                top: `${y}%`,
                width: r * 2,
                height: r * 2,
                borderRadius: "50%",
                background: color,
                opacity: 0.25 + ((i * 17) % 40) / 100,
              }}
            />
          );
        })}
      </div>
    );
  }
  if (el.kind === "stars") {
    const n = Math.round(el.density ?? 40);
    return (
      <div style={{ position: "relative", width: w, height: w }}>
        {Array.from({ length: n }).map((_, i) => {
          const x = (i * 37 + 11) % 100;
          const y = (i * 53 + 7) % 100;
          const tw = 0.35 + 0.45 * Math.abs(Math.sin(frame * 0.06 + i));
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${x}%`,
                top: `${y}%`,
                width: Math.max(1.5, w * 0.012),
                height: Math.max(1.5, w * 0.012),
                borderRadius: "50%",
                background: color,
                opacity: tw,
              }}
            />
          );
        })}
      </div>
    );
  }
  // particles
  const n = Math.round(el.density ?? 40);
  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      {Array.from({ length: n }).map((_, i) => {
        const x = (i * 37 + frame * speed * 0.4) % 100;
        const y = (i * 53 + Math.sin(i + frame * 0.01) * 6 + 100) % 100;
        const r = 1 + ((i * 7) % 3);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${x}%`,
              top: `${y}%`,
              width: r * 2,
              height: r * 2,
              borderRadius: "50%",
              background: color,
              opacity: 0.35 + ((i * 13) % 40) / 100,
            }}
          />
        );
      })}
    </div>
  );
};

type OneElProps = {
  el: FreeEl;
  index: number;
  sceneId?: string;
  frame: number;
  unit: number;
  theme: Theme;
};

/**
 * 单个元素。用 memo 隔离：拖动某一个元素时，只有它的 el 引用变了，
 * 其余元素（含粒子/星点这类一次渲染几十个 DOM 的 fx）直接跳过重渲染。
 * 播放中 frame 每帧变，仍然会整体重渲染（动画本来就要动）。
 */
const OneEl = React.memo(function OneEl({ el, index, sceneId, frame, unit, theme }: OneElProps) {
  const ref = React.useRef<HTMLDivElement>(null);

  /**
   * 把自己登记进编辑器的手势层（key 与模板元素同一套：`sceneId::fc:<序号>`，
   * 自由画布元素没有稳定 id，序号就是它在 elements 里的位置）。
   *
   * 登记之后 EditOverlay 就能像编辑模板元素那样：选中框、拖动、缩放、旋转、
   * 吸附对齐、方向键微调、Delete 删除 —— 全部复用同一套手势代码，
   * 不再靠元素自己的 onMouseDown 往全局回调里塞坐标。
   */
  React.useEffect(() => {
    const node = ref.current;
    if (!node || !sceneId) return;
    const key = `${sceneId}::fc:${index}`;
    editRegistry.set(key, node);
    return () => {
      if (editRegistry.get(key) === node) editRegistry.delete(key);
    };
  }, [sceneId, index]);

  const dur = el.durationInFrames ?? Number.POSITIVE_INFINITY;
  if (frame < (el.from ?? 0) || frame >= (el.from ?? 0) + dur) return null;

  const a = evalAnim(el, frame);
  const local = frame - (el.from ?? 0);
  const sizePx = (unit * a.size) / 100;

  const inner =
    el.type === "text" ? (
      <span
        style={{
          color: el.fill ?? theme.palette.text,
          fontFamily: el.fontFamily ?? theme.font.body,
          fontSize: sizePx,
          fontWeight: el.weight ?? 600,
          lineHeight: el.lineHeight ?? 1.2,
          letterSpacing: `${el.letterSpacing ?? 0}em`,
          textAlign: el.textAlign ?? "center",
          ...(el.maxWidth ? { maxWidth: (unit * el.maxWidth) / 100 } : {}),
          display: "inline-block",
          whiteSpace: "pre-wrap",
        }}
      >
        {el.text ?? ""}
      </span>
    ) : el.type === "shape" ? (
      <div
        style={{
          width: sizePx,
          height: el.shape === "line" ? Math.max(2, sizePx * 0.03) : sizePx,
          // fill 优先；只给了 bg 也当作形状填充（否则会被主题主色盖住）
          background: el.fill ?? el.bg ?? theme.palette.primary,
          borderRadius:
            el.shape === "circle" ? "50%" : el.radius !== undefined ? (sizePx * el.radius) / 100 : 0,
          ...(el.shape === "triangle"
            ? { clipPath: "polygon(50% 0, 100% 100%, 0 100%)", background: el.fill ?? el.bg ?? theme.palette.primary }
            : {}),
        }}
      />
    ) : el.type === "image" ? (
      <Img
        src={resolveSrc(el.src ?? "")}
        // 关掉浏览器原生拖拽：否则按住图片会触发 ghost image，画布拖动直接断掉
        draggable={false}
        style={{ width: sizePx, display: "block", objectFit: "cover", borderRadius: (sizePx * (el.radius ?? 0)) / 100 }}
      />
    ) : el.type === "video" ? (
      <Video
        src={resolveSrc(el.src ?? "")}
        muted
        loop
        style={{ width: sizePx, display: "block", objectFit: "cover", borderRadius: (sizePx * (el.radius ?? 0)) / 100 }}
      />
    ) : el.type === "svg" ? (
      <svg
        viewBox={el.viewBox ?? "0 0 24 24"}
        width={sizePx}
        fill={el.fill ?? "none"}
        stroke={el.stroke ?? "none"}
        strokeWidth={el.strokeWidth ?? 2}
        strokeLinecap="round"
        style={{ display: "block" }}
        dangerouslySetInnerHTML={{ __html: el.svg ?? "" }}
      />
    ) : (
      <Fx el={el} frame={local} unit={unit} />
    );

  return (
    <div
      ref={ref}
      data-edit-id={`fc:${index}`}
      style={{
        position: "absolute",
        left: `${a.x}%`,
        top: `${a.y}%`,
        transform: `translate(-50%, -50%) rotate(${a.rotate}deg) scale(${a.scale})`,
        opacity: a.opacity,
        ...(el.bg ? { background: el.bg } : {}),
        ...(el.border
          ? {
              borderWidth: (unit * el.border) / 100,
              borderStyle: "solid",
              borderColor: el.borderColor ?? el.fill ?? "currentColor",
            }
          : {}),
        ...((el.style ?? {}) as React.CSSProperties),
      }}
    >
      {inner}
    </div>
  );
});

export const FreeformScene: React.FC<FreeformProps & { theme: Theme; sceneId?: string }> = ({
  theme,
  background,
  elements,
  sceneId,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const unit = Math.min(width, height);

  return (
    <AbsoluteFill>
      <BG bg={background} theme={theme} />
      {(elements ?? []).map((el, i) => (
        <OneEl key={i} el={el} index={i} sceneId={sceneId} frame={frame} unit={unit} theme={theme} />
      ))}
    </AbsoluteFill>
  );
};
