import React from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable } from "../ui";
import { installBloom } from "./bloom";
import { DslScene, applyBloomMultiplier, dslCamera, dslAutoDistance } from "./DslScene";
import { glowTexture, hash01, luminance, metalBody, shade } from "./color";
import type { Scene3DDsl } from "../../../shared/scene3dDsl";

/**
 * 真 3D 场景（Three.js / react-three-fiber）。
 *
 * 三条铁律：
 *
 * 1. **画面只由「帧号」决定**。Remotion 是跳帧渲染（可以只渲第 3、97、215 帧），
 *    任何 `clock.getDelta()` 累积、任何 `Math.random()` 都会让同一帧渲出两个样，成片直接闪烁。
 *    所以动画一律写成 `t = frame / fps` 的纯函数，随机一律走确定性哈希。
 *
 * 2. **不用 `useFrame`**。R3F 自己的帧循环在 Remotion 里不可靠（渲染时机由 ThreeCanvas 接管），
 *    而且它天然是"按增量推进"的，和跳帧渲染根本不兼容。
 *
 * 3. **粒子永远用 `<points>`，不要用 N 个 `<mesh>`**。
 *    900 个球体 = 900 次 draw call，单帧几秒；同样的 1400 个点用 Points 是一次 draw call。
 *    这条对柱阵（waveform）不适用——那里需要每个柱子的实体轮廓和独立高度，只能逐个画，
 *    所以柱阵数量刻意压在 64 以内。
 */

export type Scene3DPreset =
  | "blank"
  | "orbit-core"
  | "particle-field"
  | "grid-horizon"
  | "explode-parts"
  | "waveform"
  | "globe-arc";

export type Scene3DProps = {
  theme: Theme;
  /** 场景 id（由 Video/Backdrop 注入）。氛围层会带 `::backdrop` 后缀，用来判断"我是不是背景" */
  sceneId?: string;
  /**
   * 字幕在画面底部占掉的保护区顶部（按画面高度百分比，由 Video 算好传入；0 = 没字幕）。
   *
   * 底部是抢手位置：3D 的标题层贴在底部，烧录字幕也在底部 —— 以前固定让 13%，
   * 而字幕 bottom 可以被调到 18%+，字幕条正好压在副标题上（实测横屏 1080p 第 502 帧）。
   */
  subtitleReservePct?: number;
  /**
   * 只对氛围层有意义：**盖在内容之上**时置 true。
   * 这时画布必须透明（否则整块盖住下面的字），布局也不画自己的底色。
   */
  overlay?: boolean;
  /** 场景预设：一次选好整个视觉母题 */
  preset: Scene3DPreset;
  /**
   * 自定义场景图（M2）：给了它就用它，**完全忽略 preset / spin / count**。
   * 校验在 meta 的 schema 里做（几何/材质白名单 + 结构检查），这里只负责渲染。
   */
  graph?: Scene3DDsl;
  /** 光线风格（决定"这套画面是什么气质"）；auto = 按预设自动挑一个 */
  look: Scene3DLook | "auto";
  /** 主色取哪一路主题色 */
  hue: "primary" | "accent" | "secondary" | "text";
  /** 中心物体自转速度（度/秒） */
  spin: number;
  /** 密度系数：环绕体数量 / 粒子数倍率 / 柱数 / 弧线数 */
  count: number;
  /** 叠在 3D 上的标题（3D 里不做中文文字，见方案文档） */
  title: string;
  sub: string;
};

/* ─────────────────────────── 光线风格（look） ─────────────────────────── */

export type Scene3DLook = "studio" | "dramatic" | "cyber" | "nature";

export type LightSpec = { pos: [number, number, number]; intensity: number; color: string };

/**
 * 四套光线风格。**换的是光的性格，不是配色**——颜色仍然从主题里取，
 * 所以换 look 不会让画面跳出整体色系，变的是对比度、方向、软硬和色温。
 *
 * 为什么必须有这一层：只有一套灯的时候，6 个预设的颜色气质是同源的
 * （暗绿金属 + 橙边光），同一支片里连用两个 3D 场景，观众会觉得"又是这个东西"。
 *
 * 颜色 token：`core` / `dot` 走主题色，`warm` / `cool` / `cyber` / `sky` 是固定色，
 * 只在特定风格里出现（cyber 的青、dramatic 的暖白key），量都很小。
 */
export const LOOKS: Record<
  Scene3DLook,
  {
    /** 环境光；给了 hemisphere 就不用 ambientLight（自然光靠天/地两色） */
    ambient: number;
    hemisphere?: { sky: string; ground: string; intensity: number };
    /** 环境贴图强度：金属的"亮"几乎全来自它，这套值决定材质是"亮铬"还是"暗铁" */
    env: number;
    key: LightSpec;
    rimA: LightSpec;
    rimB: LightSpec | null;
    fill: LightSpec | null;
    bloom: { strength: number; radius: number; threshold: number };
    /** 与 2D 版式混排时的观感提示，写进 meta 的 describe 里 */
    summary: string;
  }
> = {
  /* 明亮干净的产品光：高环境、强主光、弱边光。适合"讲清楚这是什么" */
  studio: {
    ambient: 0.6,
    env: 0.6,
    key: { pos: [4.5, 6, 5], intensity: 2.6, color: "#FFFFFF" },
    rimA: { pos: [-5, 2.5, -6], intensity: 0.8, color: "core" },
    rimB: { pos: [5, -2, -5], intensity: 0.5, color: "dot" },
    fill: { pos: [-3, 1.5, 4], intensity: 1.1, color: "#FFFFFF" },
    bloom: { strength: 0.26, radius: 0.4, threshold: 0.92 },
    summary: "明亮干净的产品光，材质看得最清楚（适合讲解、功能介绍）",
  },
  /* 暗色戏剧：几乎没有环境光，靠一束暖主光和冷轮廓立起来，暗部很沉 */
  dramatic: {
    ambient: 0.1,
    env: 0.14,
    key: { pos: [3.5, 5.5, 4], intensity: 2.6, color: "#FFC48A" },
    rimA: { pos: [-5, 2, -6], intensity: 2.4, color: "dot" },
    rimB: { pos: [4, -3, -5], intensity: 1.5, color: "cool" },
    fill: null,
    // 半径 0.5 而不是 0.62：半径一大，能量摊到更大的面积上，亮点反而变暗
    // （粒子星云那张实测就是"整片淡雾 + 核心不明显"）
    bloom: { strength: 0.72, radius: 0.5, threshold: 0.7 },
    summary: "暗调 + 暖主光 + 冷边光，情绪最强，暗部很沉（适合开场、悬念、情绪段落）",
  },
  /* 冷色高对比：中性白光 + 青色边光，最"科技"，也最像参考图里的 HUD 场景 */
  cyber: {
    ambient: 0.08,
    env: 0.25,
    key: { pos: [4.5, 6, 5], intensity: 2.3, color: "#FFFFFF" },
    rimA: { pos: [-5, 2.5, -6], intensity: 2.2, color: "core" },
    rimB: { pos: [5, -2, -5], intensity: 1.6, color: "cyber" },
    fill: null,
    bloom: { strength: 0.55, radius: 0.5, threshold: 0.8 },
    summary: "冷色高对比，边缘挂一道青光，最「科技」（适合科技、数据、未来感）",
  },
  /* 自然柔和：天光 + 暖阳光，没有彩色边光，材质偏"哑光实体" */
  nature: {
    ambient: 0,
    hemisphere: { sky: "#CFE0FF", ground: "#6B5A3E", intensity: 1.1 },
    env: 0.5,
    key: { pos: [5, 7, 4], intensity: 1.9, color: "#FFF0D8" },
    rimA: { pos: [-5, 2.5, -6], intensity: 0.55, color: "sky" },
    rimB: null,
    fill: { pos: [-3, 1.5, 4], intensity: 0.8, color: "#DCEBFF" },
    bloom: { strength: 0.18, radius: 0.45, threshold: 0.94 },
    summary: "天光 + 暖阳光，柔和自然，没有彩色边光（适合自然、生活、纪实类内容）",
  },
};

