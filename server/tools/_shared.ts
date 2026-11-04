/**
 * MCP 工具的共享底座：服务探活 / 请求转发 / 场景与工程解析 / 参数校验 / 文档生成。
 *
 * 这里原来是 mcp-tools.ts 的前 1185 行与末尾几百行。拆出来是为了让工具定义
 * （server/tools/*.ts）能各自成文件，而不必挤在同一个 8900 行的模块里。
 *
 * 约定：只放工具之间共用的东西。带 name 字段的工具定义不要放进来，
 * 它们属于 server/tools/ 下的分组文件。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { recallAll, remember, type MemoryKind } from "../memory.service";
import { DATA_ROOT } from "../paths";
import { BRIEF_STEPS, CONFIRM_GROUPS, CORE_STEPS, briefCoverage, briefProgress, briefToText, confirmBrief, legacyFieldNotice, readBrief, recomputeDesignLock, saveBrief, sceneCountHint, stepMissingFields, type Brief } from "../brief.service";
import { listNarrationClips, markVoiceHeard, narrationFingerprint, voiceHeardState } from "../narration-voice.service";
import { readStoryboard, saveStoryboard, storyboardToText, type Storyboard } from "../storyboard.service";
import { ELEMENT_LIBRARY, elementFromLibrary } from "../../shared/elementLibrary";
import {
  assetIdOf,
  assetToElement,
  isAssetLibraryId,
  type CustomAsset,
} from "../../shared/assetLibrary";
import { TRANSITION_TYPES } from "../../shared/transitions";
import { customEffectSchema, MAX_VOLUME, sceneSpans, totalDuration } from "../../shared/schema";
import { SUBTITLE_LIMITS, normalizeSubtitle, subtitleToField } from "../../shared/subtitleText";
import { sceneSubtitleLines, subtitleMaxChars } from "../../shared/subtitle";

/**
 * MCP 薄代理：只做参数搬运，所有写操作转发到常驻服务。
 * 绝不自己读写 project.json —— 否则会形成第二个状态源，Web 端就看不到 agent 的修改。
 */


/** 元素入场/出场特效的 zod 结构 */
export const EFFECT_DESC = z.object({
  type: z.enum(TRANSITION_TYPES),
  durationInFrames: z.number().int().min(0),
});

export const BASE = process.env.SERVER_URL ?? "http://127.0.0.1:4380";
export const BRK = String.fromCharCode(10);

/**
 * 转场时长默认值（帧）。此前散落 4 处各自写死 12、描述又都不声明，
 * agent 想统一调整节奏时感知不到这个默认 —— 收敛成一处，描述统一引用。
 */
export const TRANSITION_DEFAULT_FRAMES = 12;

/**
 * 流程闸口旁路（build_storyboard / build_film 的 skipChecks 参数）。
 *
 * 分级原则：**验收（confirm_review）与契约（mustInfo/禁词）是交付硬闸**，走各自的 force 机制；
 * 需求问诊 / 风格样张 / 稿件确认 / 配音试听是**流程性闸口**——用户明确说「直接建 / 不用问了」时
 * 应该放行，但必须附用户原话（≥2 字），跳过要在回执里留痕，风险说清由用户自担。
 */
export function processGateBypass(a: { skipChecks?: boolean; skipReason?: string }): string | null {
  if (!a.skipChecks) return null;
  if (!a.skipReason || [...a.skipReason.trim()].length < 2) {
    throw new Error(
      "skipChecks=true 必须同时给 skipReason（用户让你跳过的原话，至少 2 字）——没有原话不能跳过流程闸口",
    );
  }
  return a.skipReason.trim();
}
export const SKIPPED_NOTE = (gates: string[], by: string) =>
  `⚠ 已按用户要求跳过流程闸口：${gates.join("、")}（用户原话：「${by}」）——这些环节没走完，质量风险由用户自担。`;

/** force 旁路原话的最短长度。原话由 agent 转述、无法验真，卡长度只会增加摩擦，能对上口径即可 */
export const FORCE_QUOTE_MIN = 2;

/**
 * 平台 UI 遮挡区（画面百分比，经验值，只用于提醒，绝不硬裁）。
 *
 * 为什么只提醒：元素出框经常是有意设计（大字标题、延伸色块、出血图）。
 * 但字幕/二维码/联系方式这类"必须被看见"的东西压进按钮区，是真事故。
 */
/** 样张最多 3 个：多了用户挑不动，也浪费渲染（probe_style 入口处已限） */

/**
 * 选「画幅相关体检」按哪个画幅算（安全区 / 竖屏构图 / 字幕距底）。
 *
 * 多画幅工程（横 + 竖一起出）不能一律按竖屏判：横屏交付的片子会被竖屏规则刷出几十条误报，
 * 真问题反而被埋掉。顺序：显式 format → brief.aspect 对应的那个 → 工程第一个画幅。
 */
export function pickReviewFormat(
  formats: { key?: string; width?: number; height?: number }[],
  formatKey?: string,
  briefAspect?: string,
): { fmt?: { key?: string; width?: number; height?: number }; others: string[]; why: string } {
  const list = formats.filter((f) => Number(f.width) > 0 && Number(f.height) > 0);
  if (!list.length) return { fmt: undefined, others: [], why: "工程没设画幅" };

  if (formatKey) {
    const hit = list.find((f) => f.key === formatKey);
    if (!hit) {
      throw new Error(`没有画幅「${formatKey}」。这个工程有：${list.map((f) => f.key).join("、")}`);
    }
    return { fmt: hit, others: list.filter((f) => f !== hit).map((f) => String(f.key)), why: "按指定的 format" };
  }

  const m = /(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)/.exec(String(briefAspect ?? ""));
  if (m) {
    const want = Number(m[1]) / Number(m[2]);
    const scored = list
      .map((f) => ({ f, d: Math.abs(Number(f.width) / Number(f.height) - want) }))
      .sort((x, y) => x.d - y.d);
    // 容差 6%：16:9 与 1.85:1 这种近似比例要能对上，差一半以上的说明 brief 说错了
    if (scored[0] && scored[0].d < want * 0.06) {
      const hit = scored[0].f;
      return {
        fmt: hit,
        others: list.filter((f) => f !== hit).map((f) => String(f.key)),
        why: `按 brief 里的画幅 ${m[1]}:${m[2]}`,
      };
    }
  }

  return { fmt: list[0], others: list.slice(1).map((f) => String(f.key)), why: "按工程第一个画幅（brief 里没写画幅）" };
}

export function platformSafeArea(platform: string | undefined, aspect: string) {
  const portrait = /^(9:16|3:4|4:5|1:1)/.test(String(aspect ?? "9:16"));
  const p = String(platform ?? "");
  // 横屏没有右侧按钮栏、也没有顶部状态栏（那是竖屏 App 才有的）。
  // 只有底部播放器控件会压一点——按竖屏口径判横屏片，等于给横屏交付的片子刷一屏假警报。
  if (!portrait) {
    return {
      right: 0,
      bottom: 8,
      top: 0,
      note: "横屏：只有底部约 8% 是播放器控件区；右侧/顶部不会被平台 UI 压（网页与投屏播放甚至完全不遮）",
    };
  }
  if (/小红书/.test(p)) return { right: 0, bottom: 16, top: 8, note: "小红书竖屏：底部 16% / 顶部 8%" };
  return {
    right: 12,
    bottom: 16,
    top: 7,
    note: "竖屏短视频（抖音/快手/视频号）：右侧约 12% 按钮栏 / 底部约 16% 文案区 / 顶部约 7% 状态栏",
  };
}

/**
 * 字幕体检：字幕是「又臭又长」的重灾区，而它只在成片里暴露。
 *
 * 判两件事：
 *   1. 存的原文（scene.subtitle）有没有长句 / 标点 —— 渲染时会自动拆，但存着长句意味着
 *      断句点是机器猜的，节奏不一定对；SRT 也会跟着碎。
 *   2. 按当前幕长算，一屏停留时间够不够读（字/秒）——太快等于没字幕。
 *
 * 返回的 `hard` 是必须在渲染前修的（一屏读不完），其余是提醒。
 */
