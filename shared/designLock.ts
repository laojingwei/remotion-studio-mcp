/**
 * 设计锁（designLock）：把"审美判断"压成"可执行参数"。
 *
 * 为什么需要它：
 * 复盘里 6 轮验收有 5 轮是"方向/审美错位"。根因不是 agent 不听，而是问诊收到的是
 * 自由文本（"高级一点""有质感"），这类词无法约束具体字号、转场、元素数量，
 * 于是每一幕都靠 agent 现编 —— 幕数越多，即兴次数越多，必然不自洽。
 *
 * 设计锁做三件事：
 *   1. 用户只答"档位"（密度/动感/转场性格/要不要特效），不问实现类型（8 种转场、14 种特效）；
 *   2. 档位 → 一整套具体参数（字号、元素上限、转场白名单、stagger、允许的特效）。
 *   3. 全片共用一份锁：改一处、全片跟随，而不是逐幕手改。
 *
 * 这里保持纯函数 + 结构化类型（不 import schema），避免和 shared/schema.ts 绕成循环依赖
 * —— 和 shared/transitions.ts 处理接缝转场时是同一个理由。
 */
import { isMotionScene } from "./sceneKinds";

/** 7 种主形态。决定"哪些问题要问"和"默认档位"。 */
export const VIDEO_FORMS = [
  "口播讲解",
  "产品演示",
  "情景剧",
  "客户证言",
  "前后对比",
  "动画演示",
  "混剪",
] as const;
export type VideoForm = (typeof VIDEO_FORMS)[number];

/** 信息密度：杂志（密）/ 讲稿（中）/ 海报（疏） */
export const DENSITY_OPTIONS = ["杂志", "讲稿", "海报"] as const;
/** 动感档位 */
export const MOTION_OPTIONS = ["克制", "标准", "活泼"] as const;
/** 转场性格（用户的语言，不是 transition type） */
export const TRANSITION_TONES = ["利落", "柔和", "动感"] as const;
/** 特效档位：默认关 */
export const EFFECTS_LEVELS = ["关", "点缀", "允许"] as const;
/** 背景明暗（影响字幕反色） */
export const BG_TONES = ["浅", "深"] as const;

export type Density = (typeof DENSITY_OPTIONS)[number];
export type MotionLevel = (typeof MOTION_OPTIONS)[number];
export type TransitionTone = (typeof TRANSITION_TONES)[number];
export type EffectsLevel = (typeof EFFECTS_LEVELS)[number];
export type BgTone = (typeof BG_TONES)[number];

export type FormSpec = {
  form: VideoForm;
  label: string;
  /**
   * 镜头清单要问到什么程度：
   * - full：实拍片，逐镜要出镜人/场地/产品状态（能直接排拍摄）
   * - simple：只需出镜方式与背景（口播类）
   * - list：不需要拍摄，改成"素材/图解点"清单（动画·混剪）
   */
  shots: "full" | "simple" | "list";
  density: Density;
  motion: MotionLevel;
  transition: TransitionTone;
  bg: BgTone;
  effects: EffectsLevel;
  note: string;
};

/**
 * 形态预设（对应 v4 文档 §7.5 的默认档位表）。
 * 这些是"兜底默认值"：用户不反对就不用问，反对了改一个档位即可。
 */
export const FORM_SPECS: Record<VideoForm, FormSpec> = {
  口播讲解: {
    form: "口播讲解",
    label: "口播讲解",
    shots: "simple",
    density: "讲稿",
    motion: "克制",
    transition: "柔和",
    bg: "浅",
    effects: "关",
    note: "人说话为主：字幕可读性优先，动效不抢话，转场要软",
  },
  产品演示: {
    form: "产品演示",
    label: "产品演示",
    shots: "full",
    density: "杂志",
    motion: "标准",
    transition: "利落",
    bg: "浅",
    effects: "点缀",
    note: "卖点要密、特写要多，转场利落别拖",
  },
  情景剧: {
    form: "情景剧",
    label: "情景剧",
    shots: "full",
    density: "海报",
    motion: "活泼",
    transition: "利落",
    bg: "深",
    effects: "关",
    note: "演的是人：画面别塞字，特效会破坏表演",
  },
  客户证言: {
    form: "客户证言",
    label: "客户证言",
    shots: "full",
    density: "讲稿",
    motion: "克制",
    transition: "柔和",
    bg: "浅",
    effects: "关",
    note: "可信度优先：别做花活，字幕必须齐（很多人静音看）",
  },
  前后对比: {
    form: "前后对比",
    label: "前后对比",
    shots: "full",
    density: "杂志",
    motion: "标准",
    transition: "动感",
    bg: "浅",
    effects: "关",
    note: "对比必须同机位同参数，否则观众不信",
  },
  动画演示: {
    form: "动画演示",
    label: "动画演示",
    shots: "list",
    density: "杂志",
    motion: "活泼",
    transition: "动感",
    bg: "深",
    effects: "允许",
    note: "没有拍摄：镜头清单改成「元素/图解清单」",
  },
  混剪: {
    form: "混剪",
    label: "混剪",
    shots: "list",
    density: "海报",
    motion: "活泼",
    transition: "利落",
    bg: "深",
    effects: "点缀",
    note: "节奏靠卡点：素材量和节奏点必须先盘清",
  },
};