/**
 * 预设的默认 look。**同一支片里连用多个 3D 场景时，气质才不会撞车**：
 * orbit-core 走 cyber、particle-field 走 dramatic、explode 走 studio……
 * 用户显式传 look 就覆盖它。
 */
export const AUTO_LOOK: Record<Scene3DPreset, Scene3DLook> = {
  blank: "cyber",
  "orbit-core": "cyber",
  "particle-field": "dramatic",
  "grid-horizon": "cyber",
  "explode-parts": "studio",
  waveform: "cyber",
  "globe-arc": "nature",
};

/** 颜色 token → 实际色值 */
export const lightColor = (token: string, core: string, dot: string): string => {
  if (token === "core") return core;
  if (token === "dot") return dot;
  if (token === "warm") return dot;
  if (token === "cool") return "#5A7BFF";
  if (token === "cyber") return "#22E0FF";
  if (token === "sky") return "#CFE0FF";
  return token;
};

/**
 * look：显式给了就用显式的，auto 按预设挑。
 * 抽成函数是因为**编辑器视口也要同一套判断**（否则视口和成片的光是两回事）。
 */
export function resolveLook(
  preset: Scene3DPreset,
  look: Scene3DLook | "auto",
): { name: Scene3DLook; spec: (typeof LOOKS)[Scene3DLook] } {
  const name = look === "auto" ? (AUTO_LOOK[preset] ?? "cyber") : look;
  return { name, spec: LOOKS[name] };
}

/**
 * 辉光参数：look 的基准值 + 底色亮度修正 + graph 的 `post.bloom` 倍数。
 *
 * 浅色底不能只靠"强度减半"：白底的线性亮度本来就接近 1，阈值不提上去，
 * 整片背景都会被当成高光叠一遍 —— 这才是浅色主题做 bloom 翻车的真正原因。
 */
export function bloomFor(opts: {
  spec: (typeof LOOKS)[Scene3DLook];
  background: string;
  graph?: Scene3DDsl;
}): { strength: number; radius: number; threshold: number } {
  const dark = luminance(opts.background) < 0.32;
  const base = dark
    ? opts.spec.bloom
    : {
        strength: opts.spec.bloom.strength * 0.55,
        radius: opts.spec.bloom.radius,
        threshold: Math.min(0.99, opts.spec.bloom.threshold + 0.12),
      };
  return opts.graph ? applyBloomMultiplier(opts.graph, base) : base;
}

/**
 * look 的四盏灯 + 环境底光。
 *
 * 抽成组件不是为了复用方便，而是为了**成片和编辑器视口必须是同一套光**：
 * 各写一份的结局是"视口里好看、成片颜色不对"，而这类偏差只能靠肉眼发现。
 */
export const LookLights: React.FC<{
  spec: (typeof LOOKS)[Scene3DLook];
  core: string;
  dot: string;
  /** 场景自带 lights：look 的固定方向光会把昼夜面抹平，只留一点环境底光 */
  custom?: boolean;
}> = ({ spec, core, dot, custom }) => {
  if (custom) {
    // 数值很小是有意的：作用只是让背光面留一点形，不参与照明
    return <ambientLight intensity={0.12} color="#ffffff" />;
  }
  return (
    <>
      {spec.hemisphere ? (
        <hemisphereLight args={[spec.hemisphere.sky, spec.hemisphere.ground, spec.hemisphere.intensity]} />
      ) : (
        <ambientLight intensity={spec.ambient} color="#ffffff" />
      )}
      <directionalLight position={spec.key.pos} intensity={spec.key.intensity} color={lightColor(spec.key.color, core, dot)} />
      <directionalLight position={spec.rimA.pos} intensity={spec.rimA.intensity} color={lightColor(spec.rimA.color, core, dot)} />
      {spec.rimB ? (
        <directionalLight position={spec.rimB.pos} intensity={spec.rimB.intensity} color={lightColor(spec.rimB.color, core, dot)} />
      ) : null}
      {spec.fill ? (
        <directionalLight position={spec.fill.pos} intensity={spec.fill.intensity} color={lightColor(spec.fill.color, core, dot)} />
      ) : null}
    </>
  );
};

