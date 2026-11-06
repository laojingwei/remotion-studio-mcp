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

/** 内置 12 种（面板/文档里列的就是这些） */
export type BuiltinTransitionType = (typeof TRANSITION_TYPES)[number];

/**
 * 合法的转场 id：内置 12 种 + 插件注册的任意 id。
 *
 * 用 `| (string & {})` 而不是纯 `string`：内置名字保住自动补全与拼写检查，
 * 插件 id 又不被挡住。真正的校验在 `normalizeTransition`（写入时，会列出可用项）
 * 和 `computeStyle`（渲染时，取不到就回退 fade 并告警）。
 */
export type TransitionType = BuiltinTransitionType | (string & {});

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

/* ───────────────────────── 插件转场（2026-11-06） ───────────────────────── */

/**
 * 插件转场的上下文。
 *
 * ## 为什么 `phase` 要传，而反向播放由宿主做
 *
 * 内置的出场是"反向播放同一套转场"（`exitStyle` 里就是 `(1-p)` 再调本函数）。
 * 所以插件**只写一个方向**就是对的：宿主在 out 阶段把 p 反过来传进来。
 * `phase` 额外给那些"进出场不该对称"的效果留口子（比如出场时放大而不是缩小），
 * 但不需要区分方向的插件可以完全无视它。
 */
export type PluginTransitionContext = {
  phase: "in" | "out";
  /** 当前帧（场景内，出场窗口内也从 0 起）——要稳定的逐帧变化就用它 */
  frame: number;
  durationInFrames: number;
  sceneDurationInFrames: number;
  /** 工程里给这次转场的参数（`transitionIn.params`），缺省是空对象 */
  params: Record<string, string | number>;
};

export type PluginTransitionParam = {
  key: string;
  label?: string;
  min?: number;
  max?: number;
  default?: number | string;
};

export type PluginTransitionMeta = {
  label?: string;
  hint?: string;
  /** 参数表：编辑器据此渲染表单，agent 据此知道能调什么 */
  params?: PluginTransitionParam[];
};

export type PluginTransitionImpl = (p: number, ctx: PluginTransitionContext) => TransitionStyle;

type PluginTransitionDef = {
  id: string;
  label: string;
  hint: string;
  meta: PluginTransitionMeta;
  /** 服务端只有 id（它不执行插件代码），此时为空 */
  style?: PluginTransitionImpl;
};

const EXTRA_TRANSITIONS = new Map<string, PluginTransitionDef>();

const TRANSITION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 转场返回值只取这些 CSS 属性。
 *
 * 为什么要白名单：转场函数被 `Object.assign` 到场次的 style 上，而那个 style 同时管
 * **布局**。插件返回 `position: fixed` / `width` 之类会把整片排版搞坏，且表现出来的
 * 不是"转场怪"而是"版面错"，极难归因。要整层自定义 DOM 的，那是插件场景组件的活。
 */
const ALLOWED_STYLE_KEYS = new Set([
  "transform",
  "transformOrigin",
  "opacity",
  "filter",
  "backdropFilter",
  "clipPath",
  "maskImage",
  "WebkitMaskImage",
  "maskSize",
  "maskPosition",
  "backgroundColor",
  "background",
  "boxShadow",
  "mixBlendMode",
  "borderRadius",
]);

const warnedStyle = new Set<string>();

/** 过滤插件返回值：只留白名单内的字符串/数字属性，其余丢弃并各警告一次 */
function sanitizePluginStyle(id: string, raw: unknown): TransitionStyle {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnOnce(`transition:${id}:shape`, `[plugin-transition] ${id} 的返回值不是样式对象，已忽略（画面按无转场处理）`);
    return {};
  }
  const out: TransitionStyle = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALLOWED_STYLE_KEYS.has(k)) {
      warnOnce(`transition:${id}:key:${k}`, `[plugin-transition] ${id} 返回了不支持的属性 ${k}（已丢弃；转场只能改视觉，不能改布局）`);
      continue;
    }
    if (typeof v !== "string" && typeof v !== "number") {
      warnOnce(`transition:${id}:val:${k}`, `[plugin-transition] ${id} 的 ${k} 既不是字符串也不是数字（已丢弃）`);
      continue;
    }
    // 外部资源会让渲染端抓不到图（成片里那块就是空的），且是不受控的网络请求
    if (typeof v === "string" && /url\s*\(/i.test(v)) {
      warnOnce(`transition:${id}:url:${k}`, `[plugin-transition] ${id} 的 ${k} 里用了 url()（已丢弃；转场不能引用外部资源）`);
      continue;
    }
    out[k] = v as string | number;
  }
  return out;
}

function warnOnce(key: string, msg: string) {
  if (warnedStyle.has(key)) return;
  warnedStyle.add(key);
  console.warn(msg);
}

/** 由插件加载器调用（渲染端/编辑器）：带实现 */
export function registerPluginTransition(
  id: string,
  mod: unknown,
  from?: string,
): { ok: boolean; reason?: string } {
  const key = String(id ?? "").trim();
  if (!TRANSITION_ID_RE.test(key) || key.length > 40) {
    return { ok: false, reason: `id「${key || "(空)"}」不合法：只能小写字母、数字、短横线，≤40 字` };
  }
  if ((TRANSITION_TYPES as readonly string[]).includes(key)) {
    return { ok: false, reason: `id「${key}」与内置转场重名（内置优先，换个 id）` };
  }
  const m = (mod ?? {}) as { default?: unknown; meta?: PluginTransitionMeta };
  if (typeof m.default !== "function") {
    return { ok: false, reason: `「${key}」没有 export default 一个函数（(p, ctx) => 样式对象）` };
  }
  const meta = m.meta && typeof m.meta === "object" ? m.meta : {};
  EXTRA_TRANSITIONS.set(key, {
    id: key,
    label: String(meta.label ?? key),
    hint: String(meta.hint ?? ""),
    meta,
    style: m.default as PluginTransitionImpl,
  });
  void from;
  return { ok: true };
}

