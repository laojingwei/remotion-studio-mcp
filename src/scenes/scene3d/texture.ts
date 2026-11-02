import React from "react";
import * as THREE from "three";
import { continueRender, delayRender, staticFile } from "remotion";
import { useThree } from "@react-three/fiber";
import type { DslMaterial } from "../../../shared/scene3dDsl";

/**
 * DSL 材质的基础色贴图加载（A 路线：外部图片）。
 *
 * 异步素材的正规做法在 iso 场景已经趟通过（`src/scenes/iso/Iso.tsx`）：
 * **delayRender / continueRender** —— Remotion 会等它完成再截帧；
 * 同一个 URL 内容不变，所以逐帧确定性不受影响。这里完全照抄那个模式。
 *
 * 三个渲染细节是这套实现的关键，动之前先读：
 *
 * 1. **色彩空间必须显式设 SRGB**。three r152+ 的纹理默认按 linear 解释，而本项目
 *    靠 `NoToneMapping` + 背景色逐像素命中做验收，漏了这行整体会发灰，且极难归因
 *    （`glowTexture()` 也是这么做的）。
 * 2. **缓存按 src + UV 变换签名分键**，不是只按 src。同一个 texture 实例只有一份
 *    repeat/offset/rotation 状态，两个节点用同一张图但不同 repeat 时必须各拿一个
 *    实例——`TextureLoader` 对同 URL 重复加载走浏览器 HTTP 缓存，代价可忽略。
 * 3. **UV 变换非恒等才设 RepeatWrapping**。恒等时保持默认 ClampToEdge：标准几何体
 *    的 UV 在 [0,1]，浮点毛边在 clamp 下无害，在 repeat 下可能渗出对侧像素。
 *
 * 加载失败返回 null：材质回退到无贴图的纯色，画面能看、样张能暴露问题，
 * 不会渲成一块无人能诊断的黑。
 */

export type DslTextureSpec = NonNullable<DslMaterial["map"]>;

/** 路径解析约定与 image/iso/freeform 一致：站内 /assets/ 走 staticFile，http/data 原样 */
const resolveSrc = (src: string): string =>
  /^(https?:)?\/\//.test(src) || src.startsWith("data:") ? src : staticFile(src.replace(/^\//, ""));

/** 加载失败也进缓存（null 哨兵），否则每一帧都会重新请求一个必然 404 的地址 */
const cache = new Map<string, THREE.Texture | null>();

const cacheKey = (src: string, sig: string) => `${src}?${sig}`;

const uvSig = (m: DslTextureSpec): string =>
  `${m.repeat?.[0] ?? 1}x${m.repeat?.[1] ?? 1}|${m.offset?.[0] ?? 0},${m.offset?.[1] ?? 0}|` +
  `${m.rotation ?? 0}|${m.center?.[0] ?? 0.5},${m.center?.[1] ?? 0.5}`;

const isIdentityUv = (m: DslTextureSpec): boolean =>
  (m.repeat?.[0] ?? 1) === 1 &&
  (m.repeat?.[1] ?? 1) === 1 &&
  (m.offset?.[0] ?? 0) === 0 &&
  (m.offset?.[1] ?? 0) === 0 &&
  (m.rotation ?? 0) === 0;

const applyUv = (t: THREE.Texture, m: DslTextureSpec): void => {
  if (!isIdentityUv(m)) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.repeat.set(m.repeat?.[0] ?? 1, m.repeat?.[1] ?? 1);
  t.offset.set(m.offset?.[0] ?? 0, m.offset?.[1] ?? 0);
  // schema 里写度（和 rotX/rotY/rotZ 同一个约定），three 的 texture.rotation 吃弧度
  t.rotation = ((m.rotation ?? 0) * Math.PI) / 180;
  t.center.set(m.center?.[0] ?? 0.5, m.center?.[1] ?? 0.5);
};

/**
 * 挂在 NodeView 上的贴图 hook。materialOf 是普通函数调不了 hook，
 * 所以加载放在组件层、texture 作为参数往下传。
 *
 * graph 的字段可能带默认值也可能没归一化过，所以这里全部按可选字段兜底读取，
 * 不假设 zod 已经 parse 过。
 */
export const useDslTexture = (map: DslTextureSpec | undefined): THREE.Texture | null => {
  const src = map?.src;
  const sig = src && map ? uvSig(map) : "";
  const [tex, setTex] = React.useState<THREE.Texture | null>(() => {
    if (!src) return null;
    const hit = cache.get(cacheKey(src, sig));
    return hit ?? null;
  });
  /**
   * 纹理到位后必须主动再画一帧：@remotion/three 的 ManualFrameRenderer 只在
   * frame 变化时 advance()，单帧静帧里 frame 恒定 —— 贴图到达触发的重渲
   * 更新了材质对象，但帧缓冲里还是第一次画的无贴图画面（灰球就是这么来的）。
   */
  const advance = useThree((s) => s.advance);
  /** onLoad 里置好后，由下面的 [tex] effect 真正放行截图 */
  const finishRef = React.useRef<() => void>(() => {});

  React.useEffect(() => {
    if (!src || !map) {
      setTex(null);
      return;
    }
    const key = cacheKey(src, sig);
    if (cache.has(key)) {
      setTex(cache.get(key) ?? null);
      return;
    }
    let alive = true;
    const handle = delayRender(`scene3d-map:${src}`);
    let done = false;
    finishRef.current = () => {
      if (!done) {
        done = true;
        continueRender(handle);
      }
    };
    new THREE.TextureLoader().load(
      resolveSrc(src),
      (t) => {
        if (alive) {
          t.colorSpace = THREE.SRGBColorSpace;
          applyUv(t, map);
          cache.set(key, t);
          setTex(t);
        }
      },
      undefined,
      () => {
        if (alive) {
          cache.set(key, null);
          setTex(null);
        }
      },
    );
    return () => {
      alive = false;
      finishRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, sig]);

  /**
   * **放行截图的时机是"状态已提交"，不是"贴图已下载"。**
   * onLoad 里 setTex 是异步调度的：如果在那里直接 continueRender，
   * Remotion 可能抢在 React 提交带 map 的新状态之前截图——贴图下载成功
   * 但截图上没有（实测出现过，data: URL 二分排除了 404 才定位到这里）。
   * 放在 effect 里：tex 变化的 commit 已完成，材质已经拿到 map，截图必然带上。
   */
  React.useEffect(() => {
    if (tex) advance(performance.now());
    finishRef.current();
  }, [tex, advance]);

  return tex;
};
