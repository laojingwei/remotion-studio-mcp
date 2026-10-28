/**
 * 特效轨：叠加在**整幅画面**上的区间特效。
 *
 * 与转场的区别（这也是为什么要有独立一类对象）：
 *  - 转场挂在**接缝**上，只活在两幕交界处；
 *  - 特效挂在**区间**上，可以横跨三幕、也可以只覆盖某一幕中间的一秒。
 *
 * 所有特效只能用 `transform` / `filter` / 覆盖层 / 不透明度 四种手段实现：
 * 这样渲染端（Remotion）与编辑器预览是同一套 CSS，不会出现"预览好看、成片不同"。
 *
 * 两层结构：
 *  1. **内置特效**（11 种）：公式写在下面，参数在 `EFFECT_PARAMS` 里声明。
 *     参数是**声明式的**——面板按声明自动生成滑杆，MCP 也按同一份声明给 agent 写文档，
 *     加一个新参数只需要在表里加一行。
 *  2. **自定义特效**（kind: "custom"）：agent 直接传关键帧数组，不用等我们内置。
 *     仍然是纯声明式数据（只有数字 + 颜色），不执行任何表达式，所以安全、可版本化、可撤销。
 *
 * 和其他 shared 模块一样：这里只有纯数据与纯函数，不 import react / remotion。
 */

import { parseColor } from "./color";

/** 进度曲线：把「区间进度 p」重新映射一版，决定特效是"先猛后缓"还是"慢慢起" */
export const EFFECT_CURVES = ["linear", "out", "in", "inOut"] as const;
export type EffectCurve = (typeof EFFECT_CURVES)[number];

export const EFFECT_CURVE_LABEL: Record<EffectCurve, string> = {
  linear: "线性",
  out: "先快后慢",
  in: "先慢后快",
  inOut: "缓入缓出",
};

/* ══════════════════════════ 内置特效的参数声明 ══════════════════════════ */

/** 一个可调参数：面板按它生成滑杆，MCP 按它给 agent 出文档 */
export type EffectParamDesc = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** 默认值 = 这个特效原本写死的那个常数，保证老工程逐帧不变 */
  def: number;
  unit?: string;
  hint?: string;
};

export type EffectType =
  | "flash"
  | "shine"
  | "shake"
  | "punch"
  | "spin"
  | "glitch"
  | "blur"
  | "vignette"
  | "gray"
  | "pulse"
  | "strobe"
  | "custom";

export const EFFECT_TYPES = [
  "flash",
  "shine",
  "shake",
  "punch",
  "spin",
  "glitch",
  "blur",
  "vignette",
  "gray",
  "pulse",
  "strobe",
  "custom",
] as const satisfies readonly EffectType[];

export type EffectOption = {
  key: EffectType;
  label: string;
  /** 菜单里的一句话说明（给用户看） */
  hint: string;
  /** 新建时的默认时长（帧，30fps 基准） */
  defaultDuration: number;
  /** 是否支持 `color`（闪类 / 覆盖层类） */
  colorable?: boolean;
  /** 只能由 agent 用关键帧生成，界面里不该出现「新建」入口 */
  agentOnly?: boolean;
};

export const EFFECT_OPTIONS: EffectOption[] = [
  { key: "flash", label: "闪白", hint: "一下白场，适合卡点", defaultDuration: 18, colorable: true },
  { key: "shine", label: "扫光", hint: "斜向高光扫过", defaultDuration: 30, colorable: true },
  { key: "shake", label: "震动", hint: "画面抖动，越往后越轻", defaultDuration: 24 },
  { key: "punch", label: "冲击", hint: "快速放大再回弹", defaultDuration: 20 },
  { key: "spin", label: "旋转", hint: "轻微扭转，像被撞一下", defaultDuration: 28 },
  { key: "glitch", label: "故障", hint: "错位 + 扫描线，赛博感", defaultDuration: 16 },
  { key: "blur", label: "模糊", hint: "糊一下再聚焦", defaultDuration: 24 },
  { key: "vignette", label: "暗角", hint: "四角压暗，压气氛", defaultDuration: 48, colorable: true },
  { key: "gray", label: "去色", hint: "褪成黑白再回来", defaultDuration: 36 },
  { key: "pulse", label: "呼吸", hint: "明暗脉动，稳稳的强调", defaultDuration: 54 },
  { key: "strobe", label: "频闪", hint: "快速明暗闪，强卡点", defaultDuration: 24 },
  {
    key: "custom",
    label: "自定义",
    hint: "agent 用关键帧定义的特效",
    defaultDuration: 24,
    agentOnly: true,
  },
];

