/**
 * 样张构图模板：把「这个风格该长什么样」变成可复用的排版代码。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────
 * 原来两处样张（面板缩略图 `build-builtin-stills`、agent 的 `probe_style`）都固定用
 * `list`（五行要点）+ `title`（封面），155 种场景类型只用了 2 种。结果是 77 个风格
 * 出来全是同一句话、同一个版式，只换了配色 —— 用户原话是「千篇一律，不好区分」。
 *
 * 实测 8 个手工样本后确认：**版式只决定信息怎么组织，决定不了画面上有没有"那个东西"**。
 * 数据实体化的本质是"一个物件=一个数量"，用再漂亮的卡片网格也给不出物件；
 * 木刻的本质是"黑是版、白是刻掉的"，不加这块黑就只是浅色底上几行字。
 *
 * 所以这里不是"美化样张"，是把每种风格的**视觉语法**写成一个模板。
 *
 * ── 为什么是模板而不是给每个风格存元素数组 ──────────────────────
 * 77 段硬编码坐标没法维护：调一个间距要改 77 处，而手写坐标必错
 * （8 个手工样本里 2 个首版就错了：方块堆到标题上、点云纵向塌成一条细线）。
 * 现在风格只填文案与数量（`Showcase`），坐标全在这里。
 */
import type { Showcase, ShowcaseTemplate } from "../shared/builtin-styles";
import type { FreeformProps } from "../shared/freeform";

type Palette = Record<string, string>;

/** 画布尺寸：只用来算"画面宽度等于多少个短边单位"，让右侧元素在竖屏下不飞出画面 */
export type Canvas = { w: number; h: number };
const DEFAULT_CANVAS: Canvas = { w: 1920, h: 1080 };

type El = Record<string, unknown>;

function pick(p: Palette, ...keys: string[]): string | undefined {
  for (const k of keys) if (p[k]) return p[k];
  return undefined;
}

/* ────────────────────────── 图形生成 ────────────────────────── */

/**
 * 点云：一个回波 = 一个方点。
 *
 * 不用 `fx.particles`：那个的 `density` 是**个数**（传 0.95 只渲染 1 个点），
 * 半径还是按像素算的（2–6px），在 1920 画幅上等于看不见。它只能当装饰。
 * 真点云用一条 path 装几千个方点，体积小、位置精确。
 */