const pick = (theme: Theme, hue: Scene3DProps["hue"]): string => {
  const c = theme.palette;
  if (hue === "accent") return c.accent;
  if (hue === "secondary") return c.secondary;
  if (hue === "text") return c.text;
  return c.primary;
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * 按"物体半径刚好占画面 82%"反算相机距离。
 *
 * 写死两组 z（横屏 7.8 / 竖屏 9.6）是不够的：竖屏的水平视角比垂直视角窄得多，
 * 720×1280 时水平半角只有 11.6°，同一个距离下横向直接溢出——实测竖屏里卫星被推出画框。
 * 约束永远是**较窄的那一边**：竖屏是水平，横屏是垂直，所以取两者的小值。
 */
const fitCamera = (radius: number, fovDeg: number, aspect: number, fill = 0.82): number => {
  const vHalf = (fovDeg * Math.PI) / 360;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  const half = Math.min(vHalf, hHalf);
  return radius / (Math.tan(half) * fill);
};

/** 缓入缓出（三次）：爆炸/聚合这类"该慢的地方慢"的动作用它，线性看着像机械臂 */
const easeInOut = (x: number): number => {
  const v = clamp01(x);
  return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2;
};

/**
 * 环境光照贴图（PMREM + RoomEnvironment）。
 *
 * 这不是"锦上添花"，是金属材质成不成立的前提：`metalness` 高的材质几乎不反射直射光，
 * 全靠环境贴图提供反射。没有 envMap 时，金属会渲成**塑料**——高光是一块纯白、边缘死黑，
 * 正是 3D 最典型的"廉价感"来源。
 *
 * **必须走 `onCreated` 而不是 useEffect**：Remotion 抽静帧时只渲一帧，
 * 判定"可以截屏"的时机在 R3F 首次 render 之后、React effect 之前
 * （`effect` 是 commit 后异步跑的）。放 useEffect 里，env 会晚于那一帧被截走 ——
 * 实测就是"代码明明改了、抽帧 md5 一模一样"。onCreated 在 store 初始化时同步调用，赶得上。
 */
export const setupEnvironment = (
  { gl, scene }: { gl: THREE.WebGLRenderer; scene: THREE.Scene },
  environmentIntensity: number,
) => {
  try {
    const pmrem = new THREE.PMREMGenerator(gl);
    const tex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = tex;
    // 环境强度由 look 决定：studio 0.6（亮铬）/ dramatic 0.14（暗铁），
    // RoomEnvironment 是均匀柔光，全强度会让金属变成"奶糖塑料"
    (scene as unknown as { environmentIntensity?: number }).environmentIntensity = environmentIntensity;
  } catch {
    // 软件渲染环境不支持时降级：只有直射光，材质会偏平，但不能因此渲染失败
  }
};

/* ─────────────────────────── 预设 1：中心几何体 + 卫星 ─────────────────────────── */

const OrbitCore: React.FC<{ t: number; spin: number; count: number; core: string; dot: string; accent: string }> = ({
  t,
  spin,
  count,
  core,
  dot,
  accent,
}) => {
  const rotY = (t * spin * Math.PI) / 180;
  // 卫星反向慢走：两者相对角度一直在变，画面不会"整块一起转"那样呆板
  const orbit = -rotY * 0.55;
  const R = 2.15;
  const n = Math.max(1, Math.round(count));

  return (
    <group>
      <mesh rotation={[0.42, rotY, 0.18]}>
        <torusKnotGeometry args={[0.92, 0.27, 220, 36, 2, 3]} />
        <meshStandardMaterial
          color={metalBody(core, 0.24, 0.1)}
          metalness={1}
          roughness={0.18}
          emissive={core}
          emissiveIntensity={0.02}
          envMapIntensity={0.8}
        />
      </mesh>

      {Array.from({ length: n }).map((_, i) => {
        const a = orbit + (i / n) * Math.PI * 2;
        // 竖向错相 → 轨道看起来是倾斜椭圆，而不是一个平面圆环
        const y = Math.sin(a * 1.7 + 0.6) * 0.52;
        const color = i % 2 === 0 ? dot : accent;
        return (
          <mesh key={i} position={[Math.cos(a) * R, y, Math.sin(a) * R]}>
            <sphereGeometry args={[0.085, 20, 20]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.7} roughness={0.3} />
          </mesh>
        );
      })}

      {/* 轨道环：3D 里"有轨道"比"有球在飞"更像一回事 */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[R, 0.0035, 8, 220]} />
        <meshStandardMaterial color={core} emissive={core} emissiveIntensity={0.6} transparent opacity={0.34} />
      </mesh>
    </group>
  );
};

/* ─────────────────────────── 预设 2：粒子星云 ─────────────────────────── */

const ParticleField: React.FC<{ t: number; count: number; core: string; dot: string }> = ({ t, count, core, dot }) => {
  const glowTex = glowTexture();
  // 一次 draw call。数量随 density 走，上限兜住渲染时间
  const N = Math.max(600, Math.min(6000, Math.round(2400 * (count / 5))));

  const { positions, colors } = React.useMemo(() => {
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const cCore = new THREE.Color(core);
    const cDot = new THREE.Color(dot);
    for (let i = 0; i < N; i++) {
      // 球体内分布用 u^0.62 而不是均匀 cbrt：指数 <1 让粒子往中心聚，
      // 中心自然形成"核"，外圈稀——这才是星云的样子（均匀分布 = 撒金粉）
      const r = 4.2 * Math.pow(hash01(i, 1), 0.62);
      const theta = 2 * Math.PI * hash01(i, 2);
      const phi = Math.acos(2 * hash01(i, 3) - 1);
      // 越靠外越扁，中心留出体积感
      const squash = 0.3 + 0.35 * (1 - r / 4.2);
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi) * squash;
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      const c = hash01(i, 4) > 0.86 ? cDot : cCore;
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    return { positions: pos, colors: col };
  }, [N, core, dot]);

  const rot = (t * 7 * Math.PI) / 180;
  const pulse = 0.92 + 0.08 * Math.sin(t * 1.6);
  return (
    <group>
      {/*
        核心光核：没有它，粒子只是"分布"，看不出这个云有一个中心。

        这里**必须用 sprite**，不能用加法混合的半透明球壳 —— 第一版就是球壳，
        在 ANGLE/SwiftShader 上低不透明度会被渲成一个**方形暗块**，而且 0.07 的
        加法球壳在深底上根本看不见（样张里中心只是一团更密的点，没有"核"）。
        贴图 + sprite 既没有轮廓问题，又是一次 quad，比球壳便宜。
      */}
      {glowTex ? (
        <sprite scale={[2.5 * pulse, 2.5 * pulse, 1]}>
          <spriteMaterial
            map={glowTex}
            // 往白里提：纯橙的亮度只有 0.36，铺在深底上读作"褐色土块"而不是光。
            // 光核越白越像能量，颜色交给外围粒子去带。
            color={new THREE.Color(dot).lerp(new THREE.Color("#FFFFFF"), 0.5)}
            transparent
            opacity={0.46}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </sprite>
      ) : null}
      <points rotation={[0.16, rot, 0]} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[colors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          // 贴图边缘是透明的，有效亮径比 size 小一半，所以要给到 0.16 才抵得上"实心方点"的 0.075
          size={0.16}
          sizeAttenuation
          vertexColors
          // 必须贴一张径向渐变：不贴的话每个粒子就是一个**正方形**色块，
          // 近处的粒子一眼就露馅（贴图本身是白的，靠 vertexColors 上色）
          map={glowTex ?? undefined}
          transparent
          opacity={0.95}
          depthWrite={false}
          // 加法混合是"光点"和"圆片"的分界线：不发光就只是一堆圆
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
};

/* ─────────────────────────── 预设 3：透视网格地平线 ─────────────────────────── */

const GridHorizon: React.FC<{ t: number; spin: number; core: string; dot: string; isPortrait: boolean }> = ({
  t,
  spin,
  core,
  dot,
  isPortrait,
}) => {
  const glowTex = glowTexture();
  const size = isPortrait ? 46 : 62;

  /**
   * 远空星点。
   * 只有网格和地平线时，画面上半部分是一整块死黑，构图是"断"的；
   * 撒一层星点把上下连起来，代价只有一次 draw call。
   * 材质要关掉 fog：星星在 25 单位外，雾会把它们吃掉一半。
   */
  const stars = React.useMemo(() => {
    const N = 420;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const theta = 2 * Math.PI * hash01(i, 41);
      const y = 0.06 + 0.94 * hash01(i, 42);
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const R = 26;
      pos[i * 3] = Math.cos(theta) * r * R;
      pos[i * 3 + 1] = y * R * 0.62 + 1.2;
      pos[i * 3 + 2] = Math.sin(theta) * r * R - 16;
    }
    return pos;
  }, []);
  // 光带沿 z 轴扫过：周期 6 秒，来回一趟
  const span = 34;
  const z = span - ((t * 6) % (span * 2));
  const sweep = Math.abs(z) < span ? z : span;

  return (
    <group>
      <gridHelper
        args={[size, size, shade(core, 0.62), shade(core, 0.62)]}
        position={[0, -1.7, -size / 2 + 6]}
        material-transparent
        material-opacity={0.4}
      />

      <points frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[stars, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.55}
          sizeAttenuation
          color={core}
          map={glowTex ?? undefined}
          transparent
          opacity={0.75}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          fog={false}
        />
      </points>

      {/* 地平线上的一道光：中景被照亮，"地平线"才有存在感 */}
      <mesh position={[0, -1.66, -8]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[size * 1.6, 0.3]} />
        <meshBasicMaterial color={dot} transparent opacity={0.34} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      {/* 扫过的光带 */}
      <mesh position={[0, -1.64, sweep]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[size * 0.9, 2.4]} />
        <meshBasicMaterial
          color={dot}
          transparent
          opacity={0.07}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/*
        悬浮体给地平线一个"焦点"，否则网格只是网格。
        用 detail=0 的二十面体：细分过高（detail=1/2）在远处会变成一个圆球，
        反而看不出是什么东西；留着棱角才读得出"在转的几何体"。
      */}
      {/*
        这个多面体单独把 envMapIntensity 拉到 1.6：metalness 高的时候几乎**没有漫反射**，
        "亮"全部来自对环境（0.32）的反射。画面里它又小又远，环境一暗就糊成一块死板的橄榄色。
      */}
      {/*
        这盏灯只对多面体有效：网格（gridHelper）、星点（points）、光带（basic 材质）
        都是不受光照的材质，所以它实际上是一盏"给主体补的光"。
        场景里那四盏灯是按原点的物体布的，多面体在 z=-3.4、又小又远，
        从它那侧看过去几乎没有高光，渲出来就是一块哑光的橄榄色面片。
      */}
      <directionalLight position={[3, 4.2, 3.5]} intensity={2.2} color="#ffffff" />

      <mesh position={[0, 0.52, -2.9]} rotation={[0.3, (t * spin * Math.PI) / 180, 0]}>
        <icosahedronGeometry args={[0.95, 0]} />
        <meshStandardMaterial
          color={metalBody(core, 0.44, 0.12)}
          metalness={0.82}
          roughness={0.22}
          emissive={core}
          emissiveIntensity={0.05}
          envMapIntensity={1.6}
          flatShading
        />
      </mesh>
    </group>
  );
};

/* ─────────────────────────── 预设 4：零件爆炸 / 装配 ─────────────────────────── */
/**
 * 用途：讲"构成、拆解、模块、层次"。
 *
 * 第一版做的是"一堆小方块沿球面飞散"，渲出来像散落的色块——因为零件之间**没有关系**，
 * 观众看不出它们本来是一个整体。现在改成**把一个圆环按 N 等份切开再沿径向推开**：
 * 合起来是完整的环，散开时每段的缺口、弧度、朝向都还在互相印证，一眼就能读成"拆解"。
 *
 * 这是爆炸图的本质：不是"东西变多了"，而是"一个整体被拆开了"，
 * 拆下来的碎片必须保留原来的形状线索。
 */
const ExplodeParts: React.FC<{
  t: number;
  spin: number;
  count: number;
  core: string;
  dot: string;
}> = ({ t, spin, count, core, dot }) => {
  // 段数比 count 大：3 段读不出"环"，7 段以上才看得出这是一个被切开的整圆
  const n = Math.max(5, Math.min(12, Math.round(3 + count * 0.9)));
  // 周期刻意对齐场景默认时长 4 秒：这样"展开—悬停—合回"刚好走完一遍，
  // 时长拉长就是整数个循环，首尾仍然无缝（不是靠 remotion 的循环参数凑的）
  const cycle = 4;
  const p = (t % cycle) / cycle;
  // 三段：0–40% 展开、40–62% 悬停（让人看清）、62–100% 合回
  const e = p < 0.4 ? easeInOut(p / 0.4) : p < 0.62 ? 1 : 1 - easeInOut((p - 0.62) / 0.38);

  const glowTex = glowTexture();
  const R = 1.18;
  const tube = 0.17;
  const seg = (Math.PI * 2) / n;
  // 每段占 76% 的弧长：缝要够宽，散开后相邻两段才不会在屏幕上贴成一个 S 形
  const arc = seg * 0.76;
  const push = e * 0.52;
  const rotY = (t * spin * 0.45 * Math.PI) / 180;

  // 每段的中心角与抬升：抬升用 i 的三角函数错开，散开时是立体的，不是一张摊平的饼
  const segs = Array.from({ length: n }).map((_, i) => {
    const angStart = i * seg;
    const angMid = angStart + arc / 2;
    return {
      angStart,
      angMid,
      // 位移只推 push，不推 R：段几何体**本身**就是半径 R 的圆弧，
      // 再给 position 加上 R 的话，段上的点最远会跑到 R*2+push 去（实测 2.88 而不是 1.87），
      // 横屏看不出来、竖屏直接被画框切掉。合拢（push=0）时 position 回到原点，各段自动拼成整圆。
      x: Math.cos(angMid) * push,
      y: Math.sin(angMid) * push,
      /**
       * 抬升**按奇偶强制分两层**，不是靠 i 的三角函数错开。
       *
       * 用 `sin(i*1.9)` 的问题是相邻两段的取值可能很接近（右侧那一对就是这样），
       * 散开后两段的轮廓直接并成一个 S 形 —— 每个循环都会出现一次，不是随机瞬间。
       * 奇偶分层的效果是：相邻段至少差 0.36 个单位的抬升，从任何角度看都是"拆开的两块"。
       */
      lift: e * (i % 2 === 0 ? 1 : -1) * (0.18 + 0.22 * hash01(i, 7)),
      // 散开时每一段还会歪一下，像被拆开时各自的姿态
      tilt: e * Math.sin(i * 2.3) * 0.32,
      // 各段同色（之前留了个 `i % 2 ? core : core` 的死三元，两边一样）：
      // 用两个主题色会读成"两种零件"，而这里要表达的是同一个环的各段，
      // 深浅区分交给渲染时的 metalBody 系数
      color: core,
    };
  });

  // 引线：从中心拉到每段中点。n≤12，每帧重建一个 72 浮点的 buffer，代价可以忽略
  const linePos = React.useMemo(() => {
    const arr = new Float32Array(n * 6);
    segs.forEach((sg, i) => {
      arr[i * 6] = 0;
      arr[i * 6 + 1] = 0;
      arr[i * 6 + 2] = 0;
      // 端点必须和分段的**实际**中点一致：段自己带 `rotation=[tilt,0,angStart]`，
      // 绕 X 的 tilt 会把弧的中点从 (Rcos, Rsin) 折成 (Rcos, Rsin·cos, Rsin·sin)。
      // 少算这一段，线头就会落在空处（截图里能看到几根"插不到零件上的辐条"）。
      arr[i * 6 + 3] = sg.x + Math.cos(sg.angMid) * R;
      arr[i * 6 + 4] = sg.y + Math.sin(sg.angMid) * R * Math.cos(sg.tilt);
      arr[i * 6 + 5] = sg.lift + Math.sin(sg.angMid) * R * Math.sin(sg.tilt);
    });
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, push, e, R]);

  return (
    <group rotation={[0.5, rotY, 0.12]}>
      {/* 中心核：装配图里的"基准件"，是拆解动画的视觉锚点 */}
      {/* 中心核用平滑球，不用二十面体：detail=1 的二十面体正对镜头时轮廓是个带棱的方块，
          在纯黑背景上会显出一个"方形黑影"框住发光核，很掉价 */}
      <mesh>
        <sphereGeometry args={[0.24, 40, 40]} />
        <meshStandardMaterial
          color={metalBody(core, 0.3, 0.2)}
          metalness={1}
          roughness={0.22}
          emissive={core}
          emissiveIntensity={0.08}
          envMapIntensity={1.15}
        />
      </mesh>

      {/* 中心光晕：sprite 永远正对镜头，不会随旋转变成椭圆或被几何体轮廓带偏 */}
      {glowTex ? (
        <sprite scale={[1.5, 1.5, 1]}>
          <spriteMaterial
            map={glowTex}
            color={dot}
            transparent
            opacity={0.55}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </sprite>
      ) : null}

      {/*
        整组先绕 X 转 90°，让圆环从 XY 平面躺到 XZ 平面（水平），
        之后每段在局部 XY 里用 Z 轴旋转定位——这样"段的起始角"就是单纯的平面角，
        不用在代码里心算三轴欧拉顺序。
      */}
      {/*
        引线必须放在这个旋转过的 group **里面**。
        linePos 是按局部 XY（圆的平面）算的，而分段整体被 `rotation={[PI/2,0,0]}`
        转到了 XZ 平面。之前引线是 group 的兄弟节点，于是它在 XY 平面上画、分段在 XZ 上摆，
        渲染出来是一把"插不到零件上的辐条"——端点全落在空处。
      */}
      <group rotation={[Math.PI / 2, 0, 0]}>
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[linePos, 3]} />
          </bufferGeometry>
          {/* 连线是"关系"不是"主体"：透明度压在 0.4 以下，抢眼就变蜘蛛网 */}
          <lineBasicMaterial color={dot} transparent opacity={0.34} depthWrite={false} />
        </lineSegments>

        {segs.map((sg, i) => (
          <group key={i} position={[sg.x, sg.y, sg.lift]} rotation={[sg.tilt, 0, sg.angStart]}>
            <mesh>
              <torusGeometry args={[R, tube, 18, 28, arc]} />
              <meshStandardMaterial
                color={metalBody(sg.color, i % 2 === 0 ? 0.28 : 0.2, 0.2)}
                metalness={1}
                roughness={0.2}
                emissive={sg.color}
                emissiveIntensity={0.06}
                envMapIntensity={1.1}
              />
            </mesh>
            {/*
              断面上的两颗小珠：交代"这里是被切断的"。
              直径必须明显小于管径——做到跟管径一样粗，整段就成了胶囊/香肠，环的形状线索反而断了。
            */}
            {[0, arc].map((a) => (
              <mesh key={a} position={[Math.cos(a) * R, Math.sin(a) * R, 0]}>
                <sphereGeometry args={[tube * 0.52, 12, 12]} />
                <meshStandardMaterial color={dot} metalness={0.4} roughness={0.4} emissive={dot} emissiveIntensity={0.5} />
              </mesh>
            ))}
          </group>
        ))}
      </group>
    </group>
  );
};

