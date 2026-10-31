import fs from "node:fs";
import path from "node:path";
import { ROOT as PROJECT_ROOT } from "./root";

/**
 * 旁白时长骨架（TTS 实测，不是估算）。
 *
 * 为什么单独存一份：
 * 复盘里最大的结构性错误是「先排版、后配音」——按 4.5 字/秒估 75 秒，实配 98.3 秒（+31%），
 * 所有转场和动画的帧位全部重算。而 `tts_narration` 其实早就返回了每段的建议帧数，
 * 只是没有任何环节在排版前用它。
 *
 * 这份文件就是这个"用"：先合成拿真实时长，落到这里，再由 save_storyboard 回填幕长。
 * 口播片的时间骨架是配音，不是估算。
 */
export type TimingSegment = {
  index: number;
  text: string;
  /** 这一段的音频长度（帧） */
  frames: number;
  /** 建议幕长（含呼吸位，帧） */
  suggested: number;
  durationSec: number;
  sceneId?: string;
};

export type NarrationTiming = {
  at: string;
  fps: number;
  /** 所有段建议幕长之和 ÷ fps（这是成片的真实骨架） */
  totalSec: number;
  segments: TimingSegment[];
  /**
   * 用户听过这一版配音之后才写。**不是布尔开关，要带原话。**
   *
   * 为什么要它：事故里 5 段配音合成完了、用户一句没听到，
   * agent 就建了 5 幕画面并把幕长锁死在这版语音上。之后改稿 = 全片重排。
   * 所以「用户听过」必须是建幕的前置事实，而不是 agent 的判断。
   */
  heardAt?: string;
  /** 听取的是哪一版（= 当时的 `at`）。重跑 TTS 后 `at` 变，这一项自然失效 */
  heardOf?: string;
  /** 用户听过之后说了什么 —— 唯一有审计价值的字段 */
  heardUserSaid?: string;
};

const fileOf = (projectId: string): string => {
  if (!/^[\w-]+$/.test(projectId)) throw new Error("非法的工程 id");
  return path.join(PROJECT_ROOT, "data", "projects", projectId, "narration-timing.json");
};

export function readTiming(projectId: string): NarrationTiming | null {
  const file = fileOf(projectId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as NarrationTiming;
  } catch {
    return null;
  }
}

export function saveTiming(projectId: string, timing: Omit<NarrationTiming, "at">): NarrationTiming {
  const file = fileOf(projectId);
  const prev = readTiming(projectId);
  const at = new Date().toISOString();
  // 重新合成 = 新的一版音频：上一版的「听过」不自动继承
  // （保留字段但版本对不上，由 narrationHeardState 判失效，比直接删更好审计）
  const next: NarrationTiming = {
    ...timing,
    at,
    heardAt: prev?.heardAt,
    heardOf: prev?.heardOf,
    heardUserSaid: prev?.heardUserSaid,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** 记录「用户听过这一版配音」——必须带原话，不接受纯布尔 */
export function markNarrationHeard(projectId: string, userSaid: string): NarrationTiming {
  const t = readTiming(projectId);
  if (!t) throw new Error("这个工程还没有配音：先 tts_narration 合成，或 register_narration 登记已有音频，再把链接发给用户听");
  const next: NarrationTiming = {
    ...t,
    heardAt: new Date().toISOString(),
    heardOf: t.at,
    heardUserSaid: String(userSaid).trim(),
  };
  const file = fileOf(projectId);
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * 这一版配音「用户听过」了吗？三种状态：
 * - `none`：还没合成过（不需要闸口）
 * - `heard`：听过了，且就是当前这一版
 * - `unheard`：合成过但没听过，或听的是旧版本（重跑过 TTS）
 */
export function narrationHeardState(projectId: string): {
  state: "none" | "heard" | "unheard";
  detail: string;
} {
  const t = readTiming(projectId);
  if (!t) return { state: "none", detail: "还没有合成过配音" };
  if (!t.heardAt) {
    return {
      state: "unheard",
      detail: `配音已经合成（${t.at}，${t.segments.length} 段 / ${t.totalSec.toFixed(1)}s），但用户还没听过`,
    };
  }
  if (t.heardOf !== t.at) {
    return {
      state: "unheard",
      detail:
        `用户听过的是旧版本（听于 ${t.heardOf}），当前这一版是重新合成的（${t.at}）` +
        `—— 稿子改过，重新听一次才能确认`,
    };
  }
  return { state: "heard", detail: `用户已听过（${t.heardAt}）：${t.heardUserSaid ?? ""}` };
}