/**
 * 服务端占位注册：只登记 id（服务端不执行插件代码，只需要知道"这个 id 合法"）。
 *
 * 渲染端/编辑器会用真实实现覆盖它。两边注册互不冲突：`registerPluginTransition`
 * 直接 set，后到者生效。
 */
export function registerTransitionId(id: string, label?: string): void {
  const key = String(id ?? "").trim();
  if (!key || (TRANSITION_TYPES as readonly string[]).includes(key)) return;
  const prev = EXTRA_TRANSITIONS.get(key);
  EXTRA_TRANSITIONS.set(key, {
    id: key,
    label: label ?? prev?.label ?? key,
    hint: prev?.hint ?? "",
    meta: prev?.meta ?? {},
    style: prev?.style,
  });
}

/** 注销（插件停用/删文件时用）；内置的删不掉 */
export const unregisterPluginTransition = (id: string): boolean => EXTRA_TRANSITIONS.delete(String(id ?? "").trim());

export const pluginTransitionIds = (): string[] => [...EXTRA_TRANSITIONS.keys()];

/** 全部合法转场 id：内置在前，插件按注册顺序 */
export const allTransitionIds = (): string[] => [...TRANSITION_TYPES, ...EXTRA_TRANSITIONS.keys()];

/** 面板/文档用的完整选项表（内置 + 插件） */
export const allTransitionOptions = (): { key: string; label: string; hint: string; params: PluginTransitionParam[] }[] => [
  ...TRANSITION_OPTIONS.map((o) => ({ ...o, params: [] as PluginTransitionParam[] })),
  ...[...EXTRA_TRANSITIONS.values()].map((d) => ({
    key: d.id,
    label: d.label,
    hint: d.hint,
    params: d.meta.params ?? [],
  })),
];

/** id → 中文短名（插件没给就用 id） */
export const transitionLabelOf = (id: string): string => {
  const builtin = TRANSITION_OPTIONS.find((o) => o.key === id);
  if (builtin) return builtin.label;
  return EXTRA_TRANSITIONS.get(String(id ?? "").trim())?.label ?? id;
};

/**
 * 跑插件转场。
 *
 * 这里 `try/catch` 是**有用**的（和 GLSL pass 不同：那边编译失败不抛，只有黑屏）——
 * 插件函数是普通 JS，抛了就能接住。接住之后回退成 fade 的样式，
 * 保证"插件写崩了，这一场还是淡入淡出"，而不是整片渲不出来。
 */
function runPluginTransition(
  def: PluginTransitionDef,
  p: number,
  ctx: PluginTransitionContext,
): TransitionStyle {
  if (typeof def.style !== "function") {
    warnOnce(`transition:${def.id}:noimpl`, `[plugin-transition] ${def.id} 没有实现（可能只在服务端注册过），已回退为淡入`);
    return { opacity: p };
  }
  try {
    return sanitizePluginStyle(def.id, def.style(p, ctx));
  } catch (err) {
    warnOnce(
      `transition:${def.id}:throw`,
      `[plugin-transition] ${def.id} 报错（已回退为淡入）：${err instanceof Error ? err.message : String(err)}`,
    );
    return { opacity: p };
  }
}

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
  params?: Record<string, string | number>,
): TransitionStyle {
  return computeStyle(type, frame, durationInFrames, sceneDurationInFrames, params, "in");
}

/**
 * 真正的计算：内置走原来的 switch（一个像素都没改），插件走注册表。
 *
 * 单独拆出来是因为出场也要用它、而且必须能告诉插件"这是 out 阶段"。
 * `transitionStyle` 只是 `phase: "in"` 的薄包装，签名保持向后兼容。
 */
function computeStyle(
  type: TransitionType,
  frame: number,
  durationInFrames: number,
  sceneDurationInFrames: number,
  params: Record<string, string | number> | undefined,
  phase: "in" | "out",
): TransitionStyle {
  const d = Math.max(1, durationInFrames);
  const p = clamp01(frame / d);

  /*
   * 插件优先判断：内置 12 种是白名单常量，插件 id 只可能落在注册表里。
   * 两边都不认识时（插件被删、工程里还留着 id）走最后的 `fade` 分支 ——
   * 画面照出、只是效果退回叠化，不会因为一个已经卸掉的插件打不开工程。
   */
  const plug = EXTRA_TRANSITIONS.get(type);
  if (plug) {
    return runPluginTransition(plug, p, {
      phase,
      frame,
      durationInFrames: d,
      sceneDurationInFrames,
      params: params ?? {},
    });
  }

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
  outT:
    | { type: TransitionType; durationInFrames: number; params?: Record<string, string | number> }
    | null
    | undefined,
  framesIntoOut: number,
  outWindowLen: number,
  sceneDurationInFrames = outWindowLen,
): TransitionStyle {
  const len = Math.max(1, outWindowLen);
  const p = clamp01((Math.max(0, framesIntoOut) + 1) / len);
  const hasOut = !!outT && outT.type !== "none";
  // 出场 = 反向播放同一套转场：进度从 1 走到 0
  const base: TransitionStyle = hasOut
    ? computeStyle(outT!.type, Math.round((1 - p) * len), len, sceneDurationInFrames, outT!.params, "out")
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