export function auditSubtitles(project: any): { issues: string[]; hard: string[] } {
  const issues: string[] = [];
  const hard: string[] = [];
  const fps = Number(project?.fps ?? 30) || 30;
  const spans = sceneSpans(project?.scenes ?? []);
  (project?.scenes ?? []).forEach((sc: any, i: number) => {
    const raw = String(sc.subtitle ?? "").trim();
    if (!raw) return;
    const max = subtitleMaxChars(sc);
    const lines = raw.split("\n").map((x: string) => x.trim()).filter(Boolean);
    const long = lines.filter((l) => [...l].length > SUBTITLE_LIMITS.hard);
    if (long.length) {
      hard.push(
        `「${sc.name}」有 ${long.length} 句超过 ${SUBTITLE_LIMITS.hard} 字（最长 ${Math.max(
          ...[...long].map((l) => [...l].length),
        )} 字）：一屏读不完，观众只顾着读字`,
      );
      return;
    }
    const over = lines.filter((l) => [...l].length > max);
    if (over.length) {
      issues.push(
        `ℹ️「${sc.name}」有 ${over.length} 句超过一屏 ${max} 字（最长 ${Math.max(
          ...[...over].map((l) => [...l].length),
        )} 字）：上屏会自动拆，但建议存之前就拆好`,
      );
    }
    if (lines.some((l) => /[。，、；：！？…,;:!?]/.test(l))) {
      issues.push(`ℹ️「${sc.name}」字幕带标点：标点只用于断句，上屏会自动清掉（想干净就 fix_subtitles）`);
    }
    // 字/秒：字幕停留时间不够读，等于没有
    const span = spans[i];
    if (span) {
      const chars = sceneSubtitleLines(sc).reduce((n, l) => n + [...l.text].length, 0);
      const sec = span.dur / fps;
      const cps = sec > 0 ? chars / sec : 99;
      if (chars >= 8 && cps > 9) {
        issues.push(
          `ℹ️「${sc.name}」字幕 ${chars} 字 / ${sec.toFixed(1)}s ≈ ${cps.toFixed(1)} 字/秒（超过 9 就来不及读）：要么加时长，要么减字`,
        );
      }
    }
  });
  return { issues, hard };
}

