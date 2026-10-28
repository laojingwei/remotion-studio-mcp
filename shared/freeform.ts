import { z } from "zod";

/**
 * 自由画布（freeform）：让模型用**数据**描述任意画面，而不是写组件代码。
 *
 * 为什么是数据而不是代码：
 *  - 可校验（错字段能精确报出来）
 *  - 可预览（和普通场景同一条渲染管线，不用重新 bundle）
 *  - 可编辑（数据能被属性面板/时间轴解析，未来还能拖拽）
 *  - 安全（纯数据，不在渲染进程执行任意 JS）
 *
 * 表达能力：CSS 能做的都能做（排版/形状/渐变/阴影/滤镜/图片/视频/SVG/关键帧动画），
 * 外加内置特效原语（glow/grid/noise/particles/stars），覆盖大部分设计需求。
 */

export const freeElSchema = z.object({
  /** 稳定 id：配合 update_freeform_element 做局部更新（不传就按 index 定位） */
  id: z.string().optional(),
  type: z.enum(["text", "shape", "image", "video", "svg", "fx"]),

  /* 内容 */
  text: z.string().optional(),
  shape: z.enum(["rect", "circle", "line", "triangle"]).optional(),
  src: z.string().optional(),
  svg: z.string().optional(),
  viewBox: z.string().optional(),

  /* 颜色 / 描边 */
  fill: z.string().optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().optional(),

  /* 文字 */
  fontFamily: z.string().optional(),
  weight: z.number().optional(),
  lineHeight: z.number().optional(),
  letterSpacing: z.number().optional(),
  textAlign: z.enum(["left", "center", "right"]).optional(),
  maxWidth: z.number().optional(),

  /* 位置（百分比 / 短边百分比） */
  x: z.number().default(50),
  y: z.number().default(50),
  size: z.number().default(10).describe("短边百分比：文字是字号，形状/图片是宽度"),
  rotate: z.number().default(0),
  scale: z.number().default(1),
  opacity: z.number().default(1),
  radius: z.number().optional().describe("圆角（短边百分比）"),
  bg: z.string().optional().describe("背景色（CSS 色值/渐变）"),
  border: z.number().optional().describe("边框宽度（短边百分比）"),
  borderColor: z.string().optional().describe("边框颜色，默认用 fill"),
  style: z
    .record(z.union([z.string(), z.number()]))
    .optional()
    .describe("任意 CSS 内联样式（camelCase），最后应用"),

  /* 场景内时间 */
  from: z.number().int().min(0).default(0),
  durationInFrames: z.number().int().min(1).optional(),

  /* 关键帧动画 */
  anim: z
    .array(
      z.object({
        at: z.tuple([z.number(), z.number()]).describe("起止帧 [start, end]（场景内）"),
        from: z.record(z.union([z.string(), z.number()])).optional(),
        to: z.record(z.union([z.string(), z.number()])).optional(),
        ease: z.enum(["linear", "easeInOut", "spring"]).optional(),
      }),
    )
    .optional(),

  /* 特效原语（type=fx） */
  kind: z
    .enum(["glow", "grid", "noise", "particles", "stars", "scanlines", "rings", "beam", "dust", "wave", "meteor"])
    .optional(),
  color: z.string().optional(),
  density: z.number().optional(),
  speed: z.number().optional(),
});

export type FreeEl = z.infer<typeof freeElSchema>;

export const freeformPropsSchema = z.object({
  background: z
    .object({
      kind: z.enum(["solid", "gradient", "glow", "noise", "grid", "image"]).optional(),
      colors: z.array(z.string()).optional().describe("颜色列表：solid [底]，gradient [起,止]，glow [底, 光]"),
      image: z.string().optional(),
      blur: z.number().optional(),
      opacity: z.number().optional(),
    })
    .optional(),
  elements: z.array(freeElSchema).min(1).max(40),
});

export type FreeformProps = z.infer<typeof freeformPropsSchema>;

