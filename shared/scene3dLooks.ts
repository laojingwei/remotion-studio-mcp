/**
 * 3D 光线风格（look）的唯一数据源 + 插件注册表。
 *
 * ## 为什么从 `src/scenes/scene3d/Scene3D.tsx` 搬到这里
 *
 * 三处都要同一份：
 *  - 渲染端 / 编辑器视口：按 id 取灯光与辉光参数
 *  - 服务端：`/api/scene-types` 的字段选项里要有可选的 look id（否则 agent/面板看不到）
 *  - 插件：`scene3d/looks.json` 追加自己的风格
 *
 * 而 `shared/` 不能反向 import `src/`（那是渲染端的目录），所以数据只能放这一侧。
 *
 * ## look 是什么、不是什么
 *
 * 它只换**光的性格**，不换配色（颜色仍从主题取，`core`/`dot` 是主题色 token）。
 * 所以插件加一套 look 不可能"把画面搞成别的色系"，风险比换配色低一个量级。
 */

/** 一盏方向光。`color` 可以是 hex，也可以是主题 token（core/dot/warm/cool/cyber/sky） */
export type LookLightSpec = {
  pos: [number, number, number];
  intensity: number;
  color: string;
};

export type LookSpec = {
  /** UI 短名（面板按钮/选项）；插件不给就用 id */
  label?: string;
  /** 环境光；给了 hemisphere 就不用 ambientLight（自然光靠天/地两色） */
  ambient: number;
  hemisphere?: { sky: string; ground: string; intensity: number };
  /** 环境贴图强度：金属的"亮"几乎全来自它，这套值决定材质是"亮铬"还是"暗铁" */
  env: number;
  key: LookLightSpec;
  rimA: LookLightSpec;
  rimB: LookLightSpec | null;
  fill: LookLightSpec | null;
  bloom: { strength: number; radius: number; threshold: number };
  /** 与 2D 版式混排时的观感提示，写进 meta 的 describe 里 */
  summary: string;
};

export const BUILTIN_LOOKS: Record<string, LookSpec> = {
  /* 明亮干净的产品光：高环境、强主光、弱边光。适合"讲清楚这是什么" */
  studio: {
    ambient: 0.6,
    env: 0.6,
    key: { pos: [4.5, 6, 5], intensity: 2.6, color: "#FFFFFF" },
    rimA: { pos: [-5, 2.5, -6], intensity: 0.8, color: "core" },
    rimB: { pos: [5, -2, -5], intensity: 0.5, color: "dot" },
    fill: { pos: [-3, 1.5, 4], intensity: 1.1, color: "#FFFFFF" },
    bloom: { strength: 0.26, radius: 0.4, threshold: 0.92 },
    summary: "明亮干净的产品光，材质看得最清楚（适合讲解、功能介绍）",
  },
  /* 暗色戏剧：几乎没有环境光，靠一束暖主光和冷轮廓立起来，暗部很沉 */
  dramatic: {
    ambient: 0.1,
    env: 0.14,
    key: { pos: [3.5, 5.5, 4], intensity: 2.6, color: "#FFC48A" },
    rimA: { pos: [-5, 2, -6], intensity: 2.4, color: "dot" },
    rimB: { pos: [4, -3, -5], intensity: 1.5, color: "cool" },
    fill: null,
    // 半径 0.5 而不是 0.62：半径一大，能量摊到更大的面积上，亮点反而变暗
    // （粒子星云那张实测就是"整片淡雾 + 核心不明显"）
    bloom: { strength: 0.72, radius: 0.5, threshold: 0.7 },
    summary: "暗调 + 暖主光 + 冷边光，情绪最强，暗部很沉（适合开场、悬念、情绪段落）",
  },
  /* 冷色高对比：中性白光 + 青色边光，最"科技"，也最像参考图里的 HUD 场景 */
  cyber: {
    ambient: 0.08,
    env: 0.25,
    key: { pos: [4.5, 6, 5], intensity: 2.3, color: "#FFFFFF" },
    rimA: { pos: [-5, 2.5, -6], intensity: 2.2, color: "core" },
    rimB: { pos: [5, -2, -5], intensity: 1.6, color: "cyber" },
    fill: null,
    bloom: { strength: 0.55, radius: 0.5, threshold: 0.8 },
    summary: "冷色高对比，边缘挂一道青光，最「科技」（适合科技、数据、未来感）",
  },
  /* 自然柔和：天光 + 暖阳光，没有彩色边光，材质偏"哑光实体" */
  nature: {
    ambient: 0,
    hemisphere: { sky: "#CFE0FF", ground: "#6B5A3E", intensity: 1.1 },
    env: 0.5,
    key: { pos: [5, 7, 4], intensity: 1.9, color: "#FFF0D8" },
    rimA: { pos: [-5, 2.5, -6], intensity: 0.55, color: "sky" },
    rimB: null,
    fill: { pos: [-3, 1.5, 4], intensity: 0.8, color: "#DCEBFF" },
    bloom: { strength: 0.18, radius: 0.45, threshold: 0.94 },
    summary: "天光 + 暖阳光，柔和自然，没有彩色边光（适合自然、生活、纪实类内容）",
  },
};


/* ─────────────────────────── 插件贡献的风格 ─────────────────────────── */

/**
 * 插件注册的 look。
 *
 * 内置优先：`studio`/`dramatic`/`cyber`/`nature` 会被 agent 的技能指南成段引用，
 * 被插件顶掉就是"文档说的和画出来的不是一个东西"。
 */
const EXTRA_LOOKS = new Map<string, LookSpec>();

