/**
 * 密度自检：用**元素几何**算内容包围盒，不渲染。
 *
 * 为什么要它：
 * 复盘里最贵的一次返工是"布局太空旷"——用户第一眼就否了，18 幕全部推倒重排。
 * 而当时的量化工具 `scripts/fill-rate.mjs` 只判**横向**填充，注释还写着"竖屏永远铺不开"，
 * 于是 9:16 下内容只占 y 36%–55% 这种明显偏空的情况，工具在结构上抓不到。
 *
 * 这里的做法：
 *   1. 不渲染，纯几何估算（text 用 字号 × 等效字数，shape 用 size）——零成本，每次都能跑；
 *   2. 判据按画幅分离：竖屏看**纵向跨度**，横屏看横向；
 *   3. 装饰层（背景网格 / 光晕 / 噪点）不计入 —— 它们本来就铺满，会把"空"掩盖掉。
 */

/** 装饰层判定复用设计锁的口径，避免两处不一致 */
import { isDecorative } from "./designLock";

export type FillElement = {
  kind?: string;
  name?: string;
  text?: string;
  x?: number;
  y?: number;
  /** text 是字号，svg/image 是宽度；都按**短边百分比** */
  size?: number;
  lineHeight?: number;
  /** 文字最大宽度（短边百分比），给了才能算折行 */
  maxWidth?: number;
  scale?: number;
};

export type FillScene = {
  id?: string;
  name?: string;
  type?: string;
  elements?: FillElement[];
  /** 内置版式场景没有 elements，只有 props；这里拿不到就不判（返回 null） */
  props?: Record<string, unknown>;
};

export type SceneFill = {
  /** 内容包围盒（画面百分比，0–100） */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 纵向跨度 / 横向跨度（0–1） */
  verticalSpan: number;
  horizontalSpan: number;
  /** 包围盒面积占比（0–1） */
  area: number;
  /** 计入的信息元素数（不含装饰层） */
  contentElements: number;
  decorativeElements: number;
};

/** 拉丁字符相对汉字宽度 */
function charFactor(ch: string): number {
  if (/\s/.test(ch)) return 0.3;
  if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) return 1;
  if (/[0-9]/.test(ch)) return 0.56;
  if (/[A-Z]/.test(ch)) return 0.66;
  return 0.54;
}

/** 估算一段文字的等效宽度（单位与 size 相同：短边百分比） */
export function textWidthInSizeUnits(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += charFactor(ch) * size;
  return w;
}

const clamp01 = (v: number) => Math.max(0, Math.min(100, v));

/**
 * 单幕内容包围盒。
 * 坐标口径：element.x/y 是**中心点**（画面百分比），size 是短边百分比。
 */
export function sceneFill(scene: FillScene, format: { width: number; height: number }): SceneFill | null {
  const els = (scene.elements ?? []).filter((e) => e && e.kind !== "audio");
  // 内置版式场景（没有自由元素）拿不到几何 —— 不猜，交给 fill-rate.mjs 出像素复核
  if (!els.length) return null;

  const short = Math.min(format.width, format.height);
  const toW = (v: number) => (v * short) / format.width; // 短边百分比 → 画面宽百分比
  const toH = (v: number) => (v * short) / format.height;

  let x0 = 100;
  let y0 = 100;
  let x1 = 0;
  let y1 = 0;
  let content = 0;
  let deco = 0;

  for (const el of els) {
    if (isDecorative(el)) {
      deco++;
      continue;
    }
    const kind = String(el.kind ?? "text");
    const size = Number(el.size ?? 0) * (Number(el.scale ?? 1) || 1);
    if (!(size > 0)) continue;

    let wShort = size;
    let hShort = size;

    if (kind === "text") {
      const text = String(el.text ?? "");
      if (!text.trim()) continue;
      const natural = textWidthInSizeUnits(text, size);
      const maxW = Number(el.maxWidth ?? 0);
      // 没给 maxWidth 就当不折行（真实排版会在容器内折，这里只求"够不够满"的量级）
      const boxW = maxW > 0 ? Math.min(natural, maxW) : natural;
      const lines = maxW > 0 ? Math.max(1, Math.ceil(natural / maxW)) : 1;
      const lh = Number(el.lineHeight ?? 1.15) || 1.15;
      wShort = boxW;
      hShort = lines * size * lh;
    } else {
      // svg / image / video：size 是宽度，按接近正方估算（图标、图片块）
      hShort = size * 0.85;
    }

    const wPct = toW(wShort);
    const hPct = toH(hShort);
    const cx = clamp01(Number(el.x ?? 50));
    const cy = clamp01(Number(el.y ?? 50));

    x0 = Math.min(x0, cx - wPct / 2);
    y0 = Math.min(y0, cy - hPct / 2);
    x1 = Math.max(x1, cx + wPct / 2);
    y1 = Math.max(y1, cy + hPct / 2);
    content++;
  }

  if (!content) return null;

  x0 = clamp01(x0);
  y0 = clamp01(y0);
  x1 = clamp01(x1);
  y1 = clamp01(y1);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);

  return {
    x0, y0, x1, y1,
    verticalSpan: h / 100,
    horizontalSpan: w / 100,
    area: (w * h) / 10000,
    contentElements: content,
    decorativeElements: deco,
  };
}