/** 用户能"新建"的类型（排除只能由 agent 生成的） */
export const EFFECT_CREATABLE = EFFECT_OPTIONS.filter((o) => !o.agentOnly);

export const effectLabel = (kind: string) =>
  EFFECT_OPTIONS.find((o) => o.key === kind)?.label ?? kind;

export const effectOptionOf = (kind: string): EffectOption =>
  EFFECT_OPTIONS.find((o) => o.key === kind) ?? EFFECT_OPTIONS[0];

/** 这条特效能不能改颜色（面板据此决定要不要显示色板） */
export const effectColorable = (kind: string) => !!effectOptionOf(kind).colorable;

/**
 * 没写 color 时的默认色。
 *
 * **暗角必须是黑**：早期版本暗角是写死的黑，改成可配色后如果统一默认白，
 * 老工程的暗角会变成"白角"，看起来像 bug。
 */
export const effectDefaultColor = (kind: string) => (kind === "vignette" ? "#000000" : "#FFFFFF");

/**
 * 每种内置特效的可调参数。
 *
 * 三项铁律：
 *  1. **默认值 = 这个类型原来写死的常数**，所以老工程不填 params 时输出逐帧不变；
 *  2. 数值范围要有物理意义（% / deg / px / 次），别让 agent 传 9999 把画面糊死；
 *  3. 面板、MCP 文档、渲染公式都读这一张表，不许各写一份。
 */
export const EFFECT_PARAMS: Record<Exclude<EffectType, "custom">, EffectParamDesc[]> = {
  flash: [
    { key: "softness", label: "起落软硬", min: 0.2, max: 3, step: 0.1, def: 0.6, hint: "越小越像硬闪，越大越像渐亮" },
    { key: "peak", label: "峰值位置", min: 0, max: 1, step: 0.05, def: 0.5, hint: "0.5 = 正中；0.2 = 一上来就到最亮" },
  ],
  shine: [
    { key: "angle", label: "扫过角度", min: 0, max: 180, step: 5, def: 105, unit: "°" },
    { key: "width", label: "光带宽度", min: 4, max: 40, step: 1, def: 16, unit: "%" },
    { key: "alpha", label: "高光亮度", min: 0, max: 1, step: 0.05, def: 0.9 },
    { key: "peak", label: "峰值位置", min: 0, max: 1, step: 0.05, def: 0.5 },
  ],
  shake: [
    { key: "amp", label: "抖动幅度", min: 0, max: 8, step: 0.1, def: 1.8, unit: "%" },
    { key: "freqX", label: "横向频率", min: 0, max: 40, step: 1, def: 14, hint: "每秒来回次数的一半" },
    { key: "freqY", label: "纵向频率", min: 0, max: 40, step: 1, def: 11 },
    { key: "decay", label: "衰减", min: 0, max: 1, step: 0.05, def: 1, hint: "1 = 抖完停住；0 = 全程同样幅度" },
  ],
  punch: [
    { key: "amount", label: "放大峰值", min: 0, max: 40, step: 0.5, def: 7, unit: "%" },
    { key: "peak", label: "峰值位置", min: 0, max: 1, step: 0.05, def: 0.5 },
  ],
  spin: [
    { key: "angle", label: "扭转角度", min: 0, max: 30, step: 0.5, def: 3.5, unit: "°" },
    { key: "cycles", label: "来回次数", min: 0.25, max: 4, step: 0.25, def: 1 },
  ],
  glitch: [
    { key: "jitter", label: "横移幅度", min: 0, max: 8, step: 0.1, def: 1.4, unit: "%" },
    { key: "freq", label: "抖动频率", min: 0, max: 60, step: 1, def: 26 },
    { key: "skew", label: "斜切角度", min: 0, max: 5, step: 0.1, def: 0.8, unit: "°" },
    { key: "scan", label: "扫描线", min: 0, max: 1, step: 0.05, def: 1 },
  ],
  blur: [
    { key: "px", label: "模糊半径", min: 0, max: 60, step: 1, def: 16, unit: "px" },
    { key: "peak", label: "峰值位置", min: 0, max: 1, step: 0.05, def: 0.5 },
  ],
  vignette: [
    { key: "inner", label: "内圈透明区", min: 0, max: 90, step: 1, def: 42, unit: "%", hint: "越小压得越狠" },
    { key: "outer", label: "外圈深度", min: 40, max: 100, step: 1, def: 100, unit: "%" },
    { key: "peak", label: "峰值位置", min: 0, max: 1, step: 0.05, def: 0.5 },
  ],
  gray: [
    { key: "amount", label: "去色量", min: 0, max: 1, step: 0.05, def: 1 },
    { key: "desat", label: "降饱和量", min: 0, max: 1, step: 0.05, def: 0.35 },
  ],
  pulse: [
    { key: "amp", label: "亮度起伏", min: 0, max: 1, step: 0.05, def: 0.3 },
    { key: "freq", label: "脉动次数", min: 0, max: 8, step: 0.25, def: 0, hint: "0 = 只走一条包络（默认）" },
  ],
  strobe: [
    { key: "freq", label: "闪烁次数", min: 1, max: 20, step: 1, def: 7 },
    { key: "amp", label: "亮度起伏", min: 0, max: 1, step: 0.05, def: 0.4 },
    { key: "dark", label: "暗场深度", min: 0, max: 1, step: 0.05, def: 0.28 },
  ],
};

