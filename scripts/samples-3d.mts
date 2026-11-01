/**
 * 3D 预设样张：node_modules/.bin/tsx scripts/samples-3d.mts
 *
 * 一次 bundle，逐预设抽一张静帧到 docs/threejs-samples/。
 * 静帧比视频快两个数量级，改一次参数看一次效果就靠它。
 */
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { createSeedProject } from "../shared/ops.ts";
import { getMeta, normalizeProps } from "../shared/sceneMetas.ts";
import { DEFAULT_THEME } from "../shared/schema.ts";

const OUT = path.resolve("docs/threejs-samples");
const W = 1280;
const H = 720;
/** 竖屏：单独一组，用来核对"相机按画幅分档"到底够不够 */
const PW = 720;
const PH = 1280;
// 第 2 秒：爆炸预设此刻正好在悬停段，其余预设也避开了转场。
// 要对比"动画有没有在动"，用 SAMPLE_FRAME=100 再跑一遍比 md5 即可。
const FRAME = Number(process.env.SAMPLE_FRAME ?? 60);

/**
 * 用本机 Edge 出图，不走 Remotion 自动下载。
 *
 * 自动下载走 storage.googleapis.com，实测这里只有 20KB/s，130MB 的包要一个多小时。
 * 本机 Edge + `chrome-for-testing` 模式（--headless=new）能直接出图，和线上服务
 * `server/render.service.ts` 里的 `detectBrowser()` 走的是同一条路。
 */
const BROWSER_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];
const browserPath = process.env.REMOTION_BROWSER ?? BROWSER_CANDIDATES.find((p) => existsSync(p));
const chromeMode = browserPath?.toLowerCase().includes("chrome-headless-shell")
  ? ("headless-shell" as const)
  : ("chrome-for-testing" as const);

/** 浅色主题：专门用来验证 bloom 的"浅底分档"有没有把画面糊掉 */
const LIGHT_THEME = {
  ...DEFAULT_THEME,
  palette: {
    background: "#F3F1EA",
    surface: "#FFFFFF",
    text: "#141416",
    textMuted: "#6B6870",
    primary: "#1F3BE0",
    secondary: "#7A4BE0",
    accent: "#E05A1F",
  },
};

/* ─────────────────── M2：场景图 DSL 的三个例子 ─────────────────── */

/**
 * 分子/原子：中心核 + 三条轨道环 + 沿环公转的电子。
 * 轨道环用 basic 材质（不受光，纯色细线），电子用高 emissive 小球 ——
 * 这样"结构"和"能量点"在同一画面里读得开。
 */
const GRAPH_MOLECULE = {
  camera: { position: [0, 2.1, 6.2], target: [0, 0, 0], fov: 40, orbit: { degPerSec: 10 } },
  nodes: [
    {
      id: "core",
      geometry: { type: "sphere", radius: 0.5, segments: 48 },
      material: { color: "primary", metalness: 1, roughness: 0.2, emissive: "primary", emissiveIntensity: 0.08 },
    },
    ...[0, 60, 120].map((deg, i) => ({
      id: `orbit${i}`,
      geometry: { type: "torus", radius: 1.45, tube: 0.008, radialSegments: 8, tubularSegments: 128 },
      material: { type: "basic", color: "accent", body: false, opacity: 0.55 },
      transform: { rotation: [deg, 0, 0] },
    })),
    /*
     * 电子挂在 pivot 上、pivot 挂在环上并自己绕 Y 转：
     * 环负责"倾角"，pivot 负责"公转"。少了 pivot 这一层，电子只会定在环的某一点上
     * （第一版就是这么写错的 —— 电子直接 parent 到环，环没有动画，画面里三个电子全叠在一起）。
     */
    ...[0, 1, 2].map((i) => ({
      id: `pivot${i}`,
      parent: `orbit${i}`,
      geometry: { type: "sphere", radius: 0.001 },
      material: { type: "basic", color: "text", body: false, opacity: 0 },
      // 绕 **Z** 而不是 Y：torus 的圆在 XY 平面里，绕 Y 转会让电子跑到环外面去
      anim: [{ at: [0, 120], from: { rotZ: i * 120 }, to: { rotZ: i * 120 + 360 }, ease: "linear" }],
    })),
    ...[0, 1, 2].map((i) => ({
      id: `e${i}`,
      parent: `pivot${i}`,
      geometry: { type: "sphere", radius: 0.075, segments: 20 },
      material: { color: "accent", body: false, metalness: 0, roughness: 0.3, emissive: "accent", emissiveIntensity: 3 },
      transform: { position: [1.45, 0, 0] },
    })),
  ],
};

