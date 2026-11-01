/**
 * 实拍一支混排片：2D 版式 + 3D 场景交替，用来验"动起来对不对"。
 *
 *   node_modules/.bin/tsx scripts/tape-3d.mts            # 全片
 *   node_modules/.bin/tsx scripts/tape-3d.mts 0 29       # 只渲某段帧（先量速度）
 *
 * 为什么单帧样张不够：
 * - 静态图看不出**循环接缝**（explode 的展开—悬停—合回是不是首尾无缝）；
 * - 看不出 **2D↔3D 的切场跳色**（这正是关掉 ACES 要解决的那件事）；
 * - 看不出**逐帧确定性**（同一帧渲两次像素是否一致）。
 *
 * 出片走 crf 26 全分辨率，不做任何"预览降质"——降了就不是成片了。
 */
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { createSeedProject } from "../shared/ops.ts";
import { getMeta, normalizeProps } from "../shared/sceneMetas.ts";
import { DEFAULT_THEME } from "../shared/schema.ts";

const OUT_DIR = path.resolve("out");
const W = 1280;
const H = 720;

const BROWSER_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
];
const browserPath = process.env.REMOTION_BROWSER ?? BROWSER_CANDIDATES.find((p) => existsSync(p));
const chromeMode = browserPath?.toLowerCase().includes("chrome-headless-shell")
  ? ("headless-shell" as const)
  : ("chrome-for-testing" as const);

const base = createSeedProject("p_tape_3d");

/** 混排脚本：2D 开场 → 3D 主体 → 2D 说明 → 3D 拆解 → 3D 频谱 → 2D 收尾 */
const SCENES: {
  type: string;
  frames: number;
  props?: Record<string, unknown>;
  backdrop?: Record<string, unknown>;
}[] = [
  {
    type: "title",
    frames: 75,
    props: {
      eyebrow: "THREE.JS IN REMOTION",
      title: "3D 场景已经能用了",
      subtitle: "同一支片里，2D 版式和 3D 场景交替出现",
    },
  },
  // cyber（默认）：深色主题下偏"科技"，边光挂一道青光
  { type: "scene3d", frames: 105, props: { preset: "orbit-core", title: "", sub: "" } },
  {
    type: "bullets",
    frames: 90,
    props: {
      heading: "三个不妥协的判断",
      items: [
        { text: "agent 只写数据，不写代码" },
        { text: "预设兜住画质下限" },
        { text: "中文不进 3D，走 2D 叠层" },
      ],
    },
    // 顺带验"3D 当底 + 2D 文字"在成片里的样子（也是过渡重叠区里两个 WebGL 共存的场合）
    backdrop: { type: "scene3d", props: { preset: "particle-field", count: 5 }, opacity: 0.6 },
  },
  // studio（默认）：明亮产品光，看材质最清楚
  { type: "scene3d", frames: 120, props: { preset: "explode-parts", title: "构成", sub: "一个圆环拆成八段" } },
  // cyber：柱阵靠高度差 + 颜色梯度，不靠辉光
  { type: "scene3d", frames: 90, props: { preset: "waveform", title: "节奏", sub: "" } },
  { type: "outro", frames: 60, props: { title: "接下来：实拍验证", action: "M1.5 完成" } },
];

const totalFrames = SCENES.reduce((n, s) => n + s.frames, 0);

const project = {
  ...base,
  name: "3d-tape",
  theme: DEFAULT_THEME,
  formats: [{ key: "landscape", label: "横屏 16:9", width: W, height: H }],
  scenes: SCENES.map((s, i) => {
    const meta = getMeta(s.type)!;
    return {
      id: `scene_${i}`,
      type: s.type,
      name: meta.name,
      durationInFrames: s.frames,
      props: normalizeProps(s.type, s.props ?? {}),
      ...(s.backdrop ? { backdrop: s.backdrop } : {}),
      transitionIn: { type: "fade", durationInFrames: 10 },
    };
  }),
};

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  /**
   * `still 30,130,300` 抽指定帧存 PNG。
   * 专用 ffmpeg 是 Remotion 的精简构建，没有 png/jpg 编码器（`Error opening output files`），
   * 所以抽帧不能走 ffmpeg，只能让 Remotion 重新渲那几帧。
   */
  const stillArgs = process.argv[2] === "still" ? String(process.argv[3] ?? "").split(",").map(Number) : null;
  const [from, to] = [Number(process.argv[2] ?? 0), Number(process.argv[3] ?? totalFrames - 1)];
  const t0 = Date.now();
  console.log(`▸ 浏览器：${browserPath ?? "（未找到）"} [${chromeMode}]`);
  console.log(`▸ 全片 ${totalFrames} 帧（${(totalFrames / 30).toFixed(1)}s @30fps），本次渲 ${from}–${to}`);
  const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
  const inputProps = { ...project, formatKey: "landscape" };

  const composition = await selectComposition({
    serveUrl,
    id: "Video",
    inputProps,
    browserExecutable: browserPath,
    chromeMode,
  });

  if (stillArgs) {
    const dir = path.join(OUT_DIR, "tape-frames");
    mkdirSync(dir, { recursive: true });
    for (const f of stillArgs) {
      const out = path.join(dir, `t${String(f).padStart(3, "0")}.png`);
      await renderStill({ composition, serveUrl, inputProps, frame: f, output: out, browserExecutable: browserPath, chromeMode });
      console.log(`✓ 帧 ${f} → ${path.relative(process.cwd(), out)}`);
    }
    console.log(`总计 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return;
  }

  const output = path.join(OUT_DIR, from === 0 && to === totalFrames - 1 ? "tape-3d.mp4" : `tape-3d-${from}-${to}.mp4`);
  const t1 = Date.now();
  await renderMedia({
    composition,
    serveUrl,
    inputProps,
    codec: "h264",
    crf: 26,
    muted: true,
    frameRange: [from, to],
    outputLocation: output,
    browserExecutable: browserPath,
    chromeMode,
    concurrency: 1,
    onProgress: ({ renderedFrames }) => {
      const el = (Date.now() - t1) / 1000;
      const per = el / Math.max(1, renderedFrames);
      process.stdout.write(`\r  已渲 ${renderedFrames} 帧  平均 ${per.toFixed(2)}s/帧  预计剩余 ${((to - from + 1 - renderedFrames) * per).toFixed(0)}s   `);
    },
  });
  const frames = to - from + 1;
  const secs = (Date.now() - t1) / 1000;
  console.log(
    `\n✓ ${path.relative(process.cwd(), output)}  ${frames} 帧 / ${secs.toFixed(1)}s = ${(secs / frames).toFixed(2)}s/帧  总计 ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