/* ────────────────────────── 动画求值 ────────────────────────── */

const easeFn = (kind: string | undefined, t: number): number => {
  const x = Math.max(0, Math.min(1, t));
  if (kind === "spring") {
    // easeOutBack 近似：落定时带一点回弹
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }
  if (kind === "easeInOut") {
    return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  }
  return x;
};

export type EvalResult = {
  x: number;
  y: number;
  size: number;
  rotate: number;
  scale: number;
  opacity: number;
};

const NUM_KEYS = ["x", "y", "size", "rotate", "scale", "opacity"] as const;

/** 按当前帧求元素的位置/尺寸/透明度（关键帧动画） */
export function evalAnim(el: FreeEl, frame: number): EvalResult {
  const out: EvalResult = {
    x: el.x,
    y: el.y,
    size: el.size,
    rotate: el.rotate,
    scale: el.scale,
    opacity: el.opacity,
  };
  for (const a of el.anim ?? []) {
    const [start, end] = a.at;
    if (frame < start || frame > end) continue;
    const t = end > start ? (frame - start) / (end - start) : 1;
    const p = easeFn(a.ease, t);
    for (const key of NUM_KEYS) {
      const to = a.to?.[key];
      if (typeof to !== "number") continue;
      const fromRaw = a.from?.[key];
      const from = typeof fromRaw === "number" ? fromRaw : out[key];
      out[key] = from + (to - from) * p;
    }
  }
  return out;
}

/* ────────────────────────── 编辑器用：拖动 / 图层 / 命名 ────────────────────────── */

/**
 * 一次"变换"手势对单个元素的影响（与 Transform 的 x/y/rotate/scale 同语义）。
 * 全部是**绝对值**，不是增量。
 */
export type FreeTransform = { x?: number; y?: number; rotate?: number; scale?: number };

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const round2 = (n: number) => Number(n.toFixed(2));
const round3 = (n: number) => Number(n.toFixed(3));

/** 关键帧值随基础值一起搬：x/y/rotate 平移，scale 按比例缩放 */
const shiftAnimVals = (
  v: Record<string, string | number>,
  dx: number,
  dy: number,
  drot: number,
  k: number,
) => {
  const out: Record<string, string | number> = { ...v };
  if (typeof out.x === "number") out.x = round2(out.x + dx);
  if (typeof out.y === "number") out.y = round2(out.y + dy);
  if (typeof out.rotate === "number") out.rotate = round2(out.rotate + drot);
  if (typeof out.scale === "number") out.scale = round3(out.scale * k);
  return out;
};

/**
 * 把一个元素移到/旋到/缩到新的变换。
 *
 * 为什么要动 `anim`：关键帧里的 x/y/rotate/scale 是**绝对值**，
 * 窗口内会完全覆盖基础值 —— 只改 el.x 的话，带位移动画的元素拖了等于没拖
 * （画面上纹丝不动，松手后回读又是新值，是极难自查的一类 bug）。
 * 所以这里把关键帧里的同名值平移/等比缩放同样的量，整条轨迹跟着元素走。
 */
export function transformFreeElement(el: FreeEl, t: FreeTransform): FreeEl {
  const x0 = num(el.x, 50);
  const y0 = num(el.y, 50);
  const rot0 = num(el.rotate, 0);
  const scale0 = num(el.scale, 1);

  const x = num(t.x, x0);
  const y = num(t.y, y0);
  const rotate = num(t.rotate, rot0);
  const scale = Math.min(4, Math.max(0.2, num(t.scale, scale0)));

  const dx = x - x0;
  const dy = y - y0;
  const drot = rotate - rot0;
  const k = scale0 > 0.0001 ? scale / scale0 : 1;
  const changed = Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001 || Math.abs(drot) > 0.001 || Math.abs(k - 1) > 0.001;

  const out: FreeEl = { ...el, x: round2(x), y: round2(y), rotate: round2(rotate), scale: round3(scale) };
  if (changed && el.anim?.length) {
    out.anim = el.anim.map((a) => ({
      ...a,
      ...(a.from ? { from: shiftAnimVals(a.from, dx, dy, drot, k) } : {}),
      ...(a.to ? { to: shiftAnimVals(a.to, dx, dy, drot, k) } : {}),
    }));
  }
  return out;
}

