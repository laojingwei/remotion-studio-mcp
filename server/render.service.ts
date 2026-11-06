import path from "node:path";
import { ROOT as PROJECT_ROOT } from "./root";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import {
  makeCancelSignal,
  openBrowser,
  renderMedia,
  renderStill,
  selectComposition,
  type BrowserLog,
} from "@remotion/renderer";
import type { Project } from "../shared/schema";
import type { VideoConfig } from "remotion";
import { totalDuration } from "../shared/schema";
import { PUBLIC_DIR } from "./store";
import { bundleOutDir, cleanupLegacyBundles } from "./bundle-cache";
import { cleanupOutputs, ensureOutDir, outDirOf, projectOutDir } from "./outputs.service";
import { generatePluginEntry } from "./plugin/gen-entry";

let serveUrlPromise: Promise<string> | null = null;

/*
 * 正在跑的渲染计数。
 *
 * bundle 固定输出到项目内的 .remotion-bundle 之后，「源码变更 → 重建」意味着
 * 要整目录删掉重打。如果有渲染正在用旧目录，删了它当场 404 —— 所以重建前
 * 先看这个计数：有活跃渲染就跳过删除、就地覆盖（旧散件留在里面，下次没人
 * 用了再清）。以前每份产物在 Temp 里各有一个随机目录，不存在这个问题；
 * 固定目录换来的是不再攒 9.7GB 垃圾，代价就是这里要多想一步。
 */
let activeRenders = 0;

/** 计数器只能配对使用：三个渲染入口（still / video task / preview clip）各自包一层 */
const withActiveRender = async <T,>(fn: () => Promise<T>): Promise<T> => {
  activeRenders++;
  try {
    return await fn();
  } finally {
    activeRenders = Math.max(0, activeRenders - 1);
  }
};

/**
 * 选择渲染用的浏览器内核：
 *  1. REMOTION_BROWSER 环境变量显式指定
 *  2. 项目内预装的 .browser/<dir>/chrome-headless-shell.exe（离线环境）
 *  3. 本机 Chrome / Edge（用 chrome-for-testing 模式，即 --headless=new）
 *  4. 都没有 → 交给 Remotion 自动下载
 */
type BrowserPick = { path: string; mode: "headless-shell" | "chrome-for-testing" };

const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

function detectBrowser(): BrowserPick | undefined {
  const fromEnv = process.env.REMOTION_BROWSER;
  if (fromEnv) {
    return {
      path: fromEnv,
      mode: fromEnv.toLowerCase().includes("chrome-headless-shell") ? "headless-shell" : "chrome-for-testing",
    };
  }

  const local = path.join(PROJECT_ROOT, ".browser");
  if (fs.existsSync(local)) {
    for (const entry of fs.readdirSync(local)) {
      const exe = path.join(local, entry, "chrome-headless-shell.exe");
      if (fs.existsSync(exe)) return { path: exe, mode: "headless-shell" };
    }
  }

  for (const exe of CANDIDATES) {
    if (fs.existsSync(exe)) return { path: exe, mode: "chrome-for-testing" };
  }
  return undefined;
}

const BROWSER = detectBrowser();

/**
 * 复用同一个浏览器实例。
 * 每次截图都新起浏览器要 6-8 秒，复用后 1-2 秒 —— agent 自检是高频操作，这个差别很关键。
 */
let browserPromise: Promise<Awaited<ReturnType<typeof openBrowser>>> | null = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = openBrowser("chrome", {
      browserExecutable: BROWSER?.path ?? null,
      chromeMode: BROWSER?.mode ?? "headless-shell",
    }).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}
let bundleProgress = 0;
let bundleDone = false;
let lastSignature: number | null = null;
/** public/ 上次同步时的指纹（见 syncPublicToBundle） */
let lastPublicSig: string | null = null;

/**
 * 旧版 Temp 目录清理只需要做一次（进程生命周期内）。
 * 服务启动时也会调一次（index.ts），这里是兜底：CLI 直接渲染、不经过服务时也能清。
 */
let legacyCleaned = false;
const cleanLegacyOnce = () => {
  if (legacyCleaned) return;
  legacyCleaned = true;
  try {
    cleanupLegacyBundles(undefined, (msg) => console.log(`[render] ${msg}`));
  } catch (err) {
    console.error("[render] 清理旧打包目录失败（不影响渲染）：", err);
  }
};