/** 某个类型的参数表（custom 没有参数，返回空数组） */
export const effectParamsOf = (kind: string): EffectParamDesc[] =>
  kind === "custom" ? [] : (EFFECT_PARAMS[kind as Exclude<EffectType, "custom">] ?? []);

/** 某个参数的声明（找不到就返回 null，调用方自己兜底） */
export const effectParamDesc = (kind: string, key: string): EffectParamDesc | null =>
  effectParamsOf(kind).find((p) => p.key === key) ?? null;

/* ══════════════════════════ 自定义特效（关键帧 DSL） ══════════════════════════ */

/**
 * 自定义特效每段之间的缓动（写在后一个关键帧上，控制"进入它"的过程）。
 *
 * 刻意**没有 step（台阶）**：区间最后一帧的进度是 (dur-1)/dur，永远到不了 1，
 * 台阶就永远不触发 —— 看起来像"设了没用"。想定住一段再跳，写两个值相同的关键帧即可。
 */
export const CUSTOM_EASES = ["linear", "in", "out", "inOut", "back"] as const;
export type CustomEase = (typeof CUSTOM_EASES)[number];

/**
 * 一个关键帧。
 *
 * `p` 是**区间内进度** 0→1（不是帧号）：这样换时长时动画自动拉伸，
 * agent 不用关心 fps 和帧数。所有字段都可选，缺省 = 中性值
 * （位移 0、缩放 1、不透明度 1、滤镜 1/0），所以只写关心的那几项。
 */
export type CustomKey = {
  p: number;
  ease?: CustomEase;
  /** 画面横向位移，宽度的百分比 */
  x?: number;
  /** 画面纵向位移，高度的百分比 */
  y?: number;
  /** 缩放，1 = 原样 */
  scale?: number;
  /** 旋转角度（度） */
  rotate?: number;
  /** 斜切角度（度） */
  skewX?: number;
  /** 整幅画面不透明度 0..1 */
  opacity?: number;
  /** 滤镜：模糊（px） */
  blur?: number;
  /** 滤镜：亮度，1 = 原样 */
  brightness?: number;
  /** 滤镜：对比度，1 = 原样 */
  contrast?: number;
  /** 滤镜：饱和度，1 = 原样 */
  saturate?: number;
  /** 滤镜：去色 0..1 */
  grayscale?: number;
  /** 滤镜：色相旋转（度） */
  hueRotate?: number;
  /** 覆盖层颜色（hex）；不写就沿用前一个关键帧的颜色 */
  overlay?: string;
  /** 覆盖层不透明度 0..1 */
  overlayOpacity?: number;
  /** 覆盖层混合模式（screen / overlay / multiply / color-dodge …） */
  overlayBlend?: string;
};

