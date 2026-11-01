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
const FRAME = 60; // 第 2 秒：爆炸预设此刻正好在悬停段，其余预设也避开了转场

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

type Case = { preset: string; props?: Record<string, unknown>; theme?: typeof DEFAULT_THEME; portrait?: boolean; tag: string };

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
      {
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
