import React from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import type { Theme } from "../../../shared/schema";
import type { Scene3DDsl } from "../../../shared/scene3dDsl";
import { hash01, luminance, resolveColor } from "./color";
import { equirectEnvironment, skyShader } from "./env";

/**
 * 「世界」：渐变天空 + 地面。
 *
 * ## 为什么不能用主题底色
 *
 * 主题的 `background` 是**排版用的纸**，不是**环境**。它要保证 2D 文字的可读性，
 * 所以暗色主题一定是近黑（本项目默认 `#0B0B10`）。把它当 3D 的世界，
 * 等于把模型摆在黑摄影棚里、还不开背景灯：物体边缘直接溶进背景，
 * 没有地平线、没有空气、没有远景 —— 就是「乌漆麻黑、看不清」。
 *
 * 真实作品的背景永远是**独立的**：Blender 的 world、C4D 的背景对象、Unreal 的 SkyAtmosphere，
 * 都和 UI 主题无关。它们的共同点是"天顶偏暗、地平线偏亮、中间一道漫射光带"，
 * 因为那才是眼睛熟悉的样子（大气散射）。
 *
 * `world.mode = "auto"` 时只借主题的**明暗**（暗主题给夜、浅主题给天光），
 * 色相固定为中性冷灰 —— 不跟主题色走，避免"绿主题配绿天"这种一眼假的画面。
 */

export type WorldColors = { top: string; bottom: string; glow: string };

/** 暗主题：深蓝灰的夜，地平线稍亮，带一点冷调漫射 */
const NIGHT: WorldColors = { top: "#0A0D14", bottom: "#2B3342", glow: "#22304A" };
/** 浅主题：冷白的天光，越靠地平线越亮 */
const DAY: WorldColors = { top: "#B9C3D3", bottom: "#EDEFF3", glow: "#FFFFFF" };
/**
 * 深空：近黑，只有极弱的蓝调渐变。
 *
 * **glow 必须给纯黑**。天空 shader 在地平线附近固定加一道亮带（那是大气散射），
 * 深空里没有大气 —— 留着它，画面下半部就有一条横贯的灰蓝光带，
 * 一眼就能看出"太空里居然有地平线"，这正是太阳系示例原来不好看的主因。
 * 层次交给星点、银河、星云，不给渐变。
 */
const SPACE: WorldColors = { top: "#01020A", bottom: "#050A16", glow: "#000000" };

export const resolveWorld = (graph: Scene3DDsl | undefined, theme: Theme): WorldColors => {
  const w = graph?.world;
  if (w?.mode === "space") {
    return {
      top: w.top ? resolveColor(w.top, theme) : SPACE.top,
      bottom: w.bottom ? resolveColor(w.bottom, theme) : SPACE.bottom,
      glow: SPACE.glow,
    };
  }
  if (w?.mode === "image") {
    /**
     * 全景图模式下这两个颜色只剩两个用途：**雾色**和**加载中的兜底色**。
     * 雾色默认给一个中性暖灰（黄昏地面霾），让它贴近多数室外全景的地平线；
     * 想精确对齐就用 `bottom` 指定 —— 雾色和背景地平线不一致是最扎眼的破绽。
     */
    return {
      top: w.top ? resolveColor(w.top, theme) : "#3A3833",
      bottom: w.bottom ? resolveColor(w.bottom, theme) : "#6F6A63",
      glow: "#000000",
    };
  }
  if (w?.mode === "color" && w.color) {
    const c = resolveColor(w.color, theme);
    return { top: c, bottom: c, glow: "#000000" };
  }
  if (w?.mode === "gradient") {
    return {
      top: w.top ? resolveColor(w.top, theme) : NIGHT.top,
      bottom: w.bottom ? resolveColor(w.bottom, theme) : NIGHT.bottom,
      glow: w.glow ? resolveColor(w.glow, theme) : NIGHT.glow,
    };
  }
  return luminance(theme.palette.background) < 0.32 ? NIGHT : DAY;
};

/** 银河带倾角：水平铺一条会像"雾状楼梯"，必须斜穿画面才有纵深 */
const BAND_TILT = (56 * Math.PI) / 180;
const BAND_YAW = (-24 * Math.PI) / 180;
/** 带平面的法线：shader 用 `dot(方向, 法线)` 算到带的距离，方向必须和视觉上的带对齐 */
const BAND_NORMAL = (() => {
  const n = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(BAND_TILT, BAND_YAW, 0, "YXZ"));
  return [n.x, n.y, n.z] as [number, number, number];
})();