/** 打包一次并缓存，后续所有渲染复用；源码变更时自动失效重打包 */
export async function getServeUrl(): Promise<string> {
  cleanLegacyOnce();
  let sig = sourceSignature();
  if (serveUrlPromise && lastSignature !== null && sig !== lastSignature) {
    /**
     * 插件变了 → **必须先重新生成入口，再打包**。
     *
     * 反过来的顺序（先打包再生成）会把上一版组件打进 bundle：
     * 现象是"改了插件、渲染出来还是旧的"，而预览里已经是新的——
     * 这种"预览对、成片错"是最难自查的一类问题。
     */
    const gen = generatePluginEntry();
    for (const issue of gen.issues) console.log(`[render] 插件提示：${issue}`);
    if (gen.changed) {
      console.log(`[render] 插件场景变更，已重新生成入口（${gen.count} 个）`);
      // 生成文件本身在 src/ 下，重算签名，避免下一次又判成"变了"再打一次
      sig = sourceSignature();
    }
    console.log("[render] 检测到场景源码变更，重新打包…");
    resetBundle();
  }
  if (!serveUrlPromise) {
    // 首次打包前也生成一次：服务刚启动时生成文件可能落后于磁盘上的插件
    const gen = generatePluginEntry();
    if (gen.changed) console.log(`[render] 已生成插件入口（${gen.count} 个场景）`);
    lastSignature = sourceSignature();
    const outDir = bundleOutDir(PROJECT_ROOT);
    // 没有渲染在用旧产物才整目录删掉重打；有就就地覆盖，旧散件下次再清
    if (activeRenders === 0) {
      try {
        fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      } catch {
        /* 删不掉就让 webpack 覆盖，不至于失败 */
      }
    }
    serveUrlPromise = bundle({
      entryPoint: path.join(PROJECT_ROOT, "src", "index.ts"),
      publicDir: PUBLIC_DIR,
      outDir,
      /**
       * 插件 SDK 的别名。
       *
       * 插件组件写在 `plugins/` 下，用相对路径 import 宿主的 `src/` 会随目录深度失效，
       * 所以给它一个稳定入口（vite 侧有一份等价配置，见 vite.config.ts）。
       * 注意必须给**绝对路径**：webpack 的 alias 不做相对解析。
       */
      webpackOverride: (config) => ({
        ...config,
        resolve: {
          ...config.resolve,
          alias: {
            ...(config.resolve?.alias ?? {}),
            "@studio/sdk": path.join(PROJECT_ROOT, "src", "sdk.ts").split(path.sep).join("/"),
          },
        },
      }),
      onProgress: (p: number) => {
        bundleProgress = p;
      },
    }).then((url) => {
      bundleDone = true;
      return url;
    });
  }
  const url = await serveUrlPromise;
  // 素材必须每次渲染前同步：bundle 只在打包那一刻拷过一次 public/，
  // 之后新增的 TTS 音频 / 上传的图都不在里面（详见 syncPublicToBundle 注释）
  try {
    syncPublicToBundle(url);
  } catch (err) {
    console.error("[render] 素材同步失败（继续渲染，可能缺音频）：", err);
  }
  return url;
}

/**
 * src/ 、shared/ 与 plugins/ 下所有文件的 mtime 和，用作"代码是否变了"的指纹。
 *
 * **plugins/ 必须在里面**：插件场景是代码，改了不重打包的话，
 * 预览（走 vite 实时读）是新的、成片（走 bundle）是旧的 —— 最难自查的一种不一致。
 */
function sourceSignature(): number {
  let sum = 0;
  for (const dir of ["src", "shared", "plugins"]) {
    const root = path.join(PROJECT_ROOT, dir);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        try {
          sum += fs.statSync(path.join(entry.parentPath ?? entry.path, entry.name)).mtimeMs;
        } catch {
          /* 文件刚被删，忽略 */
        }
      }
    }
  }
  return Math.round(sum);
}

export function resetBundle() {
  serveUrlPromise = null;
  bundleDone = false;
  bundleProgress = 0;
  lastSignature = null;
  lastPublicSig = null;
}

export const bundleState = () => ({ done: bundleDone, progress: bundleProgress });

/* ────────────────────── 素材同步：让后加的素材进到渲染快照里 ────────────────────── */

/**
 * 渲染用的不是项目里的 public/，而是 `bundle()` 在**打包那一刻**拷出来的一份快照
 * （`<Temp>/remotion-webpack-bundle-<hash>/public/`）。
 *
 * 快照之后新增的素材不在里面，而且失败是静默的：
 *  - 场景内 audio 元素 → 渲染成功但整段没声音，日志一句报错都没有
 *  - 音轨（add_audio_track）→ 直接 404 …/public/assets/xxx.wav could not be found
 *
 * TTS 又是"先排版后配音"时最晚落地的素材，所以这条几乎必然踩到。
 * 对策不是重新打包（十几秒一次，每次配音都要等），而是把 public/ 增量镜像过去。
 */