/* ─────────────────────────── 预设 5：波形柱阵 ─────────────────────────── */
/**
 * 用途：讲"数据起伏、声波、节奏、趋势"。
 *
 * 高度是**两条不同频率的正弦叠加**，不是单频。单频看起来像弹簧在抖，
 * 两条一快一慢叠起来才有"信号"的不规则感。颜色随高度从主色渐变到强调色，
 * 相当于给高度额外加了一条视觉编码（柱子本身在透视下会有遮挡，只看高度会误读）。
 */
const Waveform: React.FC<{
  t: number;
  spin: number;
  count: number;
  core: string;
  dot: string;
  isPortrait: boolean;
}> = ({ t, spin, count, core, dot, isPortrait }) => {
  // 竖屏画幅是横屏的 1/3 宽：柱数要跟着减，否则三十多根柱子挤成一排栅栏
  const n = isPortrait
    ? Math.max(12, Math.min(24, Math.round(10 + count * 1.8)))
    : Math.max(16, Math.min(64, Math.round(12 + count * 4.5)));
  const span = isPortrait ? 3.6 : 11;
  const gap = span / n;
  const width = gap * 0.5;

  // spin 在这里的语义变成"波动速度"，0 就是完全静止的一排柱子
  const speed = 0.35 + (spin / 90) * 2.4;
  /**
   * 柱子分两层上色：**本体单色 + 高度驱动 emissive**。
   *
   * 之前是本体色从主色 lerp 到强调色（黄绿 → 橙），结果是中间那一段渲染出来是**褐色泥浆**——
   * 两个降过饱和的补色做插值，中点必然是灰的。柱阵要表达的是"高度"，颜色只是辅助编码，
   * 所以本体固定一支暗金属色，让"颜色 + 亮度"一起随高度走 emissive 走。
   */
  const cBody = new THREE.Color(metalBody(core, 0.24, 0.16));
  const cLow = new THREE.Color(core);
  const cHigh = new THREE.Color(dot);

  const bars = React.useMemo(() => {
    return Array.from({ length: n }).map((_, i) => {
      const u = (i / Math.max(1, n - 1)) * 2 - 1; // -1 … 1
      // 基底压到 0.22：基底一高，整排柱子都"有高度"，波形起伏就看不出来了
      const h =
        0.22 +
        1.45 * Math.pow(Math.abs(Math.sin(u * 2.05 + t * speed * 1.35)), 1.7) +
        0.42 * Math.abs(Math.sin(u * 4.8 - t * speed * 0.85 + 1.1));
      const mix = clamp01(h / 1.95);
      // 波峰要"热到发白"：橙的亮度只有 0.36，永远够不到辉光阈值（阈值是**亮度**阈值），
      // 所以峰值不往白里推的话，柱阵只是一排橙色方块，不会发光。
      /**
       * 试过让波峰"热到发白"去越过辉光阈值，三次都失败：柱阵的高度是**平顶驼峰**，
       * 一次就有十几根柱子的 mix 同时接近 1，白化之后它们一起发光，
       * 渲出来是一整块光斑，柱子的形状全丢——那不是频谱。
       *
       * 所以这里放弃发光：柱阵的表达力本来就在"高度差 + 颜色梯度"，不在辉光。
       * 真要发光的是粒子、是光核，不是一排承载数据的柱子。
       */
      const e = cLow.clone().lerp(cHigh, mix);
      // 中间的柱子略高、两翼渐低：给柱阵一个"包络"，不然像被切了一刀
      return {
        x: -span / 2 + gap * (i + 0.5),
        h,
        mix,
        color: `#${cBody.getHexString()}`,
        emissive: `#${e.getHexString()}`,
      };
    });
  }, [n, span, gap, speed, t, cBody.getHexString(), cLow.getHexString(), cHigh.getHexString()]);

  return (
    <group position={[0, -1.45, 0]}>
      {/*
        不放底板。
        第一版铺了一块 span×0.9 的实体地板想"给个地面"，结果它被环境光照亮后占了半个画面，
        在浅色主题下更是一大块深蓝——柱子反而成了地板的装饰。柱阵本身是"悬浮的频谱"，
        不需要地面，需要的是**柱底对齐的那条线**，所以下面只留一根很细的光带。
      */}
      {bars.map((b, i) => (
        <mesh key={i} position={[b.x, b.h / 2, 0]}>
          <boxGeometry args={[width, b.h, width * 1.2]} />
          <meshStandardMaterial
            color={b.color}
            metalness={0.62}
            roughness={0.32}
            emissive={b.emissive}
            // 只有波峰越过辉光阈值：低柱留在暗部，高柱才发光。
            // 注意阈值是**亮度**阈值，橙(0.36)天生比黄绿(0.72)暗一档，emissive 强度
            // 必须给到 2 以上才够让它发光——这里用 mix² 而不是 mix，是为了让"只有波峰亮"，
            // 而不是"整排都亮一档"（后者等于把对比度又还回去）。
            emissiveIntensity={0.08 + b.mix * b.mix * 1.1}
          />
        </mesh>
      ))}

      {/* 柱底光带：替代地板，给柱阵一个"站立的基线"，一条线就够 */}
      <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[span * 1.02, 0.1]} />
        <meshBasicMaterial color={dot} transparent opacity={0.4} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      {/*
        这里原本有一条「柱顶光带」（0.04 高的加法平面），想做"把柱子串成一条波形"。
        实际渲染出来是一条**横贯整幅画面**的亮线，读作镜头光斑 —— 因为它是平面、
        不受透视也不受柱子遮挡。柱阵本身就是"起伏的形状"，不需要再画一条线去解释它。
      */}
    </group>
  );
};