/** 天空球的银河参数（null = 普通天空，不画银河） */
export type GalaxySpec = {
  /** 银河带的法线 */
  normal: [number, number, number];
  color: string;
  strength: number;
  nebula: number;
  nebulaColor: string;
};

/**
 * 天空球。
 *
 * 半径 3000：相机的 far 是 12000（太阳系那种一镜到底要拉很远），
 * 天空必须在这个范围里，否则会被裁掉变成"什么都没有"（背景一片死黑）。
 *
 * **不跟着内容的刚体变换走**：天空是无限远的，平移它没有视觉意义；
 * 而且它在渲染原点就够大了，内容的位移量（几十到几百）在 3000 的半径下可忽略。
 * （旋转要跟 —— 见 WorldLayer 的 orientation，那是"相机在看哪个方向"。）
 */
export const SkyDome: React.FC<{ colors: WorldColors; galaxy?: GalaxySpec | null }> = ({ colors, galaxy }) => {
  const bandStrength = galaxy?.strength ?? 0;
  const nebulaStrength = galaxy?.nebula ?? 0;
  const bandColor = galaxy?.color ?? "#000000";
  const nebulaColor = galaxy?.nebulaColor ?? "#000000";
  /**
   * 依赖写成**标量**而不是整个 galaxy 对象：对象每次 render 都是新的引用，
   * 那样 uniforms 会被逐帧重建（Remotion 一帧一张图，等于每帧都 new 一遍 Color）。
   */
  const uniforms = React.useMemo(
    () => ({
      topColor: { value: new THREE.Color(colors.top) },
      bottomColor: { value: new THREE.Color(colors.bottom) },
      glowColor: { value: new THREE.Color(colors.glow).multiplyScalar(0.55) },
      bandNormal: { value: new THREE.Vector3(...BAND_NORMAL) },
      bandColor: { value: new THREE.Color(bandColor) },
      nebulaColor: { value: new THREE.Color(nebulaColor) },
      bandStrength: { value: bandStrength },
      nebulaStrength: { value: nebulaStrength },
    }),
    [colors.top, colors.bottom, colors.glow, bandColor, nebulaColor, bandStrength, nebulaStrength],
  );
  return (
    <mesh renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[3000, 32, 24]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={skyShader.vertex}
        fragmentShader={skyShader.fragment}
        side={THREE.BackSide}
        depthWrite={false}
        // 天空不参与雾：它就是"雾的尽头"，再被雾洗一遍就成了纯色
        fog={false}
      />
    </mesh>
  );
};

/* ─────────────────────────── 深空（星点 / 银河 / 星云） ─────────────────────────── */

/**
 * 深空由两套东西拼成，分工很清楚：
 *
 * - **星点**走几何（`<points>` + 加法混合）。它们是**点光源**，在像面上是一个 PSF，
 *   尺寸用像素而不是世界单位（`sizeAttenuation={false}`），不随距离变小。
 *   而且只有几何体的亮度能被后处理 bloom 拾取 —— 靠 shader 画在天空球上的"星星"
 *   属于背景色的一部分，亮也亮不到阈值以上，出不来星点的光晕。
 *
 * - **银河与星云**走天空 shader（见 `env.ts` 的 fbm）。这里试过用几千个大尺寸
 *   柔雾精灵叠：不论怎么调，都还是一颗颗圆斑连成的"珍珠链"，因为每张精灵贴图
 *   是同一枚印章，眼睛一眼就能认出重复。逐像素噪声才有真实的纤维状结构。
 *
 * 分工的代价是两套坐标必须对齐：银河带的方向在 shader 里是 `bandNormal`，
 * 这里的星点只负责全天均匀铺（不需要对齐）。
 */
const STAR_R = 2600;

const COOL_STAR = new THREE.Color("#CFE0FF");
const WARM_STAR = new THREE.Color("#FFE9CC");
/** 银河带淡白偏暖（银心是低色温恒星，全蓝会被看成"紫雾"） */
const BAND_COLOR = "#D8D2C4";
/** 星云默认主色（冷蓝） */
const NEBULA_BLUE = "#42558A";

/**
 * 星点贴图。
 *
 * 用 `glowTexture` 那种"中心 1 → 0.22 处就掉到 0.55"的软光斑是不行的：
 * 星点在屏上只有两三像素，软光斑采到的正好是半透明的那一圈，星星整片发灰。
 * 这里做一颗"硬核 + 短光晕"，核心占 18% 半径。
 *
 * **必须关 mipmap**：2px 的点采样到 mip 底层等于把整张光斑平均成透明，
 * 表现是"代码里明明有几千颗星，画面上一颗都看不见"。
 */