/** 递归列出目录下所有文件（返回相对 root 的路径） */
function walkFiles(root: string, base = root, out: string[] = []): string[] {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

/** public/ 的指纹：文件数 + 总字节 + mtime 和。变了才值得去比对 */
function publicSignature(): string {
  let count = 0;
  let bytes = 0;
  let mtime = 0;
  for (const rel of walkFiles(PUBLIC_DIR)) {
    try {
      const st = fs.statSync(path.join(PUBLIC_DIR, rel));
      count++;
      bytes += st.size;
      mtime += st.mtimeMs;
    } catch {
      /* 刚被删，忽略 */
    }
  }
  return `${count}:${bytes}:${Math.round(mtime)}`;
}

export type PublicSyncResult = { added: number; updated: number; removed: number; skipped: boolean };

/**
 * 把 public/ 镜像进 bundle 的 public 目录：缺的补、变了的覆盖、源里删掉的一起删。
 * 全程同步 IO（文件小、次数少），避免和渲染进程抢时序。
 */
export function syncPublicToBundle(serveUrl: string): PublicSyncResult {
  const result: PublicSyncResult = { added: 0, updated: 0, removed: 0, skipped: false };
  const bundleDir = serveUrl.startsWith("file://") ? fileURLToPath(serveUrl) : serveUrl;
  const target = path.join(bundleDir, "public");
  if (!fs.existsSync(PUBLIC_DIR) || !fs.existsSync(bundleDir)) {
    result.skipped = true;
    return result;
  }

  const sig = publicSignature();
  if (sig === lastPublicSig && fs.existsSync(target)) {
    result.skipped = true;
    return result;
  }

  fs.mkdirSync(target, { recursive: true });
  const wanted = new Set<string>();

  for (const rel of walkFiles(PUBLIC_DIR)) {
    wanted.add(rel);
    const from = path.join(PUBLIC_DIR, rel);
    const to = path.join(target, rel);
    let existed = true;
    try {
      const a = fs.statSync(from);
      const b = fs.statSync(to);
      // 目标 mtime 用 utimes 保成源文件的值，下次才能靠 mtime 判断“没变过”
      if (a.size === b.size && Math.round(a.mtimeMs) === Math.round(b.mtimeMs)) continue;
    } catch {
      existed = fs.existsSync(to);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    try {
      const a = fs.statSync(from);
      fs.utimesSync(to, a.atime, a.mtime);
    } catch {
      /* 时间戳设不上就每次重拷，不影响正确性 */
    }
    if (existed) result.updated++;
    else result.added++;
  }

  // 源里已经没有的文件，快照里也要删：否则删掉的素材还在被渲染引用
  for (const rel of walkFiles(target)) {
    if (wanted.has(rel)) continue;
    try {
      fs.unlinkSync(path.join(target, rel));
      result.removed++;
    } catch {
      /* 被占用就留着 */
    }
  }

  if (result.added || result.updated || result.removed) {
    console.log(
      `[render] 素材同步进渲染快照：新增 ${result.added} / 更新 ${result.updated} / 移除 ${result.removed}`,
    );
  }
  lastPublicSig = sig;
  return result;
}

/**
 * 产物按工程分目录（v0.99）：out/projects/<工程id>/{videos,stills,subtitles}。
 * 目录决定归属，文件名只负责给人看——不再靠解析文件名猜是哪个工程的。
 */
const ensureStillDir = (projectId: string) => ensureOutDir(projectId, "still");
const ensureVideoDir = (projectId: string) => ensureOutDir(projectId, "video");

export type StillResult = {
  format: string;
  url: string;
  frame: number;
};

/** 关键帧截图：agent 视觉自检 + 人类验收都用它 */
/* ─────────────────── 渲染超时 & 插件后期 pass 的告警回收 ─────────────────── */

/**
 * `delayRender` 等待上限 —— **不是整片总时长**。
 *
 * Remotion 这个选项的原话是「渲染最多可以等多久来 resolve 所有 `delayRender()` 调用」，
 * 默认 30000ms。它在**每帧等页面就绪**的地方生效，所以它能兜住"某帧永远准备不好"
 * （典型就是着色器把 GL 调用卡住、JS 回不来），但兜不住"整体算得太久"。
 *
 * 实测记一笔（2026-11-06）：把它设成 7000 去渲一条 62 秒才渲完的视频，
 * **照常渲完**——这直接证明它是单帧等待上限、不是总时长。别再按"总超时"去理解它。
 *
 * 为什么还要显式写：默认值在报错里不出现，用户看到一句 "Timed out" 无从下手；
 * 写进代码 + 环境变量可调，报错时才能给出"多少秒、怎么调、怀疑谁"。
 */
const DEFAULT_DELAY_RENDER_MS = 30_000; // Remotion 自己的默认值，保持一致
/**
 * 可用环境变量覆盖：`STUDIO_STILL_TIMEOUT_MS` / `STUDIO_CLIP_TIMEOUT_MS` / `STUDIO_VIDEO_TIMEOUT_MS`。
 * 存在的理由：慢机器上 30 秒等一帧大字排版+纹理解码可能不够；也让"参数确实接通了"
 * 能被一条命令验证（Remotion 会拒绝 <7000 的值，报错里带着传入的数字）。
 */
const envMs = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
// Remotion 自己会把 <7000ms 的值当成参数错误直接抛，所以要夹住
const MIN_TIMEOUT_MS = 7_000;
const TIMEOUT_STILL_MS = Math.max(MIN_TIMEOUT_MS, envMs("STUDIO_STILL_TIMEOUT_MS", DEFAULT_DELAY_RENDER_MS));
const TIMEOUT_CLIP_MS = Math.max(MIN_TIMEOUT_MS, envMs("STUDIO_CLIP_TIMEOUT_MS", DEFAULT_DELAY_RENDER_MS));
const TIMEOUT_VIDEO_MS = Math.max(MIN_TIMEOUT_MS, envMs("STUDIO_VIDEO_TIMEOUT_MS", DEFAULT_DELAY_RENDER_MS));

/**
 * 插件后期 pass 的告警标签。
 *
 * 渲染发生在 headless Chrome 里，那边 `console.warn` 没人看得见 —— 而
 * "某个 pass 编译不过、已被跳过"恰恰是**必须**告诉用户的一句话（否则画面少一层效果，
 * 用户会以为是我们的渲染坏了）。所以靠 `onBrowserLog` 捞回来。
 *
 * 标签要和 `src/scenes/scene3d/bloom.ts` 的 `PASS_TAG` 一致。
 */
const PLUGIN_PASS_TAG = "[plugin-pass]";

/** 收集一次渲染里的插件 pass 告警（去重，跨画幅共用同一个 sink） */
function browserLogSink(sink: string[]) {
  return (log: BrowserLog) => {
    const text = typeof log?.text === "string" ? log.text : "";
    if (!text.includes(PLUGIN_PASS_TAG)) return;
    const line = text.replace(/\s+/g, " ").trim();
    if (line && !sink.includes(line)) sink.push(line);
  };
}

export async function renderStills(
  project: Project,
  frame?: number,
  formats?: string[],
  /** 文件名后缀（只留字母数字与 -_）：同一帧要多张不同内容的图时必须给，
   *  否则文件名一样会互相覆盖——probe_style 的三个风格样张就踩过这个坑 */
  tag?: string,
  /** "cover" = 封面候选，落到 covers/ 目录。
   *  以前封面和关键帧同目录同命名，产物列表里根本分不出哪张是封面。 */
  purpose?: "cover",
): Promise<{ stills: StillResult[]; warnings: string[] }> {
  return withActiveRender(async () => {
    const warnings: string[] = [];
    try {
      const stills = await stillsInner(project, frame, formats, tag, purpose, warnings);
      return { stills, warnings };
    } catch (err) {
      // 抽帧的超时以前只会原样抛 "Timed out"，看不出是自己插件的 shader 卡住了
      throw explainRenderError(err);
    }
  });
}

async function stillsInner(
  project: Project,
  frame?: number,
  formats?: string[],
  tag?: string,
  purpose?: "cover",
  /** 出参：回收浏览器里的插件后期告警（headless 里的 console.warn 没人看得见） */
  warnings: string[] = [],
): Promise<StillResult[]> {
  const stillDir = purpose === "cover" ? ensureOutDir(project.id, "cover") : ensureStillDir(project.id);
  const serveUrl = await getServeUrl();
  const targets = project.formats.filter((f) => !formats?.length || formats.includes(f.key));
  const total = Math.max(1, totalDuration(project));
  const results: StillResult[] = [];

  for (const fmt of targets) {
    // 单一 Composition，画幅由 inputProps.formats + formatKey 经 calculateMetadata 推导
    const compositionId = "Video";
    const inputProps = { ...project, formatKey: fmt.key };
    const puppeteerInstance = await getBrowser();
    const composition = await selectCompositionSafe({ puppeteerInstance, serveUrl, id: compositionId, inputProps, browserExecutable: BROWSER?.path, chromeMode: BROWSER?.mode });
    const f = Math.max(0, Math.min(composition.durationInFrames - 1, Math.round(frame ?? 0)));
    const safeTag = String(tag ?? "").replace(/[^\w-]/g, "").slice(0, 24);
    // 文件名必须带 rev：同名文件会被 overwrite 覆盖，而 agent 习惯按上一版的路径打开
    // （portrait-1656.png 已经是新的了，看到的却是自己记的那次）——白诊断过一次（复盘坑 #4）
    const file = `${fmt.key}-${f}${safeTag ? `-${safeTag}` : ""}-r${project.rev}.png`;
    const output = path.join(stillDir, file);
    await renderStill({
      puppeteerInstance: await getBrowser(),
      browserExecutable: BROWSER?.path,
      chromeMode: BROWSER?.mode,
      serveUrl,
      composition,
      output,
      inputProps,
      frame: f,
      overwrite: true,
      imageFormat: "png",
      scale: 0.5,
      // 兜底：卡住的 shader 会让这一帧永远等下去（以前没有任何超时）
      timeoutInMilliseconds: TIMEOUT_STILL_MS,
      onBrowserLog: browserLogSink(warnings),
    });
    // 目录名必须跟着 purpose 走：封面写 covers/，URL 还写 stills/ 就是 404
    const dirName = purpose === "cover" ? "covers" : "stills";
    results.push({ format: fmt.key, url: `/out/projects/${project.id}/${dirName}/${file}?t=${project.rev}`, frame: f });
  }
  return results;
}

/* ────────────────────────────── 视频任务队列 ────────────────────────────── */

export type RenderTask = {
  id: string;
  projectId: string;
  /** 工程名快照：编辑器要显示「agent 在渲染哪个工程」，不能为了一个名字再去查一次 */
  projectName?: string;
  status: "queued" | "bundling" | "rendering" | "done" | "error" | "cancelled";
  progress: number;
  quality: RenderQuality;
  format: RenderFormat;
  formats: string[];
  /** 当前正在渲的画幅 key（多画幅逐个渲，进度会从 0 重来，光看百分比会以为卡住了） */
  currentFormat?: string;
  /** 自定义文件名前缀；不传就用工程名（工程名常带过期标签，如"60s精华版"实际 116 秒） */
  fileName?: string;
  outputs: { format: string; url: string }[];
  error?: string;
  /** 渲染过程中被回收的插件后期告警（"某个 pass 编不过已跳过"这类），要让人看得见 */
  warnings?: string[];
  createdAt: number;
  /** 最后一次状态变化时间（结束时间可能就是它），给编辑器算「已经跑了多久」 */
  updatedAt?: number;
  /** 第一次进入 rendering 的时间：算实测速率与剩余时间，别再用「8.8 帧/秒」那种假常数 */
  startedAt?: number;
};

export type RenderQuality = "low" | "standard" | "high";
export type RenderFormat = "mp4" | "gif" | "webm";

/** 导出格式 → Remotion codec */
const FORMAT_CODEC: Record<RenderFormat, "h264" | "vp8" | "gif"> = {
  mp4: "h264",
  webm: "vp8",
  gif: "gif",
};

/** 画质 → 目标码率（h264） */
const BITRATE: Record<RenderQuality, string> = {
  low: "2500k",
  standard: "6000k",
  high: "12000k",
};

const tasks = new Map<string, RenderTask>();
/** 每个任务的中断信号，取消时调 cancel() 让 Remotion 中途退出编码 */
const cancels = new Map<string, () => void>();
let chain: Promise<unknown> = Promise.resolve();


/**
 * 渲染器的报错翻译。
 *
 * 真实事故：本机另开了一个 `remotion studio`（占着 3000），而 Remotion 的静态服务从
 * 3000 起找空闲端口，Windows 上两者能"同时"绑上 —— 于是渲染器把**别人的页面**当成
 * 我们的打包产物，报一句 "this is not a valid Remotion project"，完全看不出是端口冲突。
 * 这句话必须翻译成能动手的下一步，否则只能在浏览器里一层层挖。
 */
function explainRenderError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not a valid Remotion project|getStaticCompositions/i.test(msg)) {
    return new Error(
      "渲染器打不开打包产物（页面里没有 Remotion 入口）。最常见原因是 **3000 端口被别的进程占用**：" +
        "Remotion 的静态服务从 3000 起找空闲端口，撞上别人的页面就会加载到外来的 HTML。\n" +
        "排查：netstat -ano | findstr :3000 → 关掉那个进程（例如另一个 remotion studio）再渲。\n" +
        `原始报错：${msg.slice(0, 240)}`,
    );
  }
  /*
   * 超时单独翻译。Remotion 的原话是 "Rendering timed out after Xms"，
   * 但真正让人无从下手的是"为什么会超时"——而 90% 的新增原因是插件后期 pass
   * （死循环的 for、超高次数的采样）。把这条线索直接给出来。
   */
  if (/timed out|timeout/i.test(msg)) {
    /*
     * 这是"某一帧迟迟准备不好"，不是"整片渲太久"（后者不会报这个错）。
     * 最可能的新增原因就是插件后期 pass 把 GL 调用卡住了——所以先让人去关它。
     */
    return new Error(
      `有一帧超过 ${Math.round(TIMEOUT_VIDEO_MS / 1000)} 秒还没准备好，渲染中止（Remotion 的 delayRender 等待上限）。\n` +
        "常见原因：① 插件的后期 pass 里有死循环 / 超大循环 / 巨量采样；② 场景里有加载不出来的素材；③ 浏览器卡住。\n" +
        "先试：set_graph_scene { post: { passes: [] } } 清掉插件后期，再渲一次——好了就说明问题在某个 pass。\n" +
        "慢机器上可以调大：环境变量 STUDIO_VIDEO_TIMEOUT_MS / STUDIO_STILL_TIMEOUT_MS（毫秒，最小 7000）。\n" +
        `原始报错：${msg.slice(0, 240)}`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

/** 包一层：所有取 composition 的地方统一走这里，报错才有人话。
 * 参数用 any：selectComposition 是重载签名，Parameters<> 取出来是 never。 */
async function selectCompositionSafe(args: any): Promise<VideoConfig> {
  try {
    return await selectComposition(args);
  } catch (err) {
    throw explainRenderError(err);
  }
}

export const getTask = (id: string) => tasks.get(id);
export const listTasks = () => [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);

/** 正在跑（含排队/打包）的任务：渲染与静帧共用同一个浏览器实例，撞上就是 28s delayRender 超时 */
export function activeRenderTask(): RenderTask | undefined {
  return listTasks().find(
    (t) => t.status === "queued" || t.status === "bundling" || t.status === "rendering",
  );
}

/** 只留最近 30 条已结束的任务：编辑器会定时拉全表，长会话里不能无限长 */
function pruneTasks() {
  if (tasks.size <= 40) return;
  const finished = [...tasks.values()]
    .filter((t) => t.status === "done" || t.status === "error" || t.status === "cancelled")
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const t of finished.slice(0, tasks.size - 30)) tasks.delete(t.id);
}

/** 取消任务：已结束的返回 false */
export function cancelTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task) return false;
  if (task.status === "done" || task.status === "error" || task.status === "cancelled") return false;

  // 先改状态，runTask 的 catch 才知道这是主动取消，不是渲染出错
  task.status = "cancelled";
  task.progress = 0;
  task.error = undefined;
  task.currentFormat = undefined;
  task.updatedAt = Date.now();
  cancels.get(id)?.();
  return true;
}

