import type { Scene } from "./schema";
import { SUBTITLE_LIMITS, splitSubtitleText } from "./subtitleText";

/**
 * 场景字幕 → 幕内时间条。
 *
 * 字幕来源（优先级）：
 *   1. 场景 `subtitle` 字段
 *   2. `caption` 版式的正文（它本身就是字幕）
 *
 * **原始文本一律先过 `splitSubtitleText`**：清标点、按语义拆短句。
 * 这样不管 agent 写进来的是一整段还是一句话，上屏都是一屏一短句——
 * 渲染烧录与 SRT 导出共用这里，画面和字幕文件永远一致。
 *
 * 一屏一首的长度上限跟着字幕字号走：字号越大，一屏能放的字越少。
 */
export type SubtitleLine = {
  text: string;
  /** 幕内起点（帧，相对场景开头） */
  start: number;
  /** 幕内终点（帧，不含） */
  end: number;
};

/** 按字幕字号推算一屏最多几个字（字号占短边百分比越大，能放的字越少） */
export function subtitleMaxChars(scene: Scene): number {
  const pct = Number(scene.subtitleStyle?.fontSize ?? 2.6);
  // 字幕框宽 86%，一行大约放得下 86 / 字号百分比 个字；留 15% 余量给标点和避让
  const perLine = 86 / Math.max(1.5, pct);
  return Math.max(8, Math.min(SUBTITLE_LIMITS.max, Math.round(perLine * 0.85)));
}

export function sceneSubtitleLines(scene: Scene, opts: { maxChars?: number } = {}): SubtitleLine[] {
  const explicit = (scene.subtitle ?? "").trim();
  const raw =
    explicit ||
    (scene.type === "caption" ? String(scene.props?.text ?? "").trim() : "");
  if (!raw) return [];

  const maxChars = opts.maxChars ?? subtitleMaxChars(scene);
  const lines: string[] = [];
  // 段尾索引：换行是作者画的分屏，短屏合并时**不许跨段**（跨段合并会吃掉作者的分屏意图）
  const paraEnds = new Set<number>();
  // 按换行分段处理：段内做拆句与合并，段间保持独立
  for (const paragraph of raw.split("\n")) {
    let added = 0;
    for (const line of splitSubtitleText(paragraph, { maxChars })) {
      if (!line) continue;
      lines.push(line);
      added++;
    }
    if (added && lines.length) paraEnds.add(lines.length - 1);
  }
  if (!lines.length) return [];

  const dur = Math.max(1, scene.durationInFrames);
  let texts = lines;
  let weights = texts.map((l) => Math.max(1, [...l].length));
  let ends = paraEnds;

  // 屏太短会一闪而过：把不足 6 帧的并进邻句（不跨段、且合起来还不算太长）
  const totalOf = (ws: number[]) => ws.reduce((a, b) => a + b, 0);
  const MIN_FRAMES = 6;
  for (let guard = 0; guard < 8; guard++) {
    if (texts.length <= 1) break;
    const total = totalOf(weights);
    const idx = weights.findIndex((w) => (w / total) * dur < MIN_FRAMES);
    if (idx < 0) break;
    const target = idx > 0 ? idx - 1 : idx + 1;
    const lo = Math.min(idx, target);
    const hi = Math.max(idx, target);
    // 跨段就放弃（宁可一闪而过，也不破坏作者的分屏）
    if (ends.has(lo)) break;
    if ([...texts[lo] + texts[hi]].length > SUBTITLE_LIMITS.hard) break;
    texts = texts.map((t, i) => (i === lo ? t + texts[hi] : t)).filter((_, i) => i !== hi);
    weights = texts.map((t) => Math.max(1, [...t].length));
    // hi 被删掉，段尾索引要整体前移
    ends = new Set(
      [...ends].filter((x) => x !== hi).map((x) => (x > hi ? x - 1 : x)),
    );
  }

  const total = totalOf(weights);
  let acc = 0;
  return texts.map((text, i) => {
    const isLast = i === texts.length - 1;
    const start = Math.round((acc / total) * dur);
    acc += weights[i];
    const end = isLast ? dur : Math.round((acc / total) * dur);
    return { text, start, end: Math.max(start + 1, end) };
  });
}