/** 自定义特效定义：一串关键帧，按 p 求值 */
export type CustomEffect = {
  /** 关键帧，**不必排序**（求值时会按 p 排好），1~32 个 */
  keys: CustomKey[];
  /** 说明：给人和 agent 看的，不参与渲染 */
  note?: string;
};

/** 每个可动画通道的中性值：intensity 缩小时朝它靠拢 */
const NEUTRAL: Record<string, number> = {
  x: 0,
  y: 0,
  scale: 1,
  rotate: 0,
  skewX: 0,
  opacity: 1,
  blur: 0,
  brightness: 1,
  contrast: 1,
  saturate: 1,
  grayscale: 0,
  hueRotate: 0,
  overlayOpacity: 0,
};

const TRANSFORM_CHANNELS = ["x", "y", "scale", "rotate", "skewX"] as const;
const FILTER_CHANNELS = ["blur", "brightness", "contrast", "saturate", "grayscale", "hueRotate"] as const;

/* ══════════════════════════ 一条特效区间 ══════════════════════════ */

/** 一条特效区间：`from` 是画面时间轴上的帧号（不是秒） */
export type EffectClip = {
  id: string;
  kind: EffectType;
  name?: string;
  from: number;
  durationInFrames: number;
  /** 0..1，整体强度。闪白用满会刺眼，0.6 左右更耐看 */
  intensity?: number;
  /** 覆盖层颜色（仅 colorable 的类型有意义），hex */
  color?: string;
  /** 内置特效的可调参数（键见 EFFECT_PARAMS）；缺省 = 用默认值，旧工程因此逐帧不变 */
  params?: Record<string, number>;
  /** 进度曲线，默认 linear */
  curve?: EffectCurve;
  /** 循环播放：在 durationInFrames 区间内按「单次循环时长」反复播放 */
  loop?: boolean;
  /** 单次循环多少帧（不传 = 该类型的 defaultDuration） */
  loopDurationInFrames?: number;
  /** 循环到多少秒自动停止（停止后效果完全退出）；不传 = 循环到区间结束 */
  loopStopAfterSeconds?: number;
  /** 只有 kind === "custom" 时有效 */
  custom?: CustomEffect;
};

export type EffectOverlay = {
  /** 同一帧可能有多个覆盖层，用 key 做 React 列表 */
  key: string;
  background: string;
  opacity: number;
  /** 覆盖层混合模式（自定义特效用得上） */
  blend?: string;
};

export type EffectFrameStyle = {
  /** 作用在「整个画面容器」上（已合并多个特效） */
  transform?: string;
  filter?: string;
  /** 整幅画面不透明度（多个特效相乘） */
  opacity?: number;
  /** 盖在画面最上层的覆盖层（闪白 / 暗角 / 扫光…） */
  overlays: EffectOverlay[];
};

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

