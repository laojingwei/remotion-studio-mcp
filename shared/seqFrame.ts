/**
 * 序列帧（imageSeq 元素 / 3D material.map 序列贴图）共用的帧号计算。
 *
 * 时间轴映射：元素的「本地帧」（Remotion 的 useCurrentFrame，元素出现时从 0 计）
 * 乘以 seqFps / 工程fps，得到序列帧的播放进度。工程 30fps、序列也 30fps 时
 * 就是 1:1 逐帧；序列 60fps 时工程播 1 帧序列进 2 帧。
 *
 * 越界语义：loop=true 循环回绕（烟雾循环、走马灯），loop=false 停在最后一帧
 * （爆炸、破碎这类一次性特效，播完保持末帧比闪回第一帧合理）。
 */

export type SeqTiming = {
  /** 起始帧编号（文件名里的那个数字） */
  seqFrom: number;
  /** 结束帧编号（含） */
  seqTo: number;
  /** 序列帧播放速率（帧/秒） */
  seqFps: number;
  /** 播完是否回绕循环 */
  loop: boolean;
};

/** 工程第 frame 帧时该显示序列的第几个编号 */
export const seqFrameIndex = (t: SeqTiming, frame: number, compFps: number): number => {
  const len = Math.max(1, t.seqTo - t.seqFrom + 1);
  const n = t.seqFrom + Math.floor((Math.max(0, frame) * t.seqFps) / (compFps || 30));
  if (t.loop) return t.seqFrom + (((n - t.seqFrom) % len) + len) % len;
  return Math.min(n, t.seqTo);
};

/** src 里的 {frame} 占位符替换成补零后的编号：xxx_{frame}.png + 7 → xxx_00000007.png */
export const seqFrameSrc = (pattern: string, index: number, digits: number): string =>
  pattern.replace(/\{frame\}/g, String(index).padStart(Math.max(1, digits), "0"));

/** 模式串 → 某一帧的具体 src（2D/3D/校验三处共用同一份逻辑，不许各写各的） */
export const seqSrcAt = (
  pattern: string,
  t: Partial<SeqTiming> | undefined,
  frame: number,
  compFps: number,
  digits?: number,
): string =>
  seqFrameSrc(
    pattern,
    seqFrameIndex(
      {
        seqFrom: t?.seqFrom ?? 1,
        seqTo: t?.seqTo ?? 1,
        seqFps: t?.seqFps ?? 30,
        loop: t?.loop ?? false,
      },
      frame,
      compFps,
    ),
    digits ?? 4,
  );
