/**
 * 入场转场：类型清单 + 纯函数样式计算。
 *
 * 放在 shared 是因为三处要共用同一份定义：
 *  - `schema.ts` 的 zod enum（落库校验）
 *  - Web 属性面板的选项按钮
 *  - `src/Video.tsx` 的渲染
 *
 * 这里故意不 import remotion / react：样式就是个普通对象，纯函数好测，
 * 也不会让 shared 被绑到渲染环境上。
 */
export const TRANSITION_TYPES = [
  "none",
  "fade",
  "slide",
  "wipe",
  "zoom",
  "blur",
  "flip",
  "circle",
] as const;

export type TransitionType = (typeof TRANSITION_TYPES)[number];

export const TRANSITION_OPTIONS: { key: TransitionType; label: string; hint: string }[] = [
  { key: "none", label: "硬切", hint: "直接切" },
  { key: "fade", label: "淡入", hint: "叠化" },
  { key: "slide", label: "上滑", hint: "从下往上推" },
  { key: "wipe", label: "擦除", hint: "自下而上揭开" },
  { key: "zoom", label: "推进", hint: "镜头向前" },
  { key: "blur", label: "虚化", hint: "模糊聚焦" },
  { key: "flip", label: "翻页", hint: "绕竖轴翻开" },
  { key: "circle", label: "圆形展开", hint: "从中心扩散" },
];

export type TransitionStyle = Record<string, string | number>;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * 计算某一帧的入场样式。
 * @param frame 场景内帧号（0 开始）
 * @param durationInFrames 转场时长
 * @param sceneDurationInFrames 场景总时长（只用于 fade 的收尾轻微压暗）
 */
export function transitionStyle(
  type: TransitionType,
  frame: number,
  durationInFrames: number,
  sceneDurationInFrames = durationInFrames,
): TransitionStyle {
  const d = Math.max(1, durationInFrames);
  const p = clamp01(frame / d);
  const fadeIn = p;

  switch (type) {
    case "none":
      return {};
    case "slide":
      return { opacity: fadeIn, transform: `translateY(${lerp(6, 0, p)}%)` };
    case "wipe":
      return { clipPath: `inset(0 0 ${lerp(100, 0, p).toFixed(2)}% 0)` };
    case "zoom":
      return { opacity: fadeIn, transform: `scale(${lerp(1.08, 1, p).toFixed(3)})` };
    case "blur":
      return { opacity: fadeIn, filter: `blur(${lerp(14, 0, p).toFixed(2)}px)` };
    case "flip":
      return {
        opacity: fadeIn,
        transform: `perspective(1200px) rotateY(${lerp(90, 0, p).toFixed(2)}deg)`,
        transformOrigin: "center",
      };
    case "circle":
      return { clipPath: `circle(${lerp(0, 75, p).toFixed(2)}% at 50% 50%)` };
    case "fade":
    default: {
      // 结尾 6 帧轻微压暗，给切走一点呼吸感（只有淡入这样做，其余转场不抢戏）
      const tail =
        sceneDurationInFrames > 6 ? clamp01((sceneDurationInFrames - frame) / 6) : 1;
      return { opacity: Math.min(fadeIn, 0.85 + 0.15 * tail) };
    }
  }
}

/* ─────────────────── 接缝重叠：让相邻两幕真的叠在一起 ─────────────────── */

/**
 * 这里只用到这两个字段，**故意不 import schema**：
 * `shared/schema.ts` 反过来 import 了本文件的 `TRANSITION_TYPES`，互相 import 会绕成环。
 */
type SeamTransition = { type: string; durationInFrames: number };
type SeamScene = {
  transitionIn?: SeamTransition | null;
  transitionOut?: SeamTransition | null;
};
type SeamSpan = { start: number; dur: number; end: number; track: number };

/**
 * 每一幕为了「接缝转场」需要**往后再多渲染几帧**。
 *
 * 老做法是两幕各玩各的：A 在自家最后 N 帧淡出到背景色，B 再从背景色淡入，
 * 中间那一小段画面是空的 —— 看起来就是"暗一下再亮起来"，不是叠化。
 * 真正的叠化（以及滑入/擦除/圆形展开）要求 A 和 B **同时存在**。
 *
 * 这里的做法不改时间轴数学（`sceneSpans` / 总时长一律不动），只在渲染时
 * 把前一幕的窗口往后再撑 `overlap` 帧（内容用 `<Freeze>` 定格在最后一帧，
 * 否则动画会过冲）。B 照常从自己的 start 开始淡入，于是
 * `[B.start, B.start + overlap)` 这段里两幕真的叠在一起，B 渐显覆盖 A。
 *
 * 规则：
 *  - 只对**主轨（track 0）上首尾相接**的两幕生效；中间有缝（钉死过起点）或画中画都不算接缝；
 *  - 用**下一幕的 `transitionIn`** 当接缝转场（出场转场在这种情况下被忽略，否则会双重变暗）；
 *  - 前一幕至少留 1 帧给自己；后一幕如果自己有淡出，重叠不能吃到它的淡出区
 *    （否则 B 淡出时会露出还没结束的 A）。
 */
export function seamOverlaps(
  scenes: readonly SeamScene[],
  spans: readonly SeamSpan[],
): number[] {
  const out = scenes.map(() => 0);
  const main = scenes
    .map((scene, i) => ({ scene, span: spans[i], i }))
    .filter((x) => x.span && (x.span.track ?? 0) === 0)
    .sort((a, b) => a.span.start - b.span.start);

  for (let k = 1; k < main.length; k++) {
    const prev = main[k - 1];
    const cur = main[k];
    // 首尾相接才算接缝：容许 1 帧误差（浮点/取整）
    if (Math.abs(cur.span.start - prev.span.end) > 1) continue;
    const t = cur.scene.transitionIn;
    if (!t || t.type === "none") continue;

    const want = Math.max(1, Math.round(t.durationInFrames));
    const outCur =
      cur.scene.transitionOut && cur.scene.transitionOut.type !== "none"
        ? Math.max(0, Math.round(cur.scene.transitionOut.durationInFrames))
        : 0;
    // 前一幕留 1 帧自己；后一幕的淡出区不能被吃掉
    const limit = Math.min(prev.span.dur - 1, cur.span.dur - outCur - 1);
    if (limit <= 0) continue;
    out[prev.i] = Math.min(want, limit);
  }
  return out;
}