const num = (n: number | undefined, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? n : fallback;

/** 0 → 1 → 0 的钟形曲线：区间开头和结尾都是 0，中间最大 */
const bell = (p: number) => Math.sin(Math.PI * clamp01(p));

/**
 * 峰值可移的钟形曲线：`peak` = 在哪一进度上最强。
 * peak = 0.5 时**完全等于** `bell(p)`（老工程零变化），
 * peak = 0.2 就是"一上来就到最亮，然后慢慢退"。
 */
const peakBell = (p: number, peak: number) => {
  const k = Math.min(0.95, Math.max(0.05, peak));
  const q = p < k ? (p / k) * 0.5 : 0.5 + ((p - k) / (1 - k)) * 0.5;
  return Math.sin(Math.PI * clamp01(q));
};

/** 进度曲线：把线性 p 映射成"先快后慢"这类手感 */
const curveApply = (curve: EffectCurve | undefined, p: number) => {
  const x = clamp01(p);
  switch (curve) {
    case "out":
      return 1 - Math.pow(1 - x, 2.2);
    case "in":
      return Math.pow(x, 2.2);
    case "inOut":
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    default:
      return x;
  }
};

const customEaseApply = (kind: CustomEase | undefined, t: number) => {
  const x = clamp01(t);
  switch (kind) {
    case "in":
      return x * x;
    case "out":
      return 1 - (1 - x) * (1 - x);
    case "inOut":
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case "back": {
      // 过冲一点再回落，像弹簧（只用于进入这一段）
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    }
    default:
      return x;
  }
};

/**
 * 颜色 → rgba() 片段。
 *
 * 为什么不能用"只认 hex"的本地解析器（真踩过）：
 * 面板 ColorPicker 在不支持 alpha 色盘的浏览器里，输出的颜色是
 * `withColorAlpha()` 生成的 **rgba() 字符串**（如 `rgba(255,0,0,0.4)`），
 * 8 位 hex 也常见（原生 alpha 色盘）。只认 hex 的解析器会把它们全部
 * 判成"认不出来"→ 当白色 —— 用户看到的现象就是"色盘改色不生效、
 * 透明度也不生效"，而色板按钮（6 位 hex）偏偏是好的。
 *
 * 统一走 `shared/color.ts#parseColor`（认 #RGB/#RRGGBB/#RRGGBBAA/rgba()）。
 * 颜色自带的 alpha 与传入 alpha **相乘**（色盘调的透明度才能真正落到画面）；
 * 认不出来仍兜底白色（宁可少出错，不要抛异常）。
 */
const rgba = (color: string | undefined, alpha: number) => {
  const c = parseColor((color ?? "").trim());
  if (!c) return `rgba(255,255,255,${clamp01(alpha).toFixed(3)})`;
  return `rgba(${c.r},${c.g},${c.b},${clamp01(alpha * c.a).toFixed(3)})`;
};

/** 去掉小数点后多余的 0（105.0 → 105），CSS 更短也更接近老版本的输出 */
const trim1 = (n: number) => String(Math.round(n * 10) / 10);

/* ══════════════════════════ 自定义特效求值 ══════════════════════════ */

type CustomSample = {
  transform: string[];
  filter: string[];
  opacity?: number;
  overlay?: { background: string; opacity: number; blend?: string };
};

/** 关键帧按 p 排好（agent 传乱序也要能用），顺手夹到 0..1 */
const sortedKeys = (keys: readonly CustomKey[]): CustomKey[] =>
  [...keys]
    .map((k) => ({ ...k, p: clamp01(num(k.p, 0)) }))
    .sort((a, b) => a.p - b.p);

/**
 * 求自定义特效在进度 p 处的画面样式。
 *
 * 分段线性插值：找到夹住 p 的两个关键帧，按后一个关键帧的 `ease` 变形后再逐通道插值。
 * `intensity` 的作用是**朝中性值收拢**（强度 0 = 画面完全原样），
 * 所以同一份关键帧可以从"轻微"一路调到"打到脸上"。
 */
function sampleCustom(custom: CustomEffect | undefined, p: number, intensity: number): CustomSample {
  const out: CustomSample = { transform: [], filter: [] };
  const keys = custom?.keys?.length ? sortedKeys(custom.keys) : [];
  if (!keys.length) return out;

  const at = clamp01(p);
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].p <= at) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const rawT = b && b.p > a.p ? (at - a.p) / (b.p - a.p) : 1;
  const t = b ? customEaseApply(b.ease, rawT) : 1;
  const mix = (k: string) => {
    const va = num(a[k as keyof CustomKey] as number | undefined, NEUTRAL[k]);
    const vb = b ? num(b[k as keyof CustomKey] as number | undefined, NEUTRAL[k]) : va;
    const v = va + (vb - va) * t;
    return NEUTRAL[k] + (v - NEUTRAL[k]) * intensity;
  };
  /** 只要一侧出现过这个通道，就认为这条特效用它（否则不生成多余 CSS） */
  const used = (k: string) =>
    typeof (a as Record<string, unknown>)[k] === "number" ||
    (b && typeof (b as Record<string, unknown>)[k] === "number");

  const parts: string[] = [];
  if (used("x") || used("y")) parts.push(`translate(${mix("x").toFixed(2)}%, ${mix("y").toFixed(2)}%)`);
  if (used("rotate")) parts.push(`rotate(${mix("rotate").toFixed(2)}deg)`);
  if (used("skewX")) parts.push(`skewX(${mix("skewX").toFixed(2)}deg)`);
  if (used("scale")) parts.push(`scale(${Math.max(0, mix("scale")).toFixed(4)})`);
  if (parts.length) out.transform.push(...parts);

  const filters: string[] = [];
  if (used("blur")) filters.push(`blur(${Math.max(0, mix("blur")).toFixed(2)}px)`);
  if (used("brightness")) filters.push(`brightness(${Math.max(0, mix("brightness")).toFixed(3)})`);
  if (used("contrast")) filters.push(`contrast(${Math.max(0, mix("contrast")).toFixed(3)})`);
  if (used("saturate")) filters.push(`saturate(${Math.max(0, mix("saturate")).toFixed(3)})`);
  if (used("grayscale")) filters.push(`grayscale(${clamp01(mix("grayscale")).toFixed(3)})`);
  if (used("hueRotate")) filters.push(`hueRotate(${mix("hueRotate").toFixed(1)}deg)`);
  if (filters.length) out.filter.push(...filters);

  if (used("opacity")) out.opacity = clamp01(mix("opacity"));

  // 覆盖层：颜色取「当前或之前最近一个写了 overlay 的关键帧」，
  // 透明度按通道插值 —— 这样只写 {p:0,overlayOpacity:0} / {p:0.5,overlay:"#fff",overlayOpacity:.8} / {p:1,overlayOpacity:0} 就是一次闪白
  if (used("overlayOpacity")) {
    let color = "#FFFFFF";
    let blend: string | undefined;
    for (let k = i; k >= 0; k--) {
      if (typeof keys[k].overlay === "string") {
        color = keys[k].overlay as string;
        blend = keys[k].overlayBlend;
        break;
      }
    }
    // 这一段的目标关键帧上写了混合模式就以它为准（人通常写在"最强那一帧"）
    if (!blend && b?.overlayBlend) blend = b.overlayBlend;
    const opacity = clamp01(mix("overlayOpacity"));
    if (opacity > 0.001) out.overlay = { background: color, opacity, blend };
  }

  return out;
}