/** 机械：底座 + 立柱 + 两段臂（parent 串起来），臂在转，末端有玻璃球 */
const GRAPH_MACHINE = {
  // 取景对准模型的重心（臂伸向 +x，所以 target 要往右挪），否则主体会挤在右上角
  camera: { position: [2.9, 2.2, 4.1], target: [0.75, 0.85, 0], fov: 42, orbit: { degPerSec: 6 } },
  nodes: [
    {
      id: "base",
      geometry: { type: "cylinder", radiusTop: 0.75, radiusBottom: 0.9, height: 0.22, segments: 48 },
      material: { color: "secondary", metalness: 1, roughness: 0.28 },
    },
    {
      id: "column",
      geometry: { type: "box", width: 0.26, height: 1.5, depth: 0.26 },
      material: { color: "secondary", metalness: 1, roughness: 0.32 },
      transform: { position: [0, 0.86, 0] },
    },
    {
      id: "arm1",
      geometry: { type: "box", width: 1.5, height: 0.16, depth: 0.2 },
      material: { color: "text", metalness: 1, roughness: 0.3 },
      transform: { position: [0.7, 1.62, 0] },
      anim: [{ at: [0, 120], from: { rotY: -25 }, to: { rotY: 25 }, ease: "easeInOut" }],
    },
    {
      id: "jam1",
      geometry: { type: "sphere", radius: 0.15, segments: 32 },
      material: { color: "accent", metalness: 1, roughness: 0.22 },
      transform: { position: [0.72, 0, 0] },
      parent: "arm1",
    },
    {
      id: "arm2",
      geometry: { type: "box", width: 0.9, height: 0.13, depth: 0.16 },
      material: { color: "text", metalness: 1, roughness: 0.3 },
      transform: { position: [0.45, 0, 0] },
      parent: "arm1",
      anim: [{ at: [0, 120], from: { rotY: 35 }, to: { rotY: -20 }, ease: "easeInOut" }],
    },
    {
      id: "lens",
      geometry: { type: "sphere", radius: 0.2, segments: 40 },
      material: { type: "physical", color: "text", transmission: 0.92, thickness: 0.5, ior: 1.6 },
      transform: { position: [0.45, 0, 0] },
      parent: "arm2",
    },
  ],
  particles: { count: 260, spread: [4, 2.4, 4], size: 0.05, color: "accent", drift: 0.5, opacity: 0.5 },
};

/** 抽象雕塑：环面纽结 + 线框外壳 + 玻璃球 + 辉光开大 */
const GRAPH_SCULPT = {
  camera: { position: [0, 1.0, 6.9], target: [0, 0, 0], fov: 40, orbit: { degPerSec: 14 } },
  nodes: [
    {
      id: "knot",
      geometry: { type: "torusKnot", radius: 1.05, tube: 0.3, p: 2, q: 3 },
      material: { color: "primary", metalness: 1, roughness: 0.26, emissive: "primary", emissiveIntensity: 0.06 },
      anim: [{ at: [0, 120], from: { rotY: 0, rotX: 20 }, to: { rotY: 180, rotX: 20 }, ease: "linear" }],
    },
    {
      id: "shell",
      geometry: { type: "icosahedron", radius: 2.05, detail: 1 },
      material: { type: "basic", color: "accent", body: false, wireframe: true, opacity: 0.09 },
      anim: [{ at: [0, 120], from: { rotY: 0 }, to: { rotY: -90 }, ease: "linear" }],
    },
    {
      id: "drop",
      geometry: { type: "sphere", radius: 0.26, segments: 40 },
      material: { type: "physical", color: "text", transmission: 0.95, thickness: 0.6, ior: 1.7 },
      transform: { position: [1.65, 0.9, 0.6] },
      anim: [{ at: [0, 120], from: { posY: 0.9 }, to: { posY: 1.35 }, ease: "easeInOut" }],
    },
  ],
  post: { bloom: 1.15 },
};