/** 元素是否带了会盖住 x/y/rotate/scale 的关键帧（属性面板要提示） */
export function animTouchesLayout(el: FreeEl): boolean {
  const KEYS = ["x", "y", "rotate", "scale"];
  return (el.anim ?? []).some(
    (a) => KEYS.some((k) => typeof a.from?.[k] === "number" || typeof a.to?.[k] === "number"),
  );
}

const TYPE_LABEL: Record<FreeEl["type"], string> = {
  text: "文字",
  shape: "形状",
  image: "图片",
  video: "视频",
  svg: "图标",
  fx: "特效",
};

/** 画布选框 / 排列条 / 属性面板统一用的名字（agent 写的元素没有 name 字段） */
export function freeElementLabel(el: FreeEl, index: number): string {
  const base = `${index + 1} · ${TYPE_LABEL[el.type] ?? el.type}`;
  if (el.type === "text") {
    const t = (el.text ?? "").replace(/\s+/g, " ").trim();
    if (!t) return base;
    return `${base}「${t.length > 12 ? `${t.slice(0, 12)}…` : t}」`;
  }
  if (el.type === "fx" && el.kind) return `${base} ${el.kind}`;
  if (el.type === "shape" && el.shape) return `${base} ${el.shape}`;
  return base;
}

/**
 * 背景层元素：全屏的光斑/星点/粒子这类特效。
 *
 * 它们的选框会盖住整张画布，如果和普通元素抢同一个层级，
 * 点文字永远命中不到（用户感受是"元素点不中、拖不了"）。
 */
export function isBackdropElement(el: FreeEl): boolean {
  return el.type === "fx";
}

export type ReorderMode = "front" | "back" | "forward" | "backward";

/**
 * 图层次序（自由画布没有 z-index，顺序 = elements 数组下标）。
 * 返回新数组，以及被移动的元素在新数组里的下标（选中集要跟着换）。
 */
export function reorderFreeElements(
  elements: FreeEl[],
  indices: number[],
  mode: ReorderMode,
): { elements: FreeEl[]; moved: number[] } {
  const n = elements.length;
  const picked = [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < n).sort((a, b) => a - b);
  if (!picked.length) return { elements: [...elements], moved: [] };

  const items = elements.map((el, i) => ({ el, i }));
  let out: { el: FreeEl; i: number }[];

  if (mode === "front" || mode === "back") {
    const sel = new Set(picked);
    const keep = items.filter((it) => !sel.has(it.i));
    const take = items.filter((it) => sel.has(it.i));
    out = mode === "front" ? [...keep, ...take] : [...take, ...keep];
  } else {
    out = [...items];
    const sel = new Set(picked);
    if (mode === "forward") {
      // 从后往前处理，避免前一个刚换完又被下一个踩到
      for (let p = picked.length - 1; p >= 0; p--) {
        const i = picked[p];
        const at = out.findIndex((it) => it.i === i);
        const next = out[at + 1];
        if (at < 0 || !next || sel.has(next.i)) continue;
        [out[at], out[at + 1]] = [out[at + 1], out[at]];
      }
    } else {
      for (const i of picked) {
        const at = out.findIndex((it) => it.i === i);
        const prev = out[at - 1];
        if (at <= 0 || !prev || sel.has(prev.i)) continue;
        [out[at - 1], out[at]] = [out[at], out[at - 1]];
      }
    }
  }

  const sel = new Set(picked);
  return {
    elements: out.map((it) => it.el),
    moved: out.map((it, pos) => (sel.has(it.i) ? pos : -1)).filter((pos) => pos >= 0),
  };
}