/** 量音频/视频真实时长（帧）；量不出来返回 null */
export async function probedDurationFrames(src: string, fps = 30): Promise<number | null> {
  try {
    const res = await fetch(
      `${BASE}/api/assets/probe?src=${encodeURI(src)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    const data = (await res.json()) as {
      probes?: { durationInSeconds?: number }[];
    };
    const d = data.probes?.[0]?.durationInSeconds;
    if (d && d > 0) return Math.max(1, Math.round(d * fps));
  } catch {
    /* 量不出来就让元素按默认（到场景结尾） */
  }
  return null;
}
/** 用脚本自身位置推工程根目录，不依赖 MCP 宿主的 cwd */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const log = (...args: unknown[]) => console.error("[mcp]", ...args);

/* ────────────────────────────── 服务拉起 ────────────────────────────── */

/**
 * 记录「最近一次确认服务活着」的时间，而不是一次性布尔值。
 * 服务进程可能被杀、崩溃或重启（用户在编辑器里改动、机器休眠等），
 * 用布尔缓存会导致此后所有调用都直接打到死端口。
 */
export let ensuredAt = 0;
export const ENSURE_TTL = 4000;

export async function health(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureServer(force = false) {
  if (!force && Date.now() - ensuredAt < ENSURE_TTL) return;
  if (await health()) {
    ensuredAt = Date.now();
    return;
  }
  log("服务未启动，尝试拉起 server/index.ts …");
  // 用工程内的 tsx + 当前 node 启动，避免依赖全局 npx / PATH
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, path.join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await health()) {
      log("服务已就绪");
      ensuredAt = Date.now();
      return;
    }
  }
  throw new Error("无法启动本地服务，请先手动执行 `npm run dev`");
}

/**
 * 「改完还没抽帧看过」的脏标记。
 *
 * 为什么要有：agent 改完一幕就直接往下做（继续改 / 渲染），用户从头到尾没看过效果，
 * 等到成片才发现不对——返工成本最高的一种。所以写操作会置脏，抽帧（preview_*）才清脏；
 * 脏着的时候 render / request_review 直接拒绝，其余写工具在返回里挂一句提醒。
 *
 * 只看"画面类"写入：brief / 稿件 / 分镜表这类文本配置不算——它们不需要看画面。
 */
export let dirtySincePreview = false;
export const DIRTY_PATH_RE = /\/ops$|\/theme$|\/formats$/;

export function markDirty(pathname: string): void {
  if (DIRTY_PATH_RE.test(pathname)) dirtySincePreview = true;
}

/**
 * 清掉「有改动还没抽帧确认」的标记（preview 之后调用）。
 *
 * 为什么要有函数而不是直接赋值：这个状态搬到了 _shared 里，其他模块拿到的是
 * 只读的 import 绑定，直接赋值会编译不过（TS2632）。
 */
export function clearDirty(): void {
  dirtySincePreview = false;
}

export const DIRTY_HINT =
  String.fromCharCode(10) +
  "⚠️ 这一轮改动还没抽帧确认：preview_frame / preview_frames 看一眼（并把图发给用户），再往下走。";

/**
 * ops 回执的统一拼装：⚠️ 开头的项**单独成行排在最前**。
 *
 * 以前一律 `summary.join("；")`，警告就埋在长句尾巴上——agent 扫一眼以为全成功，
 * 实际问题（比如「5 幕有自定义起点，时间位置不变」）就在那行末尾，被漏掉过一次。
 */
export function fmtSummary(summary: string[] | undefined): string {
  const list = (summary ?? []).filter((s) => String(s).trim());
  if (!list.length) return "";
  const isWarn = (s: string) => s.includes("⚠");
  const warns = list.filter(isWarn);
  const rest = list.filter((s) => !isWarn(s));
  if (!warns.length) return list.join("；");
  return [warns.join("\n"), rest.join("；")].filter(Boolean).join("\n");
}

/** 把输出里带 ⚠️ 的行提到最前（第一行标题保持不动） */
export function liftWarnings(out: string): string {
  if (!out.includes("⚠️")) return out;
  const lines = out.split("\n");
  if (lines.length < 3) return out;
  const isWarnLine = (s: string) => s.includes("⚠️");
  const warn = lines.slice(1).filter(isWarnLine);
  if (!warn.length) return out;
  const rest = lines.slice(1).filter((s) => !isWarnLine(s));
  return [lines[0], ...warn, ...rest].join("\n");
}

/** 清脏的工具（看过画面的都算） */
export const PREVIEW_TOOLS = new Set(["preview_frame", "preview_frames", "render_cover", "probe_style"]);

/** 不该挂提醒的工具：只读类 + 预览类 + 闸口类 */
export function needsDirtyHint(name: string): boolean {
  if (PREVIEW_TOOLS.has(name)) return false;
  return !/^(get_|list_|render_|cancel_|check_|tool_|start_|export_|import_|recall|remember|intake|confirm_|request_)/.test(
    name,
  );
}

export async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
  await ensureServer();

  const request = () =>
    fetch(`${BASE}${pathname}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });

  let res: Response;
  try {
    res = await request();
  } catch {
    // 连接层失败说明服务已不在，重新拉起后再试一次
    await ensureServer(true);
    res = await request();
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  if (init?.method && init.method !== "GET") markDirty(pathname);
  return data as T;
}

/* ────────────────────────────── 类型 ────────────────────────────── */

export type ProjectLite = {
  id: string;
  name: string;
  rev: number;
  fps: number;
  formats: { key: string; label: string; width: number; height: number }[];
  theme: { palette: Record<string, string> };
  audio?: {
    src: string;
    volume?: number;
    fadeIn?: number;
    fadeOut?: number;
    from?: number;
    durationInFrames?: number;
    loop?: boolean;
    ducking?: { enabled: boolean; depth: number; attackMs: number; releaseMs: number; padMs: number };
    gainCurve?: { stepMs: number; values: number[]; targetLufs?: number; ratio?: number };
  };
  /** 节拍网格（analyze_audio / set_beat_grid 写入） */
  beatGrid?: { bpm: number; offsetSec: number; source: "auto" | "manual"; src?: string; confidence?: number };
  audioTracks?: {
    id: string;
    name: string;
    from: number;
    volume: number;
    src: string;
    gainCurve?: { stepMs: number; values: number[]; targetLufs?: number; ratio?: number };
  }[];
  /** 特效轨（get_project 会把它列出来，agent 才知道 effectId） */
  effects?: { id: string; kind: string; name: string; from: number; durationInFrames: number; intensity?: number; color?: string }[];
  scenes: {
    id: string;
    type: string;
    name: string;
    durationInFrames: number;
    start?: number;
    track?: number;
    elements?: {
      id: string;
      kind: string;
      name: string;
      x: number;
      y: number;
      from?: number;
      durationInFrames?: number;
      src?: string;
      muted?: boolean;
      audioVolume?: number;
    }[];
    props: Record<string, unknown>;
  }[];
};

/** 最近一次用过的工程 id：没传 projectId 时优先用它（而不是永远取第一个工程）。
 * 落盘到 data/agent-state.json：服务重启后还能接上上次的工程（黑盒验证 N-04）。 */
export let lastProjectId: string | null = null;

export const AGENT_STATE_FILE = path.join(DATA_ROOT, "agent-state.json");

/** 从盘上读指针。stdio 代理与 HTTP 服务是两个进程，各有一份内存缓存，
 *  指针必须同源，否则「A 通道切换了、B 通道还在旧工程」 */
export function readPointerFromDisk(): string | null {
  try {
    if (!fs.existsSync(AGENT_STATE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(AGENT_STATE_FILE, "utf8")) as { currentProjectId?: string | null };
    return raw?.currentProjectId ?? null;
  } catch {
    /* 状态文件坏了就当作没有 */
    return null;
  }
}

export function saveAgentState(): void {
  try {
    fs.mkdirSync(path.dirname(AGENT_STATE_FILE), { recursive: true });
    fs.writeFileSync(AGENT_STATE_FILE, JSON.stringify({ currentProjectId: lastProjectId }, null, 2), "utf8");
  } catch {
    /* 落盘失败不影响会话内行为 */
  }
}

/** 唯一**写**指针的入口。只允许这五处调用：
 *  switch_project / create_project / import_project / 删除当前工程后的回退 / 指针失效自愈。 */
export function setCurrentProject(id: string | null): void {
  lastProjectId = id;
  saveAgentState();
}

/** 把盘上的指针同步进内存（另一个进程可能刚改过） */
export function refreshPointer(): void {
  const disk = readPointerFromDisk();
  if (disk && disk !== lastProjectId) lastProjectId = disk;
}

/**
 * 解析这次调用该作用在哪个工程上。
 *
 * 两条铁律（复验 P0，2026-10-28）：
 * 1. **传了 projectId 就是纯读**——绝不改当前工程指针。
 *    曾经的写法是 `if (lastProjectId !== project.id) setCurrentProject(...)`，
 *    于是任何只读工具（get_project / get_brief / check_project / intake…）只要显式带了
 *    projectId，就把「当前工程」改成它。用户流程「先看一眼前一个工程，再回来继续干」会静默
 *    把后续写操作落到别的工程上，且每次调用都返回成功。
 * 2. **指针失效时自愈并写回**（不是每次读都 fallback）：指针指向已删工程 → 落到第一个存活
 *    工程并落盘，否则 list_projects 永远标不出 ★、get_project 每次都静默换工程。
 */
/**
 * 建幕前的配音闸口。
 *
 * ## 为什么这个闸口必须存在
 *
 * 事故里 5 段配音合成完、用户一句没听到，agent 就建了 5 幕画面，
 * 并用 `tts_narration(applyToScenes)` 把幕长锁死在这版语音上（301/959/850/733/698 帧）。
 * 后果不是「画面做错了」，而是**画面被锁在未确认的语音上**：改一句台词 → 重新合成
 * → 每幕幕长变 → 所有元素坐标与动画帧位重排。改一段约等于重做。
 *
 * ## 为什么不是布尔闸口
 *
 * 布尔（`acknowledged=true`）只能表达「我确认了」，记录不下**用户到底说了什么**。
 * 而这次翻车的正是语义：用户说「可以，先合成配音试听」，
 * 被记成「稿子确认完毕，可以往下走」。所以这里要求原话，并留痕。
 *
 * 三种情况：
 * - 没合成过 → 放行（无稿类、纯图文片本来就没有配音）
 * - 合成过但没人听过 → 拒绝
 * - 听过的是旧版本（重跑过 TTS）→ 拒绝，让用户重听
 */
export async function assertNarrationHeard(projectId: string, action: string): Promise<void> {
  const nl = String.fromCharCode(10);

  // ① 先看「事实」：工程里被标记为旁白的音频元素。
  //    外部音频（真人录音 / 别的 TTS）不会产生 narration-timing，
  //    以前只看 timing 就会读到 none 直接放行 —— 那是个洞。
  const fresh = await api<{ project: never }>(`/api/projects/${projectId}`);
  const vs = voiceHeardState(fresh.project, projectId);
  if (vs.state === "unheard") {
    const clips = vs.clips
      .slice(0, 6)
      .map((c) => `    · 第 ${c.sceneIndex + 1} 幕 @${c.from} 帧（${(c.durationInFrames ?? 0) / ((fresh.project as { fps?: number }).fps || 30)}s）${c.src}`)
      .join(nl);
    throw new Error(
      `配音已经放进工程了，但用户还没听过这一版 —— 不能${action}。${nl}` +
        `  ${vs.detail}${nl}` +
        (clips ? `${nl}  ${clips}${nl}` : "") +
        `  该做的：把下面这些链接发给用户（点开就能播），问他语速/错字/停顿：${nl}` +
        vs.clips
          .slice(0, 6)
          .map((c) => `    ${BASE}${c.src}`)
          .join(nl) +
        `${nl}  他听过之后 → confirm_narration(userSaid="他的原话")。${nl}` +
        `  为什么必须等：现在建幕会把幕长锁死在这版语音上，改一句台词就要重排全片。`,
    );
  }
  if (vs.state === "heard") return;

  // ② 工程里还没有旁白音频 → 退回 TTS 骨架那条路（先合成、画面还没建）
  const r = await api<{
    timing: { at: string; segments: unknown[]; totalSec: number; heardAt?: string; heardOf?: string } | null;
  }>(`/api/projects/${projectId}/narration-timing`);
  const t = r.timing;
  if (!t) return;
  if (!t.heardAt) {
    throw new Error(
      `配音已经合成，但用户还没听过 —— 不能${action}。${nl}` +
        `  这一版：${(t.segments ?? []).length} 段 / ${Number(t.totalSec ?? 0).toFixed(1)}s（合成于 ${t.at}）${nl}` +
        `  该做的：把 tts_narration / register_narration 回执里那些「试听：http://…」链接发给用户，` +
        `问他语速/错字/停顿，他听过之后 → confirm_narration(userSaid="他的原话")。${nl}` +
        `  为什么必须等：现在建幕会把幕长锁死在这版语音上，改一句台词就要重排全片。`,
    );
  }
  if (t.heardOf !== t.at) {
    throw new Error(
      `用户听过的是**旧版本**配音，当前这一版是重新合成的 —— 不能${action}。${nl}` +
        `  他听的：${t.heardOf}${nl}  现在的：${t.at}${nl}` +
        `  该做的：把新链接发给他再听一次 → confirm_narration(userSaid="他的原话")。`,
    );
  }
}

export async function resolveProject(projectId?: string): Promise<ProjectLite> {
  if (projectId) {
    const { project } = await api<{ project: ProjectLite }>(`/api/projects/${projectId}`);
    return project;
  }
  refreshPointer();
  if (lastProjectId) {
    try {
      const { project } = await api<{ project: ProjectLite }>(`/api/projects/${lastProjectId}`);
      return project;
    } catch {
      setCurrentProject(null);
    }
  }
  const { projects } = await api<{ projects: { id: string }[] }>("/api/projects");
  if (!projects.length) throw new Error("还没有任何工程");
  const { project } = await api<{ project: ProjectLite }>(`/api/projects/${projects[0].id}`);
  setCurrentProject(project.id);
  return project;
}

/* ────────────────────── 批量 op：参数归一化 ────────────────────── */

/**
 * add_element 的「扁平参数」→ 完整 element 对象。
 *
 * 为什么要有这一层：单独调 `add_element` 工具时参数是扁平的（text / x / svg / libraryId…），
 * 而 op 层要的是 `{ sceneId, element: {...} }`。在 `apply_ops` 里 agent 很自然会把单工具的
 * 字段直接塞进 op，于是 `op.element` 是 undefined，崩出
 * `Cannot read properties of undefined (reading 'id')` ——
 * 这句报错和「你少包一层 element」毫无关系，实测让 agent 完全无法定位，
 * 只能拆成 18 次单调用（批量能力因此被判定为"不可用"）。
 *
 * 组装逻辑只留这一份：字段名、默认值、libraryId 解析、音视频按素材真实时长，
 * 单工具与批量两条路径共用。
 */
export async function composeElement(
  a: Record<string, unknown>,
  project: ProjectLite,
): Promise<{ element: Record<string, unknown>; sceneId: string }> {
  const str = (k: string) => (a[k] === undefined || a[k] === null ? undefined : String(a[k]));
  const num = (k: string) => (a[k] === undefined || a[k] === null ? undefined : Number(a[k]));

  const sceneId = str("sceneId") ?? project.scenes[0]?.id;
  if (!sceneId) throw new Error("工程里还没有场景，先 add_scene 再放元素");
  // @别名 指向"本批刚建的场景"，此刻还不存在 —— 交给服务端 apply 时解析
  if (!sceneId.startsWith("@") && !project.scenes.some((s) => s.id === sceneId)) {
    throw new Error(`找不到场景 ${sceneId}（现有场景：${project.scenes.map((s) => s.id).join("、")}）`);
  }

  const libraryId = str("libraryId");
  let base: Record<string, unknown> = {};
  if (libraryId) {
    if (isAssetLibraryId(libraryId)) {
      await ensureServer();
      const res = await fetch(`${BASE}/api/library`);
      const data = (await res.json()) as { items?: CustomAsset[] };
      const asset = (data.items ?? []).find((x) => x.id === assetIdOf(libraryId));
      if (!asset) {
        throw new Error(`我的素材里没有 ${libraryId}，先 upload_asset 或看 list_element_library`);
      }
      base = assetToElement(asset, {
        x: num("x") ?? 50,
        y: num("y") ?? 52,
      }) as unknown as Record<string, unknown>;
    } else {
      base = elementFromLibrary(libraryId) as unknown as Record<string, unknown>;
    }
  }

  const text = str("text");
  const src = str("videoSrc") ?? str("audioSrc") ?? str("imageSrc");
  const kind =
    text !== undefined
      ? "text"
      : str("videoSrc")
        ? "video"
        : str("audioSrc")
          ? "audio"
          : str("imageSrc")
            ? "image"
            : str("svg")
              ? "svg"
              : (base.kind as string | undefined);
  if (!kind) {
    throw new Error(
      "add_element 需要 libraryId / svg / text / imageSrc / videoSrc / audioSrc 至少一个" +
        "（批量里也可以直接写 element:{...} 包裹，两种写法都认）",
    );
  }

  const id = str("id") ?? `el_${Math.random().toString(36).slice(2, 10)}`;
  const element: Record<string, unknown> = {
    ...base,
    kind,
    id,
    name: str("name") ?? (base.name as string | undefined) ?? (kind === "text" ? text : "元素"),
    x: num("x") ?? (base.x as number | undefined) ?? 50,
    y: num("y") ?? (base.y as number | undefined) ?? 52,
  };
  if (src) element.src = src;

  const passthrough = [
    "svg", "viewBox", "stroke", "strokeWidth", "text",
    "size", "rotate", "scale", "opacity", "z", "fill", "bg", "weight",
    "radius", "border", "borderColor", "shadow", "filter", "blendMode",
    "clipPath", "fit", "fontFamily", "lineHeight", "letterSpacing",
    "textAlign", "fontStyle", "underline", "maxWidth", "strokeLinecap",
    "strokeLinejoin", "style", "enter", "exit", "from", "durationInFrames",
    "muted", "loop", "startFrom", "audioVolume",
  ];
  for (const k of passthrough) if (a[k] !== undefined) element[k] = a[k];

  // 音频/视频没显式给时长 → 按素材真实时长（铺满整幕会让 4 秒的素材播到幕尾时静音）
  if ((kind === "audio" || kind === "video") && element.durationInFrames === undefined) {
    const frames = src ? await probedDurationFrames(src) : null;
    if (frames) element.durationInFrames = frames;
  }
  if (kind === "video") {
    if (element.muted === undefined) element.muted = false;
    if (element.loop === undefined) element.loop = false;
  }
  return { element, sceneId };
}

/** update_element 允许的扁平字段（批量里照抄单工具写法时，这些键要收进 patch） */
export const UPDATE_ELEMENT_KEYS = [
  "name", "x", "y", "size", "rotate", "scale", "opacity", "z", "fill", "text",
  "svg", "viewBox", "stroke", "strokeWidth", "bg", "weight", "radius", "border",
  "borderColor", "shadow", "filter", "blendMode", "clipPath", "fit", "fontFamily",
  "lineHeight", "letterSpacing", "textAlign", "fontStyle", "underline", "maxWidth",
  "strokeLinecap", "strokeLinejoin", "style", "imageSrc", "videoSrc", "audioSrc",
  "audioVolume", "muted", "loop", "startFrom", "from", "durationInFrames",
  "enter", "exit",
];

/**
 * 把「单工具形状」的 op 归一化成 op 层认识的结构。
 *
 * 这是 `apply_ops` 的核心补丁：op 名与工具名相同、字段形状却不同（一个要 patch/element 包裹，
 * 一个是扁平），而报错是 `Cannot convert undefined or null to object` 这种天书。
 * 归一只在 MCP 层做，`shared/ops.ts` 的成功路径一行不动 —— 前端零影响。
 */
export async function normalizeOps(
  raw: Record<string, unknown>[],
  project: ProjectLite,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const where = `第 ${i + 1}/${raw.length} 个操作`;
    if (!item || typeof item !== "object") throw new Error(`${where}不是对象`);
    const name = typeof item.op === "string" ? item.op : "";
    if (!name) throw new Error(`${where}缺少 op 字段（形如 {op:'update_scene', sceneId, patch:{...}}）`);

    // ── add_element：扁平 → element 包裹
    if (name === "add_element") {
      if (item.element && typeof item.element === "object" && !Array.isArray(item.element)) {
        out.push({ op: "add_element", sceneId: item.sceneId ?? project.scenes[0]?.id, element: item.element });
      } else {
        const { op: _op, projectId: _pid, ...flat } = item;
        const { element, sceneId } = await composeElement(flat, project);
        out.push({ op: "add_element", sceneId, element });
      }
      continue;
    }

    // ── update_element：扁平 → patch 包裹
    if (name === "update_element") {
      const sceneId = item.sceneId;
      const elementId = item.elementId ?? item.id; // `id` 是最常见的笔误，直接认
      if (!sceneId) throw new Error(`${where}（update_element）缺少 sceneId`);
      if (!elementId) {
        throw new Error(
          `${where}（update_element）缺少 elementId（元素 id 从 get_project 里看）` +
            `；要改"本批刚加的元素"，在 add_element 上加 as:"e1"，这里写 elementId:"@e1"`,
        );
      }
      if (item.patch && typeof item.patch === "object") {
        out.push({ op: "update_element", sceneId, elementId, patch: item.patch });
      } else {
        const patch: Record<string, unknown> = {};
        for (const k of UPDATE_ELEMENT_KEYS) if (item[k] !== undefined) patch[k] = item[k];
        const extras = Object.keys(item).filter(
          (k) => !["op", "projectId", "sceneId", "elementId", "id"].includes(k) && !UPDATE_ELEMENT_KEYS.includes(k),
        );
        if (extras.length) {
          throw new Error(
            `${where}（update_element）不认识的字段：${extras.join("、")}` +
              `（可用字段见 update_element 工具；也可以用 patch:{...} 直接给）`,
          );
        }
        if (!Object.keys(patch).length) {
          throw new Error(`${where}（update_element）没有要改的字段（要改什么就传什么，如 opacity:0.5）`);
        }
        out.push({ op: "update_element", sceneId, elementId, patch });
      }
      continue;
    }

    // ── set_transition / set_transitions：转成 update_scene（op 层没有这俩名字）
    if (name === "set_transition" || name === "set_transitions") {
      const type = String(item.type ?? "");
      if (!type) throw new Error(`${where}（${name}）缺少 type（可选 ${TRANSITION_TYPES.join(" / ")}）`);
      const t = type === "none" ? null : { type, durationInFrames: Number(item.durationInFrames ?? TRANSITION_DEFAULT_FRAMES) };
      const dir = String(item.direction ?? "in");
      const patchFor = () =>
        dir === "out"
          ? { transitionOut: t }
          : dir === "both"
            ? { transitionIn: t, transitionOut: t }
            : { transitionIn: t };

      if (name === "set_transition") {
        const sceneId = item.sceneId;
        if (!sceneId) throw new Error(`${where}（set_transition）缺少 sceneId（批量给多幕套转场用 set_transitions）`);
        out.push({ op: "update_scene", sceneId, patch: patchFor() });
      } else {
        const ids = Array.isArray(item.sceneIds)
          ? item.sceneIds.map(String)
          : project.scenes.map((s) => s.id);
        if (!ids.length) throw new Error(`${where}（set_transitions）没有可设置的目标场景`);
        const known = new Set(project.scenes.map((s) => s.id));
        const unknown = ids.filter((id) => !known.has(id));
        if (unknown.length) throw new Error(`${where}（set_transitions）找不到场景：${unknown.join("、")}`);
        for (const sceneId of ids) out.push({ op: "update_scene", sceneId, patch: patchFor() });
      }
      continue;
    }

    // ── set_scene_box：扁平 x/y/scale/radius → box 包裹（画中画最常用，之前扁平写法被静默当"恢复全屏"）
    if (name === "set_scene_box") {
      const sceneId = item.sceneId;
      if (!sceneId) throw new Error(`${where}（set_scene_box）缺少 sceneId`);
      if (item.box && typeof item.box === "object") {
        out.push({ op: "set_scene_box", sceneId, box: item.box });
        continue;
      }
      if (item.reset === true || item.box === null) {
        out.push({ op: "set_scene_box", sceneId, box: null });
        continue;
      }
      const box: Record<string, unknown> = {};
      for (const k of ["x", "y", "scale", "rotate", "radius", "opacity", "shadow"]) {
        if (item[k] !== undefined) box[k] = item[k];
      }
      if (!Object.keys(box).length) {
        throw new Error(
          `${where}（set_scene_box）没有要改的字段：给 x/y/scale/radius…（扁平写法）或 box:{...}，` +
            `恢复全屏用 reset:true`,
        );
      }
      out.push({ op: "set_scene_box", sceneId, box });
      continue;
    }

    // ── update_scene：单工具形状用 props，op 层要 patch
    //    注意 props **必须留在 patch.props 里**：摊平到 patch 顶层就等于"字段层级写错"，
    //    op 层只认场景级字段，文案会静默无效（复验 N-A 的根因）
    if (name === "update_scene") {
      const sceneId = item.sceneId;
      if (!sceneId) throw new Error(`${where}（update_scene）缺少 sceneId`);
      const { props, patch, op: _op, projectId: _pid, sceneId: _sid, ...rest } = item as {
        props?: unknown;
        patch?: unknown;
      } & Record<string, unknown>;
      if (patch !== undefined && (typeof patch !== "object" || patch === null || Array.isArray(patch))) {
        throw new Error(`${where}（update_scene）的 patch 必须是对象`);
      }
      const patchIn = (patch as Record<string, unknown>) ?? {};
      // 扁平写法（title:"…"、durationInFrames:60）一并收进 patch，交给 op 层按版式校验
      const patchOut: Record<string, unknown> = { ...rest, ...patchIn };
      if (props !== undefined) {
        if (typeof props !== "object" || props === null || Array.isArray(props)) {
          throw new Error(`${where}（update_scene）的 props 必须是对象，如 props:{title:"新标题"}`);
        }
        patchOut.props = {
          ...((patchIn.props as Record<string, unknown>) ?? {}),
          ...(props as Record<string, unknown>),
        };
      }
      if (!Object.keys(patchOut).length) {
        throw new Error(
          `${where}（update_scene）没有要改的字段：单工具写法是 props:{...}，批量 op 写法是 patch:{...}，两种都认`,
        );
      }
      out.push({ op: "update_scene", sceneId, patch: patchOut });
      continue;
    }

    // ── add_freeform_element：扁平字段 → element 包裹（svg / fx / anim 只有 freeform 通道支持）
    if (name === "add_freeform_element") {
      const sceneId = item.sceneId;
      if (!sceneId) throw new Error(`${where}（add_freeform_element）缺少 sceneId`);
      if (item.element && typeof item.element === "object" && !Array.isArray(item.element)) {
        out.push({ op: "add_freeform_element", sceneId, element: item.element });
      } else {
        const { op: _op, projectId: _pid, sceneId: _sid, ...flat } = item;
        if (!Object.keys(flat).length) {
          throw new Error(
            `${where}（add_freeform_element）缺少 element（如 element:{type:"svg", svg:"...", viewBox:"..."}` +
              ` 或扁平写法 type:"fx", kind:"noise"）`,
          );
        }
        out.push({ op: "add_freeform_element", sceneId, element: flat });
      }
      continue;
    }

    // ── update_freeform_element：扁平字段 → patch 包裹
    if (name === "update_freeform_element") {
      const sceneId = item.sceneId;
      if (!sceneId) throw new Error(`${where}（update_freeform_element）缺少 sceneId`);
      if (item.patch && typeof item.patch === "object") {
        out.push(item);
        continue;
      }
      const { op: _op, projectId: _pid, sceneId: _sid, elementId, index, ...flat } = item as Record<string, unknown>;
      const locator: Record<string, unknown> = {};
      if (elementId !== undefined) locator.elementId = elementId;
      if (index !== undefined) locator.index = index;
      if (!Object.keys(locator).length) {
        throw new Error(`${where}（update_freeform_element）缺少 elementId 或 index`);
      }
      if (!Object.keys(flat).length) {
        throw new Error(`${where}（update_freeform_element）没有要改的字段（patch:{...} 或扁平写字段）`);
      }
      out.push({ op: "update_freeform_element", sceneId, ...locator, patch: flat });
      continue;
    }

    // 其它 op 原样透传（applyOps 自己校验，报错会带「第 N 个操作」前缀）
    out.push(item);
  }
  // `as` 是批内别名，normalize 会重建对象，这里按索引回填（每个输入最多产出一个 op）
  if (out.length === raw.length) {
    for (let i = 0; i < raw.length; i++) {
      const alias = raw[i]?.as;
      if (typeof alias === "string" && alias.trim()) out[i].as = alias.trim();
    }
  }
  return out;
}

export const brief = (p: ProjectLite) => {
  // 多轨之后总时长是"最靠后的那一帧"，不再是时长之和
  const total = totalDuration(p as never);
  const lines = [
    `工程：${p.name}（id=${p.id}，rev=${p.rev}）`,
    `画幅：${p.formats.map((f) => `${f.key} ${f.width}×${f.height}`).join(" / ")}`,
    `总时长：${total} 帧 ≈ ${(total / p.fps).toFixed(1)} 秒 @${p.fps}fps`,
  ];
  if (p.audio?.src) {
    const duck = p.audio.ducking;
    const duckText = duck
      ? `，人声避让${duck.enabled ? `降到 ${Math.round(duck.depth * 100)}%` : "已关"}`
      : "";
    lines.push(`背景音乐：${p.audio.src}（音量 ${Math.round((p.audio.volume ?? 1) * 100)}%${duckText}）`);
  }
  if (p.beatGrid) {
    const g = p.beatGrid;
    lines.push(
      `节拍网格：${g.bpm} BPM，首拍 ${g.offsetSec.toFixed(2)}s（${g.source === "auto" ? `自动检测，置信度 ${g.confidence ?? "?"}` : "手动指定"}）`,
    );
  }
  if (p.audioTracks?.length) {
    lines.push(
      `音效轨（${p.audioTracks.length}）：` +
        p.audioTracks.map((t) => `${t.id}「${t.name}」@${t.from}帧 音量${Math.round(t.volume * 100)}%`).join("、"),
    );
  }
  if (p.effects?.length) {
    lines.push(
      `特效轨（${p.effects.length}）：` +
        p.effects
          .map(
            (t) =>
              `${t.id}「${t.name}」@${t.from}帧 +${t.durationInFrames}帧 强度${Math.round((t.intensity ?? 1) * 100)}%`,
          )
          .join("、"),
    );
  }
  lines.push(
    `场景（${p.scenes.length}）：`,
    ...p.scenes.map((s, i) => {
      // 自由画布的元素 id/index 必须露出来，否则「改一个字」只能 get_scene 拉全量 props 重发
      // （那次一支 8 幕片子，每改一版都要重发 8 份 1.5KB 的 props）
      const freeEls = Array.isArray((s.props as { elements?: unknown })?.elements)
        ? ((s.props as { elements: Record<string, unknown>[] }).elements ?? [])
        : [];
      const freeLine = freeEls.length
        ? `\n      自由画布元素 ${freeEls.length} 个（update_freeform_element 用 index 或 elementId）：` +
          freeEls
            .slice(0, 12)
            .map((e, k) => `#${k}${e?.id ? `(${String(e.id)})` : ""} ${freeElementLabel(e)}`)
            .join("、") +
          (freeEls.length > 12 ? ` …还有 ${freeEls.length - 12} 个（get_scene 看全）` : "")
        : "";
      return (
        `  ${i + 1}. [${s.id}] ${s.name} (${s.type}) ${s.durationInFrames}帧 — ${summarizeProps(s)}` +
        freeLine +
        (s.elements?.length
          ? `
      叠加层：${s.elements.map((e) => `${e.id}「${e.name}」@${e.from ?? 0}f/${e.durationInFrames ?? "到场景尾"}f`).join("、")}`
          : "")
      );
    }),
  );
  return lines.join("\n");
};

/** 摘要里给元素一行可辨认的标签：有文字给文字，否则给名字/类型 */
export const freeElementLabel = (e: Record<string, unknown>) => {
  const text = typeof e?.text === "string" ? e.text.trim() : "";
  if (text) return `「${text.slice(0, 10)}${text.length > 10 ? "…" : ""}」`;
  const name = typeof e?.name === "string" ? e.name : "";
  if (name) return name;
  return String(e?.type ?? "元素");
};

export const summarizeProps = (s: { type?: string; props: Record<string, unknown> }) => {
  const p = s.props as Record<string, unknown>;
  const pick =
    (p.title as string) ??
    (p.heading as string) ??
    (p.text as string) ??
    (Array.isArray(p.items) ? `${p.items.length} 条要点` : "");
  if (pick) return String(pick).slice(0, 40);
  // freeform 场景没有 title/text：从元素里抽文字，否则多幕时没法辨认
  if (s.type === "freeform" || Array.isArray(p.elements)) {
    const els = (Array.isArray(p.elements) ? p.elements : []) as { text?: unknown; svg?: unknown }[];
    const texts = els
      .map((e) => (typeof e?.text === "string" ? e.text.trim() : ""))
      .filter(Boolean)
      .slice(0, 3);
    if (texts.length) return `[自由画布] ${texts.join(" / ")}`.slice(0, 50);
    if (els.length) return `[自由画布] ${els.length} 个元素`;
  }
  return "—";
};

/* ────────────────────────────── 工具注册 ────────────────────────────── */

/**
 * 让工程幕序对齐分镜表（幕序自愈）。
 *
 * 为什么必须有：build_storyboard 是「按调用顺序 append」的——先建第 1、6 幕当风格样张，
 * 再依次建第 2–18 幕，时间轴就成了 1→6→2→3…。片子于是先抛结论再演推理，钩子全废，
 * 而且**工具全程报成功**（复盘坑 #1，会毁片）。分镜表里每幕都回填了 sceneId，
 * 那个顺序才是用户确认过的唯一真相，不一致就以它为准。
 *
 * 只动顺序、不动内容；不在分镜表里的场景（样张 / 模板残留）保持它原来的位置——
 * 在块前面还在前面，在块后面还在后面。
 */
export async function alignScenesToStoryboard(
  projectId: string,
  sb: Storyboard,
): Promise<{ notes: string[]; extraCount: number }> {
  const doc = await api<{ project: ProjectLite }>(`/api/projects/${projectId}`);
  const scenes = (doc.project.scenes ?? []) as { id: string; name?: string }[];
  const current = scenes.map((s) => s.id);
  const known = new Set(current);
  const intended = sb.shots
    .map((s) => s.sceneId)
    .filter((id): id is string => !!id && known.has(id));
  if (intended.length < 2) return { notes: [], extraCount: 0 };

  const intendedSet = new Set(intended);
  const firstAt = current.indexOf(intended[0]);
  const extras = current.filter((id) => !intendedSet.has(id));
  const before = current.slice(0, Math.max(0, firstAt)).filter((id) => !intendedSet.has(id));
  const after = extras.filter((id) => !before.includes(id));
  const target = [...before, ...intended, ...after];
  const already = target.length === current.length && target.every((id, i) => id === current[i]);
  if (already) return { notes: [], extraCount: extras.length };

  const res = await api<{ summary: string[] }>(`/api/projects/${projectId}/ops`, {
    method: "POST",
    body: JSON.stringify({
      actor: "agent",
      // reflow:true —— 建幕阶段就是要一条干净的主轨；被 move_scene 钉过的起点留着，
      // 重排只改数组不会改时间，等于白排（这正是坑 #2 的现场）
      ops: [{ op: "reorder_scenes", sceneIds: target, reflow: true }],
    }),
  });
  const notes = [`已按分镜顺序重排幕序（之前是按建幕顺序排的，先建样板再补中间幕就会错位）`];
  const warn = (res.summary ?? []).filter((x) => String(x).includes("⚠"));
  notes.push(...warn);
  return { notes, extraCount: extras.length };
}


/* ────────────────────────────── 素材时长 ────────────────────────────── */

type   MediaProbe = {
  src: string;
  file: string;
  format: string;
  bytes: number;
  durationInSeconds: number;
  frames: number;
  suggestedSceneFrames: number;
  breathSec?: number;
  sampleRate?: number;
  channels?: number;
  method?: string;
  error?: string;
};

/** 量素材时长（转发给服务端，MCP 不自己解析文件） */
export async function probeAssets(srcs: string[], fps?: number, breathSec?: number): Promise<MediaProbe[]> {
  const q = srcs.map((s) => `src=${encodeURIComponent(s)}`).join("&");
  const { probes } = await api<{ probes: MediaProbe[] }>(
    `/api/assets/probe?${q}${fps ? `&fps=${fps}` : ""}${
      breathSec === undefined ? "" : `&breath=${breathSec}`
    }`,
  );
  return probes ?? [];
}

/** 单个素材时长；量不到就返回 null（不打断主流程） */
export async function probeOne(src: string, fps?: number, breathSec?: number): Promise<MediaProbe | null> {
  try {
    const [p] = await probeAssets([src], fps, breathSec);
    return p && !p.error ? p : null;
  } catch {
    return null;
  }
}

export type ToolDef = {
  name: string;
  description: string;
  shape: Record<string, z.ZodTypeAny>;
  run: (args: Record<string, any>) => Promise<string>;
  /** 已并入别的工具：仍注册可调（老调用不断），但搜索/目录不再列出，run 内透明转发并提示新名字 */
  retiredTo?: string;
};

export const text = (s: string) => s;

/** 画幅简写 → 尺寸（set_formats 收字符串时按这张表补，省掉手拼对象） */
export const FORMAT_PRESETS: Record<string, { label: string; width: number; height: number }> = {
  portrait: { label: "竖屏 9:16", width: 1080, height: 1920 },
  landscape: { label: "横屏 16:9", width: 1920, height: 1080 },
  square: { label: "方形 1:1", width: 1080, height: 1080 },
  tall45: { label: "竖版 4:5", width: 1080, height: 1350 },
};


/**
 * 需求改口的影响面：brief 里哪几个字段变了 → 下游要跟着重做什么。
 *
 * 为什么需要：复盘问题 3，项目中途从「无配音」改成「要 AI 配音」，
 * scriptType 从「屏幕文案」变成「双轨」，段落表要重算、幕长要重排、已放元素要挪。
 * 工具不说话，agent 只能自己推，推漏一步就是成片对不上稿。
 */
/**
 * 每个工程「已经提醒过的影响面」累计表。
 *
 * 为什么要累计：需求常常分两次写（先主体、再补几项），第二次的 diff 只含第二次的字段，
 * 第一次那句「配音规格变了 → 旁白全部作废」就被覆盖掉了，用户很容易漏看。
 * 这里按工程累积，回执里把「本次」和「之前提过但本次没提」分开列。
 * 进程重启丢失可接受：影响面本来就是即时提醒，不是审计记录。
 */
export const briefImpactLog = new Map<string, string[]>();

export function describeBriefImpact(prev: Brief | null, next: Brief): string[] {
  if (!prev) return [];
  const out: string[] = [];
  const changed = (k: string) =>
    JSON.stringify((prev as Record<string, unknown>)[k] ?? null) !==
    JSON.stringify((next as Record<string, unknown>)[k] ?? null);

  const voiceChanged = changed("voiceSpec") || changed("voice");
  const scriptChanged = changed("scriptType");
  const segChanged = changed("segments");
  const formChanged = changed("form");

  if (voiceChanged) {
    out.push("声音规格变了 → 已合成的旁白全部作废，要重跑 tts_narration，并重新确认试听（confirm_narration）");
  }
  if (scriptChanged) {
    out.push("稿件类型变了 → 稿件结构要重写（save_script），分镜每幕的 text 也要跟着回填");
  }
  if (segChanged) {
    out.push("段落表变了 → 幕长按新段落重算，已建场景的时长要重排（update_scene / 重建分镜）");
  }
  if (formChanged) {
    out.push("形态变了 → 版式策略要重选（「有没有东西在动」决定 freeform 还是内置版式），已有场景可能要整体重做");
  }
  if (changed("durationSec")) {
    out.push("目标时长变了 → 段落表时长合计要重新对齐（±5%），否则不是赶就是拖");
  }
  if (changed("mustInfo") || changed("bans")) {
    out.push("契约信息变了 → 建完后要重跑 brief_audit（check_project 也会按新契约体检）");
  }
  if (voiceChanged || segChanged) {
    out.push("幕长一变，已放的元素/贴纸坐标和关键帧都会错位：先定幕长再放定时元素，或回头改它们的 durationInFrames");
  }
  return out;
}


/**
 * 交付验收通过时，把「这支片子的稳定偏好」写进记忆 —— 下次开工 recall 就能命中，
 * 不用再问一遍画幅/风格/配音（复盘问题：recall 永远是「没有匹配的记忆」）。
 * 同一句话重复写会被 remember 去重；措辞带具体值，换了偏好自然产生新条目。
 */
export function rememberDeliveryPreferences(p: ProjectLite, brief: Brief | null): string[] {
  const notes: string[] = [];
  const push = (text: string, tags: string[]) => {
    try {
      remember({ kind: "preference", text, tags });
      notes.push(text);
    } catch {
      /* 记忆写不进去不影响交付 */
    }
  };
  const fmts = (p as unknown as { formats?: { key: string; label: string }[] }).formats ?? [];
  if (fmts.length === 1) push(`画幅偏好：${fmts[0].label}（${fmts[0].key}）—— 单画幅交付，用户没要多版本`, ["画幅"]);
  else if (fmts.length > 1) push(`画幅偏好：多画幅交付（${fmts.map((x) => x.key).join(" / ")}）`, ["画幅"]);

  const style = (brief as { style?: string } | null)?.style;
  if (style) push(`风格偏好：${style}`, ["风格"]);

  const vs = (brief as { voiceSpec?: { gender?: string; speed?: string } } | null)?.voiceSpec;
  if (vs?.gender) push(`配音偏好：${vs.gender}${vs.speed ? `，语速 ${vs.speed}` : ""}`, ["配音"]);

  const tone = (brief as { transitionTone?: string } | null)?.transitionTone;
  if (tone) push(`转场偏好：${tone}`, ["转场"]);
  return notes;
}

export const firstLine = (s: string) => s.split("\n")[0].trim();

/* ───────────── 响度辅助：削波提醒（供 set_audio / 音轨工具复用） ───────────── */

/** 音频角色：决定配平的目标响度（人声是主角，BGM 要让位，音效居中） */
export type Role = "voice" | "bgm" | "sfx";

export type AudioEntry =
  | { kind: "bgm"; label: string; src: string; role: Role; current: number }
  | { kind: "track"; label: string; id: string; src: string; role: Role; current: number }
  | { kind: "element"; label: string; sceneId: string; id: string; src: string; role: Role; current: number };

export function collectAudioEntries(
  p: ProjectLite,
  scope: "all" | "bgm" | "tracks" | "elements",
): AudioEntry[] {
  const out: AudioEntry[] = [];
  if ((scope === "all" || scope === "bgm") && p.audio?.src) {
    out.push({ kind: "bgm", label: "背景音乐", src: p.audio.src, role: "bgm", current: p.audio.volume ?? 1 });
  }
  if (scope === "all" || scope === "tracks") {
    for (const t of p.audioTracks ?? []) {
      out.push({ kind: "track", label: `音效「${t.name}」`, id: t.id, src: t.src, role: "sfx", current: t.volume ?? 1 });
    }
  }
  if (scope === "all" || scope === "elements") {
    for (const s of p.scenes) {
      for (const el of s.elements ?? []) {
        if (el.kind !== "audio" || !el.src) continue;
        out.push({
          kind: "element",
          label: `「${s.name}」/${el.name}`,
          sceneId: s.id,
          id: el.id,
          src: el.src,
          role: "voice",
          current: el.audioVolume ?? 1,
        });
      }
    }
  }
  return out;
}

/** 本工程素材目录里的一行（/api/projects/:id/assets 的返回） */
export type ProjectAssetLite = {
  name: string;
  url: string;
  rel: string;
  kind: "image" | "video" | "audio" | "file";
  bytes: number;
  at: number;
  referenced: boolean;
};

/** 整理旧素材的方案（/api/assets/organize 的返回，只取回执需要的字段） */
export type OrganizeResultLite = {
  dryRun: boolean;
  moves: { from: string; to: string; bytes: number; reason: string }[];
  rewrites: { projectId: string; name: string; changed: number }[];
  libraryUpdated: { id: string; name: string; changed: number }[];
  skipped: { rel: string; reason: string }[];
  freedDirs: string[];
  libraryMissing: number;
};

export const formatBytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;

export type LoudnessLite = {  src: string;
  durationSec: number;
  lufs: number;
  peakDb: number;
  rmsDb: number;
  curve: number[];
  /** 逐点窗口峰值（dBFS），压缩限幅用；旧缓存可能没有 */
  peakCurve?: number[];
  stepMs: number;
  cached?: boolean;
};

/**
 * 读素材响度。只对本地素材有效：公网 URL 我们不下载文件，返回 null 让调用方跳过检查。
 * 服务端有缓存（文件 size+mtime 指纹），同一个文件重复调是毫秒级。
 */
export async function loudnessOf(src: string): Promise<LoudnessLite | null> {
  if (!src.startsWith("/assets/")) return null;
  try {
    const res = await fetch(`${BASE}/api/audio/loudness`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ src }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: LoudnessLite };
    return data.result ?? null;
  } catch {
    return null; // 分析失败（格式不支持等）不该阻塞主操作
  }
}