/* ══════════════════════════ 主入口：某一帧的合成样式 ══════════════════════════ */

/**
 * 某一帧的合成特效样式。
 *
 * 多个特效可以叠在同一帧（例如"闪白 + 震动"），这里按顺序合并：
 * transform / filter 用空格拼成复合值，不透明度相乘，覆盖层按数组顺序从下往上盖。
 *
 * @param clips 工程里的全部特效区间
 * @param frame 画面全局帧号
 * @param fps 每秒帧数（循环的"自动停止秒数"换算成帧用；不传按 30）
 */
export function effectFrameStyle(
  clips: readonly EffectClip[] | undefined,
  frame: number,
  fps = 30,
): EffectFrameStyle {
  const overlays: EffectOverlay[] = [];
  const transforms: string[] = [];
  const filters: string[] = [];
  let opacity = 1;
  if (!clips?.length) return { overlays };

  for (const clip of clips) {
    const dur = Math.max(1, Math.round(clip.durationInFrames));
    const local = frame - Math.round(clip.from);
    if (local < 0 || local >= dur) continue;

    // 循环：把区间内的进度重映射成「第 N 次循环里的相位」。
    // 到达 loopStopAfterSeconds 后整个特效视为未激活（完全退出，不保留残影）——
    // 否则长片挂循环特效会出现"停在哪一刻就永远冻在哪个亮度"的脏状态。
    let rawP: number;
    if (clip.loop) {
      const loopDur = Math.max(
        4,
        Math.round(clip.loopDurationInFrames ?? effectOptionOf(clip.kind).defaultDuration),
      );
      if (
        clip.loopStopAfterSeconds !== undefined &&
        local >= Math.round(clip.loopStopAfterSeconds * fps)
      ) {
        continue;
      }
      rawP = clamp01((local % loopDur) / loopDur);
    } else {
      rawP = clamp01(local / dur);
    }

    const p = curveApply(clip.curve, rawP);
    const intensity = clamp01(clip.intensity ?? 1);
    const color = clip.color ?? effectDefaultColor(clip.kind);
    /** 读参数：没写就用该类型的默认值（= 老版本写死的常数） */
    const P = (key: string) => num(clip.params?.[key], effectParamDesc(clip.kind, key)?.def ?? 0);

    if (clip.kind === "custom") {
      const s = sampleCustom(clip.custom, p, intensity);
      if (s.transform.length) transforms.push(...s.transform);
      if (s.filter.length) filters.push(...s.filter);
      if (s.opacity !== undefined) opacity *= s.opacity;
      if (s.overlay) {
        overlays.push({
          key: clip.id,
          background: s.overlay.background,
          opacity: s.overlay.opacity * intensity,
          blend: s.overlay.blend,
        });
      }
      continue;
    }

    switch (clip.kind) {
      case "flash": {
        // 闪白：白场来得更快（pow < 1），走得更慢，看着才像"闪"而不是"渐亮"
        const curve = Math.pow(peakBell(p, P("peak")), Math.max(0.05, P("softness")));
        overlays.push({
          key: clip.id,
          background: color,
          opacity: clamp01(curve * intensity),
        });
        break;
      }
      case "shine": {
        // 高光扫过：位置随进度平移。默认宽度 16% 时正好是"从画面左上外侧扫到右下外侧"，
        // 也就是老版本写死的 -25% → 125%（老工程逐帧不变）；改宽度只影响光带粗细和行程
        const band = Math.max(2, P("width"));
        const at = -(band + 9) + (118 + 2 * band) * p;
        const a = clamp01(P("alpha")) * intensity;
        overlays.push({
          key: clip.id,
          background: `linear-gradient(${trim1(P("angle"))}deg, ${rgba(color, 0)} ${(at - band).toFixed(1)}%, ${rgba(color, a)} ${at.toFixed(1)}%, ${rgba(color, 0)} ${(at + band).toFixed(1)}%)`,
          opacity: 1,
        });
        break;
      }
      case "shake": {
        // 越到后面越轻（乘 1-decay*p），否则收尾会"抖一下停住"，很假
        const amp = P("amp") * intensity * (1 - clamp01(P("decay")) * p);
        const dx = Math.sin(p * Math.PI * P("freqX")) * amp;
        const dy = Math.cos(p * Math.PI * P("freqY")) * amp;
        transforms.push(`translate(${dx.toFixed(2)}%, ${dy.toFixed(2)}%)`);
        break;
      }
      case "punch": {
        const scale = 1 + (P("amount") / 100) * intensity * peakBell(p, P("peak"));
        transforms.push(`scale(${scale.toFixed(4)})`);
        break;
      }
      case "spin": {
        const deg = Math.sin(p * Math.PI * 2 * P("cycles")) * P("angle") * intensity;
        transforms.push(`rotate(${deg.toFixed(2)}deg)`);
        break;
      }
      case "glitch": {
        // 横向高平抖动 + 轻微斜切，配一层红/青扫描线，像信号被撕了一下
        const jitter = Math.sin(p * Math.PI * P("freq")) * P("jitter") * intensity;
        const skew = P("skew") * intensity * bell(p);
        transforms.push(`translateX(${jitter.toFixed(2)}%) skewX(${skew.toFixed(2)}deg)`);
        const scan = clamp01(P("scan"));
        if (scan > 0) {
          overlays.push({
            key: `${clip.id}-scan`,
            background:
              "repeating-linear-gradient(0deg, rgba(255,0,80,0.10) 0 2px, rgba(0,220,255,0.10) 2px 4px)",
            opacity: clamp01(bell(p) * intensity * scan),
          });
        }
        break;
      }
      case "blur": {
        const px = P("px") * intensity * peakBell(p, P("peak"));
        filters.push(`blur(${px.toFixed(2)}px)`);
        break;
      }
      case "vignette": {
        const inner = Math.min(89, Math.max(0, P("inner")));
        const outer = Math.min(100, Math.max(inner + 1, P("outer")));
        overlays.push({
          key: clip.id,
          background: `radial-gradient(ellipse at 50% 50%, ${rgba(color, 0)} ${inner.toFixed(1)}%, ${rgba(color, 0.92 * clamp01(outer / 100))} 100%)`,
          opacity: clamp01(peakBell(p, P("peak")) * intensity),
        });
        break;
      }
      case "gray": {
        const k = clamp01(bell(p) * intensity * clamp01(P("amount")));
        filters.push(`grayscale(${k.toFixed(3)}) saturate(${(1 - clamp01(P("desat")) * k).toFixed(3)})`);
        break;
      }
      case "pulse": {
        const freq = P("freq");
        const osc = freq > 0 ? 0.6 + 0.4 * Math.cos(p * Math.PI * 2 * freq) : 1;
        const k = bell(p) * intensity * osc;
        filters.push(`brightness(${(1 + P("amp") * k).toFixed(3)})`);
        break;
      }
      case "strobe": {
        // 频闪：fast 振荡叠在钟形包络里，两头自然收住
        const env = bell(p) * intensity;
        const flick = Math.sin(p * Math.PI * Math.max(0.5, P("freq")));
        filters.push(`brightness(${(1 + P("amp") * env * flick).toFixed(3)})`);
        const dark = clamp01(P("dark"));
        if (dark > 0) {
          overlays.push({
            key: clip.id,
            background: "#000000",
            opacity: clamp01(Math.max(0, -flick) * dark * env),
          });
        }
        break;
      }
    }
  }

  const style: EffectFrameStyle = { overlays };
  if (transforms.length) style.transform = transforms.join(" ");
  if (filters.length) style.filter = filters.join(" ");
  if (opacity < 1) style.opacity = clamp01(opacity);
  return style;
}