/** `auto` 是"按预设挑"，不是一种风格，插件不能占用 */
const RESERVED = new Set(["auto"]);

const LOOK_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const num = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

function lightOk(v: unknown, where: string): string | null {
  if (!v || typeof v !== "object") return `${where} 要是对象 { pos, intensity, color }`;
  const l = v as Partial<LookLightSpec>;
  if (!Array.isArray(l.pos) || l.pos.length !== 3 || !l.pos.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return `${where}.pos 要是三个数字`;
  }
  if (!num(l.intensity, 0, 30)) return `${where}.intensity 要是 0–30 的数字`;
  if (!l.color || typeof l.color !== "string") return `${where}.color 要是颜色值或主题 token`;
  return null;
}

/**
 * 校验并登记一套插件 look。
 *
 * 范围卡得比内置宽，但卡的都是"会渲染成黑屏/过曝"的：强度为负、bloom 超 1 之外的
 * 离谱值、灯位不是三元组。**风格好不好看不管**——那是抽帧看的事，代码管不了。
 */
export function registerLook(id: string, spec: unknown): { ok: boolean; reason?: string } {
  const key = String(id ?? "").trim();
  if (!LOOK_ID_RE.test(key)) return { ok: false, reason: `id「${key || "(空)"}」不合法：只能小写字母、数字、短横线` };
  if (RESERVED.has(key)) return { ok: false, reason: `「auto」是保留字（表示按预设自动挑），换一个 id` };
  if (BUILTIN_LOOKS[key]) return { ok: false, reason: `id「${key}」与内置风格重名（内置优先，换个 id）` };
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { ok: false, reason: `「${key}」的 spec 要是对象` };

  const s = spec as Partial<LookSpec>;
  if (!num(s.ambient, 0, 10)) return { ok: false, reason: `「${key}」的 ambient 要是 0–10 的数字` };
  if (!num(s.env, 0, 5)) return { ok: false, reason: `「${key}」的 env 要是 0–5 的数字` };
  for (const f of ["key", "rimA"] as const) {
    const bad = lightOk(s[f], `「${key}」的 ${f}`);
    if (bad) return { ok: false, reason: bad };
  }
  for (const f of ["rimB", "fill"] as const) {
    if (s[f] === null || s[f] === undefined) continue;
    const bad = lightOk(s[f], `「${key}」的 ${f}`);
    if (bad) return { ok: false, reason: bad };
  }
  const b = s.bloom as Partial<LookSpec["bloom"]> | undefined;
  if (!b || !num(b.strength, 0, 3) || !num(b.radius, 0, 1) || !num(b.threshold, 0, 1)) {
    return { ok: false, reason: `「${key}」的 bloom 要是 { strength:0–3, radius:0–1, threshold:0–1 }` };
  }
  if (s.hemisphere !== undefined && s.hemisphere !== null) {
    const h = s.hemisphere as Partial<NonNullable<LookSpec["hemisphere"]>>;
    if (!h.sky || !h.ground || !num(h.intensity, 0, 10)) {
      return { ok: false, reason: `「${key}」的 hemisphere 要是 { sky, ground, intensity:0–10 }` };
    }
  }

  EXTRA_LOOKS.set(key, {
    label: typeof s.label === "string" && s.label.trim() ? s.label.trim() : key,
    ambient: s.ambient as number,
    ...(s.hemisphere ? { hemisphere: s.hemisphere } : {}),
    env: s.env as number,
    key: s.key as LookLightSpec,
    rimA: s.rimA as LookLightSpec,
    rimB: (s.rimB as LookLightSpec | null | undefined) ?? null,
    fill: (s.fill as LookLightSpec | null | undefined) ?? null,
    // 上面逐项校验过，这里的 as 只是让 TS 认账（num() 不是类型守卫）
    bloom: { strength: b.strength as number, radius: b.radius as number, threshold: b.threshold as number },
    summary: typeof s.summary === "string" ? s.summary : "",
  });
  return { ok: true };
}

/** 注销一套插件风格（插件停用/删除时用）；内置的删不掉 */
export function unregisterLook(id: string): boolean {
  return EXTRA_LOOKS.delete(String(id ?? "").trim());
}

/** 按 id 取风格：插件 > 内置。取不到返回 undefined（调用方自己决定怎么降级） */
export const lookSpecOf = (id: string): LookSpec | undefined => EXTRA_LOOKS.get(id) ?? BUILTIN_LOOKS[id];

/** 全部可选 id（不含 `auto`）：内置在前，插件按注册顺序追加 */
export const allLookIds = (): string[] => [...Object.keys(BUILTIN_LOOKS), ...EXTRA_LOOKS.keys()];

/** id → 短名（面板/选项用）。取不到就原样返回 */
export const lookLabelOf = (id: string): string => lookSpecOf(id)?.label ?? BUILTIN_LOOK_LABEL[id] ?? id;

/** 内置 look 的中文短名（`sceneMetas` 的 `optionLabel` 会回退到这里） */
export const BUILTIN_LOOK_LABEL: Record<string, string> = {
  auto: "自动",
  studio: "影棚",
  dramatic: "戏剧",
  cyber: "赛博",
  nature: "自然",
};

/** 给 agent 看的清单：id + 短名 + 一句话（插件风格也在这里出现） */
export const lookCatalog = (): { id: string; label: string; summary: string }[] =>
  allLookIds().map((id) => {
    const spec = lookSpecOf(id)!;
    return { id, label: lookLabelOf(id), summary: spec.summary ?? "" };
  });
