import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import type { Scene, Theme } from "../../shared/schema";
import { isBackdropType } from "../../shared/sceneKinds";
import { getMeta, normalizeProps } from "../../shared/sceneMetas";
import { backdropWindow, isFullWindow } from "../../shared/backdrop";
import { SCENE_COMPONENTS } from "./components";
import { BackdropFxContext, BareContext } from "./ui";

type Backdrop = NonNullable<Scene["backdrop"]>;

/**
 * 氛围层：垫在版式**底下**的一层动效。
 *
 * 三条约定，任何一条破了这层就会"看不见"或"盖住内容"：
 *  1. 必须渲染在版式之前（DOM 顺序 = 层级），所以它跟在 SceneFrame 的第一位；
 *  2. 版式必须切透明背景（Video 里用 BareContext 告知，SceneFrame 据此不画底色）；
 *  3. 只允许 BACKDROP_TYPES 里的纯氛围类型 —— 带文字的版式垫在下面会出现两套字。
 *
 * props 走 normalizeProps 而不是直接展开：动效的 schema 全是带 default 的，
 * 传一部分（比如只改 count）也要能把其余字段补齐，否则组件里会读到 undefined。
 */

/**
 * 区间内的淡入淡出。frame 是**相对出现那一刻**的（Sequence 已经偏移过），
 * 所以「第 2 秒出现、淡 10 帧」淡的是出现后的 10 帧，不是幕首的 10 帧。
 */
const BackdropBody: React.FC<{
  backdrop: Backdrop;
  theme: Theme;
  sceneId: string;
  zIndex?: number;
  duration: number;
  fadeIn: number;
  fadeOut: number;
}> = ({ backdrop, theme, sceneId, zIndex, duration, fadeIn, fadeOut }) => {
  const frame = useCurrentFrame();
  const Comp = SCENE_COMPONENTS[backdrop.type];
  if (!Comp) return null;

  const meta = getMeta(backdrop.type);
  let props: Record<string, unknown> = backdrop.props ?? {};
  if (meta) {
    try {
      props = normalizeProps(backdrop.type, props);
    } catch {
      // 参数非法不该让整幕渲染失败（那会让预览直接黑屏，看不出原因）
      props = meta.defaultProps;
    }
  }

  const base = typeof backdrop.opacity === "number" ? backdrop.opacity : 0.8;
  // 两端各留一个 0：淡入第一帧全透明、淡出最后一帧归零，接缝才不跳
  const kIn = fadeIn > 0 ? Math.min(1, frame / fadeIn) : 1;
  const kOut = fadeOut > 0 ? Math.min(1, (duration - 1 - frame) / fadeOut) : 1;
  const opacity = base * Math.max(0, Math.min(kIn, kOut));

  /*
   * BareContext = true 是**无条件**的，和 place 无关。
   *
   * 这层只负责"叠一层效果"，不负责提供背景 —— 背景永远由版式（或最外层）给。
   * 早先只在 place="下" 时才置 true，于是 place="上"/"顶" 时氛围组件会画出自己的
   * 不透明底色，z-index 又高于版式 → 整块背景把标题盖没（抽帧时标题直接消失）。
   * 当时没发现是因为验证用的是 grain，底色恰好和主题背景同色，看不出来。
   */
  return (
    <BackdropFxContext.Provider
      value={{ speed: backdrop.speed ?? 1, once: backdrop.mode === "once" }}
    >
      <BareContext.Provider value={true}>
        <AbsoluteFill
          style={{ opacity, pointerEvents: "none", ...(zIndex === undefined ? {} : { zIndex }) }}
        >
          <Comp {...props} type={backdrop.type} theme={theme} sceneId={`${sceneId}::backdrop`} />
        </AbsoluteFill>
      </BareContext.Provider>
    </BackdropFxContext.Provider>
  );
};

export const BackdropLayer: React.FC<{
  backdrop: Backdrop;
  theme: Theme;
  sceneId: string;
  /** 这一幕的总帧数：区间要按它截断，否则 from+duration 越界会让整幕没内容 */
  sceneDuration: number;
  /** 幕的入场转场帧数（0 = 硬切入场）：区间贴幕首时把柔化交给它 */
  sceneInFrames?: number;
  /** 幕的出场转场帧数（含"靠下一幕入场的接缝淡出"）：区间贴幕尾时把柔化交给它 */
  sceneOutFrames?: number;
  /**
   * 层次：不传 = 靠 DOM 顺序垫在版式下面；传了就按这个 z-index 与叠加元素(100+z)混排。
   * 版式在 SceneWrap 里，转场 transform 已经建了 stacking context，兄弟之间能比较。
   */
  zIndex?: number;
}> = ({ backdrop, theme, sceneId, sceneDuration, sceneInFrames, sceneOutFrames, zIndex }) => {
  // 白名单再挡一次：schema 只约束了"是字符串"，工程包导入 / 手改 json 都可能绕过
  if (!isBackdropType(backdrop.type)) return null;
  if (!SCENE_COMPONENTS[backdrop.type]) return null;

  const w = backdropWindow(backdrop, sceneDuration, { sceneInFrames, sceneOutFrames });
  const full = isFullWindow(w, sceneDuration);

  /*
   * 不填区间（最常见的情况）时**不套 Sequence**：多包一层会多一个节点，
   * 存量工程要逐像素不变，这一条不能靠"看起来一样"来保证。
   *
   * layout="none" 是必须的：Sequence 默认会渲染一个 AbsoluteFill 包裹层，
   * 内部的 zIndex 就只能在包裹层里比较，和版式/贴纸的层叠关系直接失效。
   */
  const body = (
    <BackdropBody
      backdrop={backdrop}
      theme={theme}
      sceneId={sceneId}
      zIndex={zIndex}
      duration={w.duration}
      fadeIn={w.fadeIn}
      fadeOut={w.fadeOut}
    />
  );

  if (full) return body;

  return (
    <Sequence
      from={w.from}
      durationInFrames={w.duration}
      layout="none"
      name={`氛围层 ${backdrop.type}`}
    >
      {body}
    </Sequence>
  );
};