let starDotCache: THREE.CanvasTexture | null = null;
const starDot = (): THREE.CanvasTexture | null => {
  if (starDotCache) return starDotCache;
  if (typeof document === "undefined") return null;
  const size = 64;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.96)");
  g.addColorStop(0.42, "rgba(255,255,255,0.26)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  starDotCache = tex;
  return tex;
};

type Cloud = { positions: Float32Array; colors: Float32Array };
/** 球面均匀（方向分布没有极点堆叠），半径固定的星点壳 */
const sphereCloud = (count: number, radius: number, brightness: [number, number]): Cloud => {
  const positions = new Float32Array(Math.max(count, 0) * 3);
  const colors = new Float32Array(Math.max(count, 0) * 3);
  for (let i = 0; i < count; i++) {
    const u = hash01(i, 11);
    const v = hash01(i, 12);
    const phi = Math.acos(2 * u - 1);
    const theta = Math.PI * 2 * v;
    const sp = Math.sin(phi);
    positions[i * 3] = radius * sp * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.cos(phi);
    positions[i * 3 + 2] = radius * sp * Math.sin(theta);
    // 大多数星偏冷（真实天区里 K/M 型暗红星光太弱，肉眼看到的多是 A/B 型的蓝白）
    const c = COOL_STAR.clone().lerp(WARM_STAR, hash01(i, 13) ** 3);
    const b = brightness[0] + (brightness[1] - brightness[0]) * hash01(i, 14);
    colors[i * 3] = c.r * b;
    colors[i * 3 + 1] = c.g * b;
    colors[i * 3 + 2] = c.b * b;
  }
  return { positions, colors };
};

/**
 * 一层精灵点云。四层结构一样，只有尺寸/贴图/混合参数不同 —— 抽出来免得
 * 四个 `<points>` 各写一遍（改一处忘三处是这类代码最常见的坏味道）。
 */
const SpriteLayer: React.FC<{
  cloud: Cloud;
  texture: THREE.Texture;
  /** 像素尺寸（attenuate=false）或世界尺寸（attenuate=true） */
  size: number;
  opacity?: number;
  attenuate?: boolean;
  order: number;
}> = ({ cloud, texture, size, opacity = 1, attenuate = false, order }) => (
  <points renderOrder={order} frustumCulled={false}>
    <bufferGeometry>
      <bufferAttribute attach="attributes-position" args={[cloud.positions, 3]} />
      <bufferAttribute attach="attributes-color" args={[cloud.colors, 3]} />
    </bufferGeometry>
    <pointsMaterial
      size={size}
      sizeAttenuation={attenuate}
      vertexColors
      map={texture}
      transparent
      opacity={opacity}
      depthWrite={false}
      blending={THREE.AdditiveBlending}
      fog={false}
    />
  </points>
);

export const SpaceSky: React.FC<{
  /** 星点密度/亮度倍数（0 = 没有星） */
  stars: number;
}> = ({ stars }) => {
  const dot = starDot();
  const layer = React.useMemo(
    () => ({
      // 小星铺满全天；亮星只占 6% —— 真实星等的幂律分布就是「绝大多数是暗星」
      small: sphereCloud(Math.round(3000 * stars), STAR_R, [0.3, 0.9]),
      bright: sphereCloud(Math.round(180 * stars), STAR_R, [1.0, 2.4]),
    }),
    [stars],
  );

  if (!dot || stars <= 0) return null;
  return (
    <group>
      {/*
       * 银河和星云不在这里：它们在天空 shader 里（SkyDome 的 galaxy 参数）。
       * 这两层只负责「点」—— 尺寸写死像素、加法混合，让 bloom 有东西可拾。
       * depthTest 保持开启：行星必须能挡住身后的星。
       */}
      <SpriteLayer cloud={layer.small} texture={dot} size={2.6} order={-999} />
      <SpriteLayer cloud={layer.bright} texture={dot} size={7} order={-998} />
    </group>
  );
};

/**
 * 自动地面高度：所有实体节点里**最低的那个**再往下一丁点。
 *
 * 为什么要算而不是默认 0：原点在哪儿完全取决于作者的习惯 ——
 * 蒸汽机车的轮子在 y=-0.16、枕木在 -0.56，地面放 0 会横穿车体；
 * 而太阳系示例的行星都在 y=0 上，地面放 0 又正好。写死哪个都错。
 */