function pointcloudSvg(canvas: Canvas, color: string, dimColor: string): string {
  let seed = 20261108;
  const rnd = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const VW = 1920;
  const VH = 1080;
  const ridgeOf = (x: number) => {
    const r =
      0.3 * Math.exp(-((x - 620) ** 2) / (2 * 240 ** 2)) +
      0.55 * Math.exp(-((x - 1060) ** 2) / (2 * 290 ** 2)) +
      0.24 * Math.exp(-((x - 1520) ** 2) / (2 * 190 ** 2));
    return 0.18 + r + 0.03 * Math.sin(x / 44) + 0.018 * Math.sin(x / 15 + 2.1);
  };
  const dims: string[] = [];
  const bright: string[] = [];
  const BASE = 960;
  // 点必须**铺成面**：每个 x 从山脚铺到山脊。只画脊线的话看起来是条噪声曲线，不是地形。
  for (let x = 0; x < VW; x += 5.5) {
    const h = ridgeOf(x);
    const top = BASE - h * 640;
    const rows = Math.max(4, Math.round((BASE - top) / 13));
    for (let k = 0; k < rows; k++) {
      const t = k / rows;
      const y = top + (BASE - top) * t + (rnd() - 0.5) * 9;
      const d = `M${Math.round(x + (rnd() - 0.5) * 5)} ${Math.round(y)}h2.1v2.1h-2.1`;
      // 越靠山脊越亮：那是深度线索，不是滤镜
      (t < 0.42 ? bright : dims).push(d);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="none">` +
    `<path d="${dims.join("")}" fill="${dimColor}" opacity="0.38"/>` +
    `<path d="${bright.join("")}" fill="${color}" opacity="0.9"/></svg>`
  );
}

/**
 * 半调网点球：明暗不是渐变，是**网点直径**。
 * 中心点大、边缘点小 —— 这是半调最经典的用法；加线性渐变就变成另一条风格了。
 */
function halftoneSvg(cx: number, cy: number, R: number, color: string): string {
  const dots: string[] = [];
  for (let y = cy - R; y <= cy + R; y += 11) {
    for (let x = cx - R; x <= cx + R; x += 11) {
      const d = Math.hypot(x - cx, y - cy) / R;
      if (d > 1) continue;
      const r = 4.6 * Math.pow(1 - d, 0.55) + 0.45;
      dots.push(`<circle cx="${Math.round(x)}" cy="${Math.round(y)}" r="${r.toFixed(1)}"/>`);
    }
  }
  // 正方形 viewBox 配正方形容器：球才是圆的。用 16:9 画布铺满会把球压成椭圆（实测）
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080">` +
    `<g fill="${color}">${dots.join("")}</g></svg>`
  );
}

/** 堆叠方块：一个方块 = 一个写明数量。可数，这是 `data-as-objects` 的全部论点。 */
function stackBlocks(opts: {
  x: number;
  baseY: number;
  n: number;
  w: number;
  h: number;
  gap: number;
  fill: string;
}): El[] {
  return Array.from({ length: opts.n }, (_, i) => ({
    type: "shape",
    shape: "rect",
    x: opts.x,
    y: opts.baseY - i * opts.gap,
    width: opts.w,
    height: opts.h,
    radius: 0.6,
    fill: opts.fill,
  }));
}

/**
 * 「此处需真实影像」的占位。
 *
 * 为什么不放一张生成图：用户挑风格时看的是效果。假卫星图会让他以为这风格能做出那种影像，
 * 等成片才发现不能——那时已经铺了几十幕。空着是诚实的，假图是有害的。
 */
function placeholderBlock(s: Showcase, palette: Palette, c: Canvas): El[] {
  if (!s.placeholder) return [];
  const border = pick(palette, "textMuted", "text") ?? "#888";
  return [
    {
      type: "shape",
      shape: "rect",
      x: 72,
      y: 42,
      width: 46,
      height: 54,
      fill: "transparent",
      border: 0.28,
      borderColor: border,
      opacity: 0.55,
    },
    {
      type: "text",
      text: s.placeholder,
      x: 72,
      y: 42,
      size: 2.3,
      anchor: "center",
      textAlign: "center",
      fill: border,
      maxWidth: 40,
      lineHeight: 1.4,
    },
  ];
}

/* ────────────────────────── 模板 ────────────────────────── */

/**
 * 坐标语义（踩过一次坑，写在这里）：
 * · `x` / `y` 是**画面宽/高的百分比**（0–100），`x:120` 会直接飞出画面；
 * · `size` / `width` / `height` 是**短边百分比**，同一份模板在 16:9 与 9:16 下都能用。
 * 早期版本把 x 当成短边单位算（`W*0.68` = 120），结果红三角和木刻黑块全被推出画面。
 * 所以这里一律写 0–100 的字面值，不再做换算。
 */

/**
 * 模板返回类型刻意宽松：`FreeEl` 的 default 字段在 zod 里全是 required，
 * 但补齐发生在建场景时（`freeformPropsSchema.parse`）。这里逐字段写全，
 * 只会换来一堆 `opacity: 1, from: 0…` 的噪音，读不出"这张图想做成什么样"。
 */
type ShowcaseProps = { background?: Record<string, unknown>; elements: El[] };
type Build = (s: Showcase, p: Palette, c: Canvas) => ShowcaseProps;

const heading = (p: Palette) => pick(p, "text") ?? "#111";
const muted = (p: Palette) => pick(p, "textMuted", "text") ?? "#666";
const bg = (p: Palette) => pick(p, "background") ?? "#111";
const accent = (p: Palette) => pick(p, "primary", "accent", "text") ?? "#e33";
/** 堆叠的第二组颜色：优先 textMuted 而不是 secondary —— secondary 常和背景同色（实测整堆隐形） */
const second = (p: Palette) => pick(p, "textMuted", "secondary", "text") ?? "#888";

/** 巨字：字号本身就是风格（瑞士 / 编辑 / 构成主义）。清单式版式会把这条风格唯一的强项削平。 */
const giantType: Build = (s, p, c) => {
  const els: El[] = [
    {
      type: "text",
      text: s.title,
      x: 5,
      y: s.emphasis ? 34 : 40,
      size: 15,
      anchor: "left",
      textAlign: "left",
      fill: heading(p),
      weight: 900,
      lineHeight: 1.1,
      maxWidth: 66,
    },
  ];
  let ruleY = 58;
  if (s.emphasis) {
    els.push({
      type: "text",
      text: s.emphasis,
      x: 5,
      y: 56,
      size: 15,
      anchor: "left",
      textAlign: "left",
      fill: accent(p),
      weight: 900,
      // 5 个 15 号字 = 75 单位；给窄了会换行，第二行向上压住标题（实测过）
      maxWidth: 86,
    });
    ruleY = 70;
  }
  els.push(
    { type: "shape", shape: "rect", x: 12, y: ruleY, width: 16, height: 1.6, fill: accent(p) },
    {
      type: "text",
      text: s.sub ?? "",
      x: 5,
      y: ruleY + 8,
      size: 2.8,
      anchor: "left",
      textAlign: "left",
      fill: muted(p),
      maxWidth: 60,
    },
    { type: "text", text: s.note ?? "", x: 95, y: 93, size: 1.9, anchor: "center", textAlign: "right", fill: muted(p) },
  );
  return { background: { kind: "solid", colors: [bg(p)] }, elements: els };
};

/** 堆叠物件：数量换成可数的东西。等高的两堆本身就是论点。 */
const stack: Build = (s, p, c) => {
  const label = s.items ?? ["左栏", "右栏"];
  const n = Math.max(4, Math.min(14, s.count ?? 10));
  const leftX = 25;
  const rightX = 62;
  return {
    background: { kind: "solid", colors: [bg(p)] },
    elements: [
      {
        type: "text",
        text: s.title,
        x: 5,
        y: 13,
        size: 5.8,
        anchor: "left",
        textAlign: "left",
        fill: heading(p),
        weight: 800,
        lineHeight: 1.22,
        maxWidth: 64,
      },
      ...stackBlocks({ x: leftX, baseY: 80, n, w: 8, h: 3.8, gap: 4.2, fill: accent(p) }),
      ...stackBlocks({ x: rightX, baseY: 80, n, w: 8, h: 3.8, gap: 4.2, fill: second(p) }),
      { type: "text", text: label[0] ?? "", x: leftX, y: 87, size: 3.2, anchor: "center", fill: heading(p), weight: 700 },
      { type: "text", text: label[1] ?? "", x: rightX, y: 87, size: 3.2, anchor: "center", fill: heading(p), weight: 700 },
      { type: "text", text: s.values?.[0]?.value ?? "", x: leftX, y: 94, size: 4.4, anchor: "center", fill: accent(p), weight: 800 },
      { type: "text", text: s.values?.[1]?.value ?? "", x: rightX, y: 94, size: 4.4, anchor: "center", fill: second(p), weight: 800 },
      { type: "text", text: s.note ?? "", x: 95, y: 97, size: 1.8, anchor: "center", textAlign: "right", fill: muted(p) },
    ],
  };
};

/** 半调：明暗全是网点直径，暗场也是印在纸上的。 */
const halftone: Build = (s, p, c) => {
  const els: El[] = [
    // 正方形容器 + 正方形 viewBox：球必须是圆的。早期用 16:9 容器铺满，球被压成椭圆
    { type: "svg", svg: halftoneSvg(540, 540, 460, heading(p)), x: 70, y: 48, width: 92, height: 92, opacity: 0.92 },
    {
      type: "text",
      text: s.title,
      x: 5,
      y: 30,
      size: 8.6,
      anchor: "left",
      textAlign: "left",
      fill: heading(p),
      weight: 800,
      lineHeight: 1.2,
      maxWidth: 40,
    },
    { type: "shape", shape: "rect", x: 9, y: 48, width: 16, height: 0.35, fill: accent(p) },
    { type: "text", text: s.note ?? "", x: 5, y: 55, size: 2.3, anchor: "left", textAlign: "left", fill: muted(p), maxWidth: 34 },
    { type: "text", text: s.sub ?? "", x: 5, y: 80, size: 2.6, anchor: "left", textAlign: "left", fill: heading(p), maxWidth: 32 },
  ];
  return { background: { kind: "solid", colors: [bg(p)] }, elements: els };
};

/** 点阵/点云：点是测量值。不是装饰粒子。 */
const pointfield: Build = (s, p, c) => {
  const strong = pick(p, "primary", "accent") ?? "#D4FFF0";
  const els: El[] = [
    {
      type: "svg",
      svg: pointcloudSvg(c, strong, pick(p, "secondary", "textMuted") ?? "#6FA898"),
      x: 50,
      y: 52,
      width: 100,
      height: 100,
      opacity: 0.95,
    },
    { type: "shape", shape: "rect", x: 50, y: 44, width: 100, height: 0.13, fill: strong, opacity: 0.7 },
    { type: "text", text: s.sub ?? "", x: 5, y: 12, size: 3, anchor: "left", textAlign: "left", fill: heading(p), weight: 700 },
    { type: "text", text: s.title, x: 5, y: 24, size: 11, anchor: "left", textAlign: "left", fill: strong, weight: 800 },
  ];
  for (const [i, v] of (s.values ?? []).slice(0, 2).entries()) {
    els.push({
      type: "text",
      text: `${v.value}　${v.label}`,
      x: 5 + i * 15,
      y: 32,
      size: 2.3,
      anchor: "left",
      textAlign: "left",
      fill: muted(p),
    });
  }
  // 准星：测量标记才是这风格的语言
  const cx = 76;
  const cross = pick(p, "accent", "primary") ?? "#FFB347";
  els.push(
    { type: "shape", shape: "line", x: cx, y: 34, width: 5, height: 0.3, fill: cross },
    { type: "shape", shape: "line", x: cx, y: 34, width: 5, height: 0.3, rotate: 90, fill: cross },
    { type: "text", text: s.note ?? "", x: 95, y: 94, size: 2, anchor: "center", textAlign: "right", fill: muted(p) },
  );
  return { background: { kind: "glow", colors: [bg(p), bg(p)], blur: 70 }, elements: els };
};

/** 刻痕：黑是版，白是刻掉的。加一块黑，这条风格才成立。 */
const engrave: Build = (s, p, c) => {
  const ink = heading(p);
  const paper = bg(p);
  const blockX = 74;
  const lines = [24, 28.5, 32.5, 37, 41, 44.5, 48.5, 52, 56.5, 60, 63.5, 67, 71, 74];
  return {
    background: { kind: "solid", colors: [paper] },
    elements: [
      { type: "shape", shape: "rect", x: 50, y: 7, width: 90, height: 0.45, fill: ink },
      {
        type: "text",
        text: s.title,
        x: 5,
        y: 33,
        size: 13,
        anchor: "left",
        textAlign: "left",
        fill: ink,
        weight: 900,
        lineHeight: 1.1,
        maxWidth: 72,
      },
      { type: "text", text: s.sub ?? "", x: 5, y: 58, size: 2.6, anchor: "left", textAlign: "left", fill: muted(p) },
      { type: "shape", shape: "rect", x: 10, y: 66, width: 14, height: 1.4, fill: accent(p) },
      // 黑块在下，白刻痕在上：这就是「刻」的动作
      { type: "shape", shape: "rect", x: blockX, y: 48, width: 32, height: 60, fill: ink },
      ...lines.map((y, i) => ({
        type: "shape",
        shape: "line",
        x: blockX,
        y,
        width: 32 - (i % 3) * 3,
        height: [0.85, 0.5, 0.28][i % 3],
        fill: paper,
        opacity: 0.95,
      })),
      { type: "text", text: s.note ?? "", x: 95, y: 94, size: 1.8, anchor: "center", textAlign: "right", fill: muted(p) },
    ],
  };
};

/** 图鉴/清单：靠「第几张」推进。序号和页码不是装饰，是结构。 */
const catalogue: Build = (s, p, c) => {
  const items = (s.items ?? []).slice(0, 4);
  const els: El[] = [
    { type: "text", text: s.note ?? "01", x: 5, y: 11, size: 3.2, anchor: "left", textAlign: "left", fill: accent(p), weight: 800 },
    {
      type: "text",
      text: s.title,
      x: 5,
      y: 24,
      size: 14,
      anchor: "left",
      textAlign: "left",
      fill: heading(p),
      weight: 900,
      maxWidth: 58,
    },
    { type: "text", text: s.sub ?? "", x: 5, y: 38, size: 2.8, anchor: "left", textAlign: "left", fill: muted(p), maxWidth: 52 },
    { type: "shape", shape: "rect", x: 50, y: 90, width: 90, height: 0.12, fill: accent(p) },
  ];
  // 条目：一行一个符号 + 名字，保持"目录"的节奏，而不是卡片
  const step = items.length > 1 ? Math.min(18, 66 / items.length) : 18;
  for (const [i, t] of items.entries()) {
    const x = 22 + i * step;
    els.push(
      { type: "shape", shape: "circle", x, y: 64, size: 10, fill: accent(p), opacity: 1 - i * 0.18 },
      { type: "text", text: t, x, y: 73, size: 2.4, anchor: "center", fill: muted(p) },
    );
  }
  return { background: { kind: "solid", colors: [bg(p)] }, elements: els };
};

/** 读数：界面/测量的内容本来就是数字。 */
const readout: Build = (s, p, c) => {
  const strong = pick(p, "primary", "accent") ?? "#70D8DE";
  const vals = (s.values ?? []).slice(0, 3);
  const els: El[] = [
    { type: "text", text: s.sub ?? "", x: 5, y: 15, size: 3, anchor: "left", textAlign: "left", fill: heading(p), weight: 700 },
    { type: "text", text: s.title, x: 5, y: 28, size: 11, anchor: "left", textAlign: "left", fill: strong, weight: 800, maxWidth: 132 },
    { type: "shape", shape: "rect", x: 50, y: 47, width: 90, height: 0.1, fill: muted(p), opacity: 0.5 },
  ];
  const step = vals.length > 1 ? Math.min(26, 80 / vals.length) : 0;
  for (const [i, v] of vals.entries()) {
    els.push(
      { type: "text", text: v.value, x: 6 + i * step, y: 62, size: 8.4, anchor: "left", textAlign: "left", fill: i === 0 ? strong : heading(p), weight: 800 },
      { type: "text", text: v.label, x: 6 + i * step, y: 72, size: 2.3, anchor: "left", textAlign: "left", fill: muted(p) },
    );
  }
  els.push({ type: "text", text: s.note ?? "", x: 95, y: 94, size: 2, anchor: "center", textAlign: "right", fill: muted(p) });
  return {
    background: { kind: "glow", colors: [bg(p), pick(p, "surface") ?? bg(p)], blur: 80 },
    elements: els,
  };
};

/** 斜轴拼贴：论点由版面倾角给出，居中卡片给不了这件事。 */
const collage: Build = (s, p, c) => ({
  background: { kind: "solid", colors: [bg(p)] },
  elements: [
    { type: "shape", shape: "triangle", x: 76, y: 40, size: 46, rotate: 18, fill: accent(p) },
    {
      type: "text",
      text: s.title,
      x: 6,
      y: 32,
      size: 14,
      anchor: "left",
      textAlign: "left",
      fill: heading(p),
      weight: 900,
      lineHeight: 1.08,
      rotate: -3,
      maxWidth: 66,
    },
    { type: "text", text: s.sub ?? "", x: 6, y: 56, size: 2.4, anchor: "left", textAlign: "left", fill: muted(p), letterSpacing: 0.6 },
    { type: "shape", shape: "rect", x: 12, y: 64, width: 17, height: 1.8, fill: accent(p) },
    { type: "shape", shape: "rect", x: 58, y: 80, width: 54, height: 3.4, rotate: -8, fill: heading(p) },
    { type: "text", text: s.note ?? "", x: 95, y: 94, size: 1.8, anchor: "center", textAlign: "right", fill: muted(p) },
  ],
});

/**
 * 插画 / 卡通 / 扁平：看点在"画面上那组形"，不是字。
 * 用一组大小错落的实色图形占住右侧，左侧留标题——这是在缺插画素材时
 * 唯一能表达"这风格是图形驱动"的办法。
 */
const FIGURE_LAYOUTS: ((p: Palette) => El[])[] = [
  // 0 聚集式：一个主角 + 三个陪衬挤在右上
  (p) => [
    { type: "shape", shape: "circle", x: 66, y: 36, size: 30, fill: accent(p) },
    { type: "shape", shape: "rect", x: 84, y: 52, size: 22, rotate: 12, fill: second(p), radius: 1 },
    { type: "shape", shape: "triangle", x: 62, y: 72, size: 24, rotate: -8, fill: pick(p, "secondary", "text") ?? "#333" },
    { type: "shape", shape: "circle", x: 90, y: 26, size: 13, fill: muted(p) },
  ],
  // 1 横向递减：三个圆一路小下去，卡通/插画常用
  (p) => [
    { type: "shape", shape: "circle", x: 56, y: 40, size: 34, fill: accent(p) },
    { type: "shape", shape: "circle", x: 78, y: 50, size: 24, fill: second(p) },
    { type: "shape", shape: "circle", x: 93, y: 34, size: 13, fill: muted(p) },
    { type: "shape", shape: "rect", x: 70, y: 74, size: 24, rotate: -6, fill: pick(p, "secondary", "text") ?? "#444", radius: 1 },
  ],
  // 2 对称阵列：四块 + 圆心，纹样/装饰类靠这个站住
  (p) => [
    { type: "shape", shape: "rect", x: 58, y: 36, size: 20, fill: accent(p) },
    { type: "shape", shape: "rect", x: 77, y: 36, size: 20, fill: second(p) },
    { type: "shape", shape: "rect", x: 58, y: 57, size: 20, fill: second(p) },
    { type: "shape", shape: "rect", x: 77, y: 57, size: 20, fill: accent(p) },
    { type: "shape", shape: "circle", x: 67.5, y: 46.5, size: 10, fill: muted(p) },
  ],
  // 3 散落：大小不一、位置不齐，绘画类才不像排版
  (p) => [
    { type: "shape", shape: "circle", x: 58, y: 32, size: 17, fill: second(p) },
    { type: "shape", shape: "circle", x: 79, y: 42, size: 27, fill: accent(p) },
    { type: "shape", shape: "triangle", x: 64, y: 70, size: 21, rotate: 14, fill: muted(p) },
    { type: "shape", shape: "rect", x: 86, y: 68, size: 14, rotate: 22, fill: pick(p, "secondary", "text") ?? "#444" },
    { type: "shape", shape: "circle", x: 74, y: 20, size: 9, fill: accent(p), opacity: 0.7 },
  ],
  // 4 大三角主导：冲击型，材质/故障/合成波
  (p) => [
    { type: "shape", shape: "triangle", x: 71, y: 42, size: 46, rotate: 12, fill: accent(p) },
    { type: "shape", shape: "circle", x: 88, y: 66, size: 17, fill: second(p) },
    { type: "shape", shape: "rect", x: 52, y: 68, size: 15, rotate: -14, fill: muted(p) },
  ],
];

const figureGrid: Build = (s, p, c) => {
  const v = Math.max(0, Math.min(4, s.variant ?? 0));
  const shapes = FIGURE_LAYOUTS[v](p);
  return {
    background: { kind: "solid", colors: [bg(p)] },
    elements: [
      ...shapes,
      {
        type: "text",
        text: s.title,
        x: 5,
        y: 38,
        size: 11,
        anchor: "left",
        textAlign: "left",
        fill: heading(p),
        weight: 800,
        lineHeight: 1.15,
        maxWidth: 46,
      },
      { type: "shape", shape: "rect", x: 9, y: 56, width: 12, height: 1.2, fill: accent(p) },
      { type: "text", text: s.sub ?? "", x: 5, y: 63, size: 2.6, anchor: "left", textAlign: "left", fill: muted(p), maxWidth: 38 },
      { type: "text", text: s.note ?? "", x: 95, y: 94, size: 1.8, anchor: "center", textAlign: "right", fill: muted(p) },
    ],
  };
};

/**
 * 纸艺 / 剪纸 / 立体书：看点是**层**。
 * 三层色块由深到浅 + 每层一道偏移投影，读起来才是"纸叠纸"，
 * 加描边或渐变都做不出这个——纸的区别在于它挡住了下面那张。
 */
const layeredPaper: Build = (s, p, c) => {
  const layers: El[] = [];
  const spec = [
    { x: 54, y: 56, w: 76, h: 60, fill: second(p), op: 0.55, rot: -2 },
    { x: 52, y: 62, w: 62, h: 50, fill: pick(p, "secondary", "text") ?? "#555", op: 0.8, rot: 2 },
    { x: 50, y: 68, w: 48, h: 40, fill: accent(p), op: 1, rot: -1 },
  ];
  for (const L of spec) {
    // 投影先画（在下层），再画纸本身：顺序反了就看不出"谁压着谁"
    layers.push({
      type: "shape",
      shape: "rect",
      x: L.x + 1,
      y: L.y + 2.2,
      width: L.w,
      height: L.h,
      rotate: L.rot,
      fill: "#000",
      opacity: 0.1,
    });
    layers.push({
      type: "shape",
      shape: "rect",
      x: L.x,
      y: L.y,
      width: L.w,
      height: L.h,
      rotate: L.rot,
      fill: L.fill,
      opacity: L.op,
      radius: 0.4,
    });
  }
  return {
    background: { kind: "solid", colors: [bg(p)] },
    elements: [
      ...layers,
      {
        type: "text",
        text: s.title,
        x: 5,
        y: 30,
        size: 10,
        anchor: "left",
        textAlign: "left",
        fill: heading(p),
        weight: 800,
        lineHeight: 1.18,
        maxWidth: 42,
      },
      { type: "text", text: s.sub ?? "", x: 5, y: 50, size: 2.5, anchor: "left", textAlign: "left", fill: muted(p), maxWidth: 34 },
      { type: "text", text: s.note ?? "", x: 95, y: 94, size: 1.8, anchor: "center", textAlign: "right", fill: muted(p) },
    ],
  };
};

/**
 * 像素 / 低多边 / 终端：方块阵列拼出一个形。
 * 图案用字符表定义，改一个字母就改一个点——比手写几十个坐标可靠。
 */
const PIXEL_PATTERN = [
  "....####....",
  "..########..",
  ".##########.",
  "####....####",
  "###..##..###",
  "###..##..###",
  "####....####",
  "..########..",
  "...##..##...",
];

const pixelGrid: Build = (s, p, c) => {
  const CELL = 62;
  const cols = PIXEL_PATTERN[0].length;
  const rows = PIXEL_PATTERN.length;
  const ox = 1080 - (cols * CELL) / 2;
  const oy = 210;
  const cells: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      if (PIXEL_PATTERN[r][q] !== "#") continue;
      cells.push(
        `<rect x="${ox + q * CELL}" y="${oy + r * CELL}" width="${CELL - 4}" height="${CELL - 4}" fill="${
          r < 3 ? accent(p) : heading(p)
        }"/>`,
      );
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">${cells.join("")}</svg>`;
  return {
    background: { kind: "solid", colors: [bg(p)] },
    elements: [
      { type: "svg", svg, x: 56, y: 50, width: 92, height: 92, opacity: 0.95 },
      {
        type: "text",
        text: s.title,
        x: 5,
        y: 32,
        size: 9.5,
        anchor: "left",
        textAlign: "left",
        fill: heading(p),
        weight: 800,
        lineHeight: 1.2,
        maxWidth: 44,
      },
      { type: "text", text: s.sub ?? "", x: 5, y: 54, size: 2.5, anchor: "left", textAlign: "left", fill: muted(p), maxWidth: 36 },
      { type: "text", text: s.note ?? "", x: 95, y: 94, size: 1.8, anchor: "center", textAlign: "right", fill: muted(p) },
    ],
  };
};

/**
 * 老片 / CRT / 默片：放映窗 + 上下遮幅 + 颗粒。
 * 这类的"年代感"来自**画幅内缩和遮幅**，不是加个棕褐滤镜——
 * 滤镜是所有年代风格通用的，遮幅才是"这是一段被放映的片子"。
 */
const vintageFrame: Build = (s, p, c) => {
  const paper = pick(p, "surface") ?? heading(p);
  return {
    background: { kind: "solid", colors: [bg(p)] },
    elements: [
      // 画面框：放大到接近满幅，四周留一点遮幅就够——框太小会读成"一张深色卡片"
      { type: "shape", shape: "rect", x: 50, y: 44, width: 78, height: 62, fill: paper },
      // 上下遮幅：让它读起来是"放映窗"，不是"一张浅色卡片"
      { type: "shape", shape: "rect", x: 50, y: 5, width: 100, height: 14, fill: bg(p) },
      { type: "shape", shape: "rect", x: 50, y: 95, width: 100, height: 14, fill: bg(p) },
      // 两侧齿孔：一眼就能认出"这是胶片"，比任何滤镜都直接
      ...Array.from({ length: 9 }, (_, i) => ({
        type: "shape",
        shape: "rect",
        x: 9,
        y: 20 + i * 7.4,
        width: 3.2,
        height: 3.6,
        radius: 0.6,
        fill: muted(p),
        opacity: 0.75,
      })),
      ...Array.from({ length: 9 }, (_, i) => ({
        type: "shape",
        shape: "rect",
        x: 91,
        y: 20 + i * 7.4,
        width: 3.2,
        height: 3.6,
        radius: 0.6,
        fill: muted(p),
        opacity: 0.75,
      })),
      // 颗粒：压在画面上，让"片子"有物理质地
      { type: "fx", kind: "noise", x: 50, y: 46, size: 62, opacity: 0.16, color: heading(p) },
      {
        type: "text",
        text: s.title,
        x: 50,
        y: 40,
        size: 7.4,
        anchor: "center",
        textAlign: "center",
        fill: heading(p),
        weight: 800,
        lineHeight: 1.2,
        maxWidth: 50,
      },
      { type: "text", text: s.sub ?? "", x: 50, y: 54, size: 2.4, anchor: "center", textAlign: "center", fill: muted(p), maxWidth: 46 },
      { type: "text", text: s.note ?? "", x: 50, y: 90, size: 1.9, anchor: "center", textAlign: "center", fill: muted(p) },
    ],
  };
};

/**
 * 材质 / 3D / 显微 / 建筑：一个大物件 + 一行标注。
 * 物件用"主体 + 高光 + 接触阴影"三件套拼，读起来才是有体积的东西，
 * 而不是一个扁色块。上方留白是刻意的：这类风格的看点是"它被摆在那里"。
 */
const singleObject: Build = (s, p, c) => {
  const body = pick(p, "surface", "primary") ?? "#8899aa";
  return {
    background: { kind: "glow", colors: [bg(p), pick(p, "surface") ?? bg(p)], blur: 90 },
    elements: [
      // 接触阴影先画
      { type: "shape", shape: "circle", x: 52, y: 76, width: 40, height: 8, fill: "#000", opacity: 0.22 },
      { type: "shape", shape: "circle", x: 52, y: 44, size: 44, fill: body },
      // 高光：一个偏移的小亮斑，体积感几乎全靠它
      { type: "shape", shape: "circle", x: 42, y: 32, size: 13, fill: accent(p), opacity: 0.4 },
      {
        type: "text",
        text: s.title,
        x: 5,
        y: 86,
        size: 4.2,
        anchor: "left",
        textAlign: "left",
        fill: heading(p),
        weight: 800,
        maxWidth: 56,
      },
      { type: "text", text: s.sub ?? "", x: 5, y: 93, size: 2.2, anchor: "left", textAlign: "left", fill: muted(p), maxWidth: 56 },
      { type: "text", text: s.note ?? "", x: 95, y: 94, size: 1.8, anchor: "center", textAlign: "right", fill: muted(p) },
    ],
  };
};

const TEMPLATES: Record<ShowcaseTemplate, Build> = {
  giantType,
  stack,
  halftone,
  pointfield,
  engrave,
  catalogue,
  readout,
  collage,
  figureGrid,
  layeredPaper,
  pixelGrid,
  vintageFrame,
  singleObject,
};

/**
 * 这些模板的**画面里"数据/图形"才是内容**，标题只是一行注脚。
 * probe_style 别把标题换成用户那句长话：换完就是「用户标题 + 一堆不相干的示例数据」，
 * 语义脱节，而且大字会换行挤压（实测 stack 换标题后顶部一行长句、底下仍是「1 台风机」）。
 * 这类模板保留风格自带文案，整张才是一个完整、好看的论证。
 */
const KEEP_SHOWCASE_TITLE = new Set<ShowcaseTemplate>([
  "readout",
  "pointfield",
  "stack",
  "halftone",
]);

/**
 * probe_style 用：把样张的招牌文案换成用户 brief 的话，同时保证排版不崩。
 *
 * 为什么要做适配而不是直接 `show.title = briefTitle`：
 * 模板字号按 4–6 字设计，用户标题常有 10+ 字；硬塞进去会换行压住强调词
 * （第一版实测：瑞士编辑「把一周的活压成三分钟」换行后与红色「立起来」叠成一团）。
 * 这里按字数降字号、并清掉风格自带的 emphasis——它是样张的招牌词，
 * 换成用户标题后就成了不相干的红字。
 *
 * 不换标题的模板见 `KEEP_SHOWCASE_TITLE`；没有 brief 标题时原样返回。
 */
export function adaptShowcaseToBrief(showcase: Showcase, briefTitle: string): Showcase {
  const title = briefTitle.trim().slice(0, 12);
  if (!title || KEEP_SHOWCASE_TITLE.has(showcase.template)) return showcase;
  const len = [...title].length;
  if (len <= 6) return { ...showcase, title, emphasis: undefined };
  return {
    ...showcase,
    title,
    emphasis: undefined,
    titleScale: Math.max(0.58, Math.min(1, 6 / len)),
  };
}

/**
 * 把「样张配方」展开成自由画布的 props。
 *
 * 没有 `showcase` 的风格不走这里（调用方自己决定降级），因为这个函数签名的前提是
 * 有人已经想清楚"这风格该长什么样"。默认值硬凑出来的样张，正是这次要修的东西。
 */
export function buildShowcaseProps(
  showcase: Showcase,
  palette: Palette,
  canvas: Canvas = DEFAULT_CANVAS,
): FreeformProps {
  const base = TEMPLATES[showcase.template](showcase, palette, canvas);
  // 主标题自适应：一处覆盖全部模板，模板里不必重复写 `size: 15 * scale`。
  // 只改 text 内容等于当前 title 的那个元素，副标题/读数/注脚不受影响。
  const scale = showcase.titleScale ?? 1;
  if (scale < 1) {
    for (const el of base.elements) {
      if (el.type === "text" && el.text === showcase.title && typeof el.size === "number") {
        el.size = el.size * scale;
      }
    }
  }
  const ph = placeholderBlock(showcase, palette, canvas);
  const merged = ph.length ? { ...base, elements: [...base.elements, ...ph] } : base;
  // 缺省字段由建场景时的 zod 补齐（见 freeformPropsSchema）
  return merged as unknown as FreeformProps;
}

/** 面板与测试共用：模板名 → 人能读的解释 */
export const SHOWCASE_TEMPLATES: { id: ShowcaseTemplate; label: string; hint: string }[] = [
  { id: "giantType", label: "巨字", hint: "字号本身就是风格" },
  { id: "stack", label: "堆叠物件", hint: "一个物件等于一个数量" },
  { id: "halftone", label: "网点图形", hint: "明暗由网点直径决定" },
  { id: "pointfield", label: "点阵", hint: "点是被测量出来的" },
  { id: "engrave", label: "刻痕", hint: "黑是版，白是刻掉的" },
  { id: "catalogue", label: "编号条目", hint: "靠第几张推进" },
  { id: "readout", label: "读数", hint: "内容本来就是数字" },
  { id: "collage", label: "斜轴拼贴", hint: "论点由倾角给出" },
  { id: "figureGrid", label: "图形阵列", hint: "一组图形就是画面" },
  { id: "layeredPaper", label: "分层纸片", hint: "一层压一层" },
  { id: "pixelGrid", label: "像素阵列", hint: "方块拼出来的形" },
  { id: "vintageFrame", label: "年代画框", hint: "放映窗与遮幅" },
  { id: "singleObject", label: "单体物件", hint: "一个大东西摆在那" },
];