type Case = {
  preset: string;
  props?: Record<string, unknown>;
  theme?: typeof DEFAULT_THEME;
  portrait?: boolean;
  tag: string;
  /** 有值就渲成"2D 版式 + 3D 氛围层"，用来验 Backdrop 接入 */
  backdrop?: Record<string, unknown>;
  /** 承载氛围层的 2D 版式（默认 bullets） */
  host?: string;
  hostProps?: Record<string, unknown>;
};

const CASES: Case[] = [
  { preset: "orbit-core", tag: "1-orbit-core" },
  { preset: "particle-field", tag: "2-particle-field" },
  { preset: "grid-horizon", tag: "3-grid-horizon" },
  { preset: "explode-parts", tag: "4-explode-parts" },
  { preset: "waveform", tag: "5-waveform" },
  { preset: "globe-arc", tag: "6-globe-arc" },
  // 浅色底对照：同一预设 + bloom 分档
  { preset: "orbit-core", theme: LIGHT_THEME as typeof DEFAULT_THEME, tag: "7-light-orbit" },
  { preset: "waveform", theme: LIGHT_THEME as typeof DEFAULT_THEME, tag: "8-light-waveform" },
  // 竖屏抽查：结构最"宽"的和最"高"的各来一张
  { preset: "orbit-core", portrait: true, tag: "9-portrait-orbit" },
  { preset: "explode-parts", portrait: true, tag: "10-portrait-explode" },
  /**
   * 光线风格对照：**同一个预设、同一帧，只换 look**。
   * 这是判断"四套 look 到底有没有区分度"的唯一办法——
   * 换预设对比是看不出问题的，因为以前的六个预设本来就长得像。
   */
  { preset: "orbit-core", props: { look: "studio" }, tag: "11-look-studio" },
  { preset: "orbit-core", props: { look: "dramatic" }, tag: "12-look-dramatic" },
  { preset: "orbit-core", props: { look: "cyber" }, tag: "13-look-cyber" },
  { preset: "orbit-core", props: { look: "nature" }, tag: "14-look-nature" },
  // 自动 pick 的效果：这几个预设默认就是不同 look，摆在一起不该"撞脸"
  { preset: "explode-parts", tag: "15-auto-explode" },
  { preset: "waveform", tag: "16-auto-waveform" },
  { preset: "globe-arc", tag: "17-auto-globe" },
  // 柱阵对光线最敏感（发光体+受光柱体混在一起），单独比两套 look
  { preset: "waveform", props: { look: "studio" }, tag: "18-wave-studio" },
  { preset: "waveform", props: { look: "cyber" }, tag: "19-wave-cyber" },
  /**
   * 3D 当氛围层：上面压 2D 文字。
   * 这是"3D 和文字共存"最不容易出事的姿势——3D 退成背景，字永远在最前。
   */
  {
    preset: "particle-field",
    tag: "20-backdrop-particles",
    backdrop: { type: "scene3d", props: { preset: "particle-field", count: 6 }, opacity: 0.95 },
  },
  {
    preset: "grid-horizon",
    tag: "21-backdrop-grid",
    backdrop: { type: "scene3d", props: { preset: "grid-horizon" }, opacity: 0.9 },
    host: "title",
    hostProps: { eyebrow: "背景是 3D", title: "文字永远在最前", subtitle: "3D 退成氛围层" },
  },
  // 层次自由：同一套 3D 放到"上"层，应当自动透明、字仍然可读
  {
    preset: "sparks",
    tag: "22-backdrop-overlay",
    backdrop: { type: "scene3d", props: { preset: "particle-field", count: 4 }, place: "上", opacity: 0.9 },
  },
  /**
   * 双层 3D：3D 场景 + 3D 氛围层同时存在，一帧里两个 WebGL 上下文、两套 composer。
   * 注意必须放"上"层：3D 场景本身是不透明的（要自带底色做辉光），
   * 垫在它下面的氛围层会被整块盖住 —— "3D 场景 + 3D 底"是个无效组合。
   */
  {
    preset: "orbit-core",
    tag: "23-double-3d",
    host: "scene3d",
    hostProps: { preset: "orbit-core", title: "双层 3D", sub: "场景 + 氛围层" },
    backdrop: { type: "scene3d", props: { preset: "grid-horizon" }, place: "上", opacity: 0.55 },
  },
  /* M2：场景图 DSL —— 这三张不看预设，全部由 nodes/particles/camera 描述 */
  { preset: "orbit-core", props: { graph: GRAPH_MOLECULE }, tag: "24-dsl-molecule" },
  { preset: "orbit-core", props: { graph: GRAPH_MACHINE }, tag: "25-dsl-machine" },
  { preset: "orbit-core", props: { graph: GRAPH_SCULPT }, tag: "26-dsl-sculpt" },
];