export function enqueueVideo(
  project: Project,
  formats?: string[],
  quality: RenderQuality = "standard",
  format: RenderFormat = "mp4",
  fileName?: string,
): RenderTask {
  ensureVideoDir(project.id);
  // 请求了一个工程里不存在的画幅（比如 agent 以为还是竖屏、其实工程只剩横屏）时，
  // 以前会一声不响地把这个画幅 continue 掉：任务「成功」但 outputs 是空的，
  // 用户拿到一条「渲染完成、0 个文件」。这里直接拒，比渲完给个空结果好。
  const available = project.formats.map((f) => f.key);
  if (formats?.length) {
    const missing = formats.filter((k) => !available.includes(k));
    if (missing.length === formats.length) {
      throw new Error(
        `工程没有这些画幅：${missing.join("、")}（现有：${available.join("、") || "无"}）——先 set_formats 加上，或改用现有画幅`,
      );
    }
    if (missing.length) {
      // 部分不存在：只渲存在的那些，别让整个任务失败
      formats = formats.filter((k) => available.includes(k));
    }
  }
  const id = `task_${Math.random().toString(36).slice(2, 8)}`;
  const task: RenderTask = {
    id,
    projectId: project.id,
    projectName: project.name,
    status: "queued",
    progress: 0,
    quality,
    format,
    formats: formats?.length ? formats : project.formats.map((f) => f.key),
    ...(fileName?.trim() ? { fileName: fileName.trim() } : {}),
    outputs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  tasks.set(id, task);
  pruneTasks();

  // 串行：渲染吃内存，并发容易 OOM
  chain = chain.then(() => runTask(task, project)).catch(() => undefined);
  return task;
}

/** 取消状态由外部随时改写，用函数读避免 TS 的控制流收窄把它当成不可能分支 */
const isCancelled = (t: RenderTask) => t.status === "cancelled";

async function runTask(task: RenderTask, project: Project) {
  return withActiveRender(() => runTaskInner(task, project));
}

async function runTaskInner(task: RenderTask, project: Project) {
  const { cancelSignal, cancel } = makeCancelSignal();
  cancels.set(task.id, cancel);

  try {
    if (isCancelled(task)) return;

    task.status = "bundling";
    task.updatedAt = Date.now();
    const serveUrl = await getServeUrl();
    if (isCancelled(task)) return;

    /*
     * 跨画幅共用一个 sink：同一个 pass 编不过会在每个画幅各报一次，
     * 去重后回执里只留一条（画面少一层效果这句话说三遍只会让人以为坏了三处）。
     */
    const passWarnings: string[] = [];

    for (const key of task.formats) {
      // 排队期间被取消的任务在这里直接跳过，不浪费一次渲染
      if (isCancelled(task)) return;

      task.status = "rendering";
      if (!task.startedAt) task.startedAt = Date.now();
      // 多画幅是逐个渲的，进度会从 0 重来：带上「当前画幅」编辑器才不会以为卡死/重启
      task.currentFormat = key;
      task.progress = 0;
      task.updatedAt = Date.now();
      const fmt = project.formats.find((f) => f.key === key);
      if (!fmt) continue;
      const compositionId = "Video";
      const inputProps = { ...project, formatKey: key };
      const puppeteerInstance = await getBrowser();
      const composition = await selectCompositionSafe({
        puppeteerInstance,
        serveUrl,
        id: compositionId,
        inputProps,
        browserExecutable: BROWSER?.path,
        chromeMode: BROWSER?.mode,
      });
      // 文件名给用户看：自定义前缀（或工程名）+ 本地时间（到秒），尾部 `__projectId` 给清理逻辑分组。
      // 允许覆盖前缀的原因：工程名里常留着"60s精华版"这类旧标签，实际成片可能已经 116 秒，
      // 名字不改会持续误导人（文件名是交付物的一部分，用户自己没法改）。
      const pad = (n: number) => String(n).padStart(2, "0");
      const now = new Date();
      const stamp =
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
        `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      const rawName = task.fileName?.trim() || project.name;
      const safeName =
        rawName.replace(/[\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) ||
        "project";
      const file = `${safeName}_${stamp}_${key}__${task.projectId}.${task.format}`;
      await renderMedia({
        puppeteerInstance,
        browserExecutable: BROWSER?.path,
        chromeMode: BROWSER?.mode,
        serveUrl,
        composition,
        inputProps,
        cancelSignal,
        codec: FORMAT_CODEC[task.format],
        ...(task.format === "gif" ? { muted: true } : {}),
        videoBitrate: BITRATE[task.quality] ?? BITRATE.standard,
        outputLocation: path.join(outDirOf(task.projectId, "video"), file),
        concurrency: 1,
        timeoutInMilliseconds: TIMEOUT_VIDEO_MS,
        onBrowserLog: browserLogSink(passWarnings),
        onProgress: ({ progress }: { progress: number }) => {
          // 取消后不再更新进度，避免界面又跳回 30%
          if (isCancelled(task)) return;
          task.progress = Math.round(progress * 100);
          task.updatedAt = Date.now();
        },
      });
      if (isCancelled(task)) return;
      task.outputs.push({ format: key, url: `/out/projects/${task.projectId}/videos/${file}` });
      if (passWarnings.length) task.warnings = [...passWarnings];
      task.updatedAt = Date.now();
    }

    task.progress = 100;
    task.status = "done";
    task.currentFormat = undefined;
    task.updatedAt = Date.now();

    // 出片成功后自动清掉这个工程更早的成片，避免 out/ 无限增长。
    // 只动自己的工程，失败也不影响渲染结果。
    try {
      const keep = Number(process.env.KEEP_VIDEOS ?? 5);
      cleanupOutputs({ projectId: task.projectId, keepVideos: Number.isFinite(keep) ? keep : 5 });
    } catch {
      /* 清理失败不是渲染失败 */
    }
  } catch (err) {
    // 主动取消时 Remotion 会抛 CancelledError，这不是失败
    if (isCancelled(task)) return;
    task.status = "error";
    task.error = err instanceof Error ? err.message : String(err);
    task.currentFormat = undefined;
    task.updatedAt = Date.now();
  } finally {
    cancels.delete(task.id);
  }
}


/* ─────────────────── 动态预览片段：6 秒带声低码率 ─────────────────── */

/**
 * 为什么需要它：
 * 现在的验证手段只有两极 —— 一张静帧（看不出转场/节奏）和整片（98 秒要渲 12 分钟）。
 * 复盘里 6 轮返工有 5 轮是"必须看动 / 听声才能判断"的项（转场 4 轮、BGM 5 次、字幕 5 次、动画 1 轮），
 * 全都只能在最贵的阶段才发现。这个函数就是把"看见动态"的成本从 12 分钟压到几十秒。
 *
 * 输出到 out/projects/<id>/previews/，不参与成片清理（清理由 cleanupOutputs 单独收）。
 */
export type PreviewClipResult = {
  format: string;
  url: string;
  localPath: string;
  startFrame: number;
  endFrame: number;
  sections: number;
  scale: number;
  withAudio: boolean;
  bundleMs: number;
  renderMs: number;
};

export async function renderPreviewClip(
  project: Project,
  opts: {
    startFrame: number;
    endFrame: number;
    formatKey?: string;
    /** 0.3–0.6 够看动态；默认 0.5（1080×1920 → 540×960） */
    scale?: number;
    /** 默认带音轨（BGM / 旁白的问题只能听出来） */
    withAudio?: boolean;
    tag?: string;
  },
): Promise<PreviewClipResult> {
  return withActiveRender(() => renderPreviewClipInner(project, opts));
}

async function renderPreviewClipInner(
  project: Project,
  opts: {
    startFrame: number;
    endFrame: number;
    formatKey?: string;
    scale?: number;
    withAudio?: boolean;
    tag?: string;
  },
): Promise<PreviewClipResult> {
  const fmt =
    project.formats.find((f) => f.key === opts.formatKey) ?? project.formats[0];
  if (!fmt) throw new Error("工程没有画幅，无法生成预览片段");

  const dir = path.join(projectOutDir(project.id), "previews");
  fs.mkdirSync(dir, { recursive: true });

  const t0 = Date.now();
  const serveUrl = await getServeUrl();
  const bundleMs = Date.now() - t0;

  const inputProps = { ...project, formatKey: fmt.key };
  const puppeteerInstance = await getBrowser();
  const composition = await selectComposition({
    puppeteerInstance,
    serveUrl,
    id: "Video",
    inputProps,
    browserExecutable: BROWSER?.path,
    chromeMode: BROWSER?.mode,
  });

  const total = Math.max(2, composition.durationInFrames);
  const start = Math.max(0, Math.min(total - 2, Math.round(opts.startFrame)));
  const end = Math.max(start + 1, Math.min(total - 1, Math.round(opts.endFrame)));
  const scale = Math.min(0.6, Math.max(0.3, opts.scale ?? 0.5));
  const withAudio = opts.withAudio !== false;

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safeTag = String(opts.tag ?? "").replace(/[^\w-]/g, "").slice(0, 20);
  const file =
    `clip_${fmt.key}_${start}-${end}_r${project.rev}_${stamp}` +
    `${safeTag ? `-${safeTag}` : ""}.mp4`;
  const output = path.join(dir, file);

  const t1 = Date.now();
  /** 插件后期告警（"某个 pass 编不过已跳过"），随返回值回给调用方 */
  const passWarnings: string[] = [];
  await renderMedia({
    puppeteerInstance,
    browserExecutable: BROWSER?.path,
    chromeMode: BROWSER?.mode,
    serveUrl,
    composition,
    inputProps,
    codec: "h264",
    // 预览不看画质，看"动起来对不对"：crf 30 + 半分辨率，几十秒出片
    crf: 30,
    scale,
    muted: !withAudio,
    frameRange: [start, end],
    outputLocation: output,
    concurrency: 1,
    timeoutInMilliseconds: TIMEOUT_CLIP_MS,
    onBrowserLog: browserLogSink(passWarnings),
  });

  return {
    format: fmt.key,
    url: `/out/projects/${project.id}/previews/${file}`,
    localPath: output,
    startFrame: start,
    endFrame: end,
    sections: end - start + 1,
    scale,
    withAudio,
    bundleMs,
    renderMs: Date.now() - t1,
    ...(passWarnings.length ? { warnings: passWarnings } : {}),
  };
}
