/**
 * 幕数与单幕时长的合理性。
 *
 * ## 为什么需要这个文件
 *
 * 之前一直有人（包括我）把「14 幕」当成一个标准 —— 其实那只是某一支片子的结果。
 * 幕数不是拍出来的，是**由内容推出来的**：
 *
 * ```
 * 幕数 ≈ 总时长 / 单幕能撑住的时长
 * ```
 *
 * 上下界都来自与内容无关的物理约束：
 * - **下界（每幕最长）**：一个构图 + 一句口播，观众还能盯着看的极限。
 *   超过它，画面会觉得「停住了 / 卡了」，这时候该切新幕、上新信息。
 * - **上界（每幕最短）**：一屏字幕读完的时间。短于它，画面还没看清就换了。
 *
 * 所以：**同样的 90 秒，可以是 8 幕也可以是 40 幕**，取决于你要说几件事、
 * 每件事需要观众停多久。库里 2 幕到 50 幕的工程都跑得通。
 *
 * ## 为什么区间给得很宽
 *
 * 这里只做「量级参考」和「极端值拦截」，不做「标准幕数」。
 * 给窄了会误伤讲解型长幕（实测有平均 15.5s/幕的工程），
 * 那还不如不给 —— 报一个错的建议比不报更糟。
 */

/** 单幕最短可读时长（秒）：一屏字幕 8–16 字 ÷ 4.8 字/秒 ≈ 1.7s，加进出场取 2s */
export const SCENE_MIN_SEC = 2;

/** 单幕最长建议时长（秒）：超过它，画面像停住了，该切新幕上新信息 */
export const SCENE_MAX_SEC = 20;

/** 段落最短（秒）：一段至少放得下一句能读的话；低于它基本等于没有这一段 */
export const SEGMENT_MIN_SEC = 1.2;

/** 段落偏短（秒）：勉强够一句短句，值得提醒 */
export const SEGMENT_TIGHT_SEC = 1.8;

/**
 * 段落偏长（秒）：超过它几乎肯定要拆成多幕 —— 段落是内容单位，不是画面单位。
 *
 * 定 60 而不是 30：90 秒的片子分「钩子 3s / 主体 42s / 收尾 45s」是完全正常的结构，
 * 30 会把它报成两条噪声。真正该提醒的是「一段 60s 还没想好怎么拆」。
 */
export const SEGMENT_LONG_SEC = 60;

/** 幕数量级参考区间。**不是标准**，落在区间外不算错。 */
export function estimateSceneCount(totalSec: number): { min: number; max: number } {
  const total = Math.max(0, Number(totalSec) || 0);
  if (total <= 0) return { min: 0, max: 0 };
  return {
    min: Math.max(1, Math.ceil(total / SCENE_MAX_SEC)),
    max: Math.max(1, Math.ceil(total / SCENE_MIN_SEC)),
  };
}

/** 幕数落在参考区间外时的一句话（仅提示，不阻断） */
export function sceneCountNote(totalSec: number, actualScenes: number): string | null {
  const { min, max } = estimateSceneCount(totalSec);
  if (!min || actualScenes <= 0) return null;
  if (actualScenes >= min && actualScenes <= max) return null;
  if (actualScenes < min) {
    return (
      `${actualScenes} 幕 / ${totalSec.toFixed(0)}s，平均 ${(totalSec / actualScenes).toFixed(1)}s 一幕 —— ` +
      `偏长，画面会显得停住了。这个长度的片子通常 ${min}–${max} 幕（不是标准，是量级）`
    );
  }
  return (
    `${actualScenes} 幕 / ${totalSec.toFixed(0)}s，平均 ${(totalSec / actualScenes).toFixed(1)}s 一幕 —— ` +
    `偏碎，很多幕可能还没看清就换了。这个长度的片子通常 ${min}–${max} 幕（不是标准，是量级）`
  );
}

export type SegmentLike = {
  startSec?: number;
  endSec?: number;
  content?: string;
};

/**
 * 单段时长的合理性。
 *
 * 段落表是**内容骨架**，一段可以拆成多幕 —— 所以「段偏长」只是提醒，
 * 不阻断（90 秒分 3 段各 30 秒是合法的）。真正该拦的只有「短到放不下一句话」。
 */
export function segmentDurationIssues(
  segments: readonly SegmentLike[],
): { blocking: { index: number; message: string }[]; warnings: { index: number; message: string }[] } {
  const blocking: { index: number; message: string }[] = [];
  const warnings: { index: number; message: string }[] = [];
  segments.forEach((s, i) => {
    const dur = Number(s.endSec) - Number(s.startSec);
    if (!Number.isFinite(dur) || dur <= 0) return; // 合法性由调用方单独判
    if (dur < SEGMENT_MIN_SEC) {
      blocking.push({
        index: i,
        message:
          `段落表第 ${i + 1} 段只有 ${dur.toFixed(1)}s —— 放不下一句能读完的话` +
          `（一屏最短约 ${SCENE_MIN_SEC}s）。要么并进相邻段，要么把这段内容说短一点`,
      });
    } else if (dur < SEGMENT_TIGHT_SEC) {
      warnings.push({
        index: i,
        message: `段落表第 ${i + 1} 段 ${dur.toFixed(1)}s，勉强够一句短句 —— 内容要是写长了，画面会追不上`,
      });
    } else if (dur > SEGMENT_LONG_SEC) {
      warnings.push({
        index: i,
        message:
          `段落表第 ${i + 1} 段 ${dur.toFixed(0)}s —— 一段可以拆多幕，但这么长要提前想好它分成几幕、` +
          `每幕换什么信息（否则铺开时这一段会变成一大团看不清的东西）`,
      });
    }
  });
  return { blocking, warnings };
}