const autoGroundY = (graph: Scene3DDsl): number => {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const worldY = (id: string): number => {
    const n = byId.get(id);
    if (!n) return 0;
    const own = n.transform?.position?.[1] ?? 0;
    // 父链最多走 16 层：数据里已经校验过不成环，这里只是防呆
    let hops = 0;
    let cur = n.parent ? byId.get(n.parent) : undefined;
    let acc = own;
    while (cur && hops++ < 16) {
      acc += cur.transform?.position?.[1] ?? 0;
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return acc;
  };
  const ys = graph.nodes
    .filter((n) => n.geometry && n.geometry.type !== "group" && !n.hidden)
    .map((n) => worldY(n.id));
  return ys.length ? Math.min(...ys) - 0.02 : 0;
};

export const groundYOf = (graph: Scene3DDsl): number => graph.ground?.y ?? autoGroundY(graph);

/**
 * 地面。
 *
 * **必须渲染在内容的刚体 group 里**（DslScene 内），不能放在场景根上：
 * DSL 的相机是通过"把内容搬到渲染原点"实现的（见 DslScene.dslCamera），
 * 地面留在世界坐标里就会和物体脱开 —— 表现是"地面斜着插进车里"。
 */
export const Ground: React.FC<{ graph: Scene3DDsl; theme: Theme }> = ({ graph, theme }) => {
  const spec = graph.ground;
  if (!spec) return null;
  const shadowOnly = spec.mode === "shadow";
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, groundYOf(graph), 0]} receiveShadow={spec.shadow}>
      <planeGeometry args={[spec.size, spec.size]} />
      {shadowOnly ? (
        /**
         * `shadowMaterial`：除了阴影之外完全透明。
         * 配全景图时这是唯一正确的做法 —— 照片里已经有地面，实体平面会把照片的地平线
         * 和草纹全盖掉，看起来像在地上铺了块塑料布。
         */
        <shadowMaterial transparent opacity={spec.shadowOpacity} />
      ) : (
        <meshStandardMaterial
          color={resolveColor(spec.color, theme)}
          roughness={spec.roughness}
          metalness={spec.metalness}
          // 地面不发光，但要吃一点环境反射，否则是一块死平的灰
          envMapIntensity={0.8}
          dithering
        />
      )}
    </mesh>
  );
};

/**
 * 世界层：**渐变天空**或**全景图**，二选一，外加把全景图烘成 IBL。
 *
 * 为什么两者要放在同一个组件里：全景图加载是异步的，而"环境贴图"和"背景"
 * 必须来自同一张图 —— 否则会出现"背景是黄昏、光照却是正午"这种一眼假的组合。
 * 一次加载、两处使用，就不会走岔。
 */