/** 这些场景类型天然可以空：封面、标题页、结尾 —— 报出来只会制造噪声 */
export const DENSITY_EXEMPT_TYPES = new Set([
  "cover",
  "title",
  "outro",
  "end",
  "quote",
  "section",
  "divider",
]);

/**
 * 密度档位。
 *
 * **判的不是"够不够满"，是"有没有起伏"。**
 * 36%–55% 本身完全正常（一句话结论、一个二维码、一段留白都在这档）；
 * 那次返工真正的问题是：18 幕几乎全在同一档，看下来平且空，没有穿插。
 * 所以单幕永远不判好坏，只在"节奏"层面判。
 */
export type DensityBand = "loose" | "mid" | "tight";

/** 按画幅给档位阈值（竖屏看纵向跨度，横屏看横向） */
function bandThresholds(format: { width: number; height: number }) {
  return format.height > format.width
    ? { loose: 0.3, tight: 0.58 }
    : { loose: 0.55, tight: 0.8 };
}

/** 一幕的主跨度：竖屏用纵向，横屏用横向（竖屏本来就窄，横向永远铺不开） */
export function sceneSpan(fill: SceneFill, format: { width: number; height: number }): number {
  return format.height > format.width ? fill.verticalSpan : fill.horizontalSpan;
}

export function densityBand(fill: SceneFill, format: { width: number; height: number }): DensityBand {
  const span = sceneSpan(fill, format);
  const t = bandThresholds(format);
  if (span < t.loose) return "loose";
  if (span > t.tight) return "tight";
  return "mid";
}

export const BAND_LABEL: Record<DensityBand, string> = {
  loose: "空",
  mid: "中",
  tight: "满",
};

export type SceneDensity = {
  index: number;
  sceneId?: string;
  sceneName: string;
  fill: SceneFill | null;
  /** skip = 不参与节奏判断（封面类 / 只有一个元素 / 内置版式无几何） */
  band: DensityBand | "skip";
  /** 主跨度（0–1），人读时给百分比 */
  span: number;
  skipReason?: string;
};

/** 全片逐幕算密度档位（不做好坏判断，判断在 rhythmIssues） */
export function projectDensity(
  scenes: readonly FillScene[],
  format: { width: number; height: number },
): SceneDensity[] {
  return scenes.map((s, i) => {
    const name = String(s.name ?? s.type ?? `第 ${i + 1} 幕`);
    const exempt = s.type && DENSITY_EXEMPT_TYPES.has(s.type);
    const fill = sceneFill(s, format);
    if (exempt) {
      return { index: i, sceneId: s.id, sceneName: name, fill, band: "skip" as const, span: 0, skipReason: `「${s.type}」类场景不参与节奏判断` };
    }
    if (!fill) {
      return { index: i, sceneId: s.id, sceneName: name, fill: null, band: "skip" as const, span: 0, skipReason: "没有自由元素（内置版式），需像素复核" };
    }
    if (fill.contentElements <= 1) {
      return { index: i, sceneId: s.id, sceneName: name, fill, band: "skip" as const, span: sceneSpan(fill, format), skipReason: "只有一个信息元素，空是设计" };
    }
    return {
      index: i,
      sceneId: s.id,
      sceneName: name,
      fill,
      band: densityBand(fill, format),
      span: sceneSpan(fill, format),
    };
  });
}

/* ─────────────────── 节奏：连续同档才是问题 ─────────────────── */

export type RhythmIssue = {
  kind: "monotone" | "empty-run" | "no-peak";
  /** 幕号（0 起） */
  from: number;
  to: number;
  count: number;
  message: string;
};