/**
 * 放大后的削波提醒。
 *
 * 为什么必须有：>1 是数字放大，源文件峰值本来就接近满刻度时放大直接爆音，
 * 而代码不会报任何错 —— 只有听完才知道。这里用真实峰值算一次，提前把"最大安全音量"给出来。
 */
export async function clipWarning(src: string, gain: number): Promise<string | null> {
  if (gain <= 1.001) return null;
  const info = await loudnessOf(src);
  if (!info || !Number.isFinite(info.peakDb)) return null;
  const afterDb = info.peakDb + 20 * Math.log10(gain);
  if (afterDb <= -0.1) return null;

  const safeGain = Math.min(MAX_VOLUME, Math.pow(10, (-1 - info.peakDb) / 20));
  const safePct = Math.max(1, Math.floor(safeGain * 100));
  const capped = safeGain >= MAX_VOLUME ? `（该素材即使放到上限 ${MAX_VOLUME}× 也仍会削波，建议先换更好的源文件）` : "";
  return (
    `⚠️ 削波提醒：素材峰值 ${info.peakDb}dBFS × ${Math.round(gain * 100)}% = ${afterDb.toFixed(1)}dBFS，` +
    `超过 0dBFS 会爆音。不削波的最大音量约 ${safePct}%${capped}`
  );
}

