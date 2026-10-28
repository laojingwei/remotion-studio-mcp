import fs from "node:fs";
import path from "node:path";
import { ensureOutDir } from "./outputs.service";
import type { Project, Scene } from "../shared/schema";
import { sceneSpans } from "../shared/schema";
import { sceneSubtitleLines } from "../shared/subtitle";

/**
 * 字幕导出（SRT / WebVTT）。
 *
 * 字幕从哪来（按优先级）：
 *   1. 场景的 `subtitle` 字段 —— 显式写的字幕，一行一句
 *   2. `caption` 类型场景的 props.text —— 字幕版式本身就是字幕
 *   3. 其它场景不产生字幕（标题页、图表页的文案不是旁白，混进去反而乱）
 *
 * 一幕里有多句时，按**字数比例**分配幕内时长：中文语速大致恒定，
 * 句子长就该占更多时间。等分会让长句念不完就被下一句盖掉。
 *
 * 纯函数，不依赖任何外部程序。
 */

export type SubtitleCue = {
  index: number;
  startFrame: number;
  endFrame: number;
  text: string;
  sceneId: string;
  sceneName: string;
};

export type SubtitleFormat = "srt" | "vtt";

/** 帧 → 时间码。srt 用逗号分隔毫秒，vtt 用点 */
const timecode = (frames: number, fps: number, sep: "," | ".") => {
  const totalMs = Math.max(0, Math.round((frames / fps) * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60) % 60;
  const hr = Math.floor(totalSec / 3600);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(hr)}:${pad(min)}:${pad(sec)}${sep}${pad(ms, 3)}`;
};

/** 取一个场景的字幕文本（可能多行） */
export function sceneSubtitleText(scene: Scene): string {
  const explicit = (scene.subtitle ?? "").trim();
  if (explicit) return explicit;
  // 字幕版式：正文就是字幕
  if (scene.type === "caption") {
    const t = scene.props?.text;
    if (typeof t === "string" && t.trim()) return t.trim();
  }
  return "";
}

/**
 * 生成字幕条目。分配逻辑在 shared/subtitle.ts（与渲染烧录共用，保证字幕文件与画面一致）。
 */
export function buildCues(project: Project): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  // 起点走 sceneSpans：多轨之后"前序时长之和"不再等于起始帧
  const spans = sceneSpans(project.scenes ?? []);
  (project.scenes ?? []).forEach((scene, i) => {
    const span = spans[i];
    // 字幕只烧主轨 —— 画中画小窗里那行字不上屏，导出的字幕也就不该带它（否则字幕文件与画面不一致）
    if (!span || span.track !== 0) return;
    const lines = sceneSubtitleLines(scene);
    for (const line of lines) {
      cues.push({
        index: cues.length + 1,
        startFrame: span.start + line.start,
        endFrame: span.start + line.end,
        text: line.text,
        sceneId: scene.id,
        sceneName: scene.name,
      });
    }
  });

  return cues;
}

/** 生成 SRT 文本 */
export function toSrt(cues: SubtitleCue[], fps: number): string {
  if (!cues.length) return "";
  return (
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${timecode(c.startFrame, fps, ",")} --> ${timecode(c.endFrame, fps, ",")}\n${c.text}\n`,
      )
      .join("\n") + "\n"
  );
}

/** 生成 WebVTT 文本 */
export function toVtt(cues: SubtitleCue[], fps: number): string {
  if (!cues.length) return "WEBVTT\n";
  return (
    "WEBVTT\n\n" +
    cues
      .map(
        (c) =>
          `${timecode(c.startFrame, fps, ".")} --> ${timecode(c.endFrame, fps, ".")}\n${c.text}\n`,
      )
      .join("\n") +
    "\n"
  );
}

export const renderSubtitles = (cues: SubtitleCue[], fps: number, format: SubtitleFormat) =>
  format === "vtt" ? toVtt(cues, fps) : toSrt(cues, fps);

/** 字幕文件名的扩展名 */
export const subtitleExt = (format: SubtitleFormat) => (format === "vtt" ? ".vtt" : ".srt");

/** 字幕落盘目录：out/projects/<工程id>/subtitles（和成片、关键帧同属一个工程） */
export const subtitleDirOf = (projectId: string) => ensureOutDir(projectId, "subtitle");

/** 时间戳文件名（成片与关键帧也用这个格式，方便按时间排序） */
const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

/**
 * 把字幕写到 out/projects/<工程id>/subtitles/，返回文件路径。
 * 文件名带工程名与时间戳，排序时能看出是哪一版。
 */
export function writeSubtitleFile(
  projectId: string,
  projectName: string,
  content: string,
  format: SubtitleFormat,
): { file: string; filename: string; bytes: number } {
  const dir = subtitleDirOf(projectId);
  const safeName = (projectName || projectId || "project").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  const filename = `${safeName}_${stamp()}${subtitleExt(format)}`;
  const full = path.join(dir, filename);
  fs.writeFileSync(full, content, "utf8");
  return { file: full, filename, bytes: Buffer.byteLength(content, "utf8") };
}
