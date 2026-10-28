import React, { useEffect, useState } from "react";

const cache = new Map<string, number[]>();

/** 解码音频 → 归一化峰值（带缓存），供时间轴画波形 */
export function useWaveform(src: string | undefined, buckets = 220): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(() =>
    src && cache.has(src) ? cache.get(src)! : null,
  );

  useEffect(() => {
    if (!src) {
      setPeaks(null);
      return;
    }
    const cached = cache.get(src);
    if (cached) {
      setPeaks(cached);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(src);
        const buf = await res.arrayBuffer();
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const audio = await ctx.decodeAudioData(buf);
        const data = audio.getChannelData(0);
        const step = Math.max(1, Math.floor(data.length / buckets));
        const out: number[] = [];
        for (let i = 0; i < buckets; i++) {
          let sum = 0;
          const start = i * step;
          for (let j = 0; j < step; j++) sum += Math.abs(data[start + j] ?? 0);
          out.push(sum / step);
        }
        const max = Math.max(...out, 0.0001);
        const norm = out.map((v) => v / max);
        cache.set(src, norm);
        if (!cancelled) setPeaks(norm);
        await ctx.close();
      } catch {
        if (!cancelled) setPeaks(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, buckets]);

  return peaks;
}

/** 波形 SVG：竖线镜像，preserveAspectRatio=none 自适应宽度 */
export const Wave: React.FC<{ src?: string; className?: string }> = ({ src, className }) => {
  const peaks = useWaveform(src);
  if (!peaks?.length) return null;
  const h = 40;
  const mid = h / 2;
  const step = 100 / peaks.length;
  const d = peaks
    .map((p, i) => {
      const x = (i + 0.5) * step;
      const y = Math.max(0.6, p * (mid - 2));
      return `M${x.toFixed(2)},${(mid - y).toFixed(2)}V${(mid + y).toFixed(2)}`;
    })
    .join("");
  return (
    <svg
      className={className}
      viewBox={`0 0 100 ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={d} stroke="currentColor" strokeWidth={0.6} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};
