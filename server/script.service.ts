import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";

/**
 * 稿件（script）：brief 确认之后、写分镜之前的那一层。
 *
 * 为什么单独存：稿子决定幕数、幕长、配音、字幕——它比 brief 长（可能上千字），
 * 塞进 brief 会把问诊单撑爆；而且稿子会改好几版，需要独立确认。
 *
 * 类型分工（brief.scriptType）：
 *  - 口播稿：给配音读的，句子要能念出来
 *  - 屏幕文案：只出现在画面上的标题/要点，字少、可断行
 *  - 双轨：口播稿 + 屏幕文案并存（最常见，也最容易写岔）
 *  - 无稿：纯视觉，没有文字层（数据动画/氛围片）
 */
export type ScriptSegment = {
  /** 这一段要念/要显示的话（一句一意，别塞长句） */
  text: string;
  /** 对应的幕（可选，写完分镜后回填 sceneId 更好对账） */
  sceneId?: string;
  /** 给自己/给用户的备注：这段要配什么画面 */
  note?: string;
};

export type Script = {
  /** 稿件类型；不填就沿用 brief.scriptType */
  type?: string;
  segments: ScriptSegment[];
  /** 用户已给稿时的原文（保留原样，便于对照"我改了哪里"） */
  sourceText?: string;
  /** 用户确认稿件的时间（confirm_script 写入） */
  confirmedAt?: string;
  updatedAt?: string;
};

export const SCRIPT_TYPES = ["口播稿", "屏幕文案", "双轨", "无稿", "用户已给稿"] as const;

/** 中文口播的常见语速（字/秒）；短视频偏快 4.5–5.5 */
const CHARS_PER_SEC = 4.5;

const ROOT = path.join(PROJECT_ROOT, "data", "projects");

const fileOf = (projectId: string): string => {
  if (!/^[\w-]+$/.test(projectId)) throw new Error("非法的工程 id");
  return path.join(ROOT, projectId, "script.json");
};

export function readScript(projectId: string): Script | null {
  const file = fileOf(projectId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Script;
}

export function saveScript(projectId: string, script: Script): Script {
  const segments = (script.segments ?? []).filter((s) => String(s?.text ?? "").trim());
  if (!segments.length && !String(script.sourceText ?? "").trim()) {
    throw new Error("稿件是空的：至少给一段 text（一句一意），或把用户给的原文放进 sourceText");
  }
  const prev = readScript(projectId);
  const next: Script = {
    ...prev,
    ...script,
    segments,
    updatedAt: new Date().toISOString(),
    // 改稿即失效：改过内容就必须重新请用户确认，不能沿用旧确认
    confirmedAt: undefined,
  };
  fs.mkdirSync(path.dirname(fileOf(projectId)), { recursive: true });
  fs.writeFileSync(fileOf(projectId), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function confirmScript(projectId: string): Script {
  const s = readScript(projectId);
  if (!s) throw new Error("还没有稿件，先 save_script 写一版");
  const next: Script = { ...s, confirmedAt: new Date().toISOString() };
  fs.writeFileSync(fileOf(projectId), JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** 去标点后的字数（估算语速用；标点和空格不计） */
export function scriptChars(text: string): number {
  return String(text ?? "").replace(/[\s，。！？、；：「」『』（）()《》,.!?;:'"~—-]/g, "").length;
}

export function estimateSeconds(text: string): number {
  const n = scriptChars(text);
  return n ? Math.round((n / CHARS_PER_SEC) * 10) / 10 : 0;
}

/** 稿件 → 给人看的文本；传 expectedSec 会对比 brief 的目标时长 */
export function scriptToText(s: Script | null, expectedSec?: number): string {
  if (!s?.segments?.length && !s?.sourceText) {
    return "还没有稿件。先确认稿件类型（brief.scriptType），再 save_script 写一版给用户过目。";
  }
  const nl = String.fromCharCode(10);
  const lines = (s.segments ?? []).map((seg, i) => {
    const note = seg.note ? `　〔${seg.note}〕` : "";
    return `${i + 1}. ${seg.text}（~${estimateSeconds(seg.text)}s）${note}`;
  });
  const totalChars = (s.segments ?? []).reduce((n, x) => n + scriptChars(x.text), 0);
  const totalSec = Math.round((totalChars / CHARS_PER_SEC) * 10) / 10;
  const head = `稿件${s.type ? `（${s.type}）` : ""}：${(s.segments ?? []).length} 段，共 ${totalChars} 字，约 ${totalSec}s`;
  const drift =
    expectedSec && totalSec
      ? Math.abs(totalSec - expectedSec) / Math.max(1, expectedSec) > 0.25
        ? `${nl}⚠️ 目标时长 ${expectedSec}s，稿子约 ${totalSec}s（差 ${Math.round(totalSec - expectedSec)}s）——先跟用户对一下是改稿还是改时长`
        : `${nl}时长匹配：目标 ${expectedSec}s，稿子约 ${totalSec}s`
      : "";
  const state = s.confirmedAt
    ? `${nl}用户已确认（${s.confirmedAt}）✅`
    : `${nl}⚠️ 还没请用户确认：稿子是整片的骨架，确认前别往下写分镜`;
  const src = s.sourceText ? `${nl}—— 用户原稿 ——${nl}${s.sourceText}` : "";
  return `${head}${drift}${nl}${lines.join(nl)}${state}${src}`;
}