export const WorldLayer: React.FC<{
  graph: Scene3DDsl;
  theme: Theme;
  /** look 决定的环境强度（和程序化棚拍那套同一个数字） */
  envIntensity: number;
  /**
   * 全景图纹理：**由外层的 Scene3D 加载后传进来**。
   * 不能在这个组件里加载 —— 它活在 R3F 的 reconciler 里，`delayRender` 在那里注册
   * Remotion 看不见，静帧会截在贴图到位之前（详见 env.ts 的 useWorldTexture 注释）。
   */
  tex: THREE.Texture | null;
  /**
   * 相机朝向（四元数）。
   *
   * DSL 的相机是"钉在 +Z、把内容搬过去"（见 DslScene.dslCamera），所以**相机永远不转**——
   * 摇镜时转的是内容。天空如果固定不动，摇镜时星星会一动不动地贴在镜头上，
   * 那是"背景板"而不是"天球"。世界层跟着这个四元数转，等价于相机真的在看不同方向。
   * 平移（groupPos）不用跟：星点在半径 2600 的壳上，几十单位的位移等于视差为零。
   */
  orientation?: [number, number, number, number];
}> = ({ graph, theme, envIntensity, tex, orientation }) => {
  const w = graph.world;
  const src = w?.mode === "image" ? w.image : undefined;
  const colors = React.useMemo(() => resolveWorld(graph, theme), [graph, theme]);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const advance = useThree((s) => s.advance);

  React.useEffect(() => {
    if (!tex || !src) return;
    /**
     * 背景必须走 `scene.background`，**不能用球体贴图**。
     *
     * 用球体（`sphereGeometry` + `map` + BackSide）试过：three 的球面 UV 与
     * 等距柱状的 V 方向是反的，结果是"草地上半张、天空只剩一条缝"——
     * 背景图和相机对不上，而且不同几何体版本还会再差一次。
     * `scene.background` 有专门的 background pass，方向、环绕、mipmap 都由引擎处理。
     *
     * `backgroundBlurriness` 给一点点（0.08）：相机拍全景背景天然带景深虚化，
     * 全清晰反而显得像贴纸；这个值同时掩盖 2k 全景在 1080p 下的分辨率不足。
     */
    scene.background = tex;
    /**
     * **不要开 backgroundBlurriness**。
     *
     * 试过 0.08 想着"模拟景深虚化"，实际效果是把整张全景糊成一片米色 ——
     * three 的 background 模糊走 PMREM 的粗糙度层级，0.08 就已经跳到很低的 mip 上了，
     * 云和地平线全部消失、只剩颜色。要虚化只能在后期做（景深 pass），不是这个参数。
     */
    scene.backgroundBlurriness = 0;
    // 按主体曝光、背景另调：暗场景里主体打亮了，天空就会"过曝"，这里主动压一档
    (scene as unknown as { backgroundIntensity?: number }).backgroundIntensity = w?.imageIntensity ?? 1;
    // 把太阳/地平线转到想要的方位（弧度），和 DSL 的"度"约定换算一次
    (scene as unknown as { backgroundRotation?: THREE.Euler }).backgroundRotation = new THREE.Euler(
      0,
      ((w?.imageRotation ?? 0) * Math.PI) / 180,
      0,
    );
    // 换环境贴图会换材质编译分支（是否采样 envMap），不主动重画就还是上一版画面
    advance(performance.now());
    return () => {
      scene.background = null;
    };
  }, [tex, src, scene, advance, w?.imageRotation, w?.imageIntensity]);

  React.useEffect(() => {
    if (!tex || !src) return;
    // 关掉 imageLighting 时保留程序化棚拍光：背景是照片，照明还是可控的
    if (w?.imageLighting === false) return;
    try {
      scene.environment = equirectEnvironment(gl, tex);
      (scene as unknown as { environmentIntensity?: number }).environmentIntensity = envIntensity;
      /**
       * 环境也要跟着转：只转背景不转 IBL，会出现"背景里的窗在右、照亮物体的光却来自左"——
       * 夜景/室内这种有明显光源方位的图，一眼就能看出来。
       */
      (scene as unknown as { environmentRotation?: THREE.Euler }).environmentRotation = new THREE.Euler(
        0,
        ((w?.imageRotation ?? 0) * Math.PI) / 180,
        0,
      );
      advance(performance.now());
    } catch {
      // 软件渲染环境不支持 PMREM 时降级：只有灯，不黑屏
    }
  }, [tex, src, gl, scene, envIntensity, advance, w?.imageLighting, w?.imageRotation]);

  if (tex) return null;
  const space = w?.mode === "space";
  /**
   * 银河强度：0.5 是"抬头能看见、但不抢主体"的档。
   *
   * 强度上限写 1.1 而不是跟着参数到 2：叠到 2 的时候整条带会把画面下半部
   * 抬成灰白，行星的暗面全糊掉 —— 深空背景的作用是"有深度"，不是"当主光"。
   */
  const galaxy: GalaxySpec | null = space
    ? {
        normal: BAND_NORMAL,
        color: BAND_COLOR,
        strength: Math.min(0.26, (w?.milkyWay ?? 0.5) * 0.2),
        nebula: Math.min(0.4, (w?.nebula ?? 0.35) * 0.35),
        nebulaColor: w?.spaceTint ? resolveColor(w.spaceTint, theme) : NEBULA_BLUE,
      }
    : null;
  return (
    <group quaternion={orientation}>
      <SkyDome colors={colors} galaxy={galaxy} />
      {space ? <SpaceSky stars={w?.stars ?? 1} /> : null}
    </group>
  );
};

/**
 * 空气透视的距离：
 *
 * 雾太近会把主体洗掉，太远等于没有。按场景的自动取景距离推：
 * 主体在 1 倍距离处、雾从 1.6 倍开始 —— 也就是"主体全清晰，远处地面淡出"。
 * 天文场景（autoDist 几十上百）自然得到很大的雾距，等于不开。
 *
 * `haze` 只压"雾的终点"：0 = 关（调用方直接不挂 fog），1 = 终点收到 1.4 倍距离。
 * 不动起点是有意的——起点一近，主体自己就开始发灰，那是最常见的"雾用过头"。
 */
export const fogRange = (autoDist: number, haze = 0.35): [number, number] => {
  const near = Math.max(6, autoDist * 1.6);
  const far = Math.max(near * 1.6, Math.max(40, autoDist * 7) * (1 - haze * 0.6));
  return [near, far];
};