/* ─────────────────────────── 预设 6：球面弧线（地球 / 网络） ─────────────────────────── */

/**
 * 朝向镜头一侧的球面取点（经度 ±62°、纬度 ±44°）。
 *
 * 弧线端点的用途和点阵不同：点阵要铺满全球才像星空，弧线却必须在正面，
 * 否则一半弧线跑到球背后被本体挡住，画面上只剩一两条孤线。
 */
const frontPoint = (u1: number, u2: number, r: number): THREE.Vector3 => {
  // 收在 ±0.82 / ±0.58 而不是 ±1.08 / ±0.77：端点原来的投影半径到了球轮廓的 94%，
  // 弧线一抬就必然穿出球体剪影（样张里下方几条弧"飘在球外"就是这么来的）
  const lon = (u1 * 2 - 1) * 0.82;
  const lat = (u2 * 2 - 1) * 0.58;
  const cl = Math.cos(lat);
  return new THREE.Vector3(Math.sin(lon) * cl, Math.sin(lat), Math.cos(lon) * cl).multiplyScalar(r);
};

const spherePoint = (u1: number, u2: number, r: number): THREE.Vector3 => {
  const theta = 2 * Math.PI * u1;
  // 不用 asin 的均匀分布：直接在 y 上均匀采样，点阵才不会在两级堆积
  const y = 2 * u2 - 1;
  const rad = Math.sqrt(Math.max(0, 1 - y * y));
  return new THREE.Vector3(Math.cos(theta) * rad * r, y * r, Math.sin(theta) * rad * r);
};

