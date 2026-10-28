/**
 * 素材时长 → 帧数。
 *
 * 优先用素材库里记录的 duration（上传时浏览器读的）；
 * 没有就现场问服务端（/api/assets/probe 读文件头），避免"4 秒素材显示 8 秒"。
 */
export async function framesForAsset(
  src: string | undefined,
  fps: number,
  knownDuration?: number,
): Promise<number | null> {
  if (!src) return null;
  if (knownDuration && knownDuration > 0) {
    return Math.max(1, Math.round(knownDuration * fps));
  }
  try {
    const res = await fetch(`/api/assets/probe?src=${encodeURI(src)}`);
    const data = (await res.json()) as {
      probes?: { durationInSeconds?: number }[];
    };
    const d = data.probes?.[0]?.durationInSeconds;
    if (d && d > 0) return Math.max(1, Math.round(d * fps));
  } catch {
    /* 探测失败就不设时长（按场景结尾），不阻塞拖放 */
  }
  return null;
}