/** 严格参数校验：未知 key 报错、类型不符报错、缺必填报错。
 * 为什么不用 SDK 默认（non-strict）：未知 key 会被静默剥掉，工具拿到 undefined 后
 * 静默失败或泄漏 undefined（黑盒验证报告 P1-04~07 的一整类问题）。
 *
 * 2026-10-31 补充：顶层 strict 只兜住第一层。`segments: [{dur:0,end:3}]` 这种
 * **数组元素内部**的错名会被 zod 静默 strip —— 于是工具回「已保存」，回显却是 `?–?s`。
 * 那次制作里 8 次「假成功」全是这一个口子。下面这层递归把任意深度的未知 key 都揪出来。 */
export function validateToolArgs(def: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const schema = z.object(def.shape).strict();
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const issues: any[] = (parsed.error as any)?.issues ?? [];
    const msgs = issues.map((iss) => {
      if (iss.code === "unrecognized_keys") {
        const allowed = Object.keys(def.shape);
        return (iss.keys ?? [])
          .map((k: string) => {
            const retired = RETIRED_FIELDS[k.toLowerCase()];
            if (retired) return `不认识的参数：${k} —— 该字段已退役，请改用 ${retired}`;
            const near = nearestKeys(k, allowed);
            return near.length
              ? `不认识的参数：${k}，你是不是要 ${near.join(" / ")}`
              : `不认识的参数：${k}（本工具可用：${allowed.slice(0, 10).join("、")}…共 ${allowed.length} 个，全表用 tool_search）`;
          })
          .join("；");
      }
      const p = iss.path?.length ? iss.path.join(".") : "(根)";
      // elementId 收数字不是"类型错"，是把下标塞进了 id 槽 —— 这种错必须指路
      if (iss.code === "invalid_type" && p === "elementId") {
        return `elementId 要的是元素 id（字符串）。按下标改请用 index: N（从 0 开始）`;
      }
      return `参数「${p}」不合法：${iss.message}`;
    });
    throw new Error(`参数校验失败（${def.name}）：${msgs.join("；")}`);
  }
  const unknown = findUnknownKeys(schema, args ?? {}, "");
  if (unknown.length) {
    const lines = unknown.slice(0, 6).map((u) => {
      const near = nearestKeys(u.key, u.allowed);
      const hint = near.length ? `，你是不是要 ${near.join(" / ")}` : "";
      return `  · ${u.path}.${u.key} 不认识${hint}（该处可用：${u.allowed.slice(0, 12).join("、")}）`;
    });
    if (unknown.length > 6) lines.push(`  …还有 ${unknown.length - 6} 处`);
    throw new Error(
      `参数校验失败（${def.name}）：${unknown.length} 个字段名对不上，没有被保存。\n` +
        lines.join("\n") +
        `\n（嵌套字段写错时以前会「保存成功但字段没生效」，现在直接拒绝）`,
    );
  }
  return parsed.data as Record<string, unknown>;
}

