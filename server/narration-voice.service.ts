import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT as PROJECT_ROOT } from "./root";
import { sceneSpans } from "../shared/schema";
import type { Project } from "../shared/schema";

/**
 * 旁白音频的「事实」视图 + 听过状态。
 *
 * ## 为什么不再用 narration-timing.json 判断
 *
 * `narration-timing` 是 **TTS 的计划骨架**：先合成拿时长、画面还没建。
 * 但配音的真相是**工程里那些 kind:"audio" 且 narration=true 的元素** —— 它们
 * 可以一幕多条、首尾不相连、从整轨里取一段、甚至是 mp3/m4a。
 *
 * 拿计划去判断"用户听过没有"，只要不走 TTS 就全失效（实测：外部音频 → timing 不存在 →
 * 闸口读到 none → 直接放行）。所以这里改成看**事实**。
 *
 * ## 为什么要指纹，而不是"听过一次就永久算数"
 *
 * 用户听的是**某一版音频**。换文件、挪位置、改长度、整片重排导致绝对位置变化 ——
 * 他听到的东西就变了，必须重听。
 * 指纹把这些都算进去：`绝对起始帧 + 文件 + 取片段起点 + 播放长度`。
 *
 * 反过来，只是重建同名场景、音频一点没动 → 指纹不变 → 不用重听。这是为避免
 * 「每次 build_film 都被要求重听一遍」的噪声。
 */

export type NarrationClip = {
  sceneId: string;
  sceneIndex: number;
  elementId: string;
  src: string;
  /** 在成片里的绝对起始帧（场景起点 + 场景内 from） */
  absStart: number;
  /** 场景内起始帧 */
  from: number;
  /** 从文件第几帧开始取 */
  startFrom: number;
  /** 播放长度（帧）；没给就是 null（跟文件时长走） */
  durationInFrames: number | null;
  text?: string;
  name?: string;
};

type LooseEl = {
  id?: string;
  kind?: string;
  src?: string;
  from?: number;
  startFrom?: number;
  durationInFrames?: number;
  narration?: boolean;
  name?: string;
  text?: string;
  muted?: boolean;
};

/** 工程里所有被标记为旁白的音频元素（按绝对位置排序） */
export function listNarrationClips(project: Project): NarrationClip[] {
  const scenes = (project.scenes ?? []) as { id?: string; elements?: LooseEl[] }[];
  const spans = sceneSpans(scenes as never[]);
  const out: NarrationClip[] = [];
  scenes.forEach((s, i) => {
    const span = spans[i];
    for (const el of s.elements ?? []) {
      if (el?.kind !== "audio") continue;
      if (el.narration !== true) continue;
      const from = Number(el.from ?? 0);
      out.push({
        sceneId: String(s.id ?? ""),
        sceneIndex: i,
        elementId: String(el.id ?? ""),
        src: String(el.src ?? ""),
        absStart: Number(span?.start ?? 0) + from,
        from,
        startFrom: Number(el.startFrom ?? 0),
        durationInFrames: el.durationInFrames === undefined ? null : Number(el.durationInFrames),
        text: el.text,
        name: el.name,
      });
    }
  });
  return out.sort((a, b) => a.absStart - b.absStart || a.src.localeCompare(b.src));
}

/**
 * 这一版配音的指纹。
 *
 * 只算「用户实际听到的东西」：什么时候响、响的是哪个文件、从文件哪儿开始、响多久。
 * **不算 elementId / sceneId** —— 重建场景会让这些变，但音频没动时不该要求重听。
 */
export function narrationFingerprint(clips: readonly NarrationClip[]): string {
  if (!clips.length) return "";
  const canon = clips
    .map((c) => `${c.absStart}|${c.src}|${c.startFrom}|${c.durationInFrames ?? "auto"}`)
    .sort()
    .join("\n");
  return crypto.createHash("sha1").update(canon).digest("hex").slice(0, 16);
}

export type VoiceState = {
  fingerprint: string;
  heardAt: string;
  /** 听的是哪一版（= 当时的指纹） */
  heardOf: string;
  heardUserSaid: string;
};

const fileOf = (projectId: string): string => {
  if (!/^[\w-]+$/.test(projectId)) throw new Error("非法的工程 id");
  return path.join(PROJECT_ROOT, "data", "projects", projectId, "narration-voice.json");
};

export function readVoiceState(projectId: string): VoiceState | null {
  const f = fileOf(projectId);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as VoiceState;
  } catch {
    return null;
  }
}

export function markVoiceHeard(projectId: string, fingerprint: string, userSaid: string): VoiceState {
  if (!fingerprint) throw new Error("工程里没有标记为旁白的音频，无从确认「听过」");
  const said = String(userSaid ?? "").trim();
  if (said.length < 5) {
    throw new Error(`要带用户原话（至少 5 字），不是「用户听过了」。收到的是「${said}」`);
  }
  const next: VoiceState = {
    fingerprint,
    heardAt: new Date().toISOString(),
    heardOf: fingerprint,
    heardUserSaid: said,
  };
  const f = fileOf(projectId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * 当前这版配音被听过了吗。
 * - `none`：工程里没有旁白元素（纯图文片 / 还没放配音）→ 不拦
 * - `unheard`：有旁白，但没听过，或听的是旧一版
 * - `heard`：听的就是当前这一版
 */
export function voiceHeardState(
  project: Project,
  projectId: string,
): { state: "none" | "heard" | "unheard"; detail: string; fingerprint: string; clips: NarrationClip[] } {
  const clips = listNarrationClips(project);
  const fp = narrationFingerprint(clips);
  if (!clips.length) return { state: "none", detail: "工程里还没有标记为旁白的音频", fingerprint: "", clips };
  const v = readVoiceState(projectId);
  const total = clips.reduce((n, c) => n + (c.durationInFrames ?? 0), 0);
  const summary = `${clips.length} 条 / 共 ${total} 帧（${(total / (project.fps || 30)).toFixed(1)}s）`;
  if (!v) {
    return { state: "unheard", detail: `配音已就位（${summary}），但用户还没听过`, fingerprint: fp, clips };
  }
  if (v.heardOf !== fp) {
    return {
      state: "unheard",
      detail:
        `用户听过的是旧一版配音（版本 ${v.heardOf}），当前这一版是 ${fp}` +
        `—— 音频换了 / 位置挪了 / 长度变了，得重听`,
      fingerprint: fp,
      clips,
    };
  }
  return { state: "heard", detail: `用户已听过（${v.heardAt}）：${v.heardUserSaid}`, fingerprint: fp, clips };
}
