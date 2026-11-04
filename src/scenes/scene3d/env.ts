import * as THREE from "three";

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
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      // 地平线附近过渡最急，天顶最缓：smoothstep 的下沿压到 0 以下，
      // 让"贴地的那一圈"也有变化，否则低机位看成一条硬边
      float t = smoothstep(-0.18, 0.72, d.y);
      vec3 col = mix(bottomColor, topColor, t);
      // 地平线暖光带：真实世界里太阳/棚灯在地平线附近漫射出一道亮带，
      // 少了它，渐变是"纯数学"的，一眼假
      float band = 1.0 - smoothstep(0.0, 0.14, abs(d.y - 0.02));
      col += glowColor * band;
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
