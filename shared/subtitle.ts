import type { Scene } from "./schema";

/**
 * 场景字幕 → 幕内时间条。
 *
 * 字幕来源（优先级）：
 *   1. 场景 `subtitle` 字段（一行一句）
 *   2. `caption` 版式的正文（它本身就是字幕）
 *
 * 一幕多句时按**字数比例**分配幕内时长：中文语速大致恒定，
 * 等分会让长句念不完就被下一句盖掉。
 *
 * 纯函数：导出 SRT 与渲染烧录共用这一套，保证「文件里的字幕」和「画面里看到的字幕」一致。
 */
export type SubtitleLine = {
  text: string;
  /** 幕内起点（帧，相对场景开头） */
  start: number;
  /** 幕内终点（帧，不含） */
  end: number;
};

export function sceneSubtitleLines(scene: Scene): SubtitleLine[] {
  const explicit = (scene.subtitle ?? "").trim();
  const raw =
    explicit ||
    (scene.type === "caption" ? String(scene.props?.text ?? "").trim() : "");
  if (!raw) return [];

  const lines = raw
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const dur = Math.max(1, scene.durationInFrames);
  const weights = lines.map((l) => Math.max(1, [...l].length));
  const total = weights.reduce((a, b) => a + b, 0);

  let acc = 0;
  return lines.map((text, i) => {
    const isLast = i === lines.length - 1;
    const start = Math.round((acc / total) * dur);
    acc += weights[i];
    const end = isLast ? dur : Math.round((acc / total) * dur);
    return { text, start, end: Math.max(start + 1, end) };
  });
}
