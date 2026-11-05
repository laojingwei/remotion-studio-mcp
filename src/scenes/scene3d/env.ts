import * as THREE from "three";
import React from "react";
import { continueRender, delayRender, staticFile } from "remotion";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

/**
 * 程序化「棚拍」环境贴图（IBL）。
 *
 * ## 为什么必须换掉 `RoomEnvironment`
 *
 * `RoomEnvironment` 是一间**均匀白墙房间**：从任何角度看都是同样的柔光。它对"别让金属变塑料"
 * 够用，但对"真实"完全不够 —— 金属和水面**几乎不反射直射光**，它们整个"面"都是环境反射。
 * 环境是一块均匀灰，反射出来就是一块均匀灰：看不到高光形状、看不到明暗过渡，
 * 只能在"奶糖"和"死黑"之间二选一（这正是蒸汽机车首版被说"看不清"的物理原因）。
 *
 * 真实感来自**环境里有形状的亮部**：窗户、柔光箱、天空的梯度。
 * 这里用同样的原理在内存里搭一个：
 *
 * - 一圈**天空梯度**（天顶暗、地平线亮）—— 提供大面积的柔和过渡
 * - 一块**主光柔光箱**（暖白，高强度）—— 金属上那条最亮的长条高光
 * - 一块**侧光板**（冷）—— 轮廓反光
 * - 一块**顶光板** —— 顶面的淡亮，防止俯视时一片死黑
 * - 一块**地面反弹**（暗）—— 底面的暗部，让物体"坐"在环境里
 *
 * 亮度全部写成 **HDR 值（>1）**：`THREE.Color` 内部是浮点，乘 6 就是"比纯白亮 6 倍"，
 * PMREM 采样时原样保留。这正是真实 HDRI 的工作方式 —— 贴图里没有"白色"，
 * 只有"远高于 1 的亮度"。
 *
 * ## 为什么用 WeakMap 缓存
 *
 * PMREM 生成要跑一遍 GPU（几十毫秒）。Remotion 一帧一张图、每帧都可能重建 Canvas，
 * 每次都重建会直接拖垮渲染。同一个 `WebGLRenderer` 只生成一次。
 */

export type EnvTextures = { env: THREE.Texture };

const cache = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();

