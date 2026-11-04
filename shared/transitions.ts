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
  // 2026-11-01 第五批扩容
  "blinds",
  "flash",
  "glitch",
  "diagonal",
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
  { key: "blinds", label: "百叶窗", hint: "横条纹逐条展开" },
  { key: "flash", label: "闪白", hint: "白光里炸出来" },
  { key: "glitch", label: "故障", hint: "抖动撕裂后稳住" },
  { key: "diagonal", label: "斜切", hint: "斜线揭开" },
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
      // toFixed 而非直接拼：lerp 会吐 0.20000000000000018 这种值，CSS 里又长又难读
      return { opacity: fadeIn, transform: `translateY(${lerp(6, 0, p).toFixed(2)}%)` };
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
    case "blinds": {
      /*
       * 百叶窗：用 repeating-linear-gradient 当 mask。
       *
       * 之所以不用 clipPath：CSS 的 clip-path 一次只能一个 polygon，
       * 而「多条互相独立的横条」需要 6 个矩形 —— polygon 拼不出多个不连通区域
       * （拼出来会因 nonzero 填充规则互相吞掉）。mask 的 repeating 渐变天然就是
       * 「每周期重复一次」，条纹数 = 100% / 周期。
       *
       * open 是每周期内黑条占的比例：0 = 全透明（看不见），1 = 全黑（完全露出）。
       */
      const stripes = 6;
      const period = 100 / stripes;
      const open = (p * period).toFixed(3);
      const mask = `repeating-linear-gradient(180deg, #000 0 ${open}%, transparent ${open}% ${period.toFixed(3)}%)`;
      return { maskImage: mask, WebkitMaskImage: mask };
    }
    case "flash":
      /*
       * 闪白：第 0 帧就完全可见（不写 opacity），画面过曝成白，随后亮度落回 1。
       * 用 brightness 而不是叠白色遮罩 —— 这个函数只能返回样式对象，加不了额外图层；
       * 深底上 brightness(3.5) 视觉上就是"从白光里显影"。出场反向播时变成闪黑前白一下，也对味。
       */
      return { filter: `brightness(${lerp(3.6, 1, p).toFixed(3)})` };
    case "glitch": {
      /*
       * 故障：抖动幅度随进度衰减，最后稳住。
       *
       * 三条硬约束：
       * 1. **确定性** —— 逐帧渲染每帧独立进 Chrome，随机数必须从 frame 算出来，
       *    不能 Math.random()（否则每次渲染画面不一样）；
       * 2. 抖动用 transform + skew，不用 clipPath —— 出场时 exitStyle 会反向调本函数，
       *    clipPath 类转场两层相加会互相覆盖（wipe 同款问题），transform 是叠加安全的；
       * 3. 亮度闪烁比透明度闪烁安全 —— opacity 会被出场逻辑整体接管，filter 不会。
       */
      const settle = 1 - p;
      const hash = (n: number) => {
        const x = Math.sin(frame * 12.9898 + n * 78.233) * 43758.5453;
        return x - Math.floor(x); // [0,1)，frame 相同则结果相同
      };
      const dx = (hash(1) * 4 - 2) * settle; // ±2% 横跳
      const sk = (hash(2) * 6 - 3) * settle; // ±3° 斜切
      const flick = hash(3) > 0.72 - p * 0.5 ? 1 : 0.62; // 越接近结束闪得越少
      return {
        opacity: flick,
        transform: `translateX(${dx.toFixed(2)}%) skewX(${sk.toFixed(2)}deg)`,
        filter: `saturate(${(1 + settle * 1.4).toFixed(2)})`,
      };
    }
    case "diagonal":
      /*
       * 斜切：左上 → 右下揭开，前缘是一条 18° 左右的斜线。
       * 比起 wipe（水平直线）多一层"运动方向"的暗示；多边形在最右多探出 18%
       * 是为了让斜边完全出画后整幕才算揭完。
       */
      {
        const r = lerp(0, 118, p);
        return {
          clipPath: `polygon(0 0, ${r.toFixed(2)}% 0, ${(r - 18).toFixed(2)}% 100%, 0 100%)`,
        };
      }
    case "fade":
    default: {
      // 结尾 6 帧轻微压暗，给切走一点呼吸感（只有淡入这样做，其余转场不抢戏）
      const tail =
        sceneDurationInFrames > 6 ? clamp01((sceneDurationInFrames - frame) / 6) : 1;
      return { opacity: Math.min(fadeIn, 0.85 + 0.15 * tail) };
    }
  }
}

/**
 * 出场窗口：前一幕从第几帧开始退、退多久。
 *
 * ## 为什么要有"窗口"这个概念
 *
 * 以前出场被拆成两套逻辑：没接缝时按自己的 `transitionOut` 播；有接缝时
 * 被 `seamExitStyle` 塞进"接缝长度"里。而接缝长度是**下一幕入场时长**决定的 ——
 * 于是「前幕设 30 帧出场 + 下幕设 12 帧入场」时，30 帧的出场会被压进 12 帧，
 * 变成 2.5 倍速，看起来像"出场转场没生效"。
 *
 * 现在统一成：前幕的渲染窗口是 `[0, 幕长 + 接缝)`，出场窗口取
 * **`max(出场时长, 接缝长度)`**，从窗口末尾往回推。
 *
 * - 出场 ≤ 接缝 → 起点落在接缝内，行为和以前一样
 * - 出场 > 接缝 → 起点提前到接缝之前，出场能完整播完（速度不变）
 *
 * 重叠长度一点都没变，所以叠字窗口不会变长 —— 这是选这个方案而不是
 * "接缝取 max(入场, 出场)" 的原因（那会把两幕同屏的时间拉长）。
 */
