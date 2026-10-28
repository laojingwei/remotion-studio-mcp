/**
 * MCP 薄代理：只做参数搬运，所有写操作转发到常驻服务。
 * 绝不自己读写 project.json —— 否则会形成第二个状态源，Web 端就看不到 agent 的修改。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listSkills, readSkill } from "./skills.service";
import { recallAll, remember, type MemoryKind } from "./memory.service";
import { BRIEF_STEPS, briefProgress, briefToText, confirmBrief, readBrief, saveBrief, stepMissingFields, type Brief } from "./brief.service";
import { listStyles, presetOf, readStyle, styleSummary } from "./styles.service";
import { readStoryboard, saveStoryboard, storyboardToText, type Storyboard } from "./storyboard.service";
import { ELEMENT_LIBRARY, elementFromLibrary } from "../shared/elementLibrary";
import { getMeta } from "../shared/sceneMetas";
import {
  assetIdOf,
  assetToElement,
  isAssetLibraryId,
  type CustomAsset,
} from "../shared/assetLibrary";
import { TRANSITION_TYPES } from "../shared/transitions";
import {
  CUSTOM_EASES,
  EFFECT_CURVES,
  EFFECT_CURVE_LABEL,
  EFFECT_OPTIONS,
  EFFECT_TYPES,
  effectParamsOf,
} from "../shared/effects";
import { customEffectSchema, MAX_VOLUME, sceneSpans, totalDuration } from "../shared/schema";
import { beatFrames, beatTimes, buildCompressCurve, DEFAULT_DUCKING, gainForTarget, nearestBeat, summarizeCurve } from "../shared/audio";
import { analyzeBeats, BEAT_CONFIDENCE_MIN } from "./audio-analysis.service";

/** 元素入场/出场特效的 zod 结构 */
const EFFECT_DESC = z.object({
  type: z.enum(TRANSITION_TYPES),
  durationInFrames: z.number().int().min(0),
});

const BASE = process.env.SERVER_URL ?? "http://127.0.0.1:4380";

