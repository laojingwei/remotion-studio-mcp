import type { Script } from "./script.service";
import type { Shot, Storyboard } from "./storyboard.service";
import type { NarrationTiming } from "./narration-timing.service";

/**
 * 改稿即改片。
 *
 * 为什么单拎一层：改一段台词，下游有 5 个地方要跟着变（稿件 / 配音 / 幕长 / 字幕 / 分镜），
 * 还有 2 个地方**不能悄悄变**（幕内定时元素、全局音轨的绝对帧位置）。
 * 这些判断放在工具里会变成一坨 if，放在这里可以单独测。
 *
 * 这里只做纯计算：定位要改的段、算幕长落差、列出被影响的元素。
 * 合成、写工程、落盘由工具层决定（那几步要碰 HTTP 和用户确认）。
 */

export type ReviseChange = {
  /** 1 起的段号 */
  segment?: number;
  /** 或者直接给幕 id（稿件里没回填 sceneId 时也能定位） */
  sceneId?: string;
  text: string;
  note?: string;
};

export type ResolvedChange = {
  /** 0 起的段号 */
  index: number;
  /** 这段对应的幕（可能没有：还没建幕） */
  sceneId?: string;
  oldText: string;
  text: string;
  note?: string;
  /** 这段是怎么定位到的：段号 / 稿件里的 sceneId / 分镜表里的 sceneId / 同序号 */
  how: "segment" | "script-scene" | "storyboard-scene" | "storyboard-index";
  changed: boolean;
};

const same = (a: string | undefined, b: string | undefined) => String(a ?? "").trim() === String(b ?? "").trim();

/**
 * 把「用户改的几段」落到具体段号上。
 *
 * 定位优先级：段号 > 稿件 sceneId > 分镜 sceneId > 分镜同序号。
 * 最后一条是真实链路兜底：save_script 的段序和 save_storyboard 的幕序本来就该一致，
 * 而稿件里的 sceneId 只有手工回填过才有。
 */
export function resolveChanges(
  script: Script,
  storyboard: Storyboard | null,
  changes: ReviseChange[],
): ResolvedChange[] {
  const segs = script.segments ?? [];
  if (!segs.length) throw new Error("稿件没有分段：先 save_script 写一版（一段一幕）再来改");
  const shots: Shot[] = storyboard?.shots ?? [];
  const out: ResolvedChange[] = [];
  const seen = new Map<number, number>(); // index -> out 下标（同段改两次取最后一次）

  for (const [n, ch] of changes.entries()) {
    const label = `第 ${n + 1} 条改动`;
    const text = String(ch.text ?? "").trim();
    if (!text) throw new Error(`${label}：text 不能为空（要删掉这一段请用 save_script 重写稿件）`);

    let index = -1;
    let how: ResolvedChange["how"] = "segment";
    if (ch.segment !== undefined) {
      index = Math.round(Number(ch.segment)) - 1;
      if (!Number.isFinite(index) || index < 0 || index >= segs.length) {
        throw new Error(`${label}：segment=${ch.segment} 越界，当前稿件只有 ${segs.length} 段（1–${segs.length}）`);
      }
      how = "segment";
    } else if (ch.sceneId) {
      const i1 = segs.findIndex((s) => s.sceneId === ch.sceneId);
      const i2 = shots.findIndex((s) => s.sceneId === ch.sceneId);
      if (i1 >= 0) {
        index = i1;
        how = "script-scene";
      } else if (i2 >= 0 && i2 < segs.length) {
        index = i2;
        how = "storyboard-scene";
      } else {
        throw new Error(
          `${label}：sceneId=${ch.sceneId} 在稿件和分镜表里都对不上。` +
            `改用 segment=<段号>（1–${segs.length}），或先 get_script 看现有分段`,
        );
      }
    } else {
      throw new Error(`${label}：要给 segment（段号）或 sceneId 来定位改哪一段`);
    }

    const sceneId = ch.sceneId ?? segs[index].sceneId ?? shots[index]?.sceneId;
    const changed = !same(text, segs[index].text) || (ch.note !== undefined && !same(ch.note, segs[index].note));

    const item: ResolvedChange = {
      index,
      sceneId,
      oldText: segs[index].text,
      text,
      note: ch.note ?? segs[index].note,
      how: ch.sceneId && how === "segment" ? "segment" : how,
      changed,
    };
    const prev = seen.get(index);
    if (prev !== undefined) out[prev] = item;
    else {
      seen.set(index, out.length);
      out.push(item);
    }
  }

  // 稳定按段序输出：回执里的顺序要能和稿子对上
  return out.sort((a, b) => a.index - b.index);
}

/** 宽松场景视图：MCP 侧拿到的是工程快照，字段比 zod 模型少（subtitle 等），只取这里要用的 */
export type LooseScene = {
  id: string;
  name: string;
  type?: string;
  durationInFrames?: number;
  elements?: Record<string, unknown>[];
};

/** 本段对应的幕（稿件 → 分镜 → 工程三级兜底） */
export function findSceneOf<T extends { id: string }>(
  sceneId: string | undefined,
  scenes: T[],
): { scene: T; sceneIndex: number } | null {
  if (!sceneId) return null;
  const i = scenes.findIndex((s) => s.id === sceneId);
  return i >= 0 ? { scene: scenes[i], sceneIndex: i } : null;
}

export type ElementImpact = {
  id: string;
  name: string;
  kind: string;
  from: number;
  /** null = 没写时长（跟素材/幕长走），-1 = 撑到幕尾 */
  durationInFrames: number | null;
  /** 幕内结束帧（from + 时长） */
  endsAt: number;
};