/**
 * 用途：讲"全球、连接、网络、辐射范围"。
 *
 * 球体本身压得很暗、几乎只是一层剪影，信息全部交给**表面点阵 + 弧线**。
 * 这是刻意的：实体球在投影幕上永远是"一颗塑料球"，而点阵 + 弧线才像"数据图"。
 * 弧线用二次贝塞尔，中点抬到球面外 1.3 倍——太贴球面会陷进去，抬太高就飞出去了。
 */
const GlobeArc: React.FC<{
  t: number;
  spin: number;
  count: number;
  core: string;
  dot: string;
  accent: string;
}> = ({ t, spin, count, core, dot, accent }) => {
  const glowTex = glowTexture();
  const R = 1.42;
  const N = Math.max(280, Math.min(2000, Math.round(900 * (count / 5) + 200)));

  const { positions, colors } = React.useMemo(() => {
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const cCore = new THREE.Color(core);
    const cDot = new THREE.Color(dot);
    for (let i = 0; i < N; i++) {
      const v = spherePoint(hash01(i, 31), hash01(i, 32), R * 1.004);
      pos[i * 3] = v.x;
      pos[i * 3 + 1] = v.y;
      pos[i * 3 + 2] = v.z;
      const c = hash01(i, 33) > 0.9 ? cDot : cCore;
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    return { positions: pos, colors: col };
  }, [N, core, dot]);

  const arcs = React.useMemo(() => {
    const n = Math.max(3, Math.min(10, Math.round(2 + count * 1.1)));
    /**
     * 端点用**两两独立**的确定性哈希取，不用同一个低差异序列加偏移。
     *
     * 试过两版都不行：
     * - `b = g(i) + 固定偏移`：所有弧线朝同一个方向平移，渲出来是 8 条平行斜线；
     * - `b = g(i + n/2)`：R2 的第二个常量和 4 相乘、小数部分只剩 0.02，
     *   正对面"退化成了隔壁"，弧线缩成一个个小钩子。
     *
     * 要的是"网络"：长度和方向都得散开。所以两端各用一组独立哈希，
     * 只在两点过近（会退化成一个很小的小弧）时把一端推开。
     */
    const pair = (i: number) => {
      const a = { u: hash01(i, 51), v: hash01(i, 52) };
      let b = { u: hash01(i, 53), v: hash01(i, 54) };
      if (Math.abs(a.u - b.u) + Math.abs(a.v - b.v) < 0.55) {
        b = { u: (b.u + 0.34) % 1, v: (b.v + 0.3) % 1 };
      }
      return [a, b] as const;
    };
    return Array.from({ length: n }).map((_, i) => {
      const [A, B] = pair(i);
      const a = frontPoint(A.u, A.v, R);
      const b = frontPoint(B.u, B.v, R);
      const lift = 1.18 + hash01(i, 25) * 0.16;
      const mid = a.clone().add(b).multiplyScalar(0.5);
      // 中点方向归一化再抬高：直接对两点取平均会落到球内，弧线会穿球而过
      if (mid.lengthSq() < 1e-6) mid.set(0, 1, 0);
      mid.normalize().multiplyScalar(R * lift);
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      return {
        tube: new THREE.TubeGeometry(curve, 48, 0.0075, 6, false),
        curve,
        color: i % 2 === 0 ? dot : accent,
        phase: hash01(i, 26),
      };
    });
  }, [count, R, dot, accent]);

  const rotY = (t * spin * 0.35 * Math.PI) / 180;

  return (
    <group rotation={[0.28, rotY, 0.06]}>
      {/*
        暗本体用**无光照材质**，不是 StandardMaterial。
        Standard 会吃到场景里那三盏方向光：主光强度 2.4、漫反射直接乘上去，
        再暗的基色也会被推成"一颗鲜绿的塑料球"——这正是第一版的样子。
        这里要的是剪影，不是被照亮的球：基色写死、边缘靠下面那层大气光勾出来。
      */}
      <mesh>
        <sphereGeometry args={[R, 48, 48]} />
        <meshBasicMaterial color={shade(core, 0.1)} />
      </mesh>

      {/*
        大气辉光：两层 sprite 放在球心，中段被**不透明本体挡住**，只在轮廓外留下一圈。

        之前是 `scale=1.045` 的 BackSide 加法球壳，opacity 只有 0.09——因为再高就会
        整颗球内部一起发亮（BackSide 渲的是一个填充圆盘，不是环），于是它只能小到
        几乎看不见：样张里球体边缘是没有边界的，弧线像浮在虚空里。
        sprite + 球体遮挡这个组合，才是"只有边缘发光"的正确做法。
      */}
      {glowTex ? (
        <>
          <sprite scale={[R * 2.5, R * 2.5, 1]} renderOrder={-1}>
            <spriteMaterial
              map={glowTex}
              color={core}
              transparent
              opacity={0.24}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
            />
          </sprite>
          <sprite scale={[R * 1.85, R * 1.85, 1]} renderOrder={-1}>
            <spriteMaterial
              map={glowTex}
              color={dot}
              transparent
              opacity={0.12}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
            />
          </sprite>
        </>
      ) : null}

      <points frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[colors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.045}
          sizeAttenuation
          vertexColors
          map={glowTex ?? undefined}
          transparent
          opacity={0.9}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      {arcs.map((arc, i) => (
        <group key={i}>
          <mesh geometry={arc.tube}>
            <meshBasicMaterial color={arc.color} transparent opacity={0.62} blending={THREE.AdditiveBlending} />
          </mesh>
          {/* 沿弧线跑的光点：一条静止的弧线只是"连线"，有东西在跑才是"传输" */}
          {(() => {
            const u = (arc.phase + t * 0.32) % 1;
            const p = arc.curve.getPointAt(u);
            return (
              <mesh position={[p.x, p.y, p.z]}>
                <sphereGeometry args={[0.034, 12, 12]} />
                <meshBasicMaterial color={arc.color} />
              </mesh>
            );
          })()}
        </group>
      ))}
    </group>
  );
};

/* ─────────────────────────── 场景本体 ─────────────────────────── */

/**
 * 每帧把相机的 position / fov 同步到 three 相机。
 *
 * `<ThreeCanvas camera={{...}}>` 的 camera 只在 Canvas 建立那一刻生效；连续渲染视频时
 * 同一个页面里的 Canvas 不会重建，相机就永远停在"这一段的第一帧"。
 * 单帧抽图看不出来（每次都是新页面），成片里才会露馅：镜头卡住、主体飞出画面。
 * 所以必须显式同步。
 */
const CameraSync: React.FC<{ pos: [number, number, number]; fov: number }> = ({ pos, fov }) => {
  const camera = useThree((s) => s.camera);
  React.useLayoutEffect(() => {
    camera.position.set(pos[0], pos[1], pos[2]);
    const pc = camera as THREE.PerspectiveCamera;
    if (pc.fov !== fov) {
      pc.fov = fov;
      pc.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }, [camera, pos[0], pos[1], pos[2], fov]);
  return null;
};

export const Scene3DScene: React.FC<Scene3DProps> = ({
  theme,
  preset = "blank",
  graph,
  look = "auto",
  hue = "primary",
  spin = 12,
  count = 5,
  title = "",
  sub = "",
  sceneId,
  overlay = false,
  subtitleReservePct = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { h } = useSceneLayout();
  const c = theme.palette;
  const t = frame / fps;
  const isPortrait = height > width;
  /**
   * 是不是被当成氛围层在用（Backdrop 会给 sceneId 加 `::backdrop` 后缀）。
   *
   * 氛围层不画文字：它的作用就是"给上面的版式当底"，再叠一层字就变成两套字 ——
   * 而且它自带的不透明底色会让字压在 2D 正文下面，谁也看不清。
   */
  const isBackdrop = !!sceneId?.endsWith("::backdrop");

  const core = pick(theme, hue);
  const dot = c.accent;
  const accent = c.secondary;

  // look：显式给了就用显式的，auto 按预设挑（见 AUTO_LOOK）
  const { name: resolvedLook, spec: lookSpec } = resolveLook(preset, look);

  /**
   * 相机。分两类：
   *
   * - **有界物体**（orbit-core / explode-parts / globe-arc）：按各自的外接半径反算距离，
   *   横竖屏都刚好装下，不会出现"竖屏被裁、横屏太小"。
   * - **有界但需要溢出**（particle-field 的星云、grid-horizon 的地平线、waveform 的柱阵）：
   *   构图本身就是"铺满并超出"，反算距离反而会把它们缩成中间一小团，所以按画幅给固定值。
   */
  const aspect = width / height;
  /**
   * DSL 的相机是"相机在 P、看向 T"，渲染时压成内容 group 的变换（见 DslScene.dslCamera）。
   * 没写 camera 时按节点外接半径反算一个能装下的距离，避免"渲出来一片空白"。
   */
  const dslCam = graph ? dslCamera(graph, t, fps) : null;
  const autoDist = graph ? dslAutoDistance(graph) : 0;

  const cam = graph
    ? dslCam
      ? { position: dslCam.camPos, fov: dslCam.fov }
      : {
          position: [0, 0.6, fitCamera(Math.max(1, autoDist), 42, aspect, 0.82)] as [
            number,
            number,
            number,
          ],
          fov: 42,
        }
    : preset === "grid-horizon"
      ? { position: [0, 0.35, isPortrait ? 8.6 : 6.6] as [number, number, number], fov: 52 }
      : preset === "waveform"
        ? { position: [0, 2.0, isPortrait ? 7.4 : 8.0] as [number, number, number], fov: 46 }
        : preset === "particle-field"
          ? { position: [0, 0.85, isPortrait ? 9.6 : 7.8] as [number, number, number], fov: 40 }
          : preset === "globe-arc"
            ? { position: [0, 0.6, fitCamera(2.25, 44, aspect, 0.9)] as [number, number, number], fov: 44 }
            : preset === "explode-parts"
              ? { position: [0, 0.7, fitCamera(2.15, 42, aspect, 0.88)] as [number, number, number], fov: 42 }
              : { position: [0, 0.85, fitCamera(2.3, 40, aspect, 0.9)] as [number, number, number], fov: 40 };

  /**
   * 辉光参数按底色亮度分档，但要理解成"阈值"而不是"权重"：
   *
   * - 深色底：阈值放到 0.7 左右，让金属高光和 emissive 体越过它发光，本体留在暗部。
   * - 浅色底：阈值必须推到 0.95 以上。白底本身的线性亮度就接近 1，阈值一低，
   *   整个背景都会被当成"高光"叠一遍，画面直接蒙一层灰雾 ——
   *   浅色主题做 bloom 翻车从来不是强度太大，是阈值不够高。
   */
  const darkTheme = luminance(c.background) < 0.32;
  /**
   * 辉光参数从 look 里取，再按底色亮度修一次。
   * 浅色底不能只靠"强度减半"：白底的线性亮度本来就接近 1，阈值不提上去，
   * 整片背景都会被当成高光叠一遍（这才是浅色主题做 bloom 翻车的真正原因）。
   */
  // 辉光的"浅底提阈值 + graph 的倍数"都在 bloomFor 里，视口和成片共用同一套算法
  const bloomOpts = bloomFor({ spec: lookSpec, background: c.background, graph });

  /**
   * 场景自带光源时，把 look 的四盏方向光全撤掉。
   *
   * 为什么必须全撤而不是"调弱"：look 的灯方向是固定的，混杂在自定义光里会让
   * "太阳照亮地球"这件事变得不成立 —— 地球的暗面会被边光补亮，看起来还是没转向太阳。
   * 只留一点环境底光，是为了背光面不至于纯黑（科普片里全黑会被当成渲染失败）。
   *
   * 同时把环境贴图降到四分之一：`RoomEnvironment` 是一圈均匀柔光，
   * 它本身就是"从四面八方打光"，留着会直接抹平明暗交界。
   */
  const dslLights = !!graph?.lights?.length;
  /** WebGL 后处理装不上时的降级：CSS 全屏混合（观感差一档，但不会黑屏） */
  const [cssBloom, setCssBloom] = React.useState(false);
  const bloomBlur = Math.round(Math.min(width, height) * 0.012);

  return (
    <AbsoluteFill
      style={{
        // 盖在内容之上时不画底色（透明），垫在下面时画自己的底色（辉光要有底才成立）
        background: overlay ? "transparent" : c.background,
        overflow: "hidden",
      }}
    >
      <ThreeCanvas
        width={width}
        height={height}
        dpr={1}
        // preserveDrawingBuffer 是硬要求：Remotion 是画完之后去"截屏"的，
        // 缓冲区没保留时截到的是空白（headless 下尤其明显）
        gl={{
          // 叠在内容之上时必须开 alpha，否则透明区域会被合成成黑色、把下面的字盖掉
          alpha: overlay,
          antialias: true,
          preserveDrawingBuffer: true,
          powerPreference: "high-performance",
          /**
           * **必须关掉色调映射（ACES）**，否则 3D 场景的底色和 2D 场景对不上。
           *
           * three 只在"直接渲到画布"时套 tone mapping，渲进渲染目标时是关的；
           * 而接上后处理之后，OutputPass 会拿整帧（包括背景色）套一次 ACES。
           * 实测浅色主题 `#F3F1EA` 被压成 `#DFDEDC`——两幕相接时会明显跳一下色。
           *
           * 关掉之后：背景色 = 主题色（逐像素一致），高光直接截顶。
           * 对这个项目反而是对的：写多少看到多少，和 `shade()` 那条结论是同一个原则。
           */
          toneMapping: THREE.NoToneMapping,
        }}
        // 环境贴图和辉光都必须在这里装：onCreated 同步执行、早于首帧，
        // 放 useEffect 里会晚于 Remotion 截走的那一帧（踩过两次，症状都是"改了代码、md5 不变"）
        onCreated={(state) => {
          setupEnvironment(state, dslLights ? lookSpec.env * 0.25 : lookSpec.env);
          try {
            installBloom(state, bloomOpts);
          } catch {
            setCssBloom(true);
          }
        }}
        /**
         * near/far 显式给：太阳系这种"从贴脸机位一路拉到几千单位"的一镜到底，
         * 默认 far=1000 会在拉远时把整个星系裁掉（画面直接变黑），
         * 而贴脸机位又需要 near 够小。1:2e5 的比例在 24 位深度缓冲下没有可见 z-fighting。
         */
        camera={{ position: cam.position, fov: cam.fov, near: 0.06, far: 12000 }}
        style={{ position: "absolute", inset: 0 }}
      >
        {overlay ? null : <color attach="background" args={[c.background]} />}
        <CameraSync pos={cam.position} fov={cam.fov} />
        {preset === "grid-horizon" || preset === "waveform" ? (
          // 雾是最有效的"远处消隐"：没有它，网格/底板会在画面边缘硬切一条边
          <fog attach="fog" args={[c.background, 7, isPortrait ? 34 : 46]} />
        ) : null}

        {/*
          灯组由 look 决定（见 LOOKS）。共同的结构是：
          **一盏主光出高光 + 一到两盏背侧边光出轮廓 + 可选补光**，
          正面必须是中性光——彩色正面光会把整颗物体涂满颜色，那是"彩色塑料"不是"科技感"。
          四套 look 差在环境强度、主光色温、边光强度、以及有没有补光。
        */}
        <LookLights spec={lookSpec} core={core} dot={dot} custom={dslLights} />

        {graph ? (
          /*
            不套"有文字时上移"的那个 group：DSL 的相机是用户/agent 自己给的，
            再叠一层位移就等于偷偷改了它的构图。
          */
          <DslScene spec={graph} frame={frame} t={t} theme={theme} camera={dslCam!} />
        ) : (
        <group position={[0, title || sub ? 0.5 : 0, 0]}>
        {preset === "particle-field" ? (
          <ParticleField t={t} count={count} core={core} dot={dot} />
        ) : preset === "grid-horizon" ? (
          <GridHorizon t={t} spin={spin} core={core} dot={dot} isPortrait={isPortrait} />
        ) : preset === "explode-parts" ? (
          <ExplodeParts t={t} spin={spin} count={count} core={core} dot={dot} />
        ) : preset === "waveform" ? (
          <Waveform t={t} spin={spin} count={count} core={core} dot={dot} isPortrait={isPortrait} />
        ) : preset === "globe-arc" ? (
          <GlobeArc t={t} spin={spin} count={count} core={core} dot={dot} accent={accent} />
        ) : preset === "blank" ? (
          /*
            空白母题：什么都不放。它存在的意义是"新增 3D 幕时别硬塞一个预设"——
            用户要么从零搭 graph，要么在面板里挑母题。背景和灯照常（灯没东西可照，零成本）。
          */
          null
        ) : (
          <OrbitCore t={t} spin={spin} count={count} core={core} dot={dot} accent={accent} />
        )}
        </group>
        )}

      </ThreeCanvas>

      {/*
        辉光主路径是 WebGL 后处理（见 ./bloom.ts，在 onCreated 里接管 gl.render）。
        这里只是**降级兜底**：万一环境不支持半浮点渲染目标/多采样，composer 建不起来，
        就退回 CSS 全屏混合——观感差一档，但至少画面还在。

        CSS 方案为什么只是兜底：`blur + brightness + screen` 没有亮度阈值，
        它把整个物体都当成高光提亮，所以金属的锐利高光会被抹平、物体整圈泛白。
        真正让它变成"塑料发光玩具"的，一半是材质，另一半就是这个。
      */}
      {cssBloom ? (
        <AbsoluteFill
          style={{
            // 模糊半径跟画幅走：大画幅上固定像素的模糊会变成"糊一片"，看起来像失焦而不是发光
            backdropFilter: `blur(${bloomBlur}px) brightness(${darkTheme ? 1.35 : 1.14}) contrast(${darkTheme ? 1.32 : 1.08}) saturate(1.4)`,
            WebkitBackdropFilter: `blur(${bloomBlur}px) brightness(${darkTheme ? 1.35 : 1.14}) contrast(${darkTheme ? 1.32 : 1.08}) saturate(1.4)`,
            mixBlendMode: "screen",
            opacity: darkTheme ? 0.5 : 0.26,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* 文字走 2D 叠层：3D 里做中文字体的成本太高（见 docs/threejs-plan.md） */}
      {(title || sub) && !isBackdrop && (
        <AbsoluteFill
          style={{
            justifyContent: "flex-end",
            alignItems: "center",
            // 有字幕时整块标题层躲开字幕条（占位由 Video 按字幕样式实算，不是拍脑袋的固定值）
            paddingBottom: subtitleReservePct > 0 ? h(subtitleReservePct) : h(6),
            // 只在最底部留一道很窄的暗角做文字衬底；不再向上铺开（铺开会挡住 3D 星系）
            // 有字幕时不垫底：字幕条自己带底色，两层暗角叠一起会发灰
            background:
              subtitleReservePct > 0
                ? "transparent"
                : `linear-gradient(to top, ${c.background}8C 0%, ${c.background}00 18%)`,
          }}
        >
          {title ? (
            <Editable id="title" title="标题">
              <div
                style={{
                  fontFamily: theme.font.heading,
                  fontSize: h(4.2),
                  fontWeight: 800,
                  color: c.text,
                  letterSpacing: "0.01em",
                  textAlign: "center",
                  textShadow: "0 2px 20px rgba(0,0,0,0.85), 0 1px 4px rgba(0,0,0,0.9)",
                }}
              >
                {title}
              </div>
            </Editable>
          ) : null}
          {sub ? (
            <Editable id="sub" title="副标题">
              <div
                style={{
                  fontFamily: theme.font.body,
                  fontSize: h(1.9),
                  // textMuted 叠在 3D 的辉光上会糊掉（实拍第 340 帧可见），
                  // 改用正文色压不透明度：对比够了，又不抢主标题
                  color: c.text,
                  opacity: 0.74,
                  marginTop: h(1.2),
                  textAlign: "center",
                  textShadow: "0 2px 14px rgba(0,0,0,0.9), 0 1px 3px rgba(0,0,0,0.9)",
                }}
              >
                {sub}
              </div>
            </Editable>
          ) : null}
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