/** 天空梯度的公开版：世界背景和 IBL 共用同一段 shader，颜色一致才不会"前后景两套天" */
export const skyShader = {
  vertex: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragment: /* glsl */ `
    uniform vec3 topColor;
    uniform vec3 bottomColor;
    uniform vec3 glowColor;
    /** 银河带的法线（各大圆的法线不同）、带色、强度；强度 0 = 不画，普通天空零成本 */
    uniform vec3 bandNormal;
    uniform vec3 bandColor;
    uniform vec3 nebulaColor;
    uniform float bandStrength;
    uniform float nebulaStrength;
    varying vec3 vDir;

    /**
     * 3D 值噪声。**不能用球面经纬度参数化**：那样星星/云在极点会挤成一团，
     * 而相机一抬头正好看的就是极点。直接对方向向量做 3D 采样，全天分布均匀。
     */
    float hash13(vec3 p3) {
      p3 = fract(p3 * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float vnoise(vec3 x) {
      vec3 i = floor(x);
      vec3 f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), f.x),
            mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
        mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x),
            mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
        f.z);
    }
    float fbm(vec3 p) {
      float a = 0.5;
      float s = 0.0;
      for (int k = 0; k < 4; k++) {
        s += a * vnoise(p);
        p *= 2.03;
        a *= 0.5;
      }
      return s;
    }

    void main() {
      vec3 d = normalize(vDir);
      // 地平线附近过渡最急，天顶最缓：smoothstep 的下沿压到 0 以下，
      // 让"贴地的那一圈"也有变化，否则低机位看成一条硬边
      float t = smoothstep(-0.18, 0.72, d.y);
      vec3 col = mix(bottomColor, topColor, t);
      // 地平线暖光带：真实世界里太阳/棚灯在地球表面附近漫射出一道亮带，
      // 少了它，渐变是"纯数学"的，一眼假。深空模式把 glowColor 给 0 即可关掉
      float band = 1.0 - smoothstep(0.0, 0.14, abs(d.y - 0.02));
      col += glowColor * band;

      if (bandStrength > 0.001) {
        // 到银河带平面的距离（方向空间），带中心 0、两侧增大
        float dist = abs(dot(d, normalize(bandNormal)));
        float core = 1.0 - smoothstep(0.0, 0.16, dist);   // 约 18° 宽的银盘，平滑收边（高斯衰减太急，看着像光柱）
        float halo = 1.0 - smoothstep(0.0, 0.42, dist);   // 更宽的外围云气
        float n1 = fbm(d * 7.0);                     // 大尺度云团
        float n2 = fbm(d * 22.0 + 11.0);             // 细节纹理
        /**
         * 尘埃暗带：真实银河中心偏一侧有一条暗缝（未电离的分子云挡光）。
         * 只加亮不加暗，带子会是一条均匀的发光带 —— 那是"雾霾"不是银河。
         */
        float dust = exp(-((dist - 0.03) * (dist - 0.03)) / 0.0016) * (0.4 + 0.6 * n2);
        float m = core * (0.15 + 1.05 * n1) * (0.8 + 0.3 * n2);
        col += bandColor * m * (1.0 - 0.75 * dust) * bandStrength;
        if (nebulaStrength > 0.001) {
          // 星云只吃外围 halo：贴着银盘的色气会把它染成一条彩色带
          float neb = halo * smoothstep(0.35, 0.85, n1 * 0.7 + n2 * 0.5);
          col += nebulaColor * neb * nebulaStrength;
        }
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

const lin = (hex: string) => new THREE.Color(hex);

/** 一块发光的柔光板（HDR：颜色值乘 k 之后可以远超 1） */
const panel = (
  w: number,
  h: number,
  hex: string,
  k: number,
  pos: [number, number, number],
  lookAtOrigin = true,
): THREE.Mesh => {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ color: lin(hex).multiplyScalar(k), side: THREE.DoubleSide }),
  );
  mesh.position.set(...pos);
  if (lookAtOrigin) mesh.lookAt(0, 0.8, 0);
  return mesh;
};

/**
 * 搭一个"棚"：天空梯度 + 四块灯板 + 地面反弹，然后 PMREM 成一张环境贴图。
 *
 * 尺度刻意用十几到几十个单位（而不是 1）：PMREM 捕获的是**方向**，
 * 但灯板的相对大小决定了高光在球面上占多大面积 —— 板子太小，金属上只有一颗针尖。
 */
function buildStudio(): THREE.Scene {
  const scene = new THREE.Scene();

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(60, 32, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        // 天空本体比灯板暗一个数量级：它的作用是"填底"，不是"照明"
        topColor: { value: lin("#2C3444").multiplyScalar(0.5) },
        bottomColor: { value: lin("#59636F").multiplyScalar(0.35) },
        glowColor: { value: lin("#FFB877").multiplyScalar(0.16) },
        // 棚拍不需要银河：强度 0，shader 里整段跳过
        bandNormal: { value: new THREE.Vector3(0, 1, 0) },
        bandColor: { value: lin("#000000") },
        nebulaColor: { value: lin("#000000") },
        bandStrength: { value: 0 },
        nebulaStrength: { value: 0 },
      },
      vertexShader: skyShader.vertex,
      fragmentShader: skyShader.fragment,
    }),
  );
  scene.add(sky);

  // 主光柔光箱：最大最亮的一块，决定金属上那条主高光的位置
  scene.add(panel(18, 13, "#FFF4E6", 6.5, [14, 15, 11]));
  // 侧光板（冷）：轮廓反光，让暗侧不是纯黑
  scene.add(panel(12, 16, "#C8DAFF", 2.6, [-15, 7, 7]));
  // 逆光板：把主体从背景里"剥"出来
  scene.add(panel(10, 9, "#DCE8FF", 3.2, [-2, 8, -17]));
  // 顶光：俯视机位下防止顶面死黑
  const top = panel(24, 24, "#FFFFFF", 1.4, [0, 26, 0], false);
  top.rotation.x = Math.PI / 2;
  scene.add(top);
  // 地面反弹：真实环境里地面会把光弹回物体下半部，缺了它物体像"贴"在虚空里
  const bounce = panel(40, 40, "#3A4048", 0.9, [0, -8, 0], false);
  bounce.rotation.x = -Math.PI / 2;
  scene.add(bounce);

  return scene;
}

/**
 * 取（或生成）这一份渲染器上的环境贴图。
 *
 * `sigma` 给 0.03：稍微模糊一点，柔光箱的边缘不会在金属上留下硬边。
 * 想要"亮铬"就把 sigma 降到 0.01，代价是塑料感回来。
 */
export function studioEnvironment(gl: THREE.WebGLRenderer): THREE.Texture {
  const hit = cache.get(gl);
  if (hit) return hit;

  const pmrem = new THREE.PMREMGenerator(gl);
  pmrem.compileEquirectangularShader();
  const studio = buildStudio();
  const tex = pmrem.fromScene(studio, 0.03).texture;

  // 生成完就把临时的场景资源放掉：PMREM 已经把结果烘进贴图，留着只是占显存
  studio.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | undefined;
    mat?.dispose?.();
  });
  pmrem.dispose();

  cache.set(gl, tex);
  return tex;
}

/* ─────────────────────── 全景图（照片世界） ─────────────────────── */

/**
 * 一张等距柱状（2:1）全景图当「世界」：**背景和照明用同一张**。
 *
 * 这是成熟软件里"像真的"的核心一步，前面那套程序化棚拍只是个替补：
 * 程序化环境再讲究，也是"均匀的、无处的"光；而一张真实的全景图里有
 * **具体的太阳方位、具体的天光颜色、具体的地面反射** —— 金属上那条高光
 * 会真的来自画面里那个窗户，阴影方向也和背景里的太阳一致。
 *
 * 三个实现要点：
 *
 * 1. **.hdr 必须走 RGBELoader**：HDR 里太阳的亮度是几十甚至上百，普通 JPG
 *    只有 0–1，用 JPG 当 IBL 会让金属发闷（没有高动态，反射里就没有"亮到溢出"的点）。
 *    JPG/PNG 走 TextureLoader 并显式设 sRGB。
 * 2. **delayRender / continueRender**：素材是异步的，Remotion 不等它就会截到空背景。
 *    同一份 src 内容不变，逐帧确定性不受影响。
 * 3. **到位后必须手动 advance**：@remotion/three 只在 frame 变化时推进，
 *    单帧静帧里 frame 恒定 —— 全景图和它的 PMREM 都到位了，帧缓冲里还是上一版。
 */

const worldCache = new Map<string, THREE.Texture | null>();

/** 路径约定与 material.map 一致：站内 /assets/ 走 staticFile，http/data 原样 */
const resolveSrc = (src: string): string =>
  /^(https?:)?\/\//.test(src) || src.startsWith("data:") ? src : staticFile(src.replace(/^\//, ""));

const isHdr = (src: string): boolean => /\.(hdr|exr)$/i.test(src);

export const useWorldTexture = (src?: string): { tex: THREE.Texture | null; finish: () => void } => {
  const [tex, setTex] = React.useState<THREE.Texture | null>(() => (src ? worldCache.get(src) ?? null : null));

  /**
   * ## 这个 hook **必须在 Remotion 组件树里调用，不能放进 `<ThreeCanvas>` 内部**
   *
   * 踩过的坑：一开始在 Canvas 里的 `WorldLayer` 中加载全景图，日志显示图片 100% 加载成功、
   * 状态也更新了、`advance()` 也调了，**静帧里却一直是回退的渐变**
   * （靠把兜底色改成洋红二分确认过）。
   *
   * 原因：`<ThreeCanvas>` 的子节点由 R3F 自己的 reconciler 渲染，**不参与 Remotion
   * 的那趟渲染**。`delayRender` 在那里注册，Remotion 判定"这帧可截"时压根看不到这个句柄，
   * 于是它按"没有异步素材"处理，在贴图到位前就截了图。
   *
   * 所以：加载放外面（Scene3D），用 prop 把 texture 递给 canvas 内部；
   * `continueRender` 也放在外层 effect 里 —— 父组件 effect 晚于子组件执行，
   * 正好保证"先挂背景、后放行截图"。
   */
  const [handle] = React.useState<number | null>(() => {
    if (!src || worldCache.has(src)) return null;
    return delayRender(`scene3d-world:${src}`);
  });
  const finished = React.useRef(false);
  const finish = React.useCallback(() => {
    if (handle === null || finished.current) return;
    finished.current = true;
    continueRender(handle);
  }, [handle]);

  React.useEffect(() => {
    if (!src) {
      setTex(null);
      return;
    }
    if (worldCache.has(src)) {
      setTex(worldCache.get(src) ?? null);
      return;
    }
    let alive = true;
    const url = resolveSrc(src);
    const onLoad = (t: THREE.Texture) => {
      if (!alive) return;
      if (isHdr(src)) {
        // HDR 是线性数据：不能按 sRGB 解释，否则暗部整体发灰
        t.colorSpace = THREE.LinearSRGBColorSpace;
        t.mapping = THREE.EquirectangularReflectionMapping;
      } else {
        t.colorSpace = THREE.SRGBColorSpace;
        t.mapping = THREE.EquirectangularReflectionMapping;
      }
      worldCache.set(src, t);
      setTex(t);
    };
    const onErr = () => {
      if (!alive) return;
      // 失败也要放行：宁可渲成渐变兜底，也不能让整帧卡死等一个 404
      worldCache.set(src, null);
      setTex(null);
      finish();
    };
    if (isHdr(src)) new RGBELoader().load(url, onLoad, undefined, onErr);
    else new THREE.TextureLoader().load(url, onLoad, undefined, onErr);

    return () => {
      alive = false;
    };
  }, [src, finish]);

  return { tex, finish };
};

/** 同一张全景图烘成 IBL（每个纹理只烘一次：PMREM 是 GPU 活儿） */
const pmremCache = new WeakMap<THREE.Texture, THREE.Texture>();

export const equirectEnvironment = (gl: THREE.WebGLRenderer, tex: THREE.Texture): THREE.Texture => {
  const hit = pmremCache.get(tex);
  if (hit) return hit;
  const pmrem = new THREE.PMREMGenerator(gl);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  pmremCache.set(tex, env);
  return env;
};