export type UnknownHit = { path: string; key: string; allowed: string[] };

/** 已退役的字段名 → 现在该用的名字。报「不认识」不够，得告诉它换哪个 */
export const RETIRED_FIELDS: Record<string, string> = {
  mustinclude: "mustInfo（[{text, where}]）",
  delivery: "deliverables（[{type, spec}]）",
};

/** 递归找未知 key：只走 object / array / optional 这条链，碰上 record、union 就停（那是开放结构） */
export function findUnknownKeys(schema: unknown, value: unknown, path: string): UnknownHit[] {
  const out: UnknownHit[] = [];
  if (value === null || value === undefined) return out;
  const t = unwrapZod(schema);
  const tn = (t as any)?._def?.typeName as string | undefined;
  if (!tn) return out;

  if (tn === "ZodObject") {
    if (typeof value !== "object" || Array.isArray(value)) return out;
    const rawShape = (t as any)._def.shape;
    const shape = (typeof rawShape === "function" ? rawShape() : rawShape) as Record<string, unknown>;
    const allowed = Object.keys(shape ?? {});
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const here = path ? `${path}.${k}` : k;
      if (!(k in (shape ?? {}))) out.push({ path: path || "(根)", key: k, allowed });
      else out.push(...findUnknownKeys(shape[k], v, here));
    }
    return out;
  }
  if (tn === "ZodArray") {
    if (!Array.isArray(value)) return out;
    value.forEach((v, i) => out.push(...findUnknownKeys((t as any)._def.type, v, `${path}[${i}]`)));
    return out;
  }
  return out;
}