/**
 * 节奏判据（这是密度检查真正的价值所在）：
 *   1. **连续 ≥4 幕同一档** —— 看着平。分档给不同说法：全空=又平又空，全满=喘不过气，全中=温吞；
 *   2. **连续 ≥2 幕"空"档** —— 真的偏空（单幕空可以是设计）；
 *   3. **全片没有一幕"满"档** —— 缺少视觉高潮（≥5 幕才判）。
 *
 * 宁可少报也不要误报：单幕 36%–55% 永不报错。
 */
export function rhythmIssues(list: readonly SceneDensity[], format: { width: number; height: number }): RhythmIssue[] {
  const judged = list.filter((d) => d.band !== "skip");
  if (judged.length < 3) return [];

  const portrait = format.height > format.width;
  const axis = portrait ? "纵向" : "横向";
  const issues: RhythmIssue[] = [];

  // 连续同档
  let run: SceneDensity[] = [];
  const flush = () => {
    if (run.length >= 4) {
      const band = run[0].band as DensityBand;
      const from = run[0].index;
      const to = run[run.length - 1].index;
      const spanPct = Math.round((run.reduce((n, x) => n + x.span, 0) / run.length) * 100);
      const tip =
        band === "loose"
          ? `又平又空 —— 要穿插：把其中 1/3 的幕做成满版（数据页 / 清单 / 大字结论），别全靠留白撑节奏`
          : band === "tight"
            ? `全是满的，看下来喘不过气 —— 中间插一两幕一句话的留白页`
            : `温吞、没有起伏 —— 挑最关键那一幕做成满版，其余保持，形成峰谷`;
      issues.push({
        kind: "monotone",
        from,
        to,
        count: run.length,
        message: `第 ${from + 1}–${to + 1} 幕连续 ${run.length} 幕都是「${BAND_LABEL[band]}」密度（${axis}约 ${spanPct}%）：${tip}`,
      });
    }
    run = [];
  };
  for (const d of judged) {
    if (run.length && d.band !== run[0].band) flush();
    run.push(d);
  }
  flush();

  // 连续偏空（≥2 幕 loose）
  let empty: SceneDensity[] = [];
  const flushEmpty = () => {
    if (empty.length >= 2 && !issues.some((x) => x.kind === "monotone" && x.from === empty[0].index)) {
      issues.push({
        kind: "empty-run",
        from: empty[0].index,
        to: empty[empty.length - 1].index,
        count: empty.length,
        message: `第 ${empty[0].index + 1}–${empty[empty.length - 1].index + 1} 幕连续偏空（${axis} < ${
          Math.round(bandThresholds(format).loose * 100)
        }%）—— 内容确实没铺开，不只是风格问题`,
      });
    }
    empty = [];
  };
  for (const d of judged) {
    if (d.band === "loose") empty.push(d);
    else flushEmpty();
  }
  flushEmpty();

  // 没有峰值
  if (judged.length >= 5 && !judged.some((d) => d.band === "tight")) {
    const densest = judged.reduce((a, b) => (b.span > a.span ? b : a), judged[0]);
    issues.push({
      kind: "no-peak",
      from: densest.index,
      to: densest.index,
      count: judged.length,
      message:
        `全片没有一幕是「满」密度（最满的是第 ${densest.index + 1} 幕，${axis}约 ${Math.round(densest.span * 100)}%）` +
        ` —— 缺视觉高潮，看下来会一路平过去。把最关键那一幕（数据 / 结论）做成满版`,
    });
  }

  return issues.slice(0, 3);
}

/** 一句话说清全片密度分布（回执里给用户看，比"有问题/没问题"有用） */
export function densitySummary(list: readonly SceneDensity[]): string {
  const judged = list.filter((d) => d.band !== "skip");
  if (!judged.length) return "";
  const n = (b: DensityBand) => judged.filter((d) => d.band === b).length;
  const skipped = list.length - judged.length;
  return (
    `密度分布：空 ${n("loose")} / 中 ${n("mid")} / 满 ${n("tight")}（参与判断 ${judged.length} 幕` +
    `${skipped > 0 ? `，${skipped} 幕豁免` : ""}）`
  );
}

/** 兼容旧调用：把"要修的幕"取出来，方便定位 */
export function sparseScenes(list: readonly SceneDensity[]): SceneDensity[] {
  return list.filter((d) => d.band === "loose");
}