/** 量音频/视频真实时长（帧）；量不出来返回 null */
async function probedDurationFrames(src: string, fps = 30): Promise<number | null> {
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
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const log = (...args: unknown[]) => console.error("[mcp]", ...args);

/* ────────────────────────────── 服务拉起 ────────────────────────────── */

/**
 * 记录「最近一次确认服务活着」的时间，而不是一次性布尔值。
 * 服务进程可能被杀、崩溃或重启（用户在编辑器里改动、机器休眠等），
 * 用布尔缓存会导致此后所有调用都直接打到死端口。
 */
let ensuredAt = 0;
const ENSURE_TTL = 4000;

async function health(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer(force = false) {
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

async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
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
  return data as T;
}

/* ────────────────────────────── 类型 ────────────────────────────── */

type ProjectLite = {
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
let lastProjectId: string | null = null;

const AGENT_STATE_FILE = path.join(ROOT, "data", "agent-state.json");

/** 从盘上读指针。stdio 代理与 HTTP 服务是两个进程，各有一份内存缓存，
 *  指针必须同源，否则「A 通道切换了、B 通道还在旧工程」 */
function readPointerFromDisk(): string | null {
  try {
    if (!fs.existsSync(AGENT_STATE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(AGENT_STATE_FILE, "utf8")) as { currentProjectId?: string | null };
    return raw?.currentProjectId ?? null;
  } catch {
    /* 状态文件坏了就当作没有 */
    return null;
  }
}

function saveAgentState(): void {
  try {
    fs.mkdirSync(path.dirname(AGENT_STATE_FILE), { recursive: true });
    fs.writeFileSync(AGENT_STATE_FILE, JSON.stringify({ currentProjectId: lastProjectId }, null, 2), "utf8");
  } catch {
    /* 落盘失败不影响会话内行为 */
  }
}

/** 唯一**写**指针的入口。只允许这五处调用：
 *  switch_project / create_project / import_project / 删除当前工程后的回退 / 指针失效自愈。 */
function setCurrentProject(id: string | null): void {
  lastProjectId = id;
  saveAgentState();
}

/** 把盘上的指针同步进内存（另一个进程可能刚改过） */
function refreshPointer(): void {
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
async function resolveProject(projectId?: string): Promise<ProjectLite> {
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
async function composeElement(
  a: Record<string, unknown>,
  project: ProjectLite,
): Promise<{ element: Record<string, unknown>; sceneId: string }> {
  const str = (k: string) => (a[k] === undefined || a[k] === null ? undefined : String(a[k]));
  const num = (k: string) => (a[k] === undefined || a[k] === null ? undefined : Number(a[k]));

  const sceneId = str("sceneId") ?? project.scenes[0]?.id;
  if (!sceneId) throw new Error("工程里还没有场景，先 add_scene 再放元素");
  if (!project.scenes.some((s) => s.id === sceneId)) {
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
const UPDATE_ELEMENT_KEYS = [
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
async function normalizeOps(
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
            `；如果想改"刚在本批里新增的元素"，请分两批：先 add_element 拿到 id 再改`,
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
      const t = type === "none" ? null : { type, durationInFrames: Number(item.durationInFrames ?? 12) };
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
  return out;
}

const brief = (p: ProjectLite) => {
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
    ...p.scenes.map(
      (s, i) =>
        `  ${i + 1}. [${s.id}] ${s.name} (${s.type}) ${s.durationInFrames}帧 — ${summarizeProps(s)}` +
        (s.elements?.length
          ? `
      元素：${s.elements.map((e) => `${e.id}「${e.name}」@${e.from ?? 0}f/${e.durationInFrames ?? "到场景尾"}f`).join("、")}`
          : ""),
    ),
  );
  return lines.join("\n");
};

const summarizeProps = (s: { type?: string; props: Record<string, unknown> }) => {
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

/* ────────────────────────────── 素材时长 ────────────────────────────── */

type MediaProbe = {
  src: string;
  file: string;
  format: string;
  bytes: number;
  durationInSeconds: number;
  frames: number;
  suggestedSceneFrames: number;
  sampleRate?: number;
  channels?: number;
  method?: string;
  error?: string;
};

/** 量素材时长（转发给服务端，MCP 不自己解析文件） */
async function probeAssets(srcs: string[], fps?: number): Promise<MediaProbe[]> {
  const q = srcs.map((s) => `src=${encodeURIComponent(s)}`).join("&");
  const { probes } = await api<{ probes: MediaProbe[] }>(
    `/api/assets/probe?${q}${fps ? `&fps=${fps}` : ""}`,
  );
  return probes ?? [];
}

/** 单个素材时长；量不到就返回 null（不打断主流程） */
async function probeOne(src: string, fps?: number): Promise<MediaProbe | null> {
  try {
    const [p] = await probeAssets([src], fps);
    return p && !p.error ? p : null;
  } catch {
    return null;
  }
}

type ToolDef = {
  name: string;
  description: string;
  shape: Record<string, z.ZodTypeAny>;
  run: (args: Record<string, any>) => Promise<string>;
};

const text = (s: string) => s;

const TOOLS: ToolDef[] = [
  {
    name: "start_guide",
    description:
      "开工入口：返回完整创作流程（接单→brief→风格→分镜→搭建→配音→自检→渲染→沉淀），以及你现在处在哪一步、该读哪篇技能、下一步动作。每次新任务先调它一次。",
    shape: {
      projectId: z.string().optional().describe("传了会判断当前工程进度"),
    },
    run: async (a) => {
      const nl = String.fromCharCode(10);
      const lines: string[] = [
        "# 创作流程（从接单到成片）",
        "1. 接单 → intake() 9 步问诊 → save_brief(step=1..9) → 发总结请用户确认 → confirm_brief",
        "2. 风格 → list_styles → get_style → apply_style",
        "3. 分镜 → get_guide(\"formats\") 按用途定结构 → 分镜三提案给用户选 → get_guide(\"director\",\"分镜\") → save_storyboard（每幕带 change/carry 三问）→ build_storyboard",
        "4. 风格帧 → 先建 1 幕代表性场景，preview_frame 抽帧给用户过目，再批量铺开",
        "5. 搭建 → add_scene/update_scene（自由画布见 get_guide(\"freeform\")；画面质感与签名时刻见 get_guide(\"craft\")）",
        "6. 声音 → get_guide(\"sound\") 定 BGM/避让 → get_guide(\"narration\") → tts_narration（applyToScenes=true 对齐）",
        "7. 自检 → get_guide(\"qa\") → check_project → preview_frames",
        "8. 渲染 → render_video(dryRun) → render_video",
        "9. 沉淀 → get_guide(\"memory\") → remember / save_template",
        "",
        "所有指南：list_guides；只读某一节：get_guide(name, section)",
        "工具分两层：常驻 4 个（start_guide / get_guide / tool_search / tool_call），其余 70+ 个按需调用——",
        "  找工具：tool_search(\"画中画\")；执行：tool_call(name=\"move_scene\", args={...})；全表与铁律：get_guide(\"manual\")",
      ];

      if (a.projectId) {
        const p = await resolveProject(a.projectId);
        const brief = readBrief(p.id);
        const sb = readStoryboard(p.id);
        const built = !!sb?.shots?.some((x) => x.sceneId);
        const hasAudio = (p.scenes ?? []).some((sc: any) =>
          (sc.elements ?? []).some((e: any) => e.kind === "audio"),
        );
        const sceneCount = (p.scenes ?? []).length;
        const stage = hasAudio
          ? "自检 / 渲染（旁白已就位）"
          : built
            ? "配音（场景已建好，还没有旁白）"
            : sb
              ? "搭建（分镜表有了，还没 build_storyboard）"
              : sceneCount > 2
                ? "分镜 / 搭建（已有场景，还没写分镜表）"
                : !brief
                  ? "接单（还没 brief）"
                  : "风格 / 分镜（有 brief，还没有分镜表）";
        lines.push("", `你现在在：${stage}`, `工程：${p.name}（${(p.scenes ?? []).length} 场景）`);
      } else {
        lines.push("", "还没指定工程：先 create_project，然后 save_brief 接单。");
      }

      return lines.join(nl);
    },
  },
  {
    name: "get_guide",
    description:
      "读项目里的技能指南（按需加载，省上下文）：工具全书 manual（能力地图/意图速查/铁律）、导演流程、画面质感 craft、用途结构 formats、声音设计 sound、长片章节、版式配方、旁白配音、记忆与模板、交付验收。先用 list_guides 看有哪些，再 get_guide 取某一篇；传 section 可只取某一节。",
    shape: {
      name: z
        .string()
        .describe("技能名，如 manual / director / craft / formats / sound / long-form / scene-recipes / narration / memory / delivery / tools-quickref"),
      section: z
        .string()
        .optional()
        .describe("只读某个小节（按标题关键字匹配，如「接单确认」）"),
    },
    run: async (a) => {
      const name = a.name.replace(/\.md$/, "");
      return readSkill(name, a.section);
    },
  },
  {
    name: "list_styles",
    description:
      "列出风格库（来自 motion-showreel 的风格规则）：slug、名称、是否可一键套用。共 40+ 种（暗色发布会/瑞士编辑/粗野排版/电影片头/像素/国潮…）。",
    shape: {},
    run: async () => {
      const list = listStyles();
      const nl = String.fromCharCode(10);
      return (
        `共 ${list.length} 种风格：` +
        nl +
        list
          .map((x) => `- ${x.slug}：${x.name}${x.hasPreset ? " 【可一键套用】" : "（仅规则）"}`)
          .join(nl)
      );
    },
  },
  {
    name: "get_style",
    description:
      "读某个风格的完整规则（本质 / 辨识信号 / 最俗的版本 / 配色 / 字体 / 运动 / 坑）。先 list_styles 挑，再只读选中的 1–2 个。",
    shape: {
      slug: z.string().describe("风格 slug，如 dark-keynote / swiss-editorial"),
      section: z.string().optional().describe("只读某一节（按标题关键字匹配）"),
    },
    run: async (a) => readStyle(a.slug, a.section),
  },
  {
    name: "apply_style",
    description:
      "一键套用风格：改主题（配色/字体/圆角）+ 所有场景入场转场，返回推荐版式与禁止项。仅对 list_styles 里标【可一键套用】 的风格有效。",
    shape: {
      slug: z.string().describe("风格 slug"),
      transitions: z.boolean().optional().describe("是否同时应用转场，默认 true"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const preset = presetOf(a.slug);
      if (!preset) {
        throw new Error(
          `「${a.slug}」还没有结构化预设：用 get_style 读规则后手动 set_theme；或选一个带【可一键套用】的风格。`,
        );
      }
      const p = await resolveProject(a.projectId);
      const ops: Record<string, unknown>[] = [
        {
          op: "set_theme",
          palette: preset.palette,
          font: preset.font,
          radius: preset.radius,
        },
      ];
      if (a.transitions !== false && preset.transition) {
        const t =
          preset.transition.type === "none"
            ? null
            : {
                type: preset.transition.type,
                durationInFrames: preset.transition.durationInFrames,
              };
        for (const sc of p.scenes ?? []) {
          ops.push({ op: "update_scene", sceneId: sc.id, patch: { transitionIn: t } });
        }
      }
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      return `已套用风格（${res.summary.length} 处改动）${String.fromCharCode(10)}${styleSummary(a.slug)}${String.fromCharCode(10)}注意：转场只应用到**现有**场景，之后新建的场景默认转场是 fade 12 帧——要一致就给新场景补 set_transition 或重跑 apply_style。${String.fromCharCode(10)}下一步：save_storyboard 写分镜（见 get_guide(\"director\",\"分镜\")）`;
    },
  },
  {
    name: "list_guides",
    description: "列出所有可用的技能指南（名称、标题、字符数），配合 get_guide 使用。",
    shape: {},
    run: async () => {
      const skills = listSkills();
      if (!skills.length) return "还没有技能文件（server/skills/*.md）";
      return skills
        .map((x) => `- ${x.name}：${x.title}（${x.chars} 字符）`)
        .join("\n");
    },
  },
  {
    name: "remember",
    description:
      "记一条经验，按类存：pitfall（坑与解法）、preference（用户偏好/禁忌）、recipe（有效配方）。踩坑后、用户提出要求、发现好组合时用；相同内容不会重复记。",
    shape: {
      kind: z
        .enum(["pitfall", "preference", "recipe"])
        .describe("pitfall=坑与解法；preference=用户审美/禁忌；recipe=有效版式/参数配方"),
      text: z.string().describe("内容：写清触发条件 + 结论/解法，便于以后检索"),
      tags: z.array(z.string()).optional().describe("2-4 个关键词，便于 recall"),
      scope: z.enum(["global", "project"]).optional().describe("默认 global（跨工程）；只对本片有效的用 project"),
      projectId: z.string().optional().describe("scope=project 时必传"),
    },
    run: async (a) => {
      const it = remember({
        kind: a.kind as MemoryKind,
        text: a.text,
        tags: a.tags,
        scope: a.scope,
        projectId: a.projectId,
      });
      return `已记入 ${it.kind}（${it.id}，${a.scope ?? "global"}）`;
    },
  },
  {
    name: "recall",
    description:
      "检索记忆（坑/偏好/配方）：不传 kind 查全部类别，传 projectId 同时查工程级记忆。开工前先查一遍，避免重复踩坑。",
    shape: {
      kind: z.enum(["pitfall", "preference", "recipe"]).optional().describe("只查某一类，不传查全部"),
      query: z.string().optional().describe("关键词，短词更容易命中"),
      tags: z.array(z.string()).optional().describe("按标签过滤（全部命中）"),
      projectId: z.string().optional().describe("传了就同时查该工程的记忆"),
      limit: z.number().int().min(1).max(50).optional().describe("最多返回条数，默认 20"),
    },
    run: async (a) => {
      const items = recallAll({
        kind: a.kind as MemoryKind | undefined,
        query: a.query,
        tags: a.tags,
        projectId: a.projectId,
        limit: a.limit,
      });
      if (!items.length) return "没有匹配的记忆。";
      return items
        .map((x) => `- [${x.kind}] ${x.text}${x.tags.length ? `（${x.tags.join("、")}）` : ""}`)
        .join("\n");
    },
  },
  {
    name: "list_templates",
    description:
      "列出整片模板：内置模板（口播带货 / 数据复盘 / 产品发布 / 空白）+ 用户存的「我的模板」。用户说\"做个口播视频\"这类需求时，先从这里挑模板建工程，再按需改文案，比自己从零拼场景快得多。",
    shape: {
      tag: z.string().optional().describe("只列带这个标签的模板（内置/自定义都过滤）"),
    },
    run: async (a: { tag?: string }) => {
      const { templates } = await api<{ templates: any[] }>("/api/templates");
      const tag = a.tag?.trim().toLowerCase();
      const list = tag
        ? templates.filter((t: any) => {
            // 内置模板本身没有业务标签：按「内置 / builtin」筛 kind，别让标签过滤把它们筛没
            const isBuiltin = t.kind !== "custom";
            if (["内置", "builtin", "系统"].includes(tag)) return isBuiltin;
            if (["我的", "自定义", "custom", "我的模板"].includes(tag)) return !isBuiltin;
            return (t.tags ?? []).some((x: string) => String(x).toLowerCase().includes(tag));
          })
        : templates;
      if (!list.length) return `没有带「${a.tag}」标签的模板（内置模板可用 tag="内置" 筛，我的模板用 tag="我的"）。`;
      return list
        .map((t: any) => {
          const kind = t.kind === "custom" ? "「我的模板」" : "内置";
          return `${t.key} · ${t.name}（${kind}）：${t.description}\n  ${t.sceneCount} 个场景 / ${(t.durationInFrames / 30).toFixed(0)}s · 场景构成 ${t.sceneTypes.join(" → ")}`;
        })
        .join("\n");
    },
  },
  {
    name: "create_project",
    description:
      "从模板新建一个工程并切换过去（Web 端会自动跟随）。templateKey 取内置模板 key，templateId 取「我的模板」的 key（见 list_templates），二选一。用户要新片子的第一步就是它；建完用 update_scene 改文案、add_scene 补场景。",
    shape: {
      templateKey: z.string().optional().describe("内置模板 key，见 list_templates"),
      templateId: z.string().optional().describe("「我的模板」的 key（tpl_ 开头），与 templateKey 二选一"),
      name: z.string().optional().describe("工程名，不传用模板名"),
    },
    run: async (a) => {
      if (!a.templateKey && !a.templateId) {
        throw new Error("templateKey 与 templateId 至少给一个（先用 list_templates 看有哪些）");
      }
      const { project } = await api<{ project: ProjectLite }>("/api/projects/from-template", {
        method: "POST",
        body: JSON.stringify({ templateKey: a.templateKey, templateId: a.templateId, name: a.name }),
      });
      setCurrentProject(project.id); // 新建的工程就是当前工程：后续无 projectId 的调用都落在它上面
      return `已创建工程「${project.name}」（id=${project.id}，${project.scenes.length} 个场景），并已切换为当前工程。\n场景清单：\n${project.scenes
        .map((s, i) => `  ${i + 1}. ${s.name}（${s.type}）${s.durationInFrames}帧 id=${s.id}`)
        .join("\n")}` + `\n下一步：save_brief 接单——先问用户必填项（目标/时长/画幅/配音/交付），不能自己定；Reel Read 结构见 get_guide("director")`;
    },
  },
  {
    name: "list_projects",
    description:
      "列出所有工程（id / 名称 / 场景数 / 版本号），并标出当前默认工程。用户说「继续做上次的片子」或不确定在哪个工程上干活时先调它，再用 switch_project 切换。",
    shape: {},
    run: async () => {
      refreshPointer(); // 另一个通道可能刚切过工程
      const { projects } = await api<{ projects: { id: string; name: string; rev: number; scenes: number }[] }>(
        "/api/projects",
      );
      if (!projects.length) return "还没有任何工程。用 create_project 新建。";
      // 指针为空 **或指向已删工程** 都要自愈并写回，否则这里永远标不出 ★、
      // get_project 每次读都静默换一个工程（N-04 残留：旧写法只判断了「指针为空」）
      if (!projects.some((p) => p.id === lastProjectId)) {
        setCurrentProject(projects[0].id);
      }
      const nl = String.fromCharCode(10);
      return (
        `共 ${projects.length} 个工程（★ = 当前默认工程）：` +
        nl +
        projects
          .map(
            (p) =>
              `${p.id === lastProjectId ? "★" : " "} ${p.name}（id=${p.id}，${p.scenes} 场景，rev=${p.rev}）`,
          )
          .join(nl)
      );
    },
  },
  {
    name: "switch_project",
    description:
      "切换当前默认工程：之后不带 projectId 的调用都作用于它。传 list_projects 里的工程 id。带 projectId 参数的调用不受影响（显式指定总是优先）。",
    shape: {
      projectId: z.string().describe("要切换到的工程 id（list_projects 里查）"),
    },
    run: async (a) => {
      const { project } = await api<{ project: ProjectLite }>(`/api/projects/${a.projectId}`);
      setCurrentProject(project.id);
      const nl = String.fromCharCode(10);
      return (
        `当前工程已切换为「${project.name}」（id=${project.id}，${project.scenes.length} 场景，rev=${project.rev}）。` +
        nl +
        `之后不带 projectId 的读写都落在它上面；带 projectId 的调用以显式指定为准。`
      );
    },
  },
  {
    name: "save_template",
    description:
      "把当前工程存成「我的模板」（整片快照：场景、画幅、主题、素材位置都保留），之后可用 create_project 的 templateId 复用。用户说\"把这条存成模板\"时用。",
    shape: {
      name: z.string().describe("模板名"),
      description: z.string().optional().describe("模板说明（适合什么内容），不传自动生成"),
      tags: z
        .array(z.string())
        .optional()
        .describe("2-4 个关键词，如 口播/数据/快节奏，方便之后 list_templates 过滤"),
      projectId: z.string().optional().describe("要存成模板的工程 id，不传用列表第一个"),
    },
    run: async (a) => {
      const project = await resolveProject(a.projectId);
      const { template } = await api<{ template: any }>("/api/templates", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          name: a.name,
          description: a.description,
          tags: a.tags,
        }),
      });
      return `已把工程「${project.name}」存成模板「${template?.name ?? a.name}」（templateId=${template?.key ?? "?"}，${template?.sceneCount ?? project.scenes.length} 个场景）。之后 create_project 传这个 templateId 即可。`;
    },
  },
  {
    name: "list_scene_types",
    description:
      "列出所有可用的场景类型，以及每种类型的字段、含义、取值范围和默认时长。改动项目之前先调用一次；只要速览时传 summary=true。",
    shape: {
      summary: z.boolean().optional().describe("只列类型 + 一句话 + 字段名（不展开字段说明，省 token）"),
    },
    run: async (a: { summary?: boolean }) => {
      const { types } = await api<{ types: any[] }>("/api/scene-types");
      if (a.summary) {
        return types
          .map(
            (t: any) =>
              `- ${t.type}（${t.name}）：${t.summary ?? ""} · ${t.fields
                .map((f: any) => {
                  if (f.kind === "array" && Array.isArray(f.itemShape) && f.itemShape.length) {
                    return `${f.key}[{${f.itemShape.map((x: any) => x.key).join(", ")}}]`;
                  }
                  return f.key;
                })
                .join("/")}`,
          )
          .join(String.fromCharCode(10));
      }
      return types
        .map((t) => {
          const shapeOf = (f: any): string => {
            // 数组字段把元素形状打出来，省得 agent 两次 zod 报错才摸到 key
            if (f.kind !== "array" || !Array.isArray(f.itemShape) || !f.itemShape.length) return "";
            const keys = f.itemShape
              .map((x: any) => `${x.key}${x.kind === "enum" ? `(${x.options.join("|")})` : ""}`)
              .join(", ");
            return ` 形状=[{${keys}}]`;
          };
          const fields = t.fields
            .map((f: any) => {
              const kind = f.kind === "enum" ? `(${f.options.join("|")})` : `(${f.kind})`;
              const dv = f.default !== undefined ? ` 默认=${JSON.stringify(f.default)}` : "";
              return `    - ${f.key} ${kind}${dv}${shapeOf(f)}：${f.label}`;
            })
            .join("\n");
          const els = (t.elements ?? []).length
            ? "\n  可拖动元素：" +
              t.elements.map((e: any) => `${e.id}（${e.label}）`).join("、")
            : "";
          return `${t.type} · ${t.name}：${t.summary}\n  时长 ${t.duration.min}-${t.duration.max} 帧，默认 ${t.duration.default}${els}\n${fields}`;
        })
        .join("\n\n");
    },
  },
  {
    name: "get_project",
    description:
      "获取工程摘要：画幅、总时长、场景列表（含 id/类型/时长/文案摘要）。不含完整 props。要看某个场景的 props 用 get_scene；只有特殊需要才 detail=full。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("summary=摘要（默认，省 token）；full=完整 JSON（含全部 props，很费 token）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      return a.detail === "full" ? JSON.stringify(p) : brief(p);
    },
  },
  {
    name: "get_scene",
    description: "获取单个场景的完整 props。",
    shape: { sceneId: z.string(), projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const s = p.scenes.find((x) => x.id === a.sceneId);
      if (!s) throw new Error(`找不到场景 ${a.sceneId}`);
      return JSON.stringify(s, null, 2);
    },
  },
  {
    name: "add_scene",
    description:
      "新增一个场景。type 必须是 list_scene_types 返回的类型；props 只需给出想覆盖的字段，其余用默认值。元素 durationInFrames 是「出现多久」，不传或 -1 = 撑到场景结尾；想要独特排版用 type=\"freeform\"（写法见 get_guide(\"freeform\")）。返回新场景 id。",
    shape: {
      type: z.string(),
      props: z.record(z.any()).optional(),
      afterSceneId: z.string().optional().describe("插到该场景之后；省略则加到末尾"),
      name: z.string().optional(),
      durationInFrames: z.number().optional(),
      start: z.number().optional().describe("绝对起始帧；省略=接在同轨上一块之后"),
      track: z.number().optional().describe("轨道号，0=主轨；画中画用 1"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [
            {
              op: "add_scene",
              type: a.type,
              props: a.props,
              afterSceneId: a.afterSceneId,
              name: a.name,
              durationInFrames: a.durationInFrames,
              start: a.start,
              track: a.track,
            },
          ],
        }),
      });
      return `已创建场景 id=${res.createdSceneIds[0]}\n${res.summary.join("；")}\n\n${brief(res.project)}`;
    },
  },
  {
    name: "update_scene",
    description:
      "局部更新场景：只传要改的 props 字段即可，会和现有值合并（不是整份替换）。",
    shape: {
      sceneId: z.string(),
      props: z.record(z.any()).optional(),
      name: z.string().optional(),
      durationInFrames: z.number().optional(),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [
            {
              op: "update_scene",
              sceneId: a.sceneId,
              patch: { props: a.props, name: a.name, durationInFrames: a.durationInFrames },
            },
          ],
        }),
      });
      return `${res.summary.join("；")}\nrev=${res.project.rev}`;
    },
  },
  {
    name: "set_scene_type",
    description:
      "换场景版式（不改场景 id、不删场景，旁白元素也不会丢）。props 按同名 key 迁移：新版式认识的字段保留，不认识的丢弃，新版式缺少的必填字段用默认值补上——丢弃和补上的字段都会在返回里列明。换版式后建议 preview_frame 抽一帧看排版。",
    shape: {
      sceneId: z.string(),
      type: z.string().describe("目标版式，见 list_scene_types"),
      props: z.record(z.any()).optional().describe("迁移后额外覆盖的字段"),
      durationInFrames: z
        .number()
        .int()
        .optional()
        .describe("换版式同时改时长（帧），省一次 update_scene"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [
            {
              op: "set_scene_type",
              sceneId: a.sceneId,
              type: a.type,
              ...(a.props ? { props: a.props } : {}),
              ...(a.durationInFrames !== undefined
                ? { durationInFrames: a.durationInFrames }
                : {}),
            },
          ],
        }),
      });
      return `${res.summary.join("\n")}\nrev=${res.project.rev}`;
    },
  },
  {
    name: "set_scene_timing",
    description: "单独调整某个场景的停留时长（帧）。30 帧 = 1 秒。",
    shape: { sceneId: z.string(), durationInFrames: z.number(), projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "set_scene_timing", sceneId: a.sceneId, durationInFrames: a.durationInFrames }],
        }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "move_scene",
    description:
      "把一幕放到时间轴的绝对帧 / 某条轨道上（多轨剪辑台：轨道 0 = 主轨，1 以上叠在上面，可缩成小窗做画中画）。" +
      "同轨不允许重叠，撞到别的块会自动往后吸附，实际落点写在返回值里。只改时间不改内容。",
    shape: {
      sceneId: z.string(),
      start: z.number().describe("绝对起始帧（整条时间轴，不是场景内偏移）"),
      track: z.number().optional().describe("轨道号，0=主轨；省略=保持原轨道"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "move_scene", sceneId: a.sceneId, start: a.start, track: a.track }],
        }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "set_scene_box",
    description:
      "把一幕缩成小窗（画中画）。x/y 是画面百分比、按**中心点**定位（50/50 = 正中），scale=1 是全屏、0.34 约等于三分之一大小。" +
      "配合 move_scene 把它放到别的轨道同一时间段，就得到画中画。传 reset=true 恢复全屏。",
    shape: {
      sceneId: z.string(),
      x: z.number().optional().describe("中心 x（画面百分比 0-100，默认 50）"),
      y: z.number().optional().describe("中心 y（画面百分比 0-100，默认 50）"),
      scale: z.number().optional().describe("缩放 0.05-1，1 = 全屏"),
      rotate: z.number().optional().describe("旋转角度"),
      radius: z.number().optional().describe("圆角（画面短边百分比，画中画常用 2-4）"),
      opacity: z.number().optional().describe("不透明度 0-1"),
      shadow: z.boolean().optional().describe("投影，默认开"),
      reset: z.boolean().optional().describe("true = 恢复全屏"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const box = a.reset
        ? null
        : {
            ...(a.x === undefined ? {} : { x: a.x }),
            ...(a.y === undefined ? {} : { y: a.y }),
            ...(a.scale === undefined ? {} : { scale: a.scale }),
            ...(a.rotate === undefined ? {} : { rotate: a.rotate }),
            ...(a.radius === undefined ? {} : { radius: a.radius }),
            ...(a.opacity === undefined ? {} : { opacity: a.opacity }),
            ...(a.shadow === undefined ? {} : { shadow: a.shadow }),
          };
      if (box !== null && !Object.keys(box).length) {
        throw new Error(
          "没有给出任何画面框参数（x/y/scale/radius/rotate/opacity/shadow）。要恢复全屏请传 reset:true",
        );
      }
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "set_scene_box", sceneId: a.sceneId, box }] }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "apply_ops",
    description:
      "批量执行多个操作（一次调用完成整幕或整章的搭建，省掉几十次往返）。ops 是数组，每项 {op: 操作名, ...参数}。\n" +
      "**两种写法都认，不用记两套形状**：\n" +
      "  ① 单工具形状（扁平，直接照抄 add_element 的字段）：{op:'add_element', sceneId, text:'光晕', x:50, y:50, opacity:0.6}\n" +
      "  ② op 形状（包裹）：{op:'add_element', sceneId, element:{kind:'text', text:'光晕', x:50, y:50}}\n" +
      "  update_element 同理：{op:'update_element', sceneId, elementId, opacity:0.5} 或 {..., patch:{opacity:0.5}}。\n" +
      "可用操作：add_scene / update_scene / set_scene_timing / set_scene_type / set_transform / add_element / update_element / " +
      "remove_element / add_freeform_element / update_freeform_element / remove_freeform_element / remove_scene / duplicate_scene / reorder_scenes / compact_main_track / move_scene / set_scene_box / set_theme / set_audio / add_audio_track / " +
      "update_audio_track / remove_audio_track / add_effect / update_effect / remove_effect / set_formats / update_project / restore。\n" +
      "freeform 场景的元素（svg 图形 / fx 氛围层 / 带 anim 关键帧的）走 add_freeform_element：" +
      "{op:'add_freeform_element', sceneId, element:{type:'svg', svg:'…', viewBox:'0 0 920 420', x:50, y:47}}，扁平字段也会自动包裹；" +
      "注意叠加层（add_element）不支持 anim 和 fx，塞了会被丢弃并在 summary 里警告。\n" +
      "批量转场用 set_transitions（复数，给全部或指定场景套同一套）：{op:'set_transitions', type:'fade', durationInFrames:12, direction:'in'}，" +
      "direction 可选 in/out/both，sceneIds 不传=全部场景。\n" +
      "重要：整批是**原子**的——任何一个操作失败，整批都不生效（不会出现改了一半的工程）。" +
      "失败会明确报「第 N 个操作（op 名）失败：缺哪个字段 / 哪个值越界」。\n" +
      "注意：add_scene / add_element 生成的 id 是随机的，同一批里没法引用；" +
      "需要按 id 继续改的请分两批（先加，get_project 读回 id，再改）。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      ops: z
        .array(z.record(z.any()))
        .min(1)
        .describe("操作数组，每项形如 {op:'add_scene', type:'title', props:{...}}"),
      quiet: z.boolean().optional().describe("只回一行摘要，不列每一项（省 token）"),
    },
    run: async (a) => {
      const before = await resolveProject(a.projectId);
      const p = before;
      // 归一化：单工具形状（扁平字段）和 op 形状（element/patch 包裹）**两种写法都认**，
      // 缺字段时在这里就报出「第 N 个操作缺什么」，不用等 zod 吐一堆 JSON
      const normalized = await normalizeOps(a.ops as Record<string, unknown>[], before);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: normalized }),
      });
      // 批量 add_scene / add_element 生成的 id 是随机的，这里把新增的 id 回给 agent，
      // 省掉"先加再 get_project 找 id"的往返
      const prevScenes = new Set((before.scenes ?? []).map((x: any) => x.id));
      const prevEls = new Set(
        (before.scenes ?? []).flatMap((x: any) => (x.elements ?? []).map((e: any) => e.id)),
      );
      const added: string[] = [];
      for (const sc of res.project.scenes ?? []) {
        if (!prevScenes.has(sc.id)) added.push(`场景 ${sc.id}「${sc.name ?? sc.type}」`);
        for (const el of sc.elements ?? []) {
          if (!prevEls.has(el.id)) added.push(`元素 ${el.id}「${el.name ?? ""}」`);
        }
      }
      const addedText = added.length ? `${String.fromCharCode(10)}新增：${added.join("、")}` : "";
      if (a.quiet) {
        // quiet 只压掉成功项的逐条摘要，⚠️ 警告必须保留
        const warns = (res.summary as string[]).filter((line) => line.includes("⚠"));
        const nl2 = String.fromCharCode(10);
        return (
          `已执行 ${a.ops.length} 个操作，rev=${res.project.rev}${addedText}` +
          (warns.length ? `${nl2}${warns.join(nl2)}` : "")
        );
      }
      const nl = String.fromCharCode(10);
      return `已执行 ${a.ops.length} 个操作${nl}${res.summary.join(nl)}${nl}rev=${res.project.rev}${addedText}`;
    },
  },
  {
    name: "reorder_scenes",
    description: "重排场景顺序。sceneIds 必须是全部场景 id 的完整顺序。",
    shape: { sceneIds: z.array(z.string()), projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "reorder_scenes", sceneIds: a.sceneIds }] }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "remove_scene",
    description: "删除场景。",
    shape: { sceneId: z.string(), projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "remove_scene", sceneId: a.sceneId }] }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "duplicate_scene",
    description:
      "复制一个场景（含 props），副本插在原场景之后。传 props 可只改副本的文案字段（A/B 版本：同一版式两套文案），传 name 改副本名。",
    shape: {
      sceneId: z.string(),
      props: z
        .record(z.any())
        .optional()
        .describe("覆盖副本的 props 字段（只改传的字段），如 {title:'另一个标题'}"),
      name: z.string().optional().describe("副本名"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "duplicate_scene", sceneId: a.sceneId }] }),
      });
      const newId = res.createdSceneIds?.[0];
      if (!newId) throw new Error("复制失败：没有拿到副本 id");
      if (a.props || a.name) {
        await api(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({
            actor: "agent",
            ops: [
              {
                op: "update_scene",
                sceneId: newId,
                patch: {
                  ...(a.name ? { name: a.name } : {}),
                  ...(a.props ? { props: a.props } : {}),
                },
              },
            ],
          }),
        });
      }
      const changed = a.props ? "（已覆盖文案字段）" : "";
      return `副本 id=${newId}${a.name ? `「${a.name}」` : ""}${changed}`;
    },
  },
  {
    name: "set_transform",
    description:
      "拖动 / 旋转 / 缩放场景里的某个元素，也可调图层顺序。x、y 是相对画面宽高的百分比偏移（不是像素），rotate 是角度，scale 是倍数，layer 是层级（>=0，越大越靠前）；元素 id 见 list_scene_types 的「可拖动元素」。传 reset:true 恢复模板排版。",
    shape: {
      sceneId: z.string(),
      target: z.string().optional().describe("元素 id，如 title / subtitle / item1（与 elementId 二选一，都传以 target 为准）"),
      elementId: z.string().optional().describe("同 target（别名，兼容不同叫法）"),
      x: z.number().optional().describe("水平偏移（画面宽度百分比，正数向右）"),
      y: z.number().optional().describe("垂直偏移（画面高度百分比，正数向下）"),
      rotate: z.number().optional().describe("旋转角度"),
      scale: z.number().optional().describe("缩放倍数，1 为原始大小"),
      layer: z.number().int().min(0).optional().describe("图层顺序，0 为模板默认层，越大越靠前；不能为负（负值会掉到背景下面）"),
      reset: z.boolean().optional().describe("true 则清除该元素的偏移，回到模板位置"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const target = a.target ?? a.elementId;
      if (!target) {
        throw new Error(
          `缺少 target（元素 id）。注意参数名是 target 不是 elementId——不过 elementId 也认；` +
            `叠加层自由元素请改用 update_element 设 x/y/scale/rotate`,
        );
      }
      const p = await resolveProject(a.projectId);
      const patch = a.reset
        ? null
        : Object.fromEntries(
            (
              [
                ["x", a.x],
                ["y", a.y],
                ["rotate", a.rotate],
                ["scale", a.scale],
                ["z", a.layer],
              ] as const
            ).filter(([, v]) => v !== undefined),
          );
      if (patch !== null && !Object.keys(patch).length) {
        return "没有给出任何偏移量。要复位请传 reset:true。";
      }
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "set_transform", sceneId: a.sceneId, target, transform: patch }],
        }),
      });
      return res.summary?.join("；") ?? "已更新元素位置";
    },
  },
  {
    name: "set_transition",
    description:
      "设置场景的入场或出场转场。direction 默认 in；type 可选 none / fade / slide / wipe / zoom / blur / flip / circle；duration 建议 8-20 帧。",
    shape: {
      sceneId: z.string(),
      type: z.enum(TRANSITION_TYPES),
      durationInFrames: z.number().optional(),
      direction: z.enum(["in", "out"]).optional().describe("in=入场（默认），out=出场"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const t =
        a.type === "none" ? null : { type: a.type, durationInFrames: a.durationInFrames ?? 12 };
      const patch = a.direction === "out" ? { transitionOut: t } : { transitionIn: t };
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "update_scene", sceneId: a.sceneId, patch }],
        }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "set_transitions",
    description:
      "批量设置转场（复数）：给**所有场景**或指定场景套同一套入/出场转场，一次调用搞定（不用每幕调两次 set_transition）。" +
      "direction=both 时入出场都设；type=none 清除该方向的转场。",
    shape: {
      type: z.enum(TRANSITION_TYPES).describe("转场类型；none=清除"),
      durationInFrames: z.number().int().min(0).max(120).optional().describe("转场时长（帧），默认 12"),
      direction: z.enum(["in", "out", "both"]).optional().describe("in=入场（默认），out=出场，both=两者都设"),
      sceneIds: z.array(z.string()).optional().describe("只设这些场景；不传=全部场景"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      if (!p.scenes.length) throw new Error("工程里还没有场景");
      const t = a.type === "none" ? null : { type: a.type, durationInFrames: a.durationInFrames ?? 12 };
      const dir = a.direction ?? "in";
      const patch =
        dir === "out"
          ? { transitionOut: t }
          : dir === "both"
            ? { transitionIn: t, transitionOut: t }
            : { transitionIn: t };
      const ids: string[] = a.sceneIds?.length ? a.sceneIds : p.scenes.map((s) => s.id);
      const known = new Set(p.scenes.map((s) => s.id));
      const unknown = ids.filter((id) => !known.has(id));
      if (unknown.length) throw new Error(`找不到场景：${unknown.join("、")}`);
      const ops = ids.map((sceneId) => ({ op: "update_scene", sceneId, patch }));
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      const dirLabel = dir === "out" ? "出场" : dir === "both" ? "入/出场" : "入场";
      const what = a.type === "none" ? "清除" : `${a.type} ${a.durationInFrames ?? 12} 帧`;
      return `已给 ${ids.length} 个场景设置${dirLabel}转场（${what}），rev=${res.project.rev}`;
    },
  },
  {
    name: "set_audio",
    description:
      `设置或调整背景音乐。src 用 /assets/xxx.mp3 或公网 URL；**volume 0-${MAX_VOLUME}（1 = 原音，>1 是放大，上限约 +14 dB）**；` +
      "fadeIn/fadeOut 单位秒；from 为起始帧、durationInFrames 为播放长度（帧）、loop 循环。" +
      "**只传要改的字段即可**（其余沿用现有值）。ducking 做人声避让：有人说话时自动把 BGM 压下去。清除背景音乐用 clear=true。\n" +
      "放大到会削波时会在回执里警告（读了文件峰值算的），别忽略。",
    shape: {
      src: z.string().optional(),
      volume: z.number().min(0).max(MAX_VOLUME).optional().describe("音量：1 = 原音，可到 5（+14 dB）"),
      fadeIn: z.number().optional(),
      fadeOut: z.number().optional(),
      from: z.number().int().min(0).optional().describe("从第几帧开始播"),
      durationInFrames: z.number().int().min(1).optional().describe("播放长度（帧），不传=到片尾"),
      loop: z.boolean().optional().describe("是否循环"),
      ducking: z
        .union([
          z.boolean(),
          z.object({
            enabled: z.boolean().optional(),
            depth: z.number().min(0).max(1).optional().describe("人声期间 BGM 降到原音量的倍数，0.3 = 30%"),
            attackMs: z.number().min(0).optional().describe("压下去用多久（毫秒，默认 120）"),
            releaseMs: z.number().min(0).optional().describe("升回来用多久（毫秒，默认 260）"),
            padMs: z.number().min(0).optional().describe("人声区间前后余量（毫秒，默认 60）"),
          }),
        ])
        .optional()
        .describe("人声避让：true=开启（30%）、false=关闭、对象=细化参数。不传则保持现状"),
      clear: z.boolean().optional(),
      clearGainCurve: z.boolean().optional().describe("true = 清掉压缩曲线（恢复原始动态）"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      if (a.clear) {
        const res = await api<any>(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({ actor: "agent", ops: [{ op: "set_audio", audio: null }] }),
        });
        return res.summary.join("；");
      }

      // 只改一部分字段时，其余沿用现有音频 —— 否则"只调音量"会把 fadeIn/loop/避让全部打回默认
      const prev = p.audio;
      const src = a.src ?? prev?.src;
      if (!src) throw new Error("还没有背景音乐：第一次设置需要传 src（/assets/xxx.mp3）");

      const prevDuck = prev?.ducking;
      let ducking: typeof prevDuck;
      if (a.ducking === false) ducking = { ...(prevDuck ?? DEFAULT_DUCKING), enabled: false };
      else if (a.ducking === true) ducking = { ...(prevDuck ?? DEFAULT_DUCKING), enabled: true };
      else if (a.ducking && typeof a.ducking === "object") ducking = { ...(prevDuck ?? DEFAULT_DUCKING), ...a.ducking };
      else ducking = prevDuck; // 没提避让就保持现状（set_audio 是全量替换，漏带会丢配置）

      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [
            {
              op: "set_audio",
              audio: {
                src,
                volume: a.volume ?? prev?.volume ?? 0.8,
                fadeIn: a.fadeIn ?? prev?.fadeIn ?? 0.5,
                fadeOut: a.fadeOut ?? prev?.fadeOut ?? 0.8,
                from: a.from ?? prev?.from ?? 0,
                ...(a.durationInFrames !== undefined || prev?.durationInFrames
                  ? { durationInFrames: a.durationInFrames ?? prev?.durationInFrames }
                  : {}),
                loop: a.loop ?? prev?.loop ?? false,
                ...(ducking ? { ducking } : {}),
                // 压缩曲线默认保留：只调音量不该把 compress_audio 的成果抹掉
                ...(!a.clearGainCurve && prev?.gainCurve ? { gainCurve: prev.gainCurve } : {}),
              },
            },
          ],
        }),
      });
      const lines = [res.summary.join("；")];
      const warn = await clipWarning(src, a.volume ?? prev?.volume ?? 0.8);
      if (warn) lines.push(warn);
      return lines.join(String.fromCharCode(10));
    },
  },
  {
    name: "balance_audio",
    description:
      "**响度配平**：把工程里的音频按角色拉到统一响度，解决「这段声音大、那段声音小」。\n" +
      "角色目标默认：人声（场景内音频元素）-16 LUFS、BGM -23、音效轨 -18；可覆盖。\n" +
      "会读每个源文件的真实响度（LUFS）与峰值，算出增益写回 volume（1 = 原音，可到 5×）。\n" +
      "峰值被限制在 -1dBFS 以下 —— **宁可小声也不爆音**，被峰值卡住时回执会写原因。\n" +
      "dryRun=true 只给方案不落库。配平只看整段平均响度；段内忽大忽小用 compress_audio。",
    shape: {
      scope: z
        .enum(["all", "bgm", "tracks", "elements"])
        .optional()
        .describe("范围：all（默认）/ bgm / tracks（音效轨）/ elements（场景内音频，通常是人声）"),
      voiceLufs: z.number().min(-40).max(-5).optional().describe("人声目标响度（默认 -16）"),
      bgmLufs: z.number().min(-40).max(-5).optional().describe("BGM 目标响度（默认 -23）"),
      sfxLufs: z.number().min(-40).max(-5).optional().describe("音效目标响度（默认 -18）"),
      maxGain: z.number().min(1).max(MAX_VOLUME).optional().describe(`最大放大倍数（默认 ${MAX_VOLUME}）`),
      peakCeilingDb: z.number().max(0).optional().describe("峰值上限 dBFS（默认 -1）"),
      dryRun: z.boolean().optional().describe("true = 只输出方案，不写工程"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const scope = a.scope ?? "all";
      const targets: Record<Role, number> = {
        voice: a.voiceLufs ?? -16,
        bgm: a.bgmLufs ?? -23,
        sfx: a.sfxLufs ?? -18,
      };
      const entries = collectAudioEntries(p, scope);
      if (!entries.length) return `这个工程没有可配平的音频（scope=${scope}）。`;

      // 逐个测：mp3 解码器是有状态单例，并发会串音
      const measured = new Map<string, LoudnessLite | null>();
      for (const e of entries) {
        if (!measured.has(e.src)) measured.set(e.src, await loudnessOf(e.src));
      }

      const rows: string[] = [];
      const ops: Record<string, unknown>[] = [];
      let peakLimited = 0;
      for (const e of entries) {
        const info = measured.get(e.src) ?? null;
        if (!info || !Number.isFinite(info.lufs)) {
          rows.push(`· ${e.label}：读不出响度（公网 URL / 格式不支持），保持原样`);
          continue;
        }
        const d = gainForTarget({
          lufs: info.lufs,
          peakDb: info.peakDb,
          targetLufs: targets[e.role],
          peakCeilingDb: a.peakCeilingDb,
          maxGain: a.maxGain,
        });
        if (d.limitedBy !== "target") peakLimited++;
        const note =
          d.limitedBy === "peak"
            ? `（**峰值限制**：到目标要 ${d.rawGain.toFixed(2)}×，但会超过峰值上限）`
            : d.limitedBy === "max"
              ? `（已到上限 ${MAX_VOLUME}×）`
              : "";
        rows.push(
          `· ${e.label}：${info.lufs} LUFS（峰值 ${info.peakDb}dBFS）→ 目标 ${targets[e.role]}` +
            `，音量 ${Math.round(e.current * 100)}% → ${Math.round(d.gain * 100)}%${note}`,
        );
        if (a.dryRun) continue;
        if (e.kind === "bgm") {
          const cur = p.audio!;
          ops.push({
            op: "set_audio",
            audio: {
              src: cur.src,
              volume: d.gain,
              fadeIn: cur.fadeIn ?? 0,
              fadeOut: cur.fadeOut ?? 0,
              from: cur.from ?? 0,
              ...(cur.durationInFrames ? { durationInFrames: cur.durationInFrames } : {}),
              loop: !!cur.loop,
              ...(cur.ducking ? { ducking: cur.ducking } : {}),
              ...(cur.gainCurve ? { gainCurve: cur.gainCurve } : {}),
            },
          });
        } else if (e.kind === "track") {
          ops.push({ op: "update_audio_track", trackId: e.id, patch: { volume: d.gain } });
        } else {
          ops.push({ op: "update_element", sceneId: e.sceneId, elementId: e.id, patch: { audioVolume: d.gain } });
        }
      }

      const head = a.dryRun ? "配平方案（dryRun，未落库）：" : `已配平 ${ops.length} 处音频：`;
      const tail = peakLimited
        ? `\n有 ${peakLimited} 处被峰值卡住（没到目标响度）。要更响只能换更高质量的源文件，或接受削波（不推荐）。`
        : "";
      if (a.dryRun || !ops.length) return [head, ...rows].join(String.fromCharCode(10)) + tail;

      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      return [head, ...rows, "", res.summary.join("；")].join(String.fromCharCode(10)) + tail;
    },
  },
  {
    name: "compress_audio",
    description:
      "**段内动态压缩**：解决「同一段音频里前面轻、后面响」，把音量起伏压平（BGM 副歌炸、口播忽大忽小）。\n" +
      "做法：按 200ms 测短时响度 → 生成增益曲线存进工程（`gainCurve`）→ 渲染时按帧相乘。\n" +
      "ratio 越大压得越狠（1 = 只做整体增益不压动态，默认 3）。注意补与压是耦合的：ratio 变大时整体增益也会跟着抬。" +
      "曲线会按每个采样点的峰值限幅（输出 ≤ -1dBFS），被夹住多少会写进回执。\n" +
      "只作用于 BGM 与音效轨（元素级用 balance_audio 配平）。clear=true 清掉曲线恢复原始动态。",
    shape: {
      scope: z.enum(["bgm", "tracks", "all"]).optional().describe("作用范围（默认 bgm）"),
      trackId: z.string().optional().describe("scope=tracks 时只处理这一条（不传 = 全部音效轨）"),
      targetLufs: z.number().min(-40).max(-5).optional().describe("目标响度（默认 BGM -23 / 音效 -18）"),
      ratio: z.number().min(1).max(10).optional().describe("压缩比，默认 3；1 = 不压动态"),
      maxGainDb: z.number().min(0).max(24).optional().describe("最多向上补多少 dB（默认 12）"),
      maxCutDb: z.number().min(0).max(24).optional().describe("最多向下压多少 dB（默认 12）"),
      clear: z.boolean().optional().describe("true = 清除增益曲线"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const scope = a.scope ?? "bgm";
      const rows: string[] = [];
      const ops: Record<string, unknown>[] = [];

      const targets: { kind: "bgm" | "track"; id?: string; label: string; src: string; target: number }[] = [];
      if ((scope === "bgm" || scope === "all") && p.audio?.src) {
        targets.push({ kind: "bgm", label: "背景音乐", src: p.audio.src, target: a.targetLufs ?? -23 });
      }
      if (scope === "tracks" || scope === "all") {
        for (const t of p.audioTracks ?? []) {
          if (a.trackId && t.id !== a.trackId) continue;
          targets.push({ kind: "track", id: t.id, label: `音效「${t.name}」`, src: t.src, target: a.targetLufs ?? -18 });
        }
      }
      if (!targets.length) return `没有可压缩的音频（scope=${scope}${a.trackId ? `, trackId=${a.trackId}` : ""}）。`;

      for (const t of targets) {
        if (a.clear) {
          if (t.kind === "bgm") {
            const cur = p.audio!;
            // set_audio 现在是**合并**语义：只传 src + gainCurve:null 就够，其余配置原样留着
            ops.push({ op: "set_audio", audio: { src: cur.src, gainCurve: null } });
          } else {
            ops.push({ op: "update_audio_track", trackId: t.id, patch: { gainCurve: null } });
          }
          rows.push(`· ${t.label}：已清除增益曲线`);
          continue;
        }

        const info = await loudnessOf(t.src);
        if (!info || !info.curve?.length) {
          rows.push(`· ${t.label}：读不出响度曲线，跳过`);
          continue;
        }
        const built = buildCompressCurve(info.curve, {
          targetLufs: t.target,
          ratio: a.ratio,
          maxGainDb: a.maxGainDb,
          maxCutDb: a.maxCutDb,
          maxGain: MAX_VOLUME,
          peakDbCurve: info.peakCurve,
        });
        const values = built.values;
        const st = summarizeCurve(values);
        const curve = {
          stepMs: info.stepMs,
          values,
          targetLufs: t.target,
          ratio: a.ratio ?? 3,
        };
        if (t.kind === "bgm") {
          const cur = p.audio!;
          ops.push({ op: "set_audio", audio: { src: cur.src, gainCurve: curve } });
        } else {
          ops.push({ op: "update_audio_track", trackId: t.id, patch: { gainCurve: curve } });
        }
        rows.push(
          `· ${t.label}：原始 ${info.lufs} LUFS → 目标 ${t.target}，` +
            `增益 ${Math.round(st.min * 100)}%–${Math.round(st.max * 100)}%（均值 ${Math.round(st.avg * 100)}%），` +
            `${values.length} 个采样点 @${info.stepMs}ms`,
        );
        // 夹取必须写进回执（N-13 的原则）：否则用户只会觉得「调了 ratio 没反应」
        if (built.peakLimited) {
          rows.push(
            `  ⚠ ${built.peakLimited} 个采样点被峰值卡住（输出不超过 -1dBFS，素材峰值 ${info.peakDb}dBFS）：` +
              `这些点没补到目标，再抬就削波了`,
          );
        }
        if (built.cutLimited) {
          rows.push(
            `  ⚠ ${built.cutLimited} 个采样点已压到 maxCutDb（${a.maxCutDb ?? 12}dB）下限，` +
              `ratio 再大也不会更平；想更平请调大 maxCutDb`,
          );
        }
        if (built.gainLimited) {
          rows.push(
            `  ⚠ ${built.gainLimited} 个采样点已补到 maxGainDb（${a.maxGainDb ?? 12}dB）上限，再补要调大 maxGainDb`,
          );
        }
      }

      if (!ops.length) return rows.join(String.fromCharCode(10));
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      const advice = a.clear
        ? ""
        : "\n提示：压缩只改**起伏**，不改整段平均响度；但补与压是耦合的——ratio 越大，整体增益也会跟着抬（实测同一条素材 1→3→10 时均值 69%→119%→167%）。" +
          "整体偏小请先用 balance_audio 定基调，再用这个压动态。";
      return [rows.join(String.fromCharCode(10)), "", res.summary.join("；")].join(String.fromCharCode(10)) + advice;
    },
  },
  {
    name: "analyze_audio",
    description:
      "分析音频的 BPM 与拍点（卡点用）。src 给 /assets/xxx.mp3 或 wav；返回 BPM、置信度、拍点帧号。\n" +
      "**置信度 < 2.5 表示检测不可信**（纯人声/无鼓/氛围音乐），这时别自动卡点，直接问用户 BPM 再用 set_beat_grid。\n" +
      "save=true 会把结果写进工程的节拍网格（之后 get_project 能看到）。只解析 wav/mp3。",
    shape: {
      src: z.string().optional().describe("音频地址，如 /assets/bgm.mp3（list_assets 里查）"),
      assetId: z.string().optional().describe("素材库条目 id，与 src 二选一"),
      maxSeconds: z.number().optional().describe("只分析前 N 秒（默认 90）——BPM 全曲一致，长音频没必要全扫"),
      save: z.boolean().optional().describe("true = 结果写入工程节拍网格"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      let src = a.src;
      if (!src && a.assetId) {
        const { items } = await api<{ items: { id: string; url: string; name: string }[] }>("/api/library");
        const hit = items.find((x) => x.id === a.assetId);
        if (!hit) throw new Error(`素材库里没有 ${a.assetId}（用 list_assets 查）`);
        src = hit.url;
      }
      if (!src) throw new Error("需要传 src 或 assetId（音频要在 public/assets 里）");

      const nl = String.fromCharCode(10);
      // 响度先测：它对人声/纯音乐都有意义，而 BPM 对无鼓素材本来就测不出来
      const loud = await loudnessOf(src);
      const loudLine = loud
        ? `响度：${loud.lufs} LUFS（峰值 ${loud.peakDb}dBFS，RMS ${loud.rmsDb}dBFS，${loud.durationSec.toFixed(1)}s）` +
          `　配平参考：人声 -16 / BGM -23 / 音效 -18 LUFS`
        : null;

      // 走服务端算：essentia 的 WASM 只在服务进程加载一次，代理进程保持轻量
      let r: Awaited<ReturnType<typeof analyzeBeats>>;
      try {
        r = (
          await api<{ result: Awaited<ReturnType<typeof analyzeBeats>> }>("/api/audio/analyze", {
            method: "POST",
            body: JSON.stringify({ src, maxSeconds: a.maxSeconds, fps: p.fps }),
          })
        ).result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [loudLine, `BPM/拍点检测失败：${msg}`, "（响度仍然可用：配平用 balance_audio，手动 BPM 用 set_beat_grid）"]
          .filter(Boolean)
          .join(nl);
      }
      const reliable = r.confidence >= BEAT_CONFIDENCE_MIN;
      const beatsPreview = r.beatsFrames.slice(0, 16);
      const lines = [
        `「${src}」 ${r.durationSec.toFixed(2)}s（分析了前 ${r.analyzedSec.toFixed(1)}s）${r.cached ? " · 命中缓存" : ""}`,
        `BPM：${r.bpm}　置信度：${r.confidence}（${reliable ? "可信" : `低于 ${BEAT_CONFIDENCE_MIN}，不可信`}）`,
        `拍点 ${r.beats.length} 个（帧）：${beatsPreview.join(", ")}${r.beats.length > beatsPreview.length ? " …" : ""}`,
      ];
      if (loudLine) lines.splice(1, 0, loudLine);
      if (!reliable) {
        lines.push(
          "⚠️ 这段音频没有清晰的鼓点，BPM 不可信。**不要拿它自动卡点** —— 问用户这首歌的 BPM，" +
            `再用 set_beat_grid(bpm=...) 手动建网格。`,
        );
      } else {
        lines.push(
          "下一步：把转场/特效对齐到拍点，例如 set_transition(durationInFrames 落在拍点附近)、" +
            "或 add_effect(from=拍点帧)。要固定这套网格就再调一次 save=true。",
        );
      }
      if (a.save && reliable) {
        const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({
            actor: "agent",
            ops: [
              {
                op: "set_beat_grid",
                grid: {
                  bpm: r.bpm,
                  offsetSec: Math.round((r.beats[0] ?? 0) * 1000) / 1000,
                  source: "auto",
                  src,
                  confidence: r.confidence,
                },
              },
            ],
          }),
        });
        lines.push(res.summary.join("；"));
      } else if (a.save && !reliable) {
        lines.push("（置信度不足，没有写入节拍网格）");
      }
      return lines.join(nl);
    },
  },
  {
    name: "set_beat_grid",
    description:
      "手动设置节拍网格（用户告诉你 BPM 时用这个，比自动检测可靠）。存 BPM + 首拍偏移，拍点由它们现算。\n" +
      "之后用 get_project 能看到 beatGrid；对齐转场/特效时按这个 BPM 算帧号。clear=true 清除。",
    shape: {
      bpm: z.number().min(20).max(300).optional().describe("每分钟拍数"),
      offsetSec: z.number().optional().describe("第一拍在片头的第几秒（默认 0；第一拍在片头之前可给负数）"),
      clear: z.boolean().optional().describe("true = 清除节拍网格"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const total = totalDuration(p as never);
      if (a.clear) {
        const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({ actor: "agent", ops: [{ op: "set_beat_grid", grid: null }] }),
        });
        return res.summary.join("；");
      }
      if (a.bpm === undefined) throw new Error("需要传 bpm（或用 clear=true 清除）");
      const grid = { bpm: a.bpm, offsetSec: a.offsetSec ?? 0, source: "manual" as const };
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "set_beat_grid", grid }] }),
      });
      const frames = beatFrames(grid, total / p.fps, p.fps);
      const nl = String.fromCharCode(10);
      return (
        res.summary.join("；") +
        `${nl}全片 ${frames.length} 拍，前 12 拍帧号：${frames.slice(0, 12).join(", ")}` +
        `${nl}用法：转场/特效的 from 对着这些帧号放，就是卡点。`
      );
    },
  },
  {
    name: "tts_check",
    description:
      "语音服务预检。默认只探连通性（快）；deep=true 会真合成一句极短语音，验证 key/model/voice/format 全对（约 1–3 秒，产物不留）。\n" +
      "**开工做配音之前先调它**，比跑到第 6 步才发现服务没启动便宜得多。",
    shape: {
      deep: z.boolean().optional().describe("true = 连真合成一起验"),
    },
    run: async (a) => {
      // 失败时也要拿到 stage（api() 只抛 error 文本），所以这里自己发请求
      await ensureServer();
      const res = await fetch(`${BASE}/api/tts/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deep: !!a.deep }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, any>;
      const nl = String.fromCharCode(10);
      if (!data.ok) {
        const stageTip: Record<string, string> = {
          config: "配置问题：用 get_tts_config 看当前地址，set_tts_config 改",
          reach: "服务没起来：先把本地 TTS 服务拉起来再重试",
          synth: "服务在跑但合成失败：多半是 model / voice / format 名字不对，或用 set_tts_config 检查 apiKey",
        };
        return (
          `❌ 预检失败（阶段：${data.stage}）${nl}${data.error}` +
          (stageTip[data.stage] ? `${nl}建议：${stageTip[data.stage]}` : "")
        );
      }
      if (data.stage === "reach") {
        return (
          `✅ 服务可达：${data.origin}（HEAD ${data.status}，${data.reachMs}ms）${nl}` +
          `${data.detail}${nl}要确认配置真的对，再调一次 deep=true。`
        );
      }
      return (
        `✅ 语音服务可用（完整链路）${nl}` +
        `地址：${data.origin}　连通 ${data.reachMs}ms　合成 ${data.synthMs}ms${nl}` +
        `音色：${data.voice ?? "默认"}　模型：${data.model ?? "默认"}　产出 ${data.bytes} 字节 ${data.format}（预检文件已清理）`
      );
    },
  },
  {
    name: "add_audio_track",
    description:
      "叠加一条音效轨（背景音乐之外）：转场音、提示音、口播点缀。src 用 /assets/xxx（先 upload_asset 传音频），from 是从第几帧开始。",
    shape: {
      src: z.string().describe("/assets/xxx 音频地址"),
      name: z.string().optional().describe("音效名，默认「音效」"),
      from: z.number().int().min(0).optional().describe("从第几帧开始，默认 0"),
      volume: z.number().min(0).max(MAX_VOLUME).optional().describe("音量：1 = 原音，可到 5（+14 dB）"),
      fadeIn: z.number().min(0).optional().describe("淡入秒数"),
      durationInFrames: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("音效轨长度（帧），不传按素材真实时长"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const clip: Record<string, unknown> = { src: a.src };
      if (a.name !== undefined) clip.name = a.name;
      if (a.from !== undefined) clip.from = a.from;
      if (a.volume !== undefined) clip.volume = a.volume;
      if (a.fadeIn !== undefined) clip.fadeIn = a.fadeIn;
      const trackFrames =
        a.durationInFrames ?? (await probedDurationFrames(a.src, p.fps ?? 30));
      if (trackFrames) clip.durationInFrames = trackFrames;
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "add_audio_track", clip }] }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "update_audio_track",
    description: "修改某条音效轨的起点 / 音量 / 淡入 / 名称。trackId 见 get_project 里的音效轨列表。",
    shape: {
      trackId: z.string(),
      from: z.number().int().min(0).optional(),
      volume: z.number().min(0).max(MAX_VOLUME).optional().describe("音量：1 = 原音，可到 5（+14 dB）"),
      fadeIn: z.number().min(0).optional(),
      name: z.string().optional(),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const patch: Record<string, unknown> = {};
      for (const k of ["from", "volume", "fadeIn", "name"] as const) {
        if (a[k] !== undefined) patch[k] = a[k];
      }
      if (!Object.keys(patch).length) throw new Error("没有任何要改的字段");
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "update_audio_track", trackId: a.trackId, patch }] }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "remove_audio_track",
    description: "删除一条音效轨（背景音乐不受影响）。",
    shape: { trackId: z.string(), projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "remove_audio_track", trackId: a.trackId }] }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "list_effect_types",
    description:
      "列出所有特效类型 + 每种类型**可调参数**（键名 / 范围 / 默认值），以及自定义特效的关键帧 DSL。" +
      "调 add_effect / update_effect 之前先看一遍，比猜参数名快得多。" +
      "想做出内置特效做不出的效果（多段节奏、先拉远再急推、边闪边推…）就用 kind=custom 传 custom.keys。",
    shape: {
      kind: z.string().optional().describe("只看某一种类型（如 shake）；不传则全部"),
    },
    run: async (a) => {
      await ensureServer();
      const lines: string[] = [];
      for (const o of EFFECT_OPTIONS) {
        if (a.kind && o.key !== a.kind) continue;
        lines.push(`【${o.key}】${o.label} — ${o.hint}（默认 ${o.defaultDuration} 帧）`);
        const ps = effectParamsOf(o.key);
        if (!ps.length) {
          lines.push("  参数：无（用 custom.keys 自定义关键帧）");
        } else {
          lines.push(
            "  参数：" +
              ps
                .map(
                  (p) =>
                    `${p.key}（${p.label} ${p.min}~${p.max}${p.unit ?? ""}，默认 ${p.def}${p.hint ? `，${p.hint}` : ""}）`,
                )
                .join("；"),
          );
        }
      }
      if (!a.kind || a.kind === "custom") {
        lines.push(
          "【custom 关键帧 DSL】custom.keys = 关键帧数组（1~32 个，不必排序）：",
          "  每个关键帧：{ p: 0~1（区间内进度，不是帧号）, ease?: " +
            CUSTOM_EASES.join("|") +
            ", x?, y?（画面百分比）, scale?（1=原样）, rotate?, skewX?, opacity?," +
            " blur?（px）, brightness?, contrast?, saturate?（1=原样）, grayscale?（0~1）, hueRotate?," +
            " overlay?（颜色 hex）, overlayOpacity?, overlayBlend?（screen/overlay/multiply…） }",
          "  可省略的通道 = 中性值（位移 0 / 缩放 1 / 不透明 1）。intensity 会让所有通道朝中性值收拢，0 = 画面原样。",
          "  例：闪白 + 同时放大 → keys:[{p:0,overlayOpacity:0,scale:1},{p:0.35,overlay:'#FFFFFF',overlayOpacity:0.85,scale:1.12,ease:'out'},{p:1,overlayOpacity:0,scale:1.04}]",
          `  进度曲线 curve 可选：${EFFECT_CURVES.map((c) => `${c}（${EFFECT_CURVE_LABEL[c]}）`).join("、")}`,
        );
      }
      return lines.join("\n");
    },
  },
  {
    name: "add_effect",
    description:
      "加一条**特效轨**：叠加在整幅画面上的区间特效，可以横跨多幕 —— 适合卡点、强调、气氛。" +
      `可选类型：${EFFECT_OPTIONS.map((o) => `${o.key}（${o.label}：${o.hint}）`).join("、")}。` +
      "内置类型可以通过 params 微调手感（键名见 list_effect_types）；" +
      "内置做不出来的效果就用 kind=custom + custom.keys 自己写关键帧。" +
      "from 是画面帧号，intensity 0-1（闪白建议 0.6）。" +
      "长片上想要周期性效果（暗角/呼吸/频闪）就开循环：loop=true + loopDurationInFrames（单次循环帧数）+" +
      "loopStopAfterSeconds（循环多少秒后自动完全退出，不传=循环到区间结束）。" +
      "要精确对准某一幕的中间，先 get_project 看场景的 start/时长。",
    shape: {
      kind: z.enum(EFFECT_TYPES).describe("特效类型"),
      from: z.number().int().min(0).describe("从第几帧开始"),
      durationInFrames: z.number().int().min(1).optional().describe("长度（帧），默认按类型给（16~54）"),
      intensity: z.number().min(0).max(1).optional().describe("强度 0-1"),
      color: z.string().optional().describe("覆盖层颜色 hex（闪白/扫光/暗角这类才有意义）"),
      params: z
        .record(z.number())
        .optional()
        .describe("内置特效参数，如 {amp:3, freqX:24, decay:0.6}；键名与范围见 list_effect_types"),
      curve: z.enum(EFFECT_CURVES).optional().describe("进度曲线：linear/out/in/inOut"),
      loop: z.boolean().optional().describe("循环播放：在区间内按单次循环反复播放"),
      loopDurationInFrames: z.number().int().min(4).max(3000).optional().describe("单次循环多少帧（不传=按类型默认）"),
      loopStopAfterSeconds: z.number().min(0.1).max(3600).optional().describe("循环到多少秒自动停止并完全退出"),
      custom: customEffectSchema
        .optional()
        .describe("仅 kind=custom 时必填：关键帧数组，格式见 list_effect_types"),
      name: z.string().optional(),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const clip: Record<string, unknown> = { kind: a.kind, from: a.from };
      if (a.durationInFrames !== undefined) clip.durationInFrames = a.durationInFrames;
      if (a.intensity !== undefined) clip.intensity = a.intensity;
      if (a.color !== undefined) clip.color = a.color;
      if (a.params !== undefined) clip.params = a.params;
      if (a.curve !== undefined) clip.curve = a.curve;
      if (a.loop !== undefined) clip.loop = a.loop;
      if (a.loopDurationInFrames !== undefined) clip.loopDurationInFrames = a.loopDurationInFrames;
      if (a.loopStopAfterSeconds !== undefined) clip.loopStopAfterSeconds = a.loopStopAfterSeconds;
      if (a.custom !== undefined) clip.custom = a.custom;
      if (a.name !== undefined) clip.name = a.name;
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "add_effect", clip }] }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "update_effect",
    description:
      "改一条特效轨的起点 / 长度 / 强度 / 类型 / 颜色，或**微调参数**（params 按 key 合并，只传要改的那个）、" +
      "或**整份替换自定义关键帧**（custom）。effectId 见 get_project 里的特效轨列表。",
    shape: {
      effectId: z.string(),
      kind: z.enum(EFFECT_TYPES).optional(),
      from: z.number().int().min(0).optional(),
      durationInFrames: z.number().int().min(1).optional(),
      intensity: z.number().min(0).max(1).optional(),
      color: z.string().optional().describe("覆盖层颜色 hex"),
      params: z.record(z.number()).optional().describe("要改的参数（按 key 合并，不会清掉其它参数）"),
      curve: z.enum(EFFECT_CURVES).optional(),
      loop: z.boolean().optional().describe("循环播放开关"),
      loopDurationInFrames: z.number().int().min(4).max(3000).optional().describe("单次循环多少帧"),
      loopStopAfterSeconds: z.number().min(0.1).max(3600).optional().describe("循环到多少秒自动停止"),
      custom: customEffectSchema.optional().describe("整份替换自定义关键帧（仅 custom 类型）"),
      name: z.string().optional(),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const patch: Record<string, unknown> = {};
      for (const k of [
        "kind",
        "from",
        "durationInFrames",
        "intensity",
        "color",
        "params",
        "curve",
        "loop",
        "loopDurationInFrames",
        "loopStopAfterSeconds",
        "custom",
        "name",
      ] as const) {
        if (a[k] !== undefined) patch[k] = a[k];
      }
      if (!Object.keys(patch).length) throw new Error("没有任何要改的字段");
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "update_effect", effectId: a.effectId, patch }] }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "remove_effect",
    description: "删除一条特效轨（画面本身不受影响）。",
    shape: { effectId: z.string(), projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "remove_effect", effectId: a.effectId }] }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "get_history",
    description: "查看最近的编辑历史（agent 与用户混排），用来了解用户刚做了什么。",
    shape: { projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const { entries } = await api<{ entries: any[] }>(`/api/projects/${p.id}/history`);
      if (!entries.length) return "本次会话还没有历史记录";
      return entries
        .map((e) => `rev${e.rev} [${e.actor}] ${e.summary.join("；") || e.ops.join(",")}`)
        .join("\n");
    },
  },
  {
    name: "get_user_messages",
    description:
      "读取用户在编辑页「给 agent」面板里发的消息（未读的，读完自动标记已读）。用户不用切到 agent 页面，直接在编辑器里留言。",
    shape: { projectId: z.string().optional() },
    run: async () => {
      await ensureServer();
      const res = await fetch(`${BASE}/api/agent/messages`);
      const data = (await res.json()) as {
        messages?: { role: string; text: string; at: string; read: boolean }[];
      };
      const unread = (data.messages ?? []).filter((m) => m.role === "user" && !m.read);
      if (!unread.length) return "没有新的用户消息";
      await fetch(`${BASE}/api/agent/read`, { method: "POST" });
      return unread.map((m) => `[${m.at}] 用户：${m.text}`).join("\n");
    },
  },
  {
    name: "reply_user",
    description:
      "回复编辑页里的用户消息，会显示在「给 agent」面板里，用户不用切到 agent 页面看。",
    shape: { text: z.string().describe("回复内容"), projectId: z.string().optional() },
    run: async (a) => {
      await ensureServer();
      const res = await fetch(`${BASE}/api/agent/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: a.text }),
      });
      if (!res.ok) throw new Error("回复失败");
      return "已回复到编辑页";
    },
  },
  {
    name: "get_tts_config",
    description:
      "读取文本转语音（TTS）配置：本地服务地址、模型、音色、格式，以及服务端可用的完整音色列表。",
    shape: { projectId: z.string().optional() },
    run: async () => {
      await ensureServer();
      const res = await fetch(`${BASE}/api/tts/config`);
      const data = (await res.json()) as { config: any };
      let speakers: string[] = [];
      try {
        const sp = await fetch(`${BASE}/api/tts/speakers`, { signal: AbortSignal.timeout(5000) });
        const spData = (await sp.json()) as { speakers?: Record<string, string> };
        speakers = Object.keys(spData.speakers ?? {});
      } catch {
        /* 服务端没开音色接口就不列 */
      }
      const nl = String.fromCharCode(10);
      const VOICE_META: Record<string, string> = {
        vivian: "女声，温柔，适合讲解/科普",
        serena: "女声，知性，适合教学/口播",
        sohee: "女声，年轻，适合轻快内容",
        ono_anna: "女声，日系，适合轻松/二次元",
        aiden: "男声，沉稳，适合严肃讲解",
        ryan: "男声，磁性，适合商业/解说",
        eric: "男声，浑厚，适合权威感",
        dylan: "男声，年轻，适合活泼内容",
        uncle_fu: "男声，低沉，适合故事/沉稳",
        default: "默认音色（兜底）",
      };
      const head = JSON.stringify(data.config ?? {}, null, 2);
      const list = speakers.length
        ? speakers.map((v) => `- ${v}：${VOICE_META[v] ?? "（无描述）"}`).join(nl)
        : "";
      return speakers.length
        ? `${head}${nl}${nl}可用音色（${speakers.length}）：${nl}${list}`
        : head;
    },
  },
  {
    name: "set_tts_config",
    description:
      "修改 TTS 配置（endpoint/apiKey/model/voice/format/speed/customBody），只传要改的字段。",
    shape: {
      endpoint: z.string().optional().describe("语音服务完整 URL"),
      apiKey: z.string().optional().describe("Bearer token，没有就留空"),
      model: z.string().optional(),
      voice: z.string().optional().describe("默认音色"),
      format: z.enum(["mp3", "wav", "ogg"]).optional(),
      speed: z.number().min(0.25).max(4).optional(),
      customBody: z.string().optional().describe("非 OpenAI 接口的 JSON 模板，支持 {{text}}/{{voice}}/{{speed}}"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      await ensureServer();
      const { projectId: _p, ...patch } = a;
      const res = await fetch(`${BASE}/api/tts/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await res.json()) as { config: { endpoint: string } };
      return `已保存 TTS 配置：${data.config.endpoint}`;
    },
  },
  {
    name: "tts_synthesize",
    description: `把文本合成语音（走配置好的本地 TTS 服务），音频存进 assets；addAs=track 直接加音效轨，music 替换背景音乐，sceneId 放进指定场景。

【传入文本的格式很重要，直接决定读音】
- 默认自动转义（escape=true）：90% → 百分之九十、2026-10-25 → 2026年10月25日、1234565 → 一百二十三万四千五百六十五；已经写成中文读法的文本不会被转坏。
- 不要传 Markdown、代码、表情和特殊符号（* _ ~ ^ | # @ 等），需要表达时写中文：→ 写"到"、& 写"和"、+ 写"加"、% 写"百分之"。
- 英文缩写按读音写（API → "A P I" 或直接写"接口"），避免模型按字母乱读。
- 长文本按句子分段，每段不超过 200 字，分别合成后放进不同场景/音效轨。
- 不想自动转义（比如文本里已经有自己的读法标记）时传 escape=false。`,
    shape: {
      text: z.string().describe("要合成的文本"),
      voice: z.string().optional(),
      speed: z.number().min(0.25).max(4).optional(),
      format: z.enum(["mp3", "wav", "ogg"]).optional(),
      instruct: z.string().optional().describe("风格指令，如「用特别愤怒的语气说」"),
      escape: z
        .boolean()
        .optional()
        .describe("默认 true：自动把数字/百分比/日期/常见符号转成中文读法；传 false 保持原文"),
      addAs: z.enum(["none", "track", "music"]).optional().describe("合成后怎么用，默认 none"),
      sceneId: z.string().optional().describe("把音频放进指定场景（场景内音频元素）"),
      from: z.number().int().min(0).optional().describe("音效起点（帧）"),
      subtitle: z
        .string()
        .optional()
        .describe("同时写入场景字幕（一行一句）；不传则用 text 原文，传空字符串则不写字幕"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      await ensureServer();
      // 配音是谁的：先定工程，音频才能落进 assets/projects/<工程id>/（删工程连带清）
      const owner = await resolveProject(a.projectId);
      const res = await fetch(`${BASE}/api/tts/synthesize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: a.text,
          voice: a.voice,
          speed: a.speed,
          format: a.format,
          instruct: a.instruct,
          escape: a.escape,
          projectId: owner.id,
        }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(data.error ?? "合成失败");
      // 绝对落盘路径：agent 想自己处理文件（剪一段/挪位置）时不用再拼路径
      const absPath = path.join(ROOT, "public", String(data.url).replace(/^\/+/, ""));
      const fileNote = `${String.fromCharCode(10)}本地文件：${absPath}`;
      // 顺势把时长量出来：合成接口本身不返回时长，而幕长必须按配音长度倒推
      const probe = await probeOne(data.url);
      const tip = probe
        ? `\n时长 ${probe.durationInSeconds}s ≈ ${probe.frames} 帧；建议场景时长 ${probe.suggestedSceneFrames} 帧（含 0.7s 呼吸位）`
        : "";
      if (a.sceneId) {
        const p = await resolveProject(a.projectId);
        const scene = p.scenes.find((x) => x.id === a.sceneId);
        if (!scene) throw new Error("场景不存在");
        await api(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({
            actor: "agent",
            ops: [
              {
                op: "add_element",
                sceneId: a.sceneId,
                element: {
                  kind: "audio",
                  src: data.url,
                  name: "语音",
                  x: 50,
                  y: 50,
                  size: 6,
                  audioVolume: 1,
                  from: a.from ?? 0,
                },
              },
              // 顺手把旁白文字写成字幕：配音和字幕一次搞定，导出 SRT 就有内容。
              // 传空字符串表示明确不要字幕
              ...(a.subtitle === ""
                ? []
                : [{ op: "set_subtitle", sceneId: a.sceneId, text: a.subtitle ?? a.text }]),
            ],
          }),
        });
        const subNote =
          a.subtitle === ""
            ? ""
            : `\n已同时写入字幕：${(a.subtitle ?? a.text)
                .split("\n")
                .filter((x: string) => x.trim()).length} 句（导出用 export_subtitles）`;
        return `已合成并放入场景「${scene.name}」：${data.url}${tip}${subNote}${fileNote}`;
      }
      if (a.addAs === "track" || a.addAs === "music") {
        const p = await resolveProject(a.projectId);
        const op =
          a.addAs === "track"
            ? {
                op: "add_audio_track",
                clip: { src: data.url, name: "TTS 语音", from: a.from ?? 0 },
              }
            : { op: "set_audio", audio: { src: data.url, volume: 1, fadeIn: 0, fadeOut: 0 } };
        await api(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({ actor: "agent", ops: [op] }),
        });
        return `已合成并${a.addAs === "track" ? "加入音效轨" : "设为背景音乐"}：${data.url}${tip}${fileNote}`;
      }
      return `已合成：${data.url}（${Math.round((data.bytes ?? 0) / 1024)} KB）${tip}${fileNote}`;
    },
  },
  {
    name: "set_subtitle_style",
    description:
      "只改字幕样式（不动字幕文本）：fontSize（短边百分比）/ color / bg / bgOpacity / bottom / bold / stroke / strokeColor / shadow / lineHeight / letterSpacing / align / maxWidth / css。样式按场景生效。",
    shape: {
      sceneId: z.string(),
      style: z.record(z.any()).describe("样式对象，只传要改的字段"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const scene = p.scenes.find((x) => x.id === a.sceneId);
      if (!scene) throw new Error(`没有场景 ${a.sceneId}`);
      // 只发 style、不带 text：op 层收到 text 会连带重写字幕并回报"写了 N 句字幕"（黑盒验证 N-06）
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "set_subtitle", sceneId: a.sceneId, style: a.style }],
        }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "tts_narration",
    description:
      "多段旁白一次合成（每段对应一幕）：返回每段音频 URL/本地路径/真实时长/建议场景帧数；applyToScenes=true 时直接把音频写进各场景、按配音长度对齐场景时长、并写字幕。" +
      "\n**顺序很重要**：改幕长**不会**自动调整已经放进去的元素/贴纸（它们的 durationInFrames 在落库时就固化成当时的幕长）。" +
      "所以正确顺序是「先 tts_narration 定幕长 → 再 add_element 放定时元素」；" +
      "顺序反了（先放元素后配音）元素会在幕中间消失，必须回头 update_element 改时长。",
    shape: {
      segments: z
        .array(
          z.object({
            text: z.string().describe("这一段的文案（口语、短句）"),
            sceneId: z.string().optional().describe("对应场景；applyToScenes 必填"),
            voice: z.string().optional(),
            instruct: z.string().optional().describe("这一段单独的语气指令"),
          }),
        )
        .min(1)
        .optional()
        .describe("按幕顺序给，一段一幕；fromStoryboard=true 时可以不传"),
      applyToScenes: z
        .boolean()
        .optional()
        .describe("把每段写进 sceneId 对应场景（音频 + 场景时长 + 字幕），默认 false"),
      fromStoryboard: z
        .boolean()
        .optional()
        .describe("直接从分镜表的 text/sceneId 取素材（不用再重贴一遍文案）"),
      voice: z.string().optional().describe("默认音色（段内可覆盖）"),
      speed: z.number().min(0.25).max(4).optional(),
      format: z.enum(["mp3", "wav", "ogg"]).optional(),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      await ensureServer();
      // 从分镜表取（每幕 text + sceneId），省得把 22 段文案重贴一遍
      if (a.fromStoryboard) {
        const p = await resolveProject(a.projectId);
        const sb = readStoryboard(p.id);
        if (!sb?.shots?.length) throw new Error("还没有分镜表，先 save_storyboard");
        a = {
          ...a,
          segments: sb.shots
            .filter((x) => x.text && x.sceneId)
            .map((x) => ({ text: x.text as string, sceneId: x.sceneId as string })),
        } as typeof a;
        if (!a.segments?.length) throw new Error("分镜表里没有带 text + sceneId 的幕");
      }
      if (!a.segments?.length) {
        throw new Error("要给 segments，或传 fromStoryboard=true 从分镜表取");
      }
      // 批量配音同样落在工程目录里，和单段一致
      const owner = await resolveProject(a.projectId);
      const results: {
        text: string;
        sceneId?: string;
        url: string;
        absPath: string;
        duration: number;
        frames: number;
        suggested: number;
      }[] = [];

      for (const seg of a.segments) {
        const res = await fetch(`${BASE}/api/tts/synthesize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: seg.text,
            voice: seg.voice ?? a.voice,
            speed: a.speed,
            format: a.format,
            instruct: seg.instruct,
            projectId: owner.id,
          }),
        });
        const data = (await res.json()) as any;
        if (!res.ok) throw new Error(data.error ?? "合成失败");
        const probe = await probeOne(data.url);
        results.push({
          text: seg.text,
          sceneId: seg.sceneId,
          url: data.url,
          absPath: path.join(ROOT, "public", String(data.url).replace(/^\/+/, "")),
          duration: probe?.durationInSeconds ?? 0,
          frames: probe?.frames ?? 0,
          suggested: probe?.suggestedSceneFrames ?? 0,
        });
      }

      const nl = String.fromCharCode(10);
      const lines = results.map(
        (r, i) =>
          `${i + 1}. ${r.text.replace(/\n/g, " ").slice(0, 24)}… → ${r.url} · ${r.duration}s ≈ ${r.frames} 帧 · 建议 ${r.suggested} 帧${r.sceneId ? ` → ${r.sceneId}` : ""}${nl}   本地：${r.absPath}`,
      );

      if (a.applyToScenes) {
        const p = await resolveProject(a.projectId);
        const ops: Record<string, unknown>[] = [];
        let applied = 0;
        for (const r of results) {
          if (!r.sceneId) continue;
          const scene = p.scenes.find((x: any) => x.id === r.sceneId);
          if (!scene || !r.suggested) continue;
          // 先删掉这个场景里旧的音频元素，避免重复叠加
          for (const el of ((scene as any).elements ?? [])) {
            if (el.kind === "audio") {
              ops.push({ op: "remove_element", sceneId: r.sceneId, elementId: el.id });
            }
          }
          ops.push({
            op: "update_scene",
            sceneId: r.sceneId,
            patch: { durationInFrames: r.suggested },
          });
          ops.push({ op: "set_subtitle", sceneId: r.sceneId, text: r.text });
          ops.push({
            op: "add_element",
            sceneId: r.sceneId,
            element: {
              kind: "audio",
              src: r.url,
              name: "旁白",
              x: 50,
              y: 50,
              size: 6,
              audioVolume: 1,
              from: 0,
              durationInFrames: r.suggested,
            },
          });
          applied++;
        }
        if (ops.length) {
          await api(`/api/projects/${p.id}/ops`, {
            method: "POST",
            body: JSON.stringify({ actor: "agent", ops }),
          });
        }
        lines.push(`已应用到 ${applied} 个场景：场景时长按配音对齐、字幕写入、音频放入（重复应用会先清旧音频）`);
      }

      return `已合成 ${results.length} 段旁白${nl}${lines.join(nl)}${nl}下一步：preview_frames 抽帧自检 → render_video(dryRun=true) 预检 → render_video`;
    },
  },
  {
    name: "export_subtitles",
    description:
      "导出字幕（SRT / WebVTT）。字幕来源：场景的 subtitle 字段（一行一句，按字数比例分配幕内时长）；" +
      "没写 subtitle 的 caption 版式场景则用它的正文。其它版式不产生字幕。\n" +
      "用法：先 set_subtitle 给每幕写字幕，再调本工具导出。返回字幕文件路径与条目数。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      format: z.enum(["srt", "vtt"]).optional().describe("默认 srt"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const format = a.format === "vtt" ? "vtt" : "srt";
      const res = await api<any>(`/api/projects/${p.id}/subtitles`, {
        method: "POST",
        body: JSON.stringify({ format }),
      });
      const first = res.cues;
      return (
        `已导出 ${res.cues} 条字幕（${format.toUpperCase()}）：${res.filename}\n` +
        `路径：${res.file}\n` +
        `字幕条数：${first}`
      );
    },
  },
  {
    name: "set_subtitle",
    description:
      "给场景写字幕（一行一句）。导出 SRT / VTT 时按字数比例分配这一幕内的时长，" +
      "所以长句会自动占更多时间。传空字符串清空字幕。",
    shape: {
      sceneId: z.string(),
      text: z.string().describe("字幕文本，一行一句"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "set_subtitle", sceneId: a.sceneId, text: a.text }],
        }),
      });
      return `${res.summary.join("\n")}\nrev=${res.project.rev}`;
    },
  },
  {
    name: "get_asset_info",
    description:
      "量音频/视频素材的真实时长（秒 / 帧），并给出建议的场景时长。配音定稿后用它量每一段，再 set_scene_timing：帧数 = ceil((秒数 + 0.7) × 30)，0.7 秒是呼吸位。改过旁白必须重新量——同一段文字两次合成的时长可能不一样。支持 wav / mp3 / ogg / mp4 / m4a（读文件头算，不调外部程序）。",
    shape: {
      src: z
        .union([z.string(), z.array(z.string())])
        .describe("站内地址，如 /assets/tts-xxx.wav；可传数组一次量多段"),
      fps: z.number().optional().describe("帧率，默认 30"),
    },
    run: async (a) => {
      const srcs = Array.isArray(a.src) ? a.src : [a.src];
      if (!srcs.length) throw new Error("至少要传一个 src");
      const probes = await probeAssets(srcs, a.fps);
      const lines = probes.map((p) => {
        if (p.error) return `${p.file}：量不出来 —— ${p.error}`;
        const extra = p.sampleRate ? ` ${p.sampleRate}Hz/${p.channels}ch` : "";
        return (
          `${p.file}：${p.durationInSeconds}s ≈ ${p.frames} 帧${extra}` +
          `\n    建议场景时长 ${p.suggestedSceneFrames} 帧（含 0.7s 呼吸位）`
        );
      });
      const total = probes.reduce((s, p) => s + (p.error ? 0 : p.durationInSeconds), 0);
      return [...lines, `合计 ${Math.round(total * 100) / 100}s`].join("\n");
    },
  },
  {
    name: "set_theme",
    description:
      "整体改主题（配色/字体/圆角/动效强度）。palette 可用键：background / surface / text / textMuted / primary / secondary / accent；font 可改 heading/body 字体族。" +
      "\nmotion 是整体动效强度：0=静态（画面完全静止）、1=标准（默认）、2=更强（位移加大+轻微回弹+数字滚动更快）。" +
      "只影响入场位移/数字滚动/氛围光斑，不改版式与排版。用户嫌「太死板」就先试 2，嫌「晃」就调 0。",
    shape: {
      palette: z.record(z.string()).optional(),
      font: z
        .object({ heading: z.string().optional(), body: z.string().optional() })
        .optional()
        .describe("字体族，如 { heading: 'Georgia, serif', body: 'Inter, sans-serif' }"),
      radius: z.number().optional(),
      motion: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .describe("动效强度 0=静态 / 1=标准 / 2=更强；不传保持不变"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "set_theme", palette: a.palette, font: a.font, radius: a.radius, motion: a.motion }],
        }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "set_formats",
    description:
      "调整画幅尺寸（竖屏/横屏/方形/竖版等）。只传要改的画幅 key + 宽高即可，其余保持不变；宽高范围 16–7680。例：把竖屏改成 1080×1920。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      formats: z
        .array(
          z.object({
            key: z.string().describe("画幅 key：portrait / landscape / square / tall45 或自定义"),
            label: z.string().optional().describe("显示名（如「方形 1:1」），不传用 key"),
            width: z.number().int().min(16).max(7680),
            height: z.number().int().min(16).max(7680),
          }),
        )
        .min(1),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const incoming = a.formats as {
        key: string;
        label?: string;
        width: number;
        height: number;
      }[];
      const next = p.formats.map((f) => {
        const u = incoming.find((x) => x.key === f.key);
        return u ? { ...f, width: u.width, height: u.height, label: u.label ?? f.label } : f;
      });
      for (const u of incoming) {
        if (!next.some((f) => f.key === u.key)) {
          next.push({
            key: u.key,
            label: u.label ?? u.key,
            width: u.width,
            height: u.height,
          });
        }
      }
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "set_formats", formats: next }] }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "preview_frame",
    description:
      "渲染指定帧为图片（默认同时出竖屏+横屏），返回图片 URL。改完务必调用它自检：检查文字溢出、重叠、被裁。",
    shape: {
      frame: z.number().optional().describe("全局帧号，默认 0（给了 sceneId 时忽略）"),
      sceneId: z.string().optional().describe("按场景预览：给场景 id + offset 就不用自己算全局帧"),
      offset: z.number().optional().describe("场景内偏移（帧），配合 sceneId，默认 0"),
      formats: z.union([z.string(), z.array(z.string())]).optional().describe("画幅 key 或数组，如 \"portrait\" / [\"portrait\",\"landscape\"]；不传全部"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      let frame = a.frame ?? 0;
      if (a.sceneId) {
        const idx = (p.scenes ?? []).findIndex((x: any) => x.id === a.sceneId);
        if (idx < 0) throw new Error(`没有场景 ${a.sceneId}`);
        // 多轨之后起点不再等于"前序时长之和"，必须走 sceneSpans（否则画中画会预览到别处）
        const span = sceneSpans(p.scenes as any[])[idx];
        const dur = span?.dur ?? (p.scenes as any[])[idx].durationInFrames;
        const off = Math.max(0, Math.min(dur - 1, a.offset ?? 0));
        frame = (span?.start ?? 0) + off;
      }
      const res = await api<{ stills: { format: string; url: string; frame: number }[] }>(
        `/api/projects/${p.id}/stills`,
        { method: "POST", body: JSON.stringify({ frame, formats: a.formats }) },
      );
      return [
        `已渲染第 ${res.stills[0]?.frame ?? 0} 帧：`,
        ...res.stills.map(
          (s: { format: string; url: string }) =>
            `  ${s.format}: ${BASE}${encodeURI(s.url)}` +
            String.fromCharCode(10) +
            `  本地：${path.join(ROOT, String(s.url).split("?")[0].replace(/^\/+/, ""))}`,
        ),
        "请打开图片检查排版是否溢出/重叠。",
      ].join("\n");
    },
  },
  {
    name: "render_video",
    description:
      "提交渲染任务（默认两种画幅都出）。默认异步返回，用 get_render_status 查询；传 wait=true 会等到完成再返回（省轮询）。",
    shape: {
      formats: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("画幅 key 或 key 数组，如 \"portrait\" 或 [\"portrait\",\"landscape\"]；不传默认全部"),
      wait: z.boolean().optional().describe("阻塞等待渲染完成（默认 false）"),
      timeoutSec: z.number().int().min(10).max(3600).optional().describe("等待超时秒数，默认 900"),
      dryRun: z
        .boolean()
        .optional()
        .describe("只做预检：场景是否为空、素材文件是否存在，不提交渲染（几秒返回）"),
      fileName: z
        .string()
        .optional()
        .describe(
          "自定义文件名前缀（不含画幅/时间戳/扩展名，会自动补上）。不传就用工程名。" +
            "工程名里的旧标签会误导交付（如叫「60s精华版」但实际 116 秒），这种情况建议显式给一个",
        ),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const formats = typeof a.formats === "string" ? [a.formats] : a.formats;
      if (a.dryRun) {
        const issues: string[] = [];
        if (!(p.scenes ?? []).length) issues.push("工程没有场景");
        const refs = new Set<string>();
        for (const sc of p.scenes ?? []) {
          for (const el of (sc as any).elements ?? []) if (el.src) refs.add(String(el.src));
        }
        const proj = p as any;
        if (proj.audio?.src) refs.add(String(proj.audio.src));
        for (const t of proj.audioTracks ?? []) if (t?.src) refs.add(String(t.src));
        for (const src of refs) {
          if (!src.startsWith("/assets/")) continue;
          const file = path.join(ROOT, "public", src.replace(/^\/+/, ""));
          if (!fs.existsSync(file)) issues.push(`素材缺失：${src}`);
        }
        // 音频时长 > 可用空间：后面会被截断/静音，提前告警
        const audioChecks: { src: string; label: string; room: number }[] = [];
        for (const sc of p.scenes ?? []) {
          for (const el of (sc as any).elements ?? []) {
            if (el.kind === "audio" && typeof el.src === "string" && el.src.startsWith("/assets/")) {
              audioChecks.push({
                src: el.src,
                label: `场景「${sc.name}」的音频`,
                room: Math.max(1, sc.durationInFrames - (el.from ?? 0)),
              });
            }
          }
        }
        for (const t of proj.audioTracks ?? []) {
          if (typeof t?.src === "string" && t.src.startsWith("/assets/")) {
            const total = totalDuration(p as never);
            audioChecks.push({
              src: t.src,
              label: `音效轨「${t.name ?? ""}」`,
              room: Math.max(1, total - (t.from ?? 0)),
            });
          }
        }
        for (const c of audioChecks) {
          const pr = await probeOne(c.src);
          if (pr && pr.frames > c.room + 2) {
            issues.push(
              `${c.label} 只有 ${c.room} 帧可用，素材有 ${pr.frames} 帧，后面会被截断/静音`,
            );
          }
        }
        const nl = String.fromCharCode(10);
        return issues.length
          ? `预检发现 ${issues.length} 个问题：${nl}${issues.join(nl)}`
          : "预检通过：场景非空、引用的素材文件都在。可以正式渲染（去掉 dryRun）。"
      }
      const { task } = await api<any>(`/api/projects/${p.id}/render`, {
        method: "POST",
        body: JSON.stringify({ formats, quality: a.quality, format: a.format, fileName: a.fileName }),
      });
      const totalFrames = totalDuration(p as never);
      const estSec = Math.round((totalFrames / 8.8) * (task.formats?.length ?? 1));
      const estMin = Math.max(0.3, estSec / 60);
      const multiNote =
        (task.formats?.length ?? 0) > 1
          ? " 多个画幅是逐个渲染的，每个画幅的进度百分比独立从 0 开始（进度回到小数字 = 进入下一个画幅，不是重启）。"
          : "";
      const head = `已提交渲染任务 taskId=${task.id}（${task.formats.join(" + ")}，共 ${totalFrames} 帧）。预计约 ${estMin.toFixed(1)} 分钟（按 8.8 帧/秒估算）。${multiNote}`;
      if (!a.wait) return `${head} 用 get_render_status 查询。`;

      const deadline = Date.now() + (a.timeoutSec ?? 900) * 1000;
      const nl = String.fromCharCode(10);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const cur = await api<any>(`/api/tasks/${task.id}`);
        const t = cur.task;
        if (t.status === "error") throw new Error(`渲染失败：${t.error ?? "未知错误"}`);
        if (t.status === "done") {
          const files = (t.outputs ?? []).map(
            (o: any) =>
              `${o.format}: ${BASE}${encodeURI(o.url)}${nl}  文件：${path.join(ROOT, String(o.url).replace(/^\/+/, ""))}`,
          );
          return `${head}${nl}渲染完成：${nl}${files.join(nl)}`;
        }
      }
      return `${head} 等待超时（${a.timeoutSec ?? 900}s），继续用 get_render_status 查。`;
    },
  },
  {
    name: "preview_frames",
    description:
      "一次渲染多帧（最多 8 帧）为图片，返回各帧 URL。改完排版抽 2–3 帧一起看，比逐帧调用省往返。",
    shape: {
      frames: z.array(z.number()).min(1).max(8).describe("要看的帧号列表"),
      formats: z.union([z.string(), z.array(z.string())]).optional().describe("画幅 key 或数组，如 \"portrait\" / [\"portrait\",\"landscape\"]；不传全部"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const nl = String.fromCharCode(10);
      const lines: string[] = [];
      for (const f of a.frames) {
        const res = await api<{ stills: { format: string; url: string }[] }>(
          `/api/projects/${p.id}/stills`,
          {
            method: "POST",
            body: JSON.stringify({ frame: f, formats: a.formats }),
          },
        );
        lines.push(
          `第 ${f} 帧：` +
            res.stills
              .map(
                (s: { format: string; url: string }) =>
                  `${s.format} ${BASE}${encodeURI(s.url)}（本地：${path.join(ROOT, String(s.url).split("?")[0].replace(/^\/+/, ""))}）`,
              )
              .join(" | "),
        );
      }
      return lines.join(nl);
    },
  },
  {
    name: "get_render_status",
    description: "查询渲染任务状态；不传 taskId 则返回最近所有任务。",
    shape: { taskId: z.string().optional() },
    run: async (a) => {
      if (a.taskId) {
        const { task } = await api<any>(`/api/tasks/${a.taskId}`);
        const nl = String.fromCharCode(10);
        const files = (task.outputs ?? []).map(
          (o: any) =>
            `${o.format}: ${BASE}${encodeURI(o.url)}${nl}  文件：${path.join(ROOT, String(o.url).replace(/^\/+/, ""))}`,
        );
        return `${task.status} ${task.progress}%${nl}${files.join(nl)}${task.error ? `${nl}错误：${task.error}` : ""}`;
      }
      const { tasks } = await api<{ tasks: any[] }>("/api/tasks");
      if (!tasks.length) return "没有渲染任务";
      return tasks
        .map((t) => `${t.id} ${t.status} ${t.progress}% (${t.formats.join("+")})`)
        .join("\n");
    },
  },
  {
    name: "cancel_render",
    description: "取消正在排队或渲染中的任务。已结束的任务会返回提示，不报错。",
    shape: { taskId: z.string() },
    run: async (a) => {
      try {
        await api(`/api/tasks/${a.taskId}/cancel`, { method: "POST" });
        return `已取消任务 ${a.taskId}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `未取消：${msg}`;
      }
    },
  },

  {
    name: "cleanup_renders",
    description:
      "清理渲染产物（out/projects/<工程id>/ 下按工程分目录）：每个工程保留最近 N 个成片（默认 5），关键帧与字幕按天数清（默认 7 天）；工程已删除的产物目录会整块收掉。dryRun=true 只统计不删除。用户说\"磁盘满了 / 清理一下旧视频\"时用。",
    shape: {
      projectId: z.string().optional().describe("只清这个工程，不传 = 所有工程"),
      keepVideos: z.number().int().min(1).max(50).optional().describe("每个工程保留几个成片，默认 5"),
      stillsDays: z.number().int().min(0).max(365).optional().describe("关键帧/字幕保留天数，默认 7"),
      dryRun: z.boolean().optional().describe("只统计不删"),
    },
    run: async (a) => {
      const r = await api<{
        scanned: number;
        removedFiles: number;
        removedVideos: number;
        removedStills: number;
        removedSubtitles: number;
        removedOrphanDirs: number;
        removedLegacy: number;
        freedBytes: number;
        keptVideos: number;
        dryRun: boolean;
      }>("/api/outputs/cleanup", { method: "POST", body: JSON.stringify(a) });
      const nl = String.fromCharCode(10);
      const mb = (r.freedBytes / 1024 / 1024).toFixed(1);
      const parts = [
        `${r.removedVideos} 个成片`,
        `${r.removedStills} 张关键帧`,
        ...(r.removedSubtitles ? [`${r.removedSubtitles} 个字幕`] : []),
      ].join(" + ");
      const notes = [
        r.removedOrphanDirs ? `工程已删的产物目录 ${r.removedOrphanDirs} 个（整块收掉）` : "",
        r.removedLegacy ? `旧版扁平目录残留 ${r.removedLegacy} 个文件` : "",
      ].filter(Boolean);
      return (
        (r.dryRun
          ? `扫描 ${r.scanned} 个产物：可清理 ${parts}，约 ${mb} MB（dryRun，未删除）`
          : `已清理 ${r.removedFiles} 个旧产物（${parts}），释放 ${mb} MB；每个工程保留 ${r.keptVideos} 个成片`) +
        (notes.length ? `${nl}另外：${notes.join("；")}` : "")
      );
    },
  },

  {
    name: "refresh_bundle",
    description:
      "重建渲染用的打包快照。平时**不需要**——每次渲染前都会把 public/ 里新增的素材（TTS 音频、上传的图）自动同步进快照，所以不需要为了素材重启服务。只在改了打包配置、或怀疑快照坏了的时候用；会阻塞十几秒。",
    shape: {},
    run: async () => {
      const r = await api<{ serveUrl: string; bundle: { done: boolean; progress: number } }>(
        "/api/bundle/refresh",
        { method: "POST" },
      );
      return `已重建渲染快照（打包 ${r.bundle.done ? "完成" : "进行中"}）。之后出片用的是最新快照。`;
    },
  },

  /* ────────────────────────── 自由元素（贴纸 / 图标 / 标签 / 图片） ────────────────────────── */

  {
    name: "upload_asset",
    description:
      "把本机文件（图片 / 音频 / 视频）上传，返回站内地址。\n" +
      "**两种归宿**：registerToLibrary:true（默认）→ 进「我的素材」库（assets/library/，跨工程复用、删工程不动它）；\n" +
      "false → 进**本工程素材目录**（assets/projects/<工程id>/，删工程时一起清掉）。\n" +
      "只是这一支片子用一次的素材（生成的图 / 配音）建议 false；想反复用就入库存。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      path: z.string().describe("本机绝对路径，如 D:/tmp/icon.png"),
      name: z.string().optional().describe("素材名，不传就用文件名"),
      registerToLibrary: z
        .boolean()
        .optional()
        .describe("true（默认）= 进「我的素材」库；false = 只进本工程素材目录（随工程删除）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const fs = await import("node:fs/promises");
      const nodePath = await import("node:path");
      const buf = await fs.readFile(a.path);
      const base = nodePath.basename(a.path);
      const toLibrary = a.registerToLibrary ?? true;

      await ensureServer();
      if (toLibrary) {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(buf)]), base);
        if (a.name) form.append("name", a.name);
        const res = await fetch(`${BASE}/api/library`, { method: "POST", body: form });
        const data = (await res.json()) as { item?: CustomAsset; error?: string };
        if (!res.ok || !data.item) throw new Error(data.error ?? `HTTP ${res.status}`);
        return (
          `已入库：${data.item.name}（${data.item.kind ?? "文件"}）\n素材 id：asset:${data.item.id}\n` +
          `地址：${data.item.url}（在 assets/library/，删工程不会带走它）\n` +
          `用 add_element 放上画面：libraryId = "asset:${data.item.id}"`
        );
      }
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buf)]), base);
      const res = await fetch(`${BASE}/api/projects/${p.id}/assets`, { method: "POST", body: form });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? `HTTP ${res.status}`);
      return (
        `已放进工程「${p.name}」的素材目录：${data.url}（${(buf.length / 1024).toFixed(0)}KB）\n` +
        `位于 assets/projects/${p.id}/，删这个工程会一起清掉；` +
        `想跨工程复用就传 registerToLibrary:true（默认就是）`
      );
    },
  },

  {
    name: "list_assets",
    description:
      "列出「我的素材」库（跨工程复用的共用池，文件在 assets/library/），带 id、类型、时长。最新的在前。\n" +
      "**只列库，不含本工程目录里的文件** —— 那些用 list_project_assets 看。",
    shape: {
      query: z.string().optional().describe("按名字过滤（包含即可）"),
      kind: z.enum(["image", "video", "audio"]).optional().describe("只列某一类"),
      limit: z.number().int().min(1).max(500).optional().describe("最多返回条数，默认 100"),
    },
    run: async (a) => {
      const { items } = await api<{ items: any[] }>("/api/library");
      const q = (a.query ?? "").trim().toLowerCase();
      // 先过滤再截断：以前先 slice 后过滤，「按名字找」会把更早的匹配项一起藏掉
      const matched = items
        .filter((x) => !a.kind || x.kind === a.kind)
        .filter((x) => !q || String(x.name ?? "").toLowerCase().includes(q));
      const limit = a.limit ?? 100;
      const list = matched.slice(0, limit);
      if (!list.length) {
        return q
          ? `没有匹配「${q}」的素材（库里共 ${items.length} 条；用 list_assets 不带 query 看全部）`
          : "没有匹配的素材。";
      }
      const lines = list
        .map(
          (x) =>
            `- ${x.id}（${x.kind ?? "image"}）${x.name}${x.duration ? ` · ${x.duration.toFixed(1)}s` : ""} → ${x.url}`,
        )
        .join("\n");
      const more =
        matched.length > list.length
          ? `\n（匹配 ${matched.length} 条，只显示最新的 ${list.length} 条；用 query 缩小范围或调大 limit，上限 500）`
          : "";
      return lines + more;
    },
  },

  /* ─────────────────── 本工程素材目录（assets/projects/<id>/） ─────────────────── */

  {
    name: "list_project_assets",
    description:
      "列出**本工程自己的素材目录**（assets/projects/<工程id>/）。与 list_assets（共用库）分开：\n" +
      "这里的文件只属于这个工程，删工程时会被一起清掉。面板上也能看到同一份清单。",
    shape: {
      projectId: z.string().optional().describe("工程 id，不传 = 当前默认工程"),
      query: z.string().optional().describe("按文件名过滤（包含即可）"),
      kind: z.enum(["image", "video", "audio", "file"]).optional().describe("只列某一类"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const { items } = await api<{ items: ProjectAssetLite[] }>(`/api/projects/${p.id}/assets`);
      const q = (a.query ?? "").trim().toLowerCase();
      const list = (items ?? [])
        .filter((x) => !a.kind || x.kind === a.kind)
        .filter((x) => !q || x.name.toLowerCase().includes(q));
      if (!list.length) {
        return (
          `「${p.name}」的素材目录是空的（assets/projects/${p.id}/）。\n` +
          `上传：upload_asset(path, registerToLibrary:false)；共用素材放库：upload_asset(path)`
        );
      }
      const lines = list.map(
        (x) =>
          `- ${x.name}（${x.kind}，${formatBytes(x.bytes)}）→ ${x.url}` +
          (x.referenced ? "  · 工程正在用" : "  · 未被引用"),
      );
      return (
        `「${p.name}」的素材目录：${list.length} 个文件\n` +
        lines.join("\n") +
        `\n（删工程时这个目录会被清掉；要跨工程复用请入「我的素材」库）`
      );
    },
  },
  {
    name: "delete_project_asset",
    description:
      "删**本工程素材目录**里的一个文件（assets/projects/<工程id>/）。\n" +
      "只能删本工程的，别的工程/共用库里的碰不到。文件仍被工程引用时会在回执里提示——" +
      "删之前先用 list_project_assets 看「工程正在用」。",
    shape: {
      projectId: z.string().optional().describe("工程 id，不传 = 当前默认工程"),
      url: z.string().optional().describe("文件地址 /assets/projects/<id>/x.png（与 name 二选一）"),
      name: z.string().optional().describe("文件名，如 1712abcd-xy1z.png"),
    },
    run: async (a) => {
      if (!a.url && !a.name) throw new Error("给 url=/assets/projects/<id>/x.png 或 name=<文件名>");
      const p = await resolveProject(a.projectId);
      const q = a.url ? `url=${encodeURIComponent(a.url)}` : `name=${encodeURIComponent(a.name as string)}`;
      const res = await api<{ ok?: boolean; rel?: string; wasReferenced?: boolean }>(
        `/api/projects/${p.id}/assets?${q}`,
        { method: "DELETE" },
      );
      return (
        `已删除 ${res.rel}` +
        (res.wasReferenced
          ? `\n⚠ 这个文件**之前仍被工程引用**，画面里用到它的元素现在会裂图——记得改掉引用或重传`
          : "")
      );
    },
  },
  {
    name: "organize_assets",
    description:
      "一次性整理旧版散在 `public/assets/` 根目录里的文件：按「谁在引用」搬进对应工程目录或 library/，\n" +
      "并同步改写 project.json 与素材库索引里的 URL（不搬就裂图）。\n" +
      "**默认 dryRun=true 只出方案**，你看过再传 dryRun:false 真正执行。被多个工程共用的文件进 library/。",
    shape: {
      dryRun: z.boolean().optional().describe("默认 true：只出方案不动文件；false 才真的搬 + 改写"),
    },
    run: async (a) => {
      await ensureServer();
      const dryRun = a.dryRun !== false;
      const { result } = await api<{ result: OrganizeResultLite }>("/api/assets/organize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const nl = String.fromCharCode(10);
      const head = dryRun
        ? `整理方案（dryRun，未改动任何文件）`
        : `整理完成（已搬 ${result.moves.length} 个文件）`;
      const moveLines = result.moves
        .slice(0, 30)
        .map((m) => `- ${m.from} → ${m.to}（${formatBytes(m.bytes)}，${m.reason}）`)
        .join(nl);
      const moreMoves =
        result.moves.length > 30 ? `${nl}…另有 ${result.moves.length - 30} 个` : "";
      const rewriteLines = result.rewrites.length
        ? `${nl}改写了 ${result.rewrites.length} 个工程的引用：` +
          result.rewrites.map((r) => `${r.name}（${r.changed} 处）`).join("、")
        : "";
      const libLines = result.libraryUpdated.length
        ? `${nl}改写素材库 ${result.libraryUpdated.length} 条（${result.libraryUpdated.map((r) => r.name).join("、")}）`
        : "";
      const skipLines = result.skipped.length
        ? `${nl}跳过 ${result.skipped.length} 个：` +
          result.skipped
            .slice(0, 10)
            .map((s) => `${s.rel}（${s.reason}）`)
            .join("、")
        : "";
      return (
        `${head}：可搬 ${result.moves.length} 个，跳过 ${result.skipped.length} 个` +
        (result.moves.length ? `${nl}${moveLines}${moreMoves}` : "") +
        rewriteLines +
        libLines +
        skipLines +
        (result.libraryMissing
          ? `${nl}⚠ 素材库里有 ${result.libraryMissing} 条指向的文件已经不存在（点开会是空图）；` +
            `确认不要了就 delete_asset 逐条删掉`
          : "") +
        (dryRun ? `${nl}确认没问题后调 organize_assets(dryRun:false)` : "")
      );
    },
  },
  {
    name: "rename_asset",
    description: "给「我的素材」改名（只改显示名，不影响文件与已引用它的工程）。",
    shape: {
      id: z.string().optional().describe("素材 id（list_assets 里能看到）"),
      assetId: z.string().optional().describe("同 id（别名，delete_asset 用的是这个名字）"),
      name: z.string().describe("新名字"),
    },
    run: async (a) => {
      const id = a.id ?? a.assetId;
      if (!id) throw new Error("缺少 id（素材 id，list_assets 里查；也认 assetId）");
      const { item } = await api<{ item: any }>(`/api/library/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: a.name }),
      });
      return `已改名：${item.name}`;
    },
  },
  {
    name: "list_element_library",
    description:
      "列出可用的元素素材：内置素材库（图标 / 形状 / 标签）+「我的素材」里已入库的图片。拿到 id 后用 add_element 的 libraryId 放进场景。两边都没有合适的，可以直接用 add_element 的 svg / text / imageSrc 自己造。",
    shape: { category: z.string().optional().describe("按分类筛选：标记 / 箭头 / 形状 / 符号 / 标签") },
    run: async (a) => {
      await ensureServer();
      const lines: string[] = [];
      const items = ELEMENT_LIBRARY.filter((i) => !a.category || i.cat === a.category);
      if (items.length) {
        const cats = [...new Set(items.map((i) => i.cat))];
        lines.push(
          cats
            .map(
              (c) =>
                `【${c}】\n` +
                items
                  .filter((i) => i.cat === c)
                  .map((i) => `  ${i.id} · ${i.name}（默认尺寸 ${i.size}%）`)
                  .join("\n"),
            )
            .join("\n"),
        );
      } else if (a.category) {
        lines.push(`内置库里没有分类「${a.category}」`);
      }

      const res = await fetch(`${BASE}/api/library`);
      const data = (await res.json()) as { items?: CustomAsset[] };
      const mine = data.items ?? [];
      if (mine.length) {
        lines.push(
          `【我的素材】\n` +
            mine.map((x) => `  asset:${x.id} · ${x.name}${x.w ? `（${x.w}×${x.h}）` : ""}`).join("\n"),
        );
      } else {
        lines.push("【我的素材】空 —— upload_asset 传图片即可入库");
      }
      return lines.join("\n\n");
    },
  },
  {
    name: "add_element",
    description:
      "往场景里放一个自由元素（贴纸 / 图标 / 标签 / 图片 / 视频 / 音频）。可以用 libraryId 取素材库现成的，也可以自己给 svg（矢量）、text（文字）、imageSrc（图片）、videoSrc（视频）、audioSrc（音频）——素材库没有合适的就自己造。放进去之后用户可以正常拖动/旋转/缩放/删除。视频默认有声、不循环；音频/视频没给 durationInFrames 会按素材真实时长。支持背景色 bg、入场 enter / 出场 exit 特效、场景内时间 from / durationInFrames。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string().optional().describe("放到哪个场景；不传就用第一个场景"),
      libraryId: z
        .string()
        .optional()
        .describe("素材 id：内置素材见 list_element_library；我的图片素材形如 asset:<id>"),
      svg: z
        .string()
        .optional()
        .describe('自定义矢量：SVG 内部标记，如 <path d="M2 12h20" stroke="none"/>'),
      viewBox: z.string().optional().describe("配合 svg 使用，默认 0 0 24 24"),
      stroke: z.boolean().optional().describe("true 表示线稿（描边），false 表示填充"),
      strokeWidth: z.number().optional(),
      text: z.string().optional().describe("文字元素的内容"),
      imageSrc: z.string().optional().describe("图片元素：/assets/xxx（先 upload_asset）或 https 地址"),
      videoSrc: z
        .string()
        .optional()
        .describe("视频元素：/assets/xxx.mp4（先 upload_asset）；默认静音 + 循环"),
      name: z.string().optional().describe("图层名，方便后续指认"),
      x: z.number().optional().describe("中心 X，画面宽度百分比，默认 50"),
      y: z.number().optional().describe("中心 Y，画面高度百分比，默认 52"),
      size: z.number().optional().describe("短边百分比：图形是宽度，文字是字号"),
      rotate: z.number().optional(),
      scale: z.number().optional(),
      opacity: z.number().optional(),
      z: z.number().optional().describe("层级，越大越靠前"),
      fill: z.string().optional().describe("颜色，如 #C6F24E"),
      bg: z.string().optional().describe("背景色（所有元素，传 rgba/hex；空字符串=无背景）"),
      weight: z.number().optional().describe("文字字重 400-900"),
      radius: z.number().optional().describe("圆角（短边百分比，如 2）"),
      border: z.number().optional().describe("边框宽度（短边百分比）"),
      borderColor: z.string().optional().describe("边框颜色，默认用 fill"),
      shadow: z.string().optional().describe("CSS box-shadow"),
      filter: z.string().optional().describe("CSS filter，如 blur(2px) brightness(1.1)"),
      blendMode: z.string().optional().describe("mix-blend-mode"),
      clipPath: z.string().optional().describe("CSS clip-path，如 circle(50%)"),
      fit: z.enum(["cover", "contain", "fill"]).optional().describe("图片/视频填充方式"),
      fontFamily: z.string().optional().describe("字体族"),
      lineHeight: z.number().optional().describe("行高倍数"),
      letterSpacing: z.number().optional().describe("字间距（em）"),
      textAlign: z.enum(["left", "center", "right"]).optional().describe("文字对齐"),
      fontStyle: z.enum(["normal", "italic"]).optional().describe("斜体"),
      underline: z.boolean().optional().describe("下划线"),
      maxWidth: z.number().optional().describe("文字最大宽度（短边百分比），自动换行"),
      strokeLinecap: z.enum(["butt", "round", "square"]).optional(),
      strokeLinejoin: z.enum(["miter", "round", "bevel"]).optional(),
      style: z
        .record(z.any())
        .optional()
        .describe("自定义内联样式（camelCase 键，最后应用可覆盖预设），如 { textShadow: '0 0 20px #0ff', transform: 'skew(-8deg)' }"),
      enter: EFFECT_DESC.optional().describe("入场特效：{type,durationInFrames}，type 同转场"),
      exit: EFFECT_DESC.optional().describe("出场特效：{type,durationInFrames}"),
      from: z.number().int().min(0).optional().describe("场景内起点（帧），默认 0"),
      durationInFrames: z
        .number()
        .int()
        .optional()
        .describe(
          "场景内时长（帧）：**这是元素出现多久，不是出场动画时长**。不传或传 -1 = 按当时幕长落库（看起来是撑到场景结尾）。" +
            "⚠ 幕长以后被拉长（重新配音等）时，元素**不会**自动跟着变长，会停在旧幕长那一刻——要么先定幕长再放元素，要么回来改这个值",
        ),
      muted: z.boolean().optional().describe("是否静音：视频/音频默认 false（不传就出声）"),
      loop: z.boolean().optional().describe("视频是否循环，默认 false（循环视频在时间轴上可以无限拉长）"),
      audioSrc: z.string().optional().describe("音频元素：/assets/xxx.wav（先 upload_asset）或 https 地址"),
      startFrom: z.number().int().min(0).optional().describe("从素材第几帧开始播（视频/音频通用，跳过文件开头，如旁白前的空白）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      // 组装逻辑与批量 apply_ops 共用 composeElement：libraryId 解析、kind 推导、
      // 音视频按素材真实时长 —— 只有一份实现，不会两条路径越改越不一样
      const { element, sceneId } = await composeElement(a as Record<string, unknown>, p);
      await api(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "add_element", sceneId, element }],
        }),
      });
      return `已放入元素 ${element.id}「${element.name}」到场景 ${sceneId}（${element.kind}，位置 ${element.x}% / ${element.y}%）`;
    },
  },
  {
    name: "update_element",
    description:
      "修改场景里的自由元素：位置、尺寸、旋转、透明度、颜色/背景色、文字、图层、场景内时间、入出场特效；音频元素还能换音源、调音量。用户刚放进去的元素也能改，改完用户界面会实时更新。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string().describe("元素所在场景"),
      elementId: z.string().describe("元素 id（get_project 里能看到）"),
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      size: z.number().optional(),
      rotate: z.number().optional(),
      scale: z.number().optional(),
      opacity: z.number().optional(),
      z: z.number().optional(),
      fill: z.string().optional(),
      text: z.string().optional(),
      svg: z.string().optional().describe("换矢量图形的内部标记（不同造型不用删了重加）"),
      viewBox: z.string().optional().describe("配合 svg，默认 0 0 24 24"),
      stroke: z.boolean().optional().describe("svg 用描边还是填充"),
      strokeWidth: z.number().optional(),
      bg: z.string().optional(),
      weight: z.number().optional(),
      radius: z.number().optional().describe("圆角（短边百分比）"),
      border: z.number().optional().describe("边框宽度（短边百分比）"),
      borderColor: z.string().optional(),
      shadow: z.string().optional(),
      filter: z.string().optional(),
      blendMode: z.string().optional(),
      clipPath: z.string().optional(),
      fit: z.enum(["cover", "contain", "fill"]).optional(),
      fontFamily: z.string().optional(),
      lineHeight: z.number().optional(),
      letterSpacing: z.number().optional(),
      textAlign: z.enum(["left", "center", "right"]).optional(),
      fontStyle: z.enum(["normal", "italic"]).optional(),
      underline: z.boolean().optional(),
      maxWidth: z.number().optional(),
      strokeLinecap: z.enum(["butt", "round", "square"]).optional(),
      strokeLinejoin: z.enum(["miter", "round", "bevel"]).optional(),
      style: z.record(z.any()).optional().describe("自定义内联样式（camelCase 键，最后应用）"),
      imageSrc: z.string().optional(),
      videoSrc: z.string().optional().describe("替换视频元素的视频地址"),
      audioSrc: z.string().optional().describe("替换音频元素的音源（如换一段 TTS 配音）"),
      audioVolume: z.number().min(0).max(MAX_VOLUME).optional().describe("音频元素音量：1 = 原音，可到 5（+14 dB）"),
      muted: z.boolean().optional().describe("是否静音（音频/视频通用，时间轴的声音开关就是它）"),
      loop: z.boolean().optional().describe("视频是否循环"),
      startFrom: z.number().int().min(0).optional().describe("从素材第几帧开始播（跳过文件开头，如旁白前的空白）"),
      enter: EFFECT_DESC.optional().describe("入场特效：{type,durationInFrames}；type=none 关闭"),
      exit: EFFECT_DESC.optional().describe("出场特效：{type,durationInFrames}；type=none 关闭"),
      from: z.number().int().min(0).optional().describe("场景内起点（帧）"),
      durationInFrames: z
        .number()
        .int()
        .optional()
        .describe("场景内时长（帧）：这是元素出现多久。不传或传 -1 = 撑到场景结尾"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const patch: Record<string, unknown> = {};
      const entries: [string, unknown][] = [
        ["name", a.name],
        ["x", a.x],
        ["y", a.y],
        ["size", a.size],
        ["rotate", a.rotate],
        ["scale", a.scale],
        ["opacity", a.opacity],
        ["z", a.z],
        ["fill", a.fill],
        ["text", a.text],
        ["bg", a.bg],
        ["weight", a.weight],
        ["src", a.audioSrc ?? a.videoSrc ?? a.imageSrc],
        ["svg", a.svg],
        ["viewBox", a.viewBox],
        ["stroke", a.stroke],
        ["strokeWidth", a.strokeWidth],
        ["audioVolume", a.audioVolume],
        ["muted", a.muted],
        ["loop", a.loop],
        ["startFrom", a.startFrom],
        ["enter", a.enter],
        ["exit", a.exit],
        ["from", a.from],
        ["durationInFrames", a.durationInFrames === -1 ? -1 : a.durationInFrames],
      ];
      for (const [k, v] of entries) if (v !== undefined) patch[k] = v;
      // 换了音源/视频源又没显式给时长 → 按新素材真实时长更新块长
      if ((a.audioSrc || a.videoSrc) && a.durationInFrames === undefined) {
        const frames = await probedDurationFrames(
          (a.audioSrc ?? a.videoSrc) as string,
          p.fps ?? 30,
        );
        if (frames) patch.durationInFrames = frames;
      }
      if (!Object.keys(patch).length) throw new Error("没有任何要改的字段");

      const res = await api<{ project: ProjectLite; summary: string[] }>(
        `/api/projects/${p.id}/ops`,
        {
          method: "POST",
          body: JSON.stringify({
            actor: "agent",
            ops: [{ op: "update_element", sceneId: a.sceneId, elementId: a.elementId, patch }],
          }),
        },
      );
      return res.summary.join("；") || "已更新";
    },
  },
  {
    name: "update_freeform_element",
    description:
      "局部更新 freeform 场景里的一个元素（按 elementId 或 index），不用重发整个 elements 数组。patch 只写要改的字段（text/x/y/size/fill/bg/border/style/anim…）。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string(),
      elementId: z.string().optional().describe("元素的 id（freeform elements[].id）"),
      index: z.number().int().min(0).optional().describe("没有 id 时按下标（从 0 开始）"),
      patch: z.record(z.any()).describe("只写要改的字段"),
    },
    run: async (a) => {
      if (!a.elementId && a.index === undefined) {
        throw new Error("elementId 或 index 至少给一个");
      }
      const p = await resolveProject(a.projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [
            {
              op: "update_freeform_element",
              sceneId: a.sceneId,
              ...(a.elementId ? { elementId: a.elementId } : {}),
              ...(a.index !== undefined ? { index: a.index } : {}),
              patch: a.patch,
            },
          ],
        }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "add_freeform_element",
    description:
      "往 freeform 场景追加一个元素（上限 40 个）。svg 图形、fx 氛围层（glow/noise/dust/beam…）、带 anim 关键帧动画的元素**只能走这里**——add_element 的叠加层通道不支持这些。返回分配的元素 id。常用字段：type(svg/text/shape/image/fx)、x/y(百分比)、size(短边百分比)、from(出现帧)、anim(关键帧，from/to 是绝对值)、viewBox(改 svg 必须一起传，否则内容被压成一个点)。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string(),
      element: z.record(z.any()).describe('完整元素对象，如 {type:"svg", svg:"<svg…>", viewBox:"0 0 920 420", x:50, y:47}'),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const sceneId = a.sceneId ?? p.scenes[0]?.id;
      if (!sceneId) throw new Error("工程里还没有场景");
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "add_freeform_element", sceneId, element: a.element }],
        }),
      });
      const doc = await (await fetch(`${BASE}/api/projects/${p.id}`)).json();
      const scene = (doc.project?.scenes ?? []).find((s: { id: string }) => s.id === sceneId);
      const els = (scene?.props?.elements ?? []) as { id?: string }[];
      const added = els[els.length - 1]?.id;
      return `${res.summary.join("；")}（id=${added ?? "?"}，该幕现有 ${els.length} 个元素）`;
    },
  },
  {
    name: "remove_freeform_element",
    description:
      "删除 freeform 场景里的一个元素（按 elementId 或 index）。freeform 至少要保留一个元素；要清空画面请用 set_scene_type 换版式。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string(),
      elementId: z.string().optional().describe("元素的 id（freeform elements[].id）"),
      index: z.number().int().min(0).optional().describe("没有 id 时按下标（从 0 开始）"),
    },
    run: async (a) => {
      if (!a.elementId && a.index === undefined) {
        throw new Error("elementId 或 index 至少给一个");
      }
      const p = await resolveProject(a.projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [
            {
              op: "remove_freeform_element",
              sceneId: a.sceneId,
              ...(a.elementId ? { elementId: a.elementId } : {}),
              ...(a.index !== undefined ? { index: a.index } : {}),
            },
          ],
        }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "remove_element",
    description: "删除场景里的自由元素。模板元素不能删，这个方法只作用于自由元素层。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string(),
      elementId: z.string(),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "remove_element", sceneId: a.sceneId, elementId: a.elementId }],
        }),
      });
      return res.summary.join("；") || "已删除";
    },
  },
  {
    name: "export_project",
    description:
      "把工程导出成本机 .zip 工程包（含 project.json、assets、manifest），默认写到 out/project-bundles/。用于备份、换机器或发给别人；导出后把路径告诉用户。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      path: z.string().optional().describe("保存路径（.zip）；不传则写 out/project-bundles/<工程名>.zip"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await fetch(`${BASE}/api/projects/${p.id}/export`);
      if (!res.ok) throw new Error(`导出失败（${res.status}）`);
      const buf = Buffer.from(await res.arrayBuffer());
      const safe = (p.name || p.id).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || p.id;
      const file = a.path ? path.resolve(a.path) : path.join(ROOT, "out", "project-bundles", `${safe}.zip`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      return `已导出「${p.name}」到 ${file}（${(buf.length / 1024).toFixed(0)} KB，含素材）`;
    },
  },
  {
    name: "import_project",
    description:
      "从本机 .zip 工程包导入成一个新工程（id 会重新生成，不覆盖现有工程）。导入后返回新工程 id；Web 端要用户自己在工程菜单里切过去。",
    shape: {
      path: z.string().describe("本机 .zip 路径（export_project 产出的，或用户给的工程包）"),
      name: z.string().optional().describe("新工程名，不传用包里的名字"),
    },
    run: async (a) => {
      const file = path.resolve(a.path);
      if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(file)], { type: "application/zip" }), path.basename(file));
      const res = await fetch(`${BASE}/api/projects/import`, { method: "POST", body: form });
      const data = (await res.json()) as { project?: any; error?: string; warnings?: string[] };
      if (!res.ok || !data.project) throw new Error(data.error ?? `导入失败（${res.status}）`);
      if (a.name?.trim()) {
        await api(`/api/projects/${data.project.id}/ops`, {
          method: "POST",
          body: JSON.stringify({
            actor: "agent",
            ops: [{ op: "update_project", patch: { name: a.name.trim() } }],
          }),
        });
        data.project.name = a.name.trim();
      }
      setCurrentProject(data.project.id); // 导入的工程就是要接着干的工程
      const warn = data.warnings?.length ? `\n注意：${data.warnings.join("；")}` : "";
      return `已导入工程「${data.project.name}」（id=${data.project.id}，${data.project.scenes.length} 个场景，rev=1），并已切换为当前工程。${warn}`;
    },
  },
  {
    name: "restore_rev",
    description:
      "把工程回滚到某个历史 rev（磁盘快照，保留最近 50 个）。先用 get_history 看有哪些 rev 带 snapshot。回滚本身也会记一条新历史，可以再回滚回来。",
    shape: {
      rev: z.number().int().positive().describe("目标 rev，见 get_history"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<{ project: ProjectLite; summary: string[] }>(
        `/api/projects/${p.id}/restore/${a.rev}`,
        { method: "POST" },
      );
      return `已回滚到 rev ${a.rev}，当前 rev=${res.project.rev}。${res.summary.join("；")}`;
    },
  },
  {
    name: "layout_grid",
    description:
      "纯计算：把 N 个元素排成网格，返回每个元素的中心坐标和尺寸（画面百分比）。配合 add_element / apply_ops 用，省得手算坐标。不写工程。",
    shape: {
      count: z.number().int().min(1).max(24).describe("要排几个"),
      cols: z.number().int().min(1).max(6).optional().describe("列数，默认 2"),
      gap: z.number().min(0).max(20).optional().describe("格子间距（百分比），默认 4"),
      area: z
        .object({
          x1: z.number(),
          x2: z.number(),
          y1: z.number(),
          y2: z.number(),
        })
        .optional()
        .describe("可用区域（百分比），默认 x 8-92 / y 8-92"),
      sizeRatio: z
        .number()
        .min(0.2)
        .max(1)
        .optional()
        .describe("元素尺寸占格子短边的比例，默认 0.85"),
    },
    run: async (a) => {
      const count = a.count;
      const cols = Math.max(1, Math.min(count, a.cols ?? 2));
      const rows = Math.ceil(count / cols);
      const gap = a.gap ?? 4;
      const area = a.area ?? { x1: 8, x2: 92, y1: 8, y2: 92 };
      const cw = (area.x2 - area.x1 - gap * (cols - 1)) / cols;
      const ch = (area.y2 - area.y1 - gap * (rows - 1)) / rows;
      const ratio = a.sizeRatio ?? 0.85;
      const cells = Array.from({ length: count }, (_, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        return {
          x: Number((area.x1 + col * (cw + gap) + cw / 2).toFixed(1)),
          y: Number((area.y1 + row * (ch + gap) + ch / 2).toFixed(1)),
          size: Number(Math.max(4, Math.min(34, Math.min(cw, ch) * ratio)).toFixed(1)),
        };
      });
      return JSON.stringify(cells);
    },
  },
  {
    name: "align_elements",
    description:
      "把场景里几个元素对齐/等距分布：left/centerX/right/top/centerY/bottom/distributeX/distributeY。按元素中心坐标操作（尺寸差异大时边缘可能不齐），直接写库。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string().describe("元素所在场景"),
      elementIds: z.array(z.string()).describe("要操作的元素 id 列表（≥2）"),
      mode: z
        .enum([
          "left",
          "centerX",
          "right",
          "top",
          "centerY",
          "bottom",
          "distributeX",
          "distributeY",
        ])
        .describe("对齐方式"),
    },
    run: async (a) => {
      if (a.elementIds.length < 2) throw new Error("至少给两个元素");
      const p = await resolveProject(a.projectId);
      const scene = p.scenes.find((s) => s.id === a.sceneId);
      if (!scene) throw new Error(`没有场景 ${a.sceneId}`);
      const els = (scene.elements ?? []).filter((e) => a.elementIds.includes(e.id));
      if (els.length < 2) throw new Error("场景里没找到这些元素（检查 id 和 sceneId）");
      const pick = (e: any) => ({ id: e.id, x: e.x ?? 50, y: e.y ?? 52, size: e.size ?? 20 });

      if (a.mode === "distributeX" || a.mode === "distributeY") {
        const axis = a.mode === "distributeX" ? "x" : "y";
        const sorted = els.map(pick).sort((u, v) => u[axis] - v[axis]);
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const step = (last[axis] - first[axis]) / (sorted.length - 1);
        const patches = sorted.map((e, i) => ({
          id: e.id,
          value: Number((first[axis] + step * i).toFixed(1)),
        }));
        const ops = patches.map((pt) => ({
          op: "update_element" as const,
          sceneId: a.sceneId,
          elementId: pt.id,
          patch: { [axis]: pt.value } as Record<string, number>,
        }));
        const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({ actor: "agent", ops }),
        });
        return res.summary.join("；");
      }

      const list = els.map(pick);
      const xs = list.map((e) => e.x);
      const ys = list.map((e) => e.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      let targetX: number | null = null;
      let targetY: number | null = null;
      switch (a.mode) {
        case "left":
          targetX = minX;
          break;
        case "centerX":
          targetX = (minX + maxX) / 2;
          break;
        case "right":
          targetX = maxX;
          break;
        case "top":
          targetY = minY;
          break;
        case "centerY":
          targetY = (minY + maxY) / 2;
          break;
        case "bottom":
          targetY = maxY;
          break;
      }
      const ops = list.map((e) => ({
        op: "update_element" as const,
        sceneId: a.sceneId,
        elementId: e.id,
        patch:
          targetX != null
            ? { x: Number(targetX.toFixed(1)) }
            : { y: Number((targetY as number).toFixed(1)) },
      }));
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      return res.summary.join("；");
    },
  },
  {
    name: "confirm_brief",
    description:
      "记录「用户已确认需求」。9 步问完后，把 brief 总结发给用户，用户确认后调用它；没有确认过，build_storyboard 会拒绝。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      summary: z
        .string()
        .optional()
        .describe("发给用户确认的那份总结（可选，便于留档）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const brief = confirmBrief(p.id);
      const nl = String.fromCharCode(10);
      return (
        `需求已确认（${brief.confirmedAt}）${a.summary ? `${nl}确认单：${a.summary}` : ""}` +
        `${nl}下一步：list_styles 选风格 → save_storyboard 写分镜`
      );
    },
  },
  {
    name: "check_project",
    description:
      "只读诊断：场景/时长/文案/音频/字幕/素材的潜在问题，返回清单（不改工程）。交付前或每轮修改后跑一次，按提示修。",
    shape: { projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const issues: string[] = [];
      const scenes = p.scenes ?? [];
      if (!scenes.length) issues.push("⚠️ 工程没有场景");

      const total = totalDuration(p as any);
      const spans = sceneSpans(scenes as any[]);
      const KEY_TEXT = ["title", "heading", "text", "quote", "leftTitle", "rightTitle", "value"];

      for (const sc of scenes as any[]) {
        if (sc.durationInFrames < 30) {
          issues.push(`⚠️「${sc.name}」只有 ${sc.durationInFrames} 帧，短到看不清`);
        }
        const props = sc.props ?? {};
        const isFreeform =
          sc.type === "freeform" && Array.isArray((props as any).elements) && (props as any).elements.length > 0;
        const hasText =
          isFreeform ||
          KEY_TEXT.some((k) => typeof props[k] === "string" && props[k].trim()) ||
          (sc.elements ?? []).some((e: any) => e.kind === "text" && String(e.text ?? "").trim());
        if (!hasText) issues.push(`ℹ️「${sc.name}」没有文案（空场景？）`);
        const hasAudio = (sc.elements ?? []).some((e: any) => e.kind === "audio");
        if (hasAudio && !String(sc.subtitle ?? "").trim()) {
          issues.push(`ℹ️「${sc.name}」有旁白但没有字幕（set_subtitle 或 tts_narration）`);
        }
      }

      // 多轨：同轨重叠 / 画中画挂旁白 / 画中画忘了缩小
      const byTrack = new Map<number, typeof spans>();
      for (const sp of spans) {
        const list = byTrack.get(sp.track) ?? [];
        list.push(sp);
        byTrack.set(sp.track, list);
      }
      for (const [track, list] of byTrack) {
        list.sort((a, b) => a.start - b.start);
        for (let i = 1; i < list.length; i++) {
          if (list[i].start < list[i - 1].end) {
            const prev = (scenes as any[]).find((s) => s.id === list[i - 1].id)?.name;
            const cur = (scenes as any[]).find((s) => s.id === list[i].id)?.name;
            issues.push(
              `⚠️ 轨道 ${track}：「${prev}」和「${cur}」时间重叠（同轨只能串行，要叠着放请 move_scene 换轨道）`,
            );
          }
        }
      }
      for (const sc of scenes as any[]) {
        const track = sc.track ?? 0;
        if (track <= 0 && !sc.box) continue;
        if ((sc.elements ?? []).some((e: any) => e.kind === "audio")) {
          issues.push(`ℹ️「${sc.name}」是画中画但挂了旁白：所有轨道的声音都会播，容易和主轨撞车`);
        }
        if (track > 0 && !sc.box) {
          issues.push(
            `ℹ️「${sc.name}」在轨道 ${track} 但仍是全屏大小，会把下面的画面整块盖住（用 set_scene_box 缩小）`,
          );
        }
      }

      // 素材缺失
      const refs = new Set<string>();
      for (const sc of scenes as any[]) {
        for (const el of sc.elements ?? []) {
          if (typeof el.src === "string" && el.src.startsWith("/assets/")) refs.add(el.src);
        }
      }
      const proj = p as any;
      if (proj.audio?.src) refs.add(String(proj.audio.src));
      for (const t of proj.audioTracks ?? []) {
        if (typeof t?.src === "string" && t.src.startsWith("/assets/")) refs.add(t.src);
      }
      for (const src of refs) {
        const file = path.join(ROOT, "public", src.replace(/^\/+/, ""));
        if (!fs.existsSync(file)) issues.push(`⚠️ 素材缺失：${src}`);
      }

      // freeform 元素级体检（踩坑清单第 2 轮 §3/§9 的手写脚本，内置成诊断）：
      // 提前消失 / 永不出现 / 空 svg / 可疑 viewBox / 同幕 y 不一致
      for (const sc of scenes as any[]) {
        if (sc.type !== "freeform") continue;
        const els = (sc.props?.elements ?? []) as any[];
        if (!els.length) continue;
        const dur = Number(sc.durationInFrames) || 0;
        const ys = new Set<number>();
        els.forEach((el, i) => {
          const label = el.id ? `元素 ${el.id}` : `元素 #${i + 1}`;
          const isAmbient = el.type === "fx" || el.id === "paper" || el.id === "bg";
          const from = Number(el.from ?? 0);
          const d = el.durationInFrames === undefined ? undefined : Number(el.durationInFrames);
          if (from >= dur) {
            issues.push(`⚠️「${sc.name}」${label} 起点 ${from} ≥ 幕长 ${dur}，永远不会出现（from 要 < 幕长）`);
          } else if (d !== undefined && dur - (from + d) > 3) {
            issues.push(
              `⚠️「${sc.name}」${label} 在第 ${from + d} 帧提前消失（幕长 ${dur} 帧）。` +
                `想一直显示到幕尾就不要传 durationInFrames（或传到幕尾的帧数）`,
            );
          }
          if (el.type === "svg") {
            if (!el.svg) issues.push(`⚠️「${sc.name}」${label} 是 svg 但没有 svg 内容（空元素）`);
            else if (String(el.viewBox ?? "0 0 24 24") === "0 0 24 24" && String(el.svg).length > 150) {
              issues.push(
                `⚠️「${sc.name}」${label} 的 viewBox 还是默认值 0 0 24 24，但 svg 内容不小 —— ` +
                  `不是 24×24 图标的话整层会被压成一个点（update 时 svg 和 viewBox 要一起传）`,
              );
            }
          }
          if (!isAmbient) ys.add(Number(el.y ?? 50));
        });
        if (ys.size > 1) {
          issues.push(
            `ℹ️「${sc.name}」freeform 元素的 y 有 ${[...ys].sort((a, b) => a - b).join(" / ")} 多个值 —— ` +
              `同一行内容差 5%（约 27px）就会错开成两行，同一行请统一成同一个 y`,
          );
        }
      }

      // 音频超出可用时长
      for (const sc of scenes as any[]) {
        for (const el of sc.elements ?? []) {
          if (el.kind !== "audio" || typeof el.src !== "string" || !el.src.startsWith("/assets/")) continue;
          const pr = await probeOne(el.src);
          const room = Math.max(1, sc.durationInFrames - (el.from ?? 0));
          if (pr && pr.frames > room + 2) {
            issues.push(
              `⚠️「${sc.name}」旁白 ${pr.frames} 帧 > 场景可用 ${room} 帧，后面会被截断（set_scene_timing 改场景时长）`,
            );
          }
        }
      }

      const nl = String.fromCharCode(10);
      const head = `工程「${p.name}」：${scenes.length} 场景 / ${total} 帧（${(total / (p.fps || 30)).toFixed(1)}s）`;
      if (!issues.length) return `${head}${nl}✅ 没有发现明显问题。${nl}自检清单见 get_guide(\"qa\")`;
      return `${head}${nl}发现 ${issues.length} 条：${nl}${issues.join(nl)}`;
    },
  },
  {
    name: "intake",
    description:
      "9 步需求问诊：不传 step 返回全部步骤总览；传 step 返回那一步该问用户的问题、必填项、当前已填/未填。\n两种用法：① 逐条问，每步 save_brief(step=N)；② 已经把信息问全了，一次 save_brief 传齐全部字段（不传 step），再 intake 看还缺什么。",
    shape: {
      step: z.number().int().min(1).max(9).optional().describe("第几步（1–9），不传看总览"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const nl = String.fromCharCode(10);
      const p = await resolveProject(a.projectId);
      const brief = readBrief(p.id);
      const progress = briefProgress(brief);

      if (!a.step) {
        return [
          "9 步需求问诊（一步一问，问完 save_brief(step=N)）：",
          ...BRIEF_STEPS.map(
            (s) => `${s.no}. ${s.title}（必填：${s.required.map(([, l]) => l).join("、")}）`,
          ),
          "",
          brief
            ? `当前进度：${progress.done.length}/9${progress.finished ? "（已问完）" : `，下一步第 ${progress.next} 步`}`
            : "还没有 brief：从第 1 步开始。",
        ].join(nl);
      }

      const step = BRIEF_STEPS.find((s) => s.no === a.step);
      if (!step) throw new Error(`没有第 ${a.step} 步（1–9）`);
      const missing = stepMissingFields(step.no, brief);
      return [
        `第 ${step.no} 步：${step.title}`,
        "必填：" + step.required.map(([, l]) => l).join("、"),
        "要问用户：",
        ...step.questions.map((q) => `- ${q}`),
        "",
        missing.length
          ? `还缺：${missing.join("、")}——问完用 save_brief(step=${step.no}, ...) 保存`
          : "这一步需要的都填了，可以 save_brief(step=" + step.no + ") 标记完成",
        `进度：${progress.done.length}/9`,
      ].join(nl);
    },
  },
  {
    name: "save_brief",
    description:
      "保存创作需求（开工前先问用户，确认后落盘）。**带 step 时会校验该步必填**（如 step=2 必须有 durationSec），缺了报错；**不传 step 则不强制必填**，字段齐不齐用 intake 看进度（进度按字段是否齐判断，不看 step 标记）。\n之后随时 get_brief 对照。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      step: z
        .number()
        .int()
        .min(1)
        .max(9)
        .optional()
        .describe("第几步（1–9）。按步保存：每步只校验该步必填项，并记录进度"),
      goal: z.string().optional().describe("要达成什么"),
      format: z
        .string()
        .optional()
        .describe("用途类型（get_guide(\"formats\") 的 A–I，如「B 产品宣传」）——写分镜前先按它定结构"),
      benchmark: z.string().optional().describe("对标：1–2 个参考作品，学什么 / 不学什么"),
      structure: z.string().optional().describe("3 个候选结构 → 选哪个、为什么"),
      signals: z.array(z.string()).optional().describe("风格辨识信号：挑 2–3 个，翻掉哪些俗套"),
      takeaway: z.string().optional().describe("观众记住的一句话或一个画面"),
      hook: z.string().optional().describe("前 1 秒发生什么"),
      signature: z.string().optional().describe("记忆点：第几秒、什么手法"),
      palette: z.string().optional().describe("配色（具体色值或风格）"),
      type: z.string().optional().describe("字体/排版方案"),
      motion: z.string().optional().describe("运动气质"),
      texture: z.string().optional().describe("材质/纹理"),
      forbidden: z.array(z.string()).optional().describe("这支片子的禁止清单"),
      audience: z.string().optional().describe("给谁看"),
      platform: z.string().optional().describe("投放平台（抖音/小红书/B站/视频号）"),
      durationSec: z.number().optional().describe("目标时长（秒）"),
      aspect: z.string().optional().describe("画幅，如 9:16 / 16:9 / 1:1"),
      style: z.string().optional().describe("风格：色调、节奏、参考对标"),
      layoutMode: z
        .string()
        .optional()
        .describe("版式体系：内置场景（39 种现成版式）/ 自由画布 freeform / 混合"),
      mustInclude: z.array(z.string()).optional().describe("必须出现的信息"),
      avoid: z.array(z.string()).optional().describe("禁止出现的词/竞品/品牌规范"),
      assetsNote: z.string().optional().describe("可用素材情况"),
      voice: z.string().optional().describe("配音：音色/语言/语速/是否要字幕"),
      music: z.string().optional().describe("BGM 风格与音量"),
      soundPlan: z
        .string()
        .optional()
        .describe("声音计划：BGM/音效来源（素材库/用户提供/关闭）、情绪曲线、人声避让（get_guide(\"sound\")）"),
      delivery: z.string().optional().describe("交付要求：格式/画幅/字幕/封面"),
      pace: z.string().optional().describe("节奏：快剪 / 慢叙 / 卡点"),
      versions: z.string().optional().describe("版本数量：只竖屏 / 竖+横 / 多语言"),
      copySource: z.string().optional().describe("文案来源：用户给稿 / agent 写 / 改写已有"),
      assetConstraints: z.string().optional().describe("素材约束：版权 / 品牌规范"),
      subtitle: z.string().optional().describe("字幕方式：硬字幕 / 只出 SRT / 都不要"),
      brandRules: z.string().optional().describe("品牌规范（没有写「无」）"),
      release: z.string().optional().describe("发布限制（可公开 / 敏感信息）"),
      languages: z.string().optional().describe("多语言版本"),
      deadline: z.string().optional().describe("什么时候要"),
      notes: z.string().optional().describe("其他补充"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      // projectId 只是定位工程，不写进 brief
      const { projectId: _ignored, step: _step, ...briefFields } = a;
      // 9 步问诊：按 step 校验那一步的必填项，缺了不落盘，逼 agent 回去问用户
      const step = a.step;
      const fields: Record<string, unknown> = { ...briefFields };
      if (step !== undefined) {
        if (step < 1 || step > 9) throw new Error(`step 只能是 1–9（收到 ${step}）`);
        const merged = { ...(readBrief(p.id) ?? {}), ...fields } as Brief;
        const missing = stepMissingFields(step, merged);
        if (missing.length) {
          throw new Error(
            `第 ${step} 步还缺必填：${missing.join("、")}。先问用户，补齐后 save_brief(step=${step}, ...)。`,
          );
        }
        fields.steps = [step];
      }
      const { brief } = await api<{ brief: unknown }>(`/api/projects/${p.id}/brief`, {
        method: "PUT",
        body: JSON.stringify(fields),
      });
      const progress = briefProgress(brief as never);
      const nextTip = progress.finished
        ? `需求问完了 ✅ 现在把 9 步总结发给用户确认（目标/时长/画幅/风格/必讲内容/音频/交付/禁止项），` +
          `用户点头后调用 confirm_brief，之后才能 save_storyboard / build_storyboard`
        : `下一步：intake(${progress.next}) 问第 ${progress.next} 步`;
      return `已保存 brief（工程 ${p.id}）` + String.fromCharCode(10) + briefToText(brief as never) + String.fromCharCode(10) + nextTip;
    },
  },
  {
    name: "get_brief",
    description: "读取创作需求 brief（开工前/创作中对照用）。",
    shape: { projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      return briefToText(readBrief(p.id));
    },
  },
  {
    name: "save_storyboard",
    description:
      "保存分镜表（brief 之后、搭场景之前的计划）：每幕给 type / props / durationInFrames / text（口播字幕）/ note。先确认分镜，再 build_storyboard 一次建成。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      shots: z
        .array(
          z.object({
            type: z.string().describe("场景类型，见 list_scene_types"),
            name: z.string().optional(),
            durationInFrames: z.number().int().optional().describe("不传按类型默认"),
            props: z.record(z.any()).optional().describe("场景业务数据（直传 add_scene 的 props）"),
            text: z.string().optional().describe("这一幕的口播/字幕文本（一行一句）"),
            change: z
              .string()
              .optional()
              .describe("连续叙事三问①：这一幕让观众看懂什么变化（get_guide(\"craft\") §3）"),
            carry: z.string().optional().describe("连续叙事三问②：从上一幕承接什么（主体/位置/颜色）"),
            note: z.string().optional().describe("给自己的备注：要传达什么"),
          }),
        )
        .min(1)
        .describe("分镜：一幕一项，顺序就是出场顺序"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      // 写分镜时就按各类型 schema 校验，别等 build 整批原子失败
      for (const [i, shot] of a.shots.entries()) {
        const meta = getMeta(shot.type);
        if (!meta) throw new Error(`第 ${i + 1} 幕：未知场景类型「${shot.type}」（先 list_scene_types）`);
        const parsed = meta.schema.safeParse({ ...meta.defaultProps, ...(shot.props ?? {}) });
        if (!parsed.success) {
          const errs = parsed.error.issues
            .map((e) => `${e.path.join(".") || "(根)"}：${e.message}`)
            .join("；");
          throw new Error(`第 ${i + 1} 幕（${shot.type}）props 校验失败：${errs}`);
        }
      }
      const sb = saveStoryboard(p.id, { shots: a.shots as Storyboard["shots"] });
      return `已保存分镜表${String.fromCharCode(10)}${storyboardToText(sb)}${String.fromCharCode(10)}下一步：确认分镜后 build_storyboard 一次建成（会顺带写字幕）`;
    },
  },
  {
    name: "get_storyboard",
    description: "读取当前分镜表（开工前/搭建中对照用）。",
    shape: { projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      return storyboardToText(readStoryboard(p.id));
    },
  },
  {
    name: "build_storyboard",
    description:
      "按分镜表一次建成场景：每幕 add_scene（type/props/时长/名字），口播文本写成字幕，并把 sceneId 回填分镜。replace=true 会先清掉工程现有场景。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      replace: z.boolean().optional().describe("先删掉工程现有场景再建（默认 false：追加）"),
      attachSubtitle: z.boolean().optional().describe("把每幕 text 写成字幕，默认 true"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      // 需求 9 步没问完就不许开建（重要配置不能自己定）
      const brief = readBrief(p.id);
      const progress = briefProgress(brief);
      if (!progress.finished) {
        throw new Error(
          `需求还没问完（${progress.done.length}/9），下一步该问第 ${progress.next} 步。` +
            `先用 intake(${progress.next}) 看要问什么，save_brief(step=${progress.next}) 逐步补齐，再 build_storyboard。`,
        );
      }
      if (!(brief as any)?.confirmedAt) {
        throw new Error(
          "需求还没请用户确认：把 9 步总结发给用户，用户确认后调用 confirm_brief，再 build_storyboard。",
        );
      }
      const sb = readStoryboard(p.id);
      if (!sb?.shots?.length) throw new Error("还没有分镜表，先用 save_storyboard 写");

      const ops: Record<string, unknown>[] = [];
      if (a.replace) {
        for (const sc of p.scenes ?? []) ops.push({ op: "remove_scene", sceneId: sc.id });
      }
      for (const shot of sb.shots) {
        ops.push({
          op: "add_scene",
          type: shot.type,
          ...(shot.name ? { name: shot.name } : {}),
          ...(shot.durationInFrames ? { durationInFrames: shot.durationInFrames } : {}),
          ...(shot.props ? { props: shot.props } : {}),
        });
      }
      const res = await api<{ createdSceneIds: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      const ids = res.createdSceneIds ?? [];

      if (a.attachSubtitle !== false) {
        const subOps = sb.shots
          .map((shot, i) =>
            shot.text && ids[i]
              ? { op: "set_subtitle", sceneId: ids[i], text: shot.text }
              : null,
          )
          .filter(Boolean);
        if (subOps.length) {
          await api(`/api/projects/${p.id}/ops`, {
            method: "POST",
            body: JSON.stringify({ actor: "agent", ops: subOps }),
          });
        }
      }

      // sceneId 回填，和分镜一一对应
      saveStoryboard(p.id, {
        ...sb,
        shots: sb.shots.map((s, i) => ({ ...s, sceneId: ids[i] })),
      });
      const nl = String.fromCharCode(10);
      return `已按分镜建了 ${ids.length} 幕：${nl}${ids.map((id, i) => `${i + 1}. ${id}（${sb.shots[i]?.type}）`).join(nl)}${nl}下一步：tts_narration 配音（applyToScenes=true 自动对齐场景时长和字幕）`;
    },
  },
  {
    name: "delete_template",
    description:
      "删除「我的模板」（不可撤销，内置模板删不掉）。id 见 list_templates。文件会向用户确认，agent 调用即代表用户已要求删除。",
    shape: {
      templateId: z.string().describe("模板 id（tpl_ 开头，list_templates 里查）"),
    },
    run: async (a) => {
      const res = await api<{ ok: boolean }>(`/api/templates/${a.templateId}`, { method: "DELETE" });
      return `已删除模板 ${a.templateId}（ok=${res.ok}）。用 list_templates 确认。`;
    },
  },
  {
    name: "delete_asset",
    description:
      "从素材库删除一个素材条目并回收文件（不可撤销）。仍在被工程引用的文件会自动保留，只删条目。删除前建议先和用户确认。",
    shape: {
      assetId: z.string().optional().describe("素材条目 id（list_assets 里查）"),
      id: z.string().optional().describe("同 assetId（别名）"),
    },
    run: async (a) => {
      const id = a.assetId ?? a.id;
      if (!id) throw new Error("缺少 assetId（素材条目 id，list_assets 里查；也认 id）");
      const res = await api<{ removed: any; reclaimed: number }>(`/api/library/${id}`, {
        method: "DELETE",
      });
      const n = Number(res.reclaimed ?? 0);
      const tail = n > 0 ? `，已回收 ${n} 个文件` : "（文件仍被工程引用，只删了条目、文件保留）";
      return `已删除素材条目 ${id}${tail}`;
    },
  },
  {
    name: "delete_project",
    description:
      "删除整个工程（含它的历史快照），不可撤销。demo 示例工程删不掉，只能用「重置 demo」恢复。\n" +
      "会一并清掉它的素材（assets/projects/<id>/）与渲染产物（out/projects/<id>/）；被别的工程或素材库还引用的素材文件会保留。",
    shape: {
      projectId: z.string().describe("要删除的工程 id"),
      confirm: z.boolean().describe("必须显式传 true —— 这是不可撤销的操作"),
    },
    run: async (a) => {
      if (a.confirm !== true) {
        throw new Error("删除工程不可撤销：确认要删再进行，调用时传 confirm: true");
      }
      if (a.projectId === "demo") throw new Error("demo 是示例工程，不能删除");
      // resolveProject 不改指针，prev 一定还是「删除前」的当前工程（v2 N-01 的根因就在这里）
      const prev = lastProjectId;
      const p = await resolveProject(a.projectId);
      const res = await api<{
        assets?: { removed: number; kept: number; freedBytes: number };
        renders?: { removed: number; freedBytes: number };
      }>(`/api/projects/${a.projectId}`, { method: "DELETE" });
      const nl = String.fromCharCode(10);
      const assets = res?.assets;
      const renders = res?.renders;
      const assetLine = [
        assets
          ? `素材目录：清掉 ${assets.removed} 个文件（${formatBytes(assets.freedBytes)}）` +
            (assets.kept ? `，${assets.kept} 个仍被别的工程/素材库引用，保留` : "")
          : "",
        renders && renders.removed
          ? `产物目录：清掉 ${renders.removed} 个成片/关键帧/字幕（${formatBytes(renders.freedBytes)}）`
          : "",
      ]
        .filter(Boolean)
        .join(nl);
      if (prev && prev !== p.id) {
        // 删的是别的工程：指针还原，别把当前工程冲掉
        setCurrentProject(prev);
        return `已删除工程「${p.name}」（id=${p.id}）${nl}${assetLine}${nl}当前工程仍是 ${prev}（未受影响）。`;
      }
      // 删的就是当前工程：明说接下来落在哪个工程上
      const { projects } = await api<{ projects: { id: string; name: string }[] }>("/api/projects");
      const next = projects[0];
      setCurrentProject(next?.id ?? null);
      return (
        `已删除工程「${p.name}」（id=${p.id}）${nl}` +
        assetLine +
        nl +
        (next
          ? `当前工程已切到「${next.name}」（id=${next.id}）——之后不带 projectId 的调用落在这里，要换工程用 switch_project。`
          : "已经没有工程了，用 create_project 新建。")
      );
    },
  },

  /* ───────────── 工具门面：按需发现与执行（其余 75+ 个工具经这两层调用） ───────────── */
  {
    name: "tool_search",
    description:
      "按意图搜索可用工具（常驻只暴露 4 个核心工具，其余 70+ 个从这里找）：返回工具名、完整说明、参数表。找到后用 tool_call(name, args) 执行。传 all=true 看全部工具目录（只有名字与一句话说明）。",
    shape: {
      query: z.string().optional().describe("意图关键词，如：画中画 / 字幕 / 配音 / 历史 / 横屏 / 卡点"),
      all: z.boolean().optional().describe("true = 返回全部工具目录"),
      names: z.array(z.string()).optional().describe("按名字精确取某几个工具的完整文档（含参数表）"),
    },
    run: async (a) => {
      const others = TOOLS.filter((d) => !CORE_TOOL_NAMES.has(d.name));
      if (a.names?.length) {
        const wanted: string[] = a.names;
        const picked = wanted
          .map((n: string) => others.find((d) => d.name === n))
          .filter((d): d is ToolDef => !!d);
        if (!picked.length) throw new Error(`一个都没匹配上（检查拼写）。传 all=true 看全量目录`);
        return JSON.stringify(picked.map(fullDoc));
      }
      if (a.all) {
        return JSON.stringify(others.map((d) => ({ name: d.name, desc: firstLine(d.description) })));
      }
      const q = (a.query ?? "").trim().toLowerCase();
      if (!q) return `传 query 搜工具（如 tool_search("画中画")），或 all=true 看全量目录。`;
      const terms = q.split(/\s+/);
      const aliasNames = new Set(terms.flatMap((t: string) => SEARCH_ALIASES[t] ?? []));
      const scored = others
        .map((d) => {
          const name = d.name.toLowerCase();
          const desc = d.description.toLowerCase();
          let score = 0;
          for (const t of terms) {
            if (name.includes(t)) score += 5;
            else if (desc.includes(t)) score += 3;
          }
          if (aliasNames.has(d.name)) score += 6;
          return { d, score };
        })
        .filter((x) => x.score > 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, 8);
      if (!scored.length) {
        return `没有匹配「${q}」的工具。试试更短的关键词（中文意图词也行，如「字幕」「历史」），或 all=true 看全量目录。意图→能力映射见 get_guide("manual")。`;
      }
      return JSON.stringify(scored.map(({ d }) => fullDoc(d)));
    },
  },
  {
    name: "tool_call",
    description:
      "执行任意已注册工具（配合 tool_search 使用）：tool_call(name=\"preview_frame\", args={...})。参数字段见 tool_search 返回的 params；执行报错带字段级原因，按报错改一次即可。",
    shape: {
      name: z.string().describe("要执行的工具名（来自 tool_search 或 manual 全书）"),
      args: z.record(z.any()).optional().describe("参数对象，字段见该工具的 params"),
    },
    run: async (a) => {
      const name = a.name;
      if (!name || name === "tool_call") throw new Error("tool_call 不能调用自身");
      const def = TOOLS.find((t) => t.name === name);
      if (!def) throw new Error(`没有工具「${name}」。先 tool_search 找（传 all=true 看全量目录），注意拼写`);
      return await def.run(validateToolArgs(def, (a.args ?? {}) as Record<string, unknown>) as never);
    },
  },
];

/** 工具门面：常驻暴露的核心工具；其余工具经 tool_search 发现、tool_call 执行 */
export const CORE_TOOL_NAMES = new Set(["start_guide", "get_guide", "tool_search", "tool_call"]);

/** MCP_EXPOSE=all 时恢复全量暴露（调试用） */
export const exposeAllTools = () => (process.env.MCP_EXPOSE ?? "").trim().toLowerCase() === "all";

const firstLine = (s: string) => s.split("\n")[0].trim();

/* ───────────── 响度辅助：削波提醒（供 set_audio / 音轨工具复用） ───────────── */

/** 音频角色：决定配平的目标响度（人声是主角，BGM 要让位，音效居中） */
type Role = "voice" | "bgm" | "sfx";

type AudioEntry =
  | { kind: "bgm"; label: string; src: string; role: Role; current: number }
  | { kind: "track"; label: string; id: string; src: string; role: Role; current: number }
  | { kind: "element"; label: string; sceneId: string; id: string; src: string; role: Role; current: number };

function collectAudioEntries(
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
type ProjectAssetLite = {
  name: string;
  url: string;
  rel: string;
  kind: "image" | "video" | "audio" | "file";
  bytes: number;
  at: number;
  referenced: boolean;
};

/** 整理旧素材的方案（/api/assets/organize 的返回，只取回执需要的字段） */
type OrganizeResultLite = {
  dryRun: boolean;
  moves: { from: string; to: string; bytes: number; reason: string }[];
  rewrites: { projectId: string; name: string; changed: number }[];
  libraryUpdated: { id: string; name: string; changed: number }[];
  skipped: { rel: string; reason: string }[];
  freedDirs: string[];
  libraryMissing: number;
};

const formatBytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;

type LoudnessLite = {  src: string;
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
async function loudnessOf(src: string): Promise<LoudnessLite | null> {
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
async function clipWarning(src: string, gain: number): Promise<string | null> {
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
 * 静默失败或泄漏 undefined（黑盒验证报告 P1-04~07 的一整类问题）。 */
export function validateToolArgs(def: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const parsed = z.object(def.shape).strict().safeParse(args ?? {});
  if (parsed.success) return parsed.data as Record<string, unknown>;
  const issues: any[] = (parsed.error as any)?.issues ?? [];
  const msgs = issues.map((iss) => {
    if (iss.code === "unrecognized_keys") {
      const keys = (iss.keys ?? []).join("、");
      return `不认识的参数：${keys}（本工具可用：${Object.keys(def.shape).join("、")}）`;
    }
    const p = iss.path?.length ? iss.path.join(".") : "(根)";
    return `参数「${p}」不合法：${iss.message}`;
  });
  throw new Error(`参数校验失败（${def.name}）：${msgs.join("；")}`);
}

/** zod shape → { 参数名?: 说明 }（describe 写在 optional 内外都能取到） */
function paramDocs(shape: Record<string, z.ZodTypeAny>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, t] of Object.entries(shape)) {
    const anyT = t as any;
    const optional = !!anyT?.isOptional?.();
    const inner = anyT?._def?.innerType;
    const desc = anyT?.description ?? inner?.description ?? "";
    out[`${k}${optional ? "?" : ""}`] = desc || "—";
  }
  return out;
}

function fullDoc(d: ToolDef) {
  return { name: d.name, description: d.description, params: paramDocs(d.shape) };
}

/** 中文口语意图 → 工具名别名（搜索加分项；描述里已含的词不用写这里） */
const SEARCH_ALIASES: Record<string, string[]> = {
  画中画: ["move_scene", "set_scene_box"],
  小窗: ["set_scene_box"],
  卡点: ["set_transition", "add_effect"],
  撤销: ["restore_rev", "get_history"],
  找回: ["restore_rev", "get_history"],
  历史: ["get_history", "restore_rev"],
  横屏: ["set_formats"],
  竖屏: ["set_formats"],
  画幅: ["set_formats"],
  配音: ["tts_narration", "tts_synthesize", "set_tts_config"],
  旁白: ["tts_narration"],
  音乐: ["add_audio_track", "update_audio_track"],
  bgm: ["add_audio_track", "update_audio_track"],
  音效: ["add_audio_track", "set_audio"],
  删: ["remove_scene", "remove_element", "delete_project"],
  删除: ["remove_scene", "remove_element", "delete_project"],
  改: ["update_scene", "update_element"],
  加: ["add_scene", "add_element"],
  复制: ["duplicate_scene"],
  顺序: ["reorder_scenes", "move_scene", "compact_main_track"],
  时长: ["set_scene_timing"],
  多版本: ["duplicate_scene"],
  模板: ["list_templates", "save_template"],
  主题: ["set_theme"],
  封面: ["add_scene"],
  尺寸: ["set_formats"],
  比例: ["set_formats"],
  试: ["preview_frame", "preview_frames"],
  抽帧: ["preview_frame", "preview_frames"],
  出片: ["render_video"],
  成片: ["render_video"],
  导出: ["export_project", "export_subtitles"],
  导入: ["import_project", "upload_asset"],
  上传: ["upload_asset"],
  素材: [
    "list_assets",
    "upload_asset",
    "get_asset_info",
    "list_project_assets",
    "delete_project_asset",
    "organize_assets",
    "delete_asset",
  ],
  整理: ["organize_assets"],
  工程素材: ["list_project_assets", "delete_project_asset", "upload_asset"],
  贴纸: ["list_element_library"],
  图标: ["list_element_library"],
  布局: ["layout_grid", "align_elements"],
  对齐: ["align_elements", "layout_grid"],
  排版: ["layout_grid", "align_elements"],
  体检: ["check_project"],
  诊断: ["check_project"],
  自检: ["check_project"],
  记住: ["remember"],
  回忆: ["recall"],
};


/* 同时给 stdio 入口（mcp-proxy.ts）和 HTTP 入口（server/index.ts 的 /mcp）共用 */
export { TOOLS };
export type { ToolDef };

/** 建一个注册好全部工具的 MCP Server（stdio / HTTP 共用）。
 * 门面模式：全部工具保持注册（tool_call 与兼容直调都能执行），
 * 但非核心工具在注册表里标记 enabled=false —— SDK 的 tools/list 只返回 enabled 的，
 * 于是宿主只看到 4 个核心入口。MCP_EXPOSE=all 恢复全量暴露（调试用）。 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "remotion-studio", version: "1.1.0" });
  const exposeAll = exposeAllTools();
  for (const def of TOOLS) {
    const handler = async (args: Record<string, any>) => {
      try {
        const out = await def.run(args ?? {});
        return { content: [{ type: "text" as const, text: text(out) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `失败：${message}` }],
          isError: true,
        };
      }
    };

    const anyServer = server as any;
    if (typeof anyServer.registerTool === "function") {
      // strict schema：未知 key 在 SDK 层就被拒（不会静默剥掉传进 handler）
      anyServer.registerTool(
        def.name,
        { description: def.description, inputSchema: z.object(def.shape).strict() },
        handler,
      );
    } else {
      anyServer.tool(def.name, def.description, def.shape, handler);
    }
  }
  if (!exposeAll) {
    const registered = (server as any)._registeredTools ?? {};
    for (const [name, tool] of Object.entries(registered)) {
      if (!CORE_TOOL_NAMES.has(name)) (tool as any).enabled = false;
    }
  }
  return server;
}