export type SceneReflow = {
  sceneId: string;
  sceneName: string;
  sceneIndex: number;
  oldDur: number;
  newDur: number;
  deltaFrames: number;
  /** 会被替换掉的旧旁白条数 */
  narrationCount: number;
  /** 新幕长下被幕尾截断的元素（时长是写死的具体帧数，且 -1 除外） */
  clipped: ElementImpact[];
  /** 起点已越过幕尾 —— 整段看不见 */
  unreachable: ElementImpact[];
  /** 幕变长后元素提前结束，留下空白 */
  earlyEnd: ElementImpact[];
};

/** 幕长变化会牵动谁：逐元素算「还在不在幕内」 */
export function analyzeReflow(scene: LooseScene, newDur: number): SceneReflow {
  const oldDur = Math.max(1, Number(scene.durationInFrames ?? 1));
  const dur = Math.max(1, Math.round(newDur));
  const els = (scene.elements ?? []) as Record<string, unknown>[];
  const clipped: ElementImpact[] = [];
  const unreachable: ElementImpact[] = [];
  const earlyEnd: ElementImpact[] = [];
  let narrationCount = 0;

  for (const el of els) {
    const kind = String(el.kind ?? "");
    if (kind === "audio" && el.narration === true) {
      narrationCount++;
      continue; // 这段音频马上会被新配音替换，不参与排版判断
    }
    const from = Math.max(0, Number(el.from ?? 0));
    const raw = el.durationInFrames;
    const durationInFrames =
      raw === undefined || raw === null ? null : Number(raw) === -1 ? -1 : Math.max(1, Number(raw));
    const endsAt = durationInFrames === -1 || durationInFrames === null ? dur : from + durationInFrames;
    const item: ElementImpact = {
      id: String(el.id ?? ""),
      name: String(el.name ?? kind),
      kind,
      from,
      durationInFrames,
      endsAt,
    };
    if (from >= dur) unreachable.push(item);
    else if (durationInFrames !== -1 && durationInFrames !== null && endsAt > dur) clipped.push(item);
    else if (dur > oldDur && durationInFrames !== null && durationInFrames !== -1 && endsAt < dur) {
      earlyEnd.push(item);
    }
  }

  return {
    sceneId: scene.id,
    sceneName: scene.name,
    sceneIndex: -1,
    oldDur,
    newDur: dur,
    deltaFrames: dur - oldDur,
    narrationCount,
    clipped,
    unreachable,
    earlyEnd,
  };
}

export type TimingPatch = {
  sceneId?: string;
  /** 0 起，按 sceneId 匹配不上时按序号兜底 */
  index: number;
  text: string;
  frames: number;
  suggested: number;
  durationSec: number;
};

/**
 * 把新配音的实测时长并进时间骨架。
 *
 * 只改命中的那几段，其余段原样保留——它们对应的音频没重配，读数还是准的。
 * 返回命中的段数，0 表示这份 timing 和当前稿件不是一套（比如换过工程/产物），
 * 由调用方决定是提示还是重建。
 */
export function mergeTiming(
  timing: NarrationTiming,
  patches: TimingPatch[],
  opts: {
    /**
     * 允许按序号兜底。
     * 由调用方判断「骨架段数 == 稿件段数」再传 true —— 段数一致才敢认为两套是一一对应的，
     * 否则「改第 3 段」可能落到别的段上。
     */
    allowIndexFallback?: boolean;
  } = {},
): { timing: Omit<NarrationTiming, "at">; matched: number } {
  const segs = (timing.segments ?? []).map((s) => ({ ...s }));
  let matched = 0;
  for (const p of patches) {
    let i = p.sceneId ? segs.findIndex((s) => s.sceneId === p.sceneId) : -1;
    if (i < 0 && opts.allowIndexFallback) i = p.index;
    if (i < 0 || i >= segs.length) continue;
    segs[i] = { ...segs[i], text: p.text, frames: p.frames, suggested: p.suggested, durationSec: p.durationSec };
    matched++;
  }
  const fps = Number(timing.fps) > 0 ? Number(timing.fps) : 30;
  const totalSec = segs.reduce((n, s) => n + Number(s.suggested || 0), 0) / fps;
  return {
    timing: { ...timing, segments: segs, totalSec: Math.round(totalSec * 10) / 10 },
    matched,
  };
}

/** 分镜表里要跟着改的幕：先按 sceneId，再按同序号（且该幕还没回填 sceneId） */
export function patchStoryboard(
  storyboard: Storyboard | null,
  patches: { index: number; sceneId?: string; text: string; durationInFrames?: number }[],
): { storyboard: Storyboard; matched: number[]; skipped: number[] } | null {
  if (!storyboard?.shots?.length) return null;
  const shots = storyboard.shots.map((s) => ({ ...s }));
  const matched: number[] = [];
  const skipped: number[] = [];
  for (const p of patches) {
    let i = p.sceneId ? shots.findIndex((s) => s.sceneId === p.sceneId) : -1;
    if (i < 0 && shots.length === storyboard.shots.length && p.index < shots.length && !shots[p.index].sceneId) {
      i = p.index;
    }
    if (i < 0) {
      skipped.push(p.index + 1);
      continue;
    }
    shots[i] = {
      ...shots[i],
      text: p.text,
      ...(p.durationInFrames ? { durationInFrames: p.durationInFrames } : {}),
    };
    matched.push(i + 1);
  }
  return { storyboard: { ...storyboard, shots }, matched, skipped };
}