/** 转场性格 → 白名单（用户永远不需要看到 fade/circle 这些词） */
export const TRANSITION_WHITELIST: Record<TransitionTone, string[]> = {
  利落: ["none", "zoom"],
  柔和: ["none", "blur", "fade"],
  动感: ["none", "slide", "wipe", "circle", "zoom", "blur"],
};

/** 转场性格 → 时长上限（帧）。文字页拉长转场会放大叠字，所以上限必须封死。 */
export const TRANSITION_MAX_FRAMES: Record<TransitionTone, number> = {
  利落: 10,
  柔和: 15,
  动感: 22,
};

/** 密度 → 字号与元素上限。字号按「短边百分比」，与 elementSchema.size 同口径。 */
export const DENSITY_SPECS: Record<
  Density,
  {
    maxTextElements: number;
    maxDecorative: number;
    titleSizePct: number;
    bodySizePct: number;
    subtitleSizePct: number;
    bodyYRange: [number, number];
    note: string;
  }
> = {
  杂志: {
    maxTextElements: 10,
    maxDecorative: 4,
    titleSizePct: 5.2,
    bodySizePct: 3.2,
    subtitleSizePct: 3.8,
    bodyYRange: [20, 74],
    note: "信息密度高：一屏可多块内容，但标题仍要压场",
  },
  讲稿: {
    maxTextElements: 7,
    maxDecorative: 3,
    titleSizePct: 5.6,
    bodySizePct: 3.6,
    subtitleSizePct: 3.8,
    bodyYRange: [24, 72],
    note: "一段话为核心：靠字号层级拉开，不靠元素数量",
  },
  海报: {
    maxTextElements: 5,
    maxDecorative: 2,
    titleSizePct: 7.0,
    bodySizePct: 4.0,
    subtitleSizePct: 4.0,
    bodyYRange: [30, 70],
    note: "大字压场：一屏只说一件事，留白是设计不是空",
  },
};

/** 动感档位 → 入场节奏 */
export const MOTION_SPECS: Record<
  MotionLevel,
  { staggerFrames: number; inFrames: number; ease: "easeOut" | "linear" | "spring"; note: string }
> = {
  克制: { staggerFrames: 4, inFrames: 18, ease: "easeOut", note: "稳重：慢入、错峰大，适合口播与证言" },
  标准: { staggerFrames: 3, inFrames: 14, ease: "easeOut", note: "常规节奏：多数片子用这一档" },
  活泼: { staggerFrames: 2, inFrames: 10, ease: "spring", note: "快节奏：短促、有弹性，适合发布与混剪" },
};

/** 特效档位 → 白名单。空数组 = 一个都不许上。 */
export const EFFECTS_WHITELIST: Record<EffectsLevel, string[]> = {
  关: [],
  点缀: ["shine", "vignette"],
  允许: ["shine", "vignette", "pulse", "flash", "glitch"],
};

export type DesignLock = {
  /** 锁定时的形态（改动形态 = 重新推导） */
  form: VideoForm;
  density: Density;
  motion: MotionLevel;
  transition: TransitionTone;
  effects: EffectsLevel;
  bg: BgTone;

  /* ── 由档位推导出的具体参数（下游直接读这些，不再自己判断） ── */
  titleSizePct: number;
  bodySizePct: number;
  subtitleSizePct: number;
  bodyYRange: [number, number];
  maxTextElements: number;
  maxDecorative: number;
  staggerFrames: number;
  inFrames: number;
  ease: string;
  transitionWhitelist: string[];
  transitionMaxFrames: number;
  effectWhitelist: string[];
  bgTone: BgTone;
  /** 人读的硬规则，验收时原样回显（"你定的：讲稿密度、柔和转场"） */
  rules: string[];
  /** 推导依据：用户明确给的档位 vs 形态默认值 */
  sources: Record<string, "user" | "form">;
  derivedAt: string;
};