/** 时间轴上的一块：从 from 到 from + duration，方便和场景块共用一套定位 */
export const effectSpan = (clip: EffectClip) => ({
  start: Math.max(0, Math.round(clip.from)),
  dur: Math.max(1, Math.round(clip.durationInFrames)),
  end: Math.max(0, Math.round(clip.from)) + Math.max(1, Math.round(clip.durationInFrames)),
});

/** 新建特效时的默认值（缺少的字段用这里补齐，避免各处自己写一份） */
export function effectDefaults(kind: EffectType) {
  const opt = effectOptionOf(kind);
  return {
    kind,
    name: opt.label,
    durationInFrames: opt.defaultDuration,
    intensity: 0.8,
    ...(opt.colorable ? { color: effectDefaultColor(kind) } : {}),
  } as const;
}

/** 一条特效的可读摘要（面板、MCP 回执、历史记录都用它，避免各写一份描述） */
export function effectSummaryText(clip: EffectClip): string {
  if (clip.kind === "custom") {
    const n = clip.custom?.keys?.length ?? 0;
    return n ? `自定义（${n} 个关键帧）` : "自定义（缺关键帧，不会有效果）";
  }
  const tuned = Object.entries(clip.params ?? {})
    .filter(([k, v]) => {
      const d = effectParamDesc(clip.kind, k);
      return d && Number.isFinite(v) && Math.abs(v - d.def) > 1e-9;
    })
    .map(([k]) => effectParamDesc(clip.kind, k)?.label ?? k);
  const base = `${effectLabel(clip.kind)} · 强度 ${Math.round((clip.intensity ?? 1) * 100)}%`;
  return tuned.length ? `${base} · 已调 ${tuned.join("/")}` : base;
}
