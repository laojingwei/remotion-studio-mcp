import * as THREE from "three";
import type { RootState } from "@react-three/fiber";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

/**
 * 阈值辉光（UnrealBloomPass），走 three 自带后处理，不引第三方库。
 *
 * ## 为什么不用 `@react-three/postprocessing`
 *
 * 它用 priority 1 的 `useFrame` 接管渲染，而 `ThreeCanvas` 是 `frameloop="never"` +
 * 手动 `advance()`：Remotion 判"可以截屏"的时刻早于 composer 输出到默认帧缓冲，
 * 整帧是空的（实测调 frameBufferType / 关 MSAA 都不变一个像素）。
 *
 * ## 这里的做法：劫持 `gl.render`，而不是挂 useFrame
 *
 * R3F 每次 advance 都会调 `gl.render(scene, camera)`。把 `gl.render` 换成
 * "composer.render()"，后处理就发生在 **R3F 渲染的同一次同步调用里**，
 * 调用栈返回时像素已经在屏幕上，Remotion 什么时候截屏都赶得上 —— 这是绕开
 * 时序问题的唯一可靠位置。RenderPass 内部会再调一次 `renderer.render()`，
 * 用 `inside` 标志让它走回原始实现，否则无限递归。
 *
 * ## 为什么之前 CSS 全屏混合不够
 *
 * CSS 的 `blur + brightness + screen` 没有亮度阈值：它把**整个物体**都当成高光提亮，
 * 于是金属的锐利高光被抹平、物体整圈发白，观感从"金属"掉到"发光糖果"。
 * UnrealBloomPass 只取 `luminance > threshold` 的部分，才是"光溢出"而不是"整体提亮"。
 */

export type BloomOptions = {
  /** 强度：0–1，浅色主题要压到 0.2 附近，否则白底直接蒙一层雾 */
  strength: number;
  /** 扩散半径：0–1，越大光晕越散 */
  radius: number;
  /** 亮度阈值：线性空间亮度，只让超过它的像素发光 */
  threshold: number;
};

export type BloomHandle = {
  setSize: (cssWidth: number, cssHeight: number) => void;
  dispose: () => void;
};

/**
 * 装上辉光。必须在 `onCreated` 里调用（同步、早于首帧），
 * 放 `useEffect` 里会晚于 Remotion 截的第一帧 —— 这个坑和 envMap 那个是同一个。
 */
export function installBloom(
  state: Pick<RootState, "gl" | "scene" | "camera" | "size">,
  opts: BloomOptions,
): BloomHandle {
  const { gl, scene, camera, size } = state;
  const dpr = gl.getPixelRatio();
  const px = (v: number) => Math.max(1, Math.round(v * dpr));

  /**
   * 自建渲染目标而不是让 EffectComposer 自己建：
   * 上下文上的 `antialias: true` 在"渲染到 RT"时是无效的（它只作用于默认帧缓冲），
   * 不走 RT 的 samples 的话，接管渲染后画面的边缘会比原来明显更糙。
   */
  const target = new THREE.WebGLRenderTarget(px(size.width), px(size.height), {
    type: THREE.HalfFloatType,
    samples: 4,
  });

  const composer = new EffectComposer(gl, target);
  composer.setPixelRatio(dpr);

  const renderPass = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(px(size.width), px(size.height)),
    opts.strength,
    opts.radius,
    opts.threshold,
  );
  // OutputPass 负责 linear → sRGB（以及 tone mapping）：
  // 少了它，composer 把**线性**结果直接贴到屏幕上，画面会明显发灰发亮
  const output = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(output);
  composer.setSize(size.width, size.height);

  const original = gl.render.bind(gl);
  let inside = false;

  gl.render = ((s: THREE.Object3D, c: THREE.Camera) => {
    if (inside) {
      // composer 的 RenderPass 内部回调：走原始渲染，否则无限递归
      original(s as THREE.Scene, c);
      return;
    }
    // 相机/场景可能在 props 变化后被替换，每次接管前同步一次
    renderPass.scene = s as THREE.Scene;
    renderPass.camera = c;
    inside = true;
    try {
      composer.render();
    } finally {
      inside = false;
    }
  }) as typeof gl.render;

  return {
    setSize: (cssWidth, cssHeight) => {
      composer.setPixelRatio(dpr);
      composer.setSize(cssWidth, cssHeight);
      bloom.setSize(px(cssWidth), px(cssHeight));
    },
    dispose: () => {
      gl.render = original as typeof gl.render;
      bloom.dispose();
      output.dispose();
      renderPass.dispose?.();
      composer.dispose();
      target.dispose();
    },
  };
}