const MOOD_DOWN = ["高级", "克制", "冷静", "沉稳", "质感", "专业", "安静"];
const MOOD_UP = ["燃", "热闹", "年轻", "活泼", "带感", "炸", "轻快"];

export function normalizeForm(form?: string): VideoForm {
  const raw = String(form ?? "").trim();
  if (!raw) return "口播讲解";
  if ((VIDEO_FORMS as readonly string[]).includes(raw)) return raw as VideoForm;
  // 常见别名容错：用户/agent 很可能写成"口播""演示""证言"
  const hit = (VIDEO_FORMS as readonly string[]).find((f) => raw.includes(f) || f.includes(raw));
  if (hit) return hit as VideoForm;
  if (/口播|讲解|讲述|知识/.test(raw)) return "口播讲解";
  if (/演示|测评|开箱|展示/.test(raw)) return "产品演示";
  if (/情景|剧情|短剧|故事/.test(raw)) return "情景剧";
  if (/证言|见证|口碑|采访/.test(raw)) return "客户证言";
  if (/对比|前后|改造/.test(raw)) return "前后对比";
  if (/动画|MG|图解|信息图|数据/.test(raw)) return "动画演示";
  if (/混剪|卡点|合集/.test(raw)) return "混剪";
  return "口播讲解";
}

function oneOf<T extends string>(list: readonly T[], v: unknown, fallback: T): T {
  const s = String(v ?? "").trim();
  return (list as readonly string[]).includes(s) ? (s as T) : fallback;
}

/** 动感档位升降一档（情绪词微调用） */
function shiftMotion(level: MotionLevel, dir: -1 | 1): MotionLevel {
  const i = MOTION_OPTIONS.indexOf(level);
  const next = Math.min(MOTION_OPTIONS.length - 1, Math.max(0, i + dir));
  return MOTION_OPTIONS[next];
}

/** 特效档位升降一档 */
function shiftEffects(level: EffectsLevel, dir: -1 | 1): EffectsLevel {
  const i = EFFECTS_LEVELS.indexOf(level);
  const next = Math.min(EFFECTS_LEVELS.length - 1, Math.max(0, i + dir));
  return EFFECTS_LEVELS[next];
}

/**
 * 由 brief 推导设计锁。
 *
 * 优先级：用户明确给的档位 > 形态默认 > 情绪词微调。
 * 情绪词只做"升降一档"，不改变形态基准 —— 否则「高级 + 情景剧」会被推成四不像。
 */
