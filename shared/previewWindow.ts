/**
 * 「该看哪一段」的选择逻辑。
 *
 * 为什么单独抽出来：这段逻辑决定用户看到的是不是最容易翻车的地方。
 * 选错了，他会看完说"没问题"，然后整片渲染出来才发现转场叠字——
 * 比不预览更糟（预览给了假的安心）。
 *
 * 三个优先级：
 *   1. 指定帧区间（调用方明确要看哪）
 *   2. 指定幕（前后各带 1 秒，能看见交界）
 *   3. 自动：第一个"相邻且有入场转场"的接缝 → 没有接缝就取开头
 */

export type PreviewScene = {
  id?: string;
  durationInFrames?: number;
  transitionIn?: { type?: string; durationInFrames?: number } | null;
  transitionOut?: { type?: string; durationInFrames?: number } | null;
};

export type PreviewSpan = { start: number; dur: number; end: number; track?: number };

export type PreviewPick = {
  start: number;
  end: number;
  /** 人读的选取理由，直接写进回执 —— 用户要知道"为什么让我看这一段" */
  reason: string;
  /** seam = 转场交界 / start = 开头 / scenes = 指定幕 / range = 指定帧 */
  kind: "seam" | "start" | "scenes" | "range";
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function pickPreviewRange(opts: {
  scenes: readonly PreviewScene[];
  spans: readonly PreviewSpan[];
  totalFrames: number;
  fps: number;
  seconds: number;
  /** 指定的帧区间，优先级最高 */
  range?: [number, number];
  /** 指定的幕 id，其次是它 */
  sceneIds?: readonly string[];
}): PreviewPick {
  const { scenes, spans, totalFrames, fps, seconds, range, sceneIds } = opts;
  const win = Math.max(1, Math.round(seconds * fps));
  const last = Math.max(1, totalFrames - 1);

  if (range) {
    const start = clamp(Math.round(range[0]), 0, Math.max(0, last - 1));
    const end = clamp(Math.round(range[1]), start + 1, last);
    return { start, end, reason: `指定帧区间 ${start}–${end}`, kind: "range" };
  }

  if (sceneIds?.length) {
    const idxs = sceneIds
      .map((id) => scenes.findIndex((s) => s.id === id))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    if (!idxs.length) throw new Error("sceneIds 一个都没匹配上（用 get_project 查 id）");
    const first = spans[idxs[0]];
    const lastSpan = spans[idxs[idxs.length - 1]];
    const start = clamp((first?.start ?? 0) - Math.round(fps), 0, Math.max(0, last - 1));
    const end = clamp((lastSpan?.end ?? totalFrames) + Math.round(fps), start + 1, last);
    return {
      start,
      end,
      reason: `指定 ${idxs.length} 幕（前后各带 1 秒，能看见交界）`,
      kind: "scenes",
    };
  }

  // 自动：第一个"首尾相接 + 有入场转场"的接缝
  const main = spans
    .map((sp, i) => ({ sp, i }))
    .filter((x) => (x.sp?.track ?? 0) === 0)
    .sort((a, b) => (a.sp?.start ?? 0) - (b.sp?.start ?? 0));

  for (let k = 1; k < main.length; k++) {
    const prev = main[k - 1];
    const cur = main[k];
    if (Math.abs((cur.sp?.start ?? 0) - (prev.sp?.end ?? 0)) > 1) continue;
    const t = scenes[cur.i]?.transitionIn;
    if (!t || !t.type || t.type === "none") continue;
    const seam = Math.round(cur.sp?.start ?? 0);
    const half = Math.round(win / 2);
    return {
      start: clamp(seam - half, 0, Math.max(0, last - 1)),
      end: clamp(seam + half, seam + 1, last),
      reason: `第一个转场交界（第 ${seam} 帧）用 ${t.type}，${t.durationInFrames ?? 0} 帧 —— 叠字 / 糊场都在这看`,
      kind: "seam",
    };
  }

  // 没有任何转场：开头 6 秒仍然是"最贵的位置"（钩子 / 首帧 / BGM 是否起）
  const noSeam = clamp(win, 1, last);
  return {
    start: 0,
    end: noSeam,
    reason:
      scenes.length > 1
        ? `没有任何转场（全是硬切），取开头 ${seconds} 秒：看钩子和首帧`
        : `只有一幕，取开头 ${seconds} 秒`,
    kind: "start",
  };
}