/** 剥掉 optional / default / nullable / effects，拿到真正的结构 */
export function unwrapZod(t: unknown): unknown {
  let cur = t as any;
  for (let i = 0; i < 6 && cur?._def; i++) {
    const tn = cur._def.typeName as string;
    if (tn === "ZodOptional" || tn === "ZodNullable" || tn === "ZodDefault") cur = cur._def.innerType;
    else if (tn === "ZodEffects") cur = cur._def.schema;
    else break;
  }
  return cur;
}

/** 拼错的字段名 → 最像的正确名字（按编辑距离，阈值随长度放宽） */
export function nearestKeys(wrong: string, allowed: string[]): string[] {
  // 时间区间的同义词：`dur` / `from-to` / `start-end` 与 startSec/endSec 的编辑距离太远，
  // 纯距离算法给不出建议 —— 而那一族恰恰是那次制作里连试四次的错。
  const TIME_WORDS = ["dur", "duration", "durationsec", "from", "to", "start", "end", "begin", "finish", "time", "sec", "seconds"];
  const w = wrong.toLowerCase();
  if (TIME_WORDS.includes(w)) {
    const timeKeys = allowed.filter((k) => /^(start|end|from|to|dur)/i.test(k));
    if (timeKeys.length) return timeKeys.slice(0, 2);
  }
  const scored = allowed
    .map((k) => ({ k, d: editDistance(w, k.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(wrong.length / 3)))
    .sort((a, b) => a.d - b.d);
  return scored.slice(0, 2).map((x) => x.k);
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** zod shape → { 参数名?: 说明 + 嵌套字段 }（describe 写在 optional 内外都能取到）
 *
 * 为什么必须带嵌套字段：门面模式下 agent 只看到 tool_search 的回执，看不到 JSON Schema。
 * 以前这里只输出顶层 key + 描述，于是 `segments` 里到底叫 startSec 还是 from/to
 * 完全不可见 —— 那次试了四次才命中（前三次还都返回"已保存"）。 */
export function paramDocs(shape: Record<string, z.ZodTypeAny>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, t] of Object.entries(shape)) {
    const anyT = t as any;
    const optional = !!anyT?.isOptional?.();
    const desc = descOf(t);
    const hint = structHint(t);
    out[`${k}${optional ? "?" : ""}`] = `${desc || "—"}${hint ? ` 【${hint}】` : ""}`;
  }
  return out;
}

/** 参数自带的描述（写在外层或 unwrap 后的都认） */
export function descOf(t: unknown): string {
  const outer = (t as { description?: string })?.description;
  if (outer) return outer;
  const inner = (unwrapZod(t) as { description?: string })?.description;
  return inner ?? "";
}

/** 描述取第一句，给嵌套字段列表用（太长会把回执撑爆） */
export function firstClause(s: string, max = 16): string {
  const head = s.split(/[。；;\n]/)[0] ?? s;
  return head.length > max ? `${head.slice(0, max)}…` : head;
}

/** 嵌套结构提示：对象给字段清单，数组给"数组项字段" */
export function structHint(t: unknown, depth = 0): string {
  const u = unwrapZod(t) as any;
  const tn = u?._def?.typeName as string | undefined;
  const fieldsOf = (obj: any) => {
    const raw = obj?._def?.shape;
    const shape = (typeof raw === "function" ? raw() : raw) ?? {};
    return Object.entries(shape).map(([k, v]: [string, any]) => {
      const d = descOf(v);
      return d ? `${k}(${firstClause(d)})` : k;
    });
  };
  if (depth > 0) return "";
  if (tn === "ZodObject") return `字段：${fieldsOf(u).join("、")}`;
  if (tn === "ZodArray") {
    const el = unwrapZod(u._def.type) as any;
    if (el?._def?.typeName === "ZodObject") return `数组项字段：${fieldsOf(el).join("、")}`;
  }
  return "";
}

export function fullDoc(d: ToolDef) {
  return { name: d.name, description: d.description, params: paramDocs(d.shape) };
}