export function deriveDesignLock(input: {
  form?: string;
  density?: string;
  motionLevel?: string;
  transitionTone?: string;
  effects?: string;
  bgTone?: string;
  mood?: string[];
}): DesignLock {
  const form = normalizeForm(input.form);
  const spec = FORM_SPECS[form];

  const density = oneOf(DENSITY_OPTIONS, input.density, spec.density);
  const motionRaw = oneOf(MOTION_OPTIONS, input.motionLevel, spec.motion);
  const transition = oneOf(TRANSITION_TONES, input.transitionTone, spec.transition);
  const effectsRaw = oneOf(EFFECTS_LEVELS, input.effects, spec.effects);
  const bg = oneOf(BG_TONES, input.bgTone, spec.bg);

  const sources: Record<string, "user" | "form"> = {
    form: input.form ? "user" : "form",
    density: input.density ? "user" : "form",
    motion: input.motionLevel ? "user" : "form",
    transition: input.transitionTone ? "user" : "form",
    effects: input.effects ? "user" : "form",
    bg: input.bgTone ? "user" : "form",
  };

  // 情绪词微调：只在用户没显式给动感/特效档位时生效
  let motion = motionRaw;
  let effects = effectsRaw;
  const moods = (input.mood ?? []).map((m) => String(m).trim()).filter(Boolean);
  const down = moods.find((m) => MOOD_DOWN.some((k) => m.includes(k)));
  const up = moods.find((m) => MOOD_UP.some((k) => m.includes(k)));
  if (!input.motionLevel) {
    if (down) motion = shiftMotion(motion, -1);
    if (up) motion = shiftMotion(motion, 1);
  }
  if (!input.effects) {
    if (down) effects = shiftEffects(effects, -1);
    if (up) effects = shiftEffects(effects, 1);
  }

  const d = DENSITY_SPECS[density];
  const m = MOTION_SPECS[motion];
  const rules = [
    `密度：${density} —— ${d.note}（正文约 ${d.bodySizePct}%，一屏文字元素 ≤ ${d.maxTextElements}）`,
    `动感：${motion} —— ${m.note}（入场 ${m.inFrames} 帧，错峰 ${m.staggerFrames} 帧）`,
    `转场：${transition} —— 只用 ${TRANSITION_WHITELIST[transition].join(" / ")}，单次 ≤ ${TRANSITION_MAX_FRAMES[transition]} 帧`,
    `背景：${bg}底${effects === "关" ? "，不加特效" : `，特效限 ${EFFECTS_WHITELIST[effects].join(" / ")}`}`,
    "文字密集的幕禁止用 flip / circle / wipe 做转场（会叠字，已实测）",
    "特效不能当转场用（punch 每幕砸一下 = 廉价方案，已被否决过）",
  ];

  return {
    form,
    density,
    motion,
    transition,
    effects,
    bg,
    titleSizePct: d.titleSizePct,
    bodySizePct: d.bodySizePct,
    subtitleSizePct: d.subtitleSizePct,
    bodyYRange: d.bodyYRange,
    maxTextElements: d.maxTextElements,
    maxDecorative: d.maxDecorative,
    staggerFrames: m.staggerFrames,
    inFrames: m.inFrames,
    ease: m.ease,
    transitionWhitelist: TRANSITION_WHITELIST[transition],
    transitionMaxFrames: TRANSITION_MAX_FRAMES[transition],
    effectWhitelist: EFFECTS_WHITELIST[effects],
    bgTone: bg,
    rules,
    sources,
    derivedAt: new Date().toISOString(),
  };
}

/* ─────────────────── 违约检查：给 check_project / brief_audit 用 ─────────────────── */

type LooseElement = {
  kind?: string;
  type?: string;
  name?: string;
  size?: number;
  text?: string;
};
type LooseScene = {
  id?: string;
  name?: string;
  type?: string;
  durationInFrames?: number;
  subtitle?: string;
  transitionIn?: { type?: string; durationInFrames?: number } | null;
  transitionOut?: { type?: string; durationInFrames?: number } | null;
  elements?: LooseElement[];
};

export type LockViolation = {
  sceneIndex: number;
  sceneName: string;
  kind: "elements" | "transition" | "transitionLength" | "titleSize" | "effect";
  message: string;
};

const DECORATIVE_HINT = /网格|grid|光晕|glow|噪点|dust|纹理|texture|背景|bg/i;

/** 元素是否算"装饰层"（背景网格/光晕/噪点这类，不占信息位） */
export function isDecorative(el: { kind?: string; name?: string }): boolean {
  if (el.kind !== "text" && el.kind !== "svg") return false;
  return DECORATIVE_HINT.test(String(el.name ?? ""));
}

/**
 * 按设计锁检查场景，返回违约清单。
 * 只报"确定违约"，不报风格偏好 —— 免得变成一堆没人看的警告。
 */