const base = createSeedProject("p_3d_samples");

const propsFor = (c: Case) => {
  const meta = getMeta("scene3d")!;
  const project = {
    ...base,
    name: `3d-${c.preset}`,
    theme: c.theme ?? DEFAULT_THEME,
    formats: [
      c.portrait
        ? { key: "portrait", label: "竖屏 9:16", width: PW, height: PH }
        : { key: "landscape", label: "横屏 16:9", width: W, height: H },
    ],
    scenes: [
      c.backdrop
        ? {
            id: "scene_bd",
            type: c.host ?? "bullets",
            name: "氛围层承载",
            durationInFrames: 120,
            props: normalizeProps(
              c.host ?? "bullets",
              c.hostProps ?? {
                heading: "3D 当背景",
                items: [{ text: "上面照常压 2D 文字" }, { text: "字永远在最前" }],
              },
            ),
            backdrop: c.backdrop,
            transitionIn: { type: "fade", durationInFrames: 12 },
          }
        : {
            id: "scene_3d",
            type: "scene3d",
            name: meta.name,
            durationInFrames: 120,
            props: normalizeProps("scene3d", { preset: c.preset, title: "", sub: "", ...(c.props ?? {}) }),
            transitionIn: { type: "fade", durationInFrames: 12 },
          },
    ],
  };
  return { ...project, formatKey: c.portrait ? "portrait" : "landscape" };
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  // 可只渲一张：tsx scripts/samples-3d.mts waveform
  const only = process.argv[2];
  const cases = only ? CASES.filter((c) => c.tag.includes(only)) : CASES;
  if (!cases.length) throw new Error(`没有匹配的预设：${only}`);
  const t0 = Date.now();
  console.log(`▸ 浏览器：${browserPath ?? "（未找到，将触发下载）"} [${chromeMode}]`);
  console.log("▸ 打包中…");
  const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
  console.log(`✓ 打包完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  for (const c of cases) {
    const inputProps = propsFor(c);
    const t1 = Date.now();
    const composition = await selectComposition({
      serveUrl,
      id: "Video",
      inputProps,
      browserExecutable: browserPath,
      chromeMode,
    });
    const output = path.join(OUT, `${c.tag}.png`);
    const t2 = Date.now();
    await renderStill({
      composition,
      serveUrl,
      output,
      frame: FRAME,
      inputProps,
      browserExecutable: browserPath,
      chromeMode,
    });
    console.log(`✓ ${c.tag}  选择 ${((t2 - t1) / 1000).toFixed(1)}s  出图 ${((Date.now() - t2) / 1000).toFixed(1)}s`);
  }
  console.log(`\n样张目录：${OUT}（总计 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