export function exitWindow(opts: {
  /** 本幕时长（帧） */
  durationInFrames: number;
  /** 接缝重叠帧数（由下一幕入场决定，0 = 没有接缝） */
  seam: number;
  /** 出场转场；没有就是 null */
  transitionOut?: { type: TransitionType; durationInFrames: number } | null;
}): { start: number; len: number } {
  const seam = Math.max(0, Math.round(opts.seam));
  const dur = Math.max(0, Math.round(opts.durationInFrames));
  const outDur =
    opts.transitionOut && opts.transitionOut.type !== "none"
      ? Math.max(0, Math.round(opts.transitionOut.durationInFrames))
      : 0;
  // 窗口至少覆盖接缝（保证前一幕真的退出去），出场更长时以出场为准（保证它播得完整）
  const wantLen = Math.max(outDur, seam);
  const windowEnd = dur + seam;
  // 出场比整幕还长时只能压到整幕（否则起点为负，第一帧就已经退完了）
  const start = Math.max(0, windowEnd - wantLen);
  return { start, len: windowEnd - start };
}

/**
 * 出场样式：在"出场窗口"内退场。
 *
 * 两个保证：
 * 1. **opacity 一定走到 0** —— 前一幕必须真的离开（复盘 R6：以前接缝期前幕被 Freeze 定格，
 *    文字一直留在画面上，拉长转场只是拉长露字窗口）
 * 2. 有 `transitionOut` 就按它的性格退（保留 slide 的位移、blur 的 filter），
 *    没有就纯淡出
 *
 * @param outT 出场转场（可为 null）
 * @param framesIntoOut 进入出场窗口后的第几帧（0 起）
 * @param outWindowLen 出场窗口长度（= exitWindow().len）
 */
export function exitStyle(
  outT: { type: TransitionType; durationInFrames: number } | null | undefined,
  framesIntoOut: number,
  outWindowLen: number,
  sceneDurationInFrames = outWindowLen,
): TransitionStyle {
  const len = Math.max(1, outWindowLen);
  const p = clamp01((Math.max(0, framesIntoOut) + 1) / len);
  const hasOut = !!outT && outT.type !== "none";
  // 出场 = 反向播放同一套转场：进度从 1 走到 0
  const base: TransitionStyle = hasOut
    ? transitionStyle(outT!.type, Math.round((1 - p) * len), len, sceneDurationInFrames)
    : {};
  return { ...base, opacity: p >= 1 ? 0 : 1 - p };
}

/** @deprecated 用 exitStyle + exitWindow（语义从"接缝内"改成"出场窗口内"） */
export const seamExitStyle = exitStyle;

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

/**
 * 接缝交叠区（给"抽帧/预览时看到两个画面叠在一起"提供**可解释的坐标**）。
 *
 * 背景：`seamOverlaps` 让上一幕多渲 N 帧定格淡出，于是 `[下一幕.start, +N)` 这段里
 * 两幕真的同时存在。这在成片里是叠化，在**抽帧**里就是"上一幕的大字半透明地压在
 * 新幕上"——看起来非常像渲染 bug（"为什么 3D 幕里出现了 outro 的谢谢观看"）。
 *
 * 实测代价：为了确认这是转场而不是状态泄漏，来回抽了 6 组帧（235/260/325/415）
 * 才敢下结论。所以这段窗口必须能被工具直接报出来，而不是让人自己盯着帧号猜。
 *
 * 只对主轨首尾相接的幕生效，和 `seamOverlaps` 同一套判定——两处算不齐就会
 * 出现"提示说这帧有交叠、画面其实是干净的"。
 */
export type SeamBlendWindow = {
  /** 交叠区起始帧（= 下一幕的 start） */
  start: number;
  /** 交叠区结束帧（不含），start + 交叠帧数 */
  end: number;
  /** 交叠帧数（= 下一幕 transitionIn 的时长，被幕长夹过） */
  frames: number;
  /** 上一幕（定格淡出的那一幕） */
  from: string;
  /** 下一幕（正在渐显的那一幕） */
  to: string;
};

export function seamBlendWindows(
  scenes: readonly (SeamScene & { name?: string; id?: string })[],
  spans: readonly SeamSpan[],
): SeamBlendWindow[] {
  const overlaps = seamOverlaps(scenes, spans);
  const out: SeamBlendWindow[] = [];
  for (let i = 0; i < scenes.length - 1; i++) {
    const n = overlaps[i] ?? 0;
    if (!n) continue;
    const cur = spans[i + 1];
    if (!cur) continue;
    out.push({
      start: cur.start,
      end: cur.start + n,
      frames: n,
      from: String(scenes[i].name ?? scenes[i].id ?? `第 ${i + 1} 幕`),
      to: String(scenes[i + 1].name ?? scenes[i + 1].id ?? `第 ${i + 2} 幕`),
    });
  }
  return out;
}
