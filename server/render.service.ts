import path from "node:path";
import { ROOT as PROJECT_ROOT } from "./root";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, openBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import type { Project } from "../shared/schema";
import { totalDuration } from "../shared/schema";
import { PUBLIC_DIR } from "./store";
import { cleanupOutputs, ensureOutDir, outDirOf } from "./outputs.service";

let serveUrlPromise: Promise<string> | null = null;

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

/** 打包一次并缓存，后续所有渲染复用；源码变更时自动失效重打包 */
export async function getServeUrl(): Promise<string> {
  const sig = sourceSignature();
  if (serveUrlPromise && lastSignature !== null && sig !== lastSignature) {
    console.log("[render] 检测到场景源码变更，重新打包…");
    resetBundle();
  }
  if (!serveUrlPromise) {
    lastSignature = sig;
    serveUrlPromise = bundle({
      entryPoint: path.join(PROJECT_ROOT, "src", "index.ts"),
      publicDir: PUBLIC_DIR,
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

/** src/ 与 shared/ 下所有文件的 mtime 和，用作"代码是否变了"的指纹 */
function sourceSignature(): number {
  let sum = 0;
  for (const dir of ["src", "shared"]) {
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
export async function renderStills(
  project: Project,
  frame?: number,
  formats?: string[],
  /** 文件名后缀（只留字母数字与 -_）：同一帧要多张不同内容的图时必须给，
   *  否则文件名一样会互相覆盖——probe_style 的三个风格样张就踩过这个坑 */
  tag?: string,
): Promise<StillResult[]> {
  const stillDir = ensureStillDir(project.id);
  const serveUrl = await getServeUrl();
  const targets = project.formats.filter((f) => !formats?.length || formats.includes(f.key));
  const total = Math.max(1, totalDuration(project));
  const results: StillResult[] = [];

  for (const fmt of targets) {
    // 单一 Composition，画幅由 inputProps.formats + formatKey 经 calculateMetadata 推导
    const compositionId = "Video";
    const inputProps = { ...project, formatKey: fmt.key };
    const puppeteerInstance = await getBrowser();
    const composition = await selectComposition({ puppeteerInstance, serveUrl, id: compositionId, inputProps, browserExecutable: BROWSER?.path, chromeMode: BROWSER?.mode });
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
    });
    results.push({ format: fmt.key, url: `/out/projects/${project.id}/stills/${file}?t=${project.rev}`, frame: f });
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
  createdAt: number;
  /** 最后一次状态变化时间（结束时间可能就是它），给编辑器算「已经跑了多久」 */
  updatedAt?: number;
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

export const getTask = (id: string) => tasks.get(id);
export const listTasks = () => [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);

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
  const { cancelSignal, cancel } = makeCancelSignal();
  cancels.set(task.id, cancel);

  try {
    if (isCancelled(task)) return;

    task.status = "bundling";
    task.updatedAt = Date.now();
    const serveUrl = await getServeUrl();
    if (isCancelled(task)) return;

    for (const key of task.formats) {
      // 排队期间被取消的任务在这里直接跳过，不浪费一次渲染
      if (isCancelled(task)) return;

      task.status = "rendering";
      // 多画幅是逐个渲的，进度会从 0 重来：带上「当前画幅」编辑器才不会以为卡死/重启
      task.currentFormat = key;
      task.progress = 0;
      task.updatedAt = Date.now();
      const fmt = project.formats.find((f) => f.key === key);
      if (!fmt) continue;
      const compositionId = "Video";
      const inputProps = { ...project, formatKey: key };
      const puppeteerInstance = await getBrowser();
      const composition = await selectComposition({
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
        onProgress: ({ progress }: { progress: number }) => {
          // 取消后不再更新进度，避免界面又跳回 30%
          if (isCancelled(task)) return;
          task.progress = Math.round(progress * 100);
          task.updatedAt = Date.now();
        },
      });
      if (isCancelled(task)) return;
      task.outputs.push({ format: key, url: `/out/projects/${task.projectId}/videos/${file}` });
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