export function lockViolations(lock: DesignLock, scenes: readonly LooseScene[]): LockViolation[] {
  const out: LockViolation[] = [];
  scenes.forEach((s, i) => {
    const name = String(s.name ?? s.type ?? `第 ${i + 1} 幕`);
    const els = (s.elements ?? []).filter((e) => !isDecorative(e));
    const textEls = els.filter((e) => e.kind === "text" && String(e.text ?? "").trim());
    const deco = (s.elements ?? []).filter(isDecorative);

    // 动效场景（glow/grain/lightleak/kinetic/maskreveal）是效果件，不是版面：
    // 逐字动画天然几十个 span，按「一屏文字元素 / 标题字号」审计就是每条必违规。
    // 它们仍然要过下面的转场审计。
    if (!isMotionScene(String(s.type ?? ""))) {
      // 装饰层天然可以多（背景是三层也不为过），所以这里只看信息元素
      if (textEls.length > lock.maxTextElements) {
        out.push({
          sceneIndex: i,
          sceneName: name,
          kind: "elements",
          message: `一屏 ${textEls.length} 个文字元素，超过「${lock.density}」密度上限 ${lock.maxTextElements}`,
        });
      }
      if (deco.length > lock.maxDecorative + 2) {
        out.push({
          sceneIndex: i,
          sceneName: name,
          kind: "elements",
          message: `装饰层 ${deco.length} 层（上限约 ${lock.maxDecorative + 2}），容易糊`,
        });
      }
    }

    for (const [dir, t] of [
      ["入", s.transitionIn],
      ["出", s.transitionOut],
    ] as const) {
      if (!t?.type || t.type === "none") continue;
      if (!lock.transitionWhitelist.includes(t.type)) {
        out.push({
          sceneIndex: i,
          sceneName: name,
          kind: "transition",
          message: `${dir}场转场用了 ${t.type}，不在「${lock.transition}」白名单（${lock.transitionWhitelist.join("/")}）`,
        });
      }
      const dur = Number(t.durationInFrames ?? 0);
      if (dur > lock.transitionMaxFrames) {
        out.push({
          sceneIndex: i,
          sceneName: name,
          kind: "transitionLength",
          message: `${dir}场转场 ${dur} 帧，超过上限 ${lock.transitionMaxFrames} 帧（文字页会叠字）`,
        });
      }
    }

    // 文字密集的幕禁 flip/circle/wipe（动效场景本身就是文字动画，这条不适用）
    const dense = !isMotionScene(String(s.type ?? "")) && textEls.reduce((n, e) => n + String(e.text ?? "").length, 0) > 20;
    for (const t of [s.transitionIn, s.transitionOut]) {
      if (dense && t?.type && ["flip", "circle", "wipe"].includes(t.type)) {
        out.push({
          sceneIndex: i,
          sceneName: name,
          kind: "transition",
          message: `这幕文字 ${textEls.reduce((n, e) => n + String(e.text ?? "").length, 0)} 字，用 ${t.type} 会叠字`,
        });
      }
    }

    // 标题字号偏离（只查最大的那个文字元素，容差 1.2 个百分点）
    // 动效场景的「字」是效果的一部分，字号由动画决定，不跟版面档位比。
    if (!isMotionScene(String(s.type ?? ""))) {
      const biggest = textEls.reduce<LooseElement | null>(
        (acc, e) => (!acc || Number(e.size ?? 0) > Number(acc.size ?? 0) ? e : acc),
        null,
      );
      if (biggest && Math.abs(Number(biggest.size ?? 0) - lock.titleSizePct) > 1.2) {
        out.push({
          sceneIndex: i,
          sceneName: name,
          kind: "titleSize",
          message: `最大字号 ${biggest.size}% 偏离锁定值 ${lock.titleSizePct}%（容差 1.2）`,
        });
      }
    }
  });

  // 同一条违约在多幕里重复时只报一次 + 受影响幕数（复盘里 check_project 噪声就是这么来的）
  const grouped = new Map<string, LockViolation & { count: number; scenes: number[] }>();
  for (const v of out) {
    const key = `${v.kind}|${v.message.replace(/^\d+/, "N")}`;
    const hit = grouped.get(key);
    if (hit) {
      hit.count += 1;
      hit.scenes.push(v.sceneIndex);
    } else {
      grouped.set(key, { ...v, count: 1, scenes: [v.sceneIndex] });
    }
  }
  return [...grouped.values()].map((g) => ({
    sceneIndex: g.sceneIndex,
    sceneName: g.count > 1 ? `${g.sceneName} 等 ${g.count} 幕` : g.sceneName,
    kind: g.kind,
    message: g.message,
  }));
}

/** 设计锁的一句话摘要（回执/验收时原样回显，让用户确认"你定的是这个"） */
export function designLockSummary(lock: DesignLock): string {
  return [
    `形态「${lock.form}」· 密度 ${lock.density} · 动感 ${lock.motion} · 转场 ${lock.transition} · 特效 ${lock.effects} · ${lock.bg}底`,
    `锁定值：标题 ${lock.titleSizePct}% / 正文 ${lock.bodySizePct}% / 字幕 ${lock.subtitleSizePct}% · 一屏文字元素 ≤ ${lock.maxTextElements} · 转场 ≤ ${lock.transitionMaxFrames} 帧`,
  ].join("\n");
}
