import type { OverlayElement } from "./schema";

/**
 * 内置元素素材库。
 *
 * 每个素材是**自包含**的定义（svg 内部标记 + viewBox），没有外部依赖：
 * 放进画布后就算素材库改了，画面也不会跟着变。
 *
 * 约定：
 *  - viewBox 统一 0 0 24 24，stroke 项由外层给 `fill:none; stroke:currentColor`
 *  - size 是「短边百分比」：图形算宽度，文字算字号
 */
export type ElementCategory = "标记" | "箭头" | "形状" | "符号" | "标签";

export type LibraryItem = {
  id: string;
  name: string;
  cat: ElementCategory;
  kind: "svg" | "text";
  /** 默认尺寸（短边百分比） */
  size: number;
  /** svg 内部标记 */
  svg?: string;
  viewBox?: string;
  stroke?: boolean;
  strokeWidth?: number;
  /** text */
  text?: string;
  bg?: string;
  weight?: number;
  /** 默认颜色，不给就用主题前景色 */
  fill?: string;
};

const LIME = "#C6F24E";
const INK = "#0B0B10";

export const ELEMENT_LIBRARY: LibraryItem[] = [
  /* ── 标记 ── */
  { id: "mark-underline", name: "手写下划线", cat: "标记", kind: "svg", size: 26, stroke: true, strokeWidth: 2.4, svg: '<path d="M3 15.5c5.5-2.4 11-4 18-5.5"/>' },
  { id: "mark-circle", name: "圈选", cat: "标记", kind: "svg", size: 20, stroke: true, strokeWidth: 1.8, svg: '<ellipse cx="12" cy="12" rx="10.2" ry="7.6" transform="rotate(-6 12 12)"/>' },
  { id: "mark-star", name: "星标", cat: "标记", kind: "svg", size: 8, stroke: true, strokeWidth: 1.8, svg: '<path d="M12 3.2l2.7 5.5 6 .9-4.4 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.3 9.6l6-.9z"/>' },
  { id: "mark-check", name: "对勾", cat: "标记", kind: "svg", size: 8, stroke: true, strokeWidth: 2.6, svg: '<path d="M4 12.6l5 5L20 6.8"/>' },
  { id: "mark-cross", name: "叉号", cat: "标记", kind: "svg", size: 7, stroke: true, strokeWidth: 2.6, svg: '<path d="M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/>' },
  { id: "mark-spark", name: "十字星", cat: "标记", kind: "svg", size: 8, stroke: true, strokeWidth: 1.8, svg: '<path d="M12 2.6v6.6M12 14.8v6.6M2.6 12h6.6M14.8 12h6.6"/>' },
  { id: "mark-quote", name: "引号", cat: "标记", kind: "svg", size: 9, fill: LIME, svg: '<path d="M9.4 4.6C5.6 6.6 3.6 9.4 3.6 13.2v6.2h7v-7.2H6.4c.1-2.4 1.2-4 3.6-5.2l-.6-2.4zM20.4 4.6c-3.8 2-5.8 4.8-5.8 8.6v6.2h7v-7.2h-4.2c.1-2.4 1.2-4 3.6-5.2l-.6-2.4z"/>' },

  /* ── 箭头 ── */
  { id: "arrow-right", name: "右箭头", cat: "箭头", kind: "svg", size: 12, stroke: true, strokeWidth: 2, svg: '<path d="M3 12h15.5M12.5 5.5L19 12l-6.5 6.5"/>' },
  { id: "arrow-left", name: "左箭头", cat: "箭头", kind: "svg", size: 12, stroke: true, strokeWidth: 2, svg: '<path d="M21 12H5.5M11.5 5.5L5 12l6.5 6.5"/>' },
  { id: "arrow-up", name: "上箭头", cat: "箭头", kind: "svg", size: 10, stroke: true, strokeWidth: 2, svg: '<path d="M12 21V5.5M5.5 12L12 5.5l6.5 6.5"/>' },
  { id: "arrow-down", name: "下箭头", cat: "箭头", kind: "svg", size: 10, stroke: true, strokeWidth: 2, svg: '<path d="M12 3v15.5M5.5 12L12 18.5l6.5-6.5"/>' },
  { id: "arrow-slant", name: "斜箭头", cat: "箭头", kind: "svg", size: 9, stroke: true, strokeWidth: 2, svg: '<path d="M4.5 19.5L19 5M10.5 5H19v8.5"/>' },
  { id: "arrow-curve", name: "弯箭头", cat: "箭头", kind: "svg", size: 12, stroke: true, strokeWidth: 2, svg: '<path d="M3.5 18.5c6 0 10.2-4.4 11.2-11M12 7.8l3-3.4 3.2 3.2"/>' },
  { id: "chevron", name: "尖角", cat: "箭头", kind: "svg", size: 7, stroke: true, strokeWidth: 2.2, svg: '<path d="M9 4.5L16.5 12 9 19.5"/>' },

  /* ── 形状 ── */
  { id: "shape-circle", name: "圆形", cat: "形状", kind: "svg", size: 14, svg: '<circle cx="12" cy="12" r="9.5"/>' },
  { id: "shape-ring", name: "圆环", cat: "形状", kind: "svg", size: 14, stroke: true, strokeWidth: 2.4, svg: '<circle cx="12" cy="12" r="9"/>' },
  { id: "shape-square", name: "方形", cat: "形状", kind: "svg", size: 14, svg: '<rect x="2.5" y="2.5" width="19" height="19" rx="1.4"/>' },
  { id: "shape-round", name: "圆角块", cat: "形状", kind: "svg", size: 14, svg: '<rect x="2.5" y="2.5" width="19" height="19" rx="6"/>' },
  { id: "shape-triangle", name: "三角", cat: "形状", kind: "svg", size: 13, svg: '<path d="M12 3l9.4 17.6H2.6z"/>' },
  { id: "shape-half", name: "半圆", cat: "形状", kind: "svg", size: 14, svg: '<path d="M2.5 12a9.5 9.5 0 0 1 19 0z"/>' },
  { id: "shape-line", name: "横线", cat: "形状", kind: "svg", size: 20, stroke: true, strokeWidth: 3, svg: '<path d="M2 12h20"/>' },
  { id: "shape-grid", name: "点阵", cat: "形状", kind: "svg", size: 12, svg: '<circle cx="5" cy="5" r="1.4"/><circle cx="12" cy="5" r="1.4"/><circle cx="19" cy="5" r="1.4"/><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/><circle cx="5" cy="19" r="1.4"/><circle cx="12" cy="19" r="1.4"/><circle cx="19" cy="19" r="1.4"/>' },

  /* ── 符号 ── */
  { id: "sym-play", name: "播放", cat: "符号", kind: "svg", size: 8, svg: '<path d="M7.2 4l13 8-13 8z"/>' },
  { id: "sym-bolt", name: "闪电", cat: "符号", kind: "svg", size: 8, fill: LIME, svg: '<path d="M13.6 2L4 13.8h5.8L8.8 22l9.6-12h-6z"/>' },
  { id: "sym-heart", name: "爱心", cat: "符号", kind: "svg", size: 8, svg: '<path d="M12 21.2S3.4 15.6 3.4 9.7A4.7 4.7 0 0 1 12 6.8a4.7 4.7 0 0 1 8.6 2.9c0 5.9-8.6 11.5-8.6 11.5z"/>' },
  { id: "sym-pin", name: "定位", cat: "符号", kind: "svg", size: 8, stroke: true, strokeWidth: 1.9, svg: '<path d="M12 21.6s7-7.4 7-12.4A7 7 0 1 0 5 9.2c0 5 7 12.4 7 12.4z"/><circle cx="12" cy="9.2" r="2.6"/>' },
  { id: "sym-clock", name: "时钟", cat: "符号", kind: "svg", size: 8, stroke: true, strokeWidth: 1.9, svg: '<circle cx="12" cy="12" r="9"/><path d="M12 6.8V12l3.4 2"/>' },
  { id: "sym-bulb", name: "灯泡", cat: "符号", kind: "svg", size: 8, stroke: true, strokeWidth: 1.8, svg: '<path d="M8.6 18h6.8M10.2 21h3.6M12 3a6.2 6.2 0 0 0-3.4 11.4V17h6.8v-2.6A6.2 6.2 0 0 0 12 3z"/>' },
  { id: "sym-rocket", name: "火箭", cat: "符号", kind: "svg", size: 9, stroke: true, strokeWidth: 1.7, svg: '<path d="M5 19c.8-3.6 2.9-6.5 6.3-8.5 2.7-1.6 5.1-2 6.9-2 0 1.8-.3 4.3-2 7-2 3.4-4.8 5.4-8.4 6.2L5 19z"/><circle cx="14.6" cy="9.4" r="1.7"/>' },
  { id: "sym-chart", name: "图表", cat: "符号", kind: "svg", size: 9, stroke: true, strokeWidth: 1.9, svg: '<path d="M3.6 20.4V11M9.6 20.4V4M15.6 20.4v-6.6M21 20.4H3"/>' },
  { id: "sym-user", name: "用户", cat: "符号", kind: "svg", size: 8, stroke: true, strokeWidth: 1.8, svg: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-6.6 8-6.6S20 16.6 20 21"/>' },
  { id: "sym-search", name: "放大镜", cat: "符号", kind: "svg", size: 8, stroke: true, strokeWidth: 1.9, svg: '<circle cx="11" cy="11" r="6.2"/><path d="M15.8 15.8L21 21"/>' },
  { id: "sym-sparkle", name: "闪耀", cat: "符号", kind: "svg", size: 9, fill: LIME, svg: '<path d="M10.4 2.5l1.9 5.4 5.4 1.9-5.4 1.9-1.9 5.4-1.9-5.4L3.1 9.8l5.4-1.9zM18.4 15.6l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9z"/>' },
  { id: "sym-music", name: "音乐", cat: "符号", kind: "svg", size: 8, stroke: true, strokeWidth: 1.8, svg: '<path d="M9 18V5.6l10-2v12"/><circle cx="6.6" cy="18" r="2.5"/><circle cx="16.6" cy="15.6" r="2.5"/>' },

  /* ── 标签（文字类） ── */
  { id: "badge-new", name: "NEW 标签", cat: "标签", kind: "text", size: 5.2, text: "NEW", bg: LIME, fill: INK, weight: 800 },
  { id: "badge-hot", name: "限时标", cat: "标签", kind: "text", size: 5.2, text: "限时", bg: "#FF7A45", fill: INK, weight: 700 },
  { id: "badge-num", name: "序号", cat: "标签", kind: "text", size: 9, text: "01", fill: LIME, weight: 800 },
  { id: "badge-tag", name: "文字标", cat: "标签", kind: "text", size: 4.4, text: "重点", bg: "#17171F", fill: LIME, weight: 600 },
  /* ── 常用符号（新增） ── */
  { id: "shape-heart", name: "心形", cat: "形状", kind: "svg", size: 14, svg: '<path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 11c0 5.5-7 10-7 10z"/>' },
  { id: "shape-star", name: "五角星", cat: "形状", kind: "svg", size: 14, svg: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>' },
  { id: "shape-bolt", name: "闪电", cat: "符号", kind: "svg", size: 13, svg: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>' },
  { id: "shape-crown", name: "皇冠", cat: "标记", kind: "svg", size: 15, svg: '<path d="M3 18h18l-1.4-8L15 14l-3-6-3 6-4.6-4z"/>' },
  { id: "shape-flame", name: "火焰", cat: "符号", kind: "svg", size: 13, svg: '<path d="M12 2c3 4 5 7 5 10a5 5 0 0 1-10 0c0-2 1-4 2-5 0 2 1 3 2 3 1 0 1-4 1-8z"/>' },
  { id: "shape-gift", name: "礼物", cat: "形状", kind: "svg", size: 14, svg: '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M2 13h20M12 9v11M12 9c-2 0-3.5-1-3.5-2.5S10 4 12 5c2-1 3.5 0 3.5 1.5S14 9 12 9z"/>', stroke: true, strokeWidth: 1.8 },
  { id: "shape-bell", name: "铃铛", cat: "符号", kind: "svg", size: 13, svg: '<path d="M6 16V10a6 6 0 0 1 12 0v6l2 3H4z"/><path d="M10 21h4"/>', stroke: true, strokeWidth: 1.8 },
  { id: "shape-sun", name: "太阳", cat: "形状", kind: "svg", size: 14, svg: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2 2M17.1 17.1l2 2M19.1 4.9l-2 2M6.9 17.1l-2 2"/>', stroke: true, strokeWidth: 1.8 },
  { id: "shape-moon", name: "月亮", cat: "形状", kind: "svg", size: 14, svg: '<path d="M20 14a8 8 0 1 1-8-11 6.5 6.5 0 0 0 8 11z"/>' },
  { id: "shape-cloud", name: "云朵", cat: "形状", kind: "svg", size: 15, svg: '<path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 7 18z"/>', stroke: true, strokeWidth: 1.8 },
  { id: "shape-pin", name: "定位", cat: "标记", kind: "svg", size: 13, svg: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>', stroke: true, strokeWidth: 1.8 },
  { id: "shape-cart", name: "购物车", cat: "符号", kind: "svg", size: 14, svg: '<path d="M3 4h2l2.5 12h10L20 7H6"/><circle cx="9" cy="19" r="1.6"/><circle cx="17" cy="19" r="1.6"/>', stroke: true, strokeWidth: 1.8 },
  { id: "shape-play", name: "播放", cat: "符号", kind: "svg", size: 12, svg: '<path d="M7 4l13 8-13 8z"/>' },
  { id: "shape-check", name: "勾选", cat: "标记", kind: "svg", size: 12, svg: '<path d="M4 12.5l5 5L20 6"/>', stroke: true, strokeWidth: 2.4 },
  /* ── 光效（借鉴霓虹风） ── */
  { id: "glow-orb", name: "光晕圆", cat: "形状", kind: "svg", size: 22, viewBox: "0 0 24 24", svg: '<defs><radialGradient id="g-orb" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#7C5CFF"/><stop offset="55%" stop-color="#7C5CFF" stop-opacity=".45"/><stop offset="100%" stop-color="#7C5CFF" stop-opacity="0"/></radialGradient></defs><circle cx="12" cy="12" r="11" fill="url(#g-orb)"/>' },
  { id: "glow-frame", name: "霓虹框", cat: "形状", kind: "svg", size: 24, viewBox: "0 0 24 24", svg: '<defs><linearGradient id="g-neon" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#22D3EE"/><stop offset="100%" stop-color="#7C5CFF"/></linearGradient></defs><rect x="2" y="2" width="20" height="20" rx="5" fill="none" stroke="url(#g-neon)" stroke-width="1.8"/><rect x="4.5" y="4.5" width="15" height="15" rx="3.5" fill="none" stroke="url(#g-neon)" stroke-width=".7" opacity=".45"/>' },
  { id: "glow-bar", name: "渐变条", cat: "形状", kind: "svg", size: 28, viewBox: "0 0 24 24", svg: '<defs><linearGradient id="g-bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#FF6B35"/><stop offset="50%" stop-color="#C86BFF"/><stop offset="100%" stop-color="#22D3EE"/></linearGradient></defs><rect x="1" y="9.5" width="22" height="5" rx="2.5" fill="url(#g-bar)"/>' },
  { id: "glow-star", name: "发光星", cat: "符号", kind: "svg", size: 11, viewBox: "0 0 24 24", svg: '<defs><filter id="f-star" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><path d="M12 2l2.3 6.4L21 11l-6.7 2.6L12 20l-2.3-6.4L3 11l6.7-2.6z" fill="#FFE27A" filter="url(#f-star)"/>' },
  { id: "glow-dot", name: "光点", cat: "标记", kind: "svg", size: 6, viewBox: "0 0 24 24", svg: '<circle cx="12" cy="12" r="5" fill="#22D3EE"/><circle cx="12" cy="12" r="10" fill="none" stroke="#22D3EE" stroke-width="1" opacity=".35"/>' },
];

export const LIBRARY_CATS: ElementCategory[] = ["标记", "箭头", "形状", "符号", "标签"];

export const getLibraryItem = (id: string) => ELEMENT_LIBRARY.find((x) => x.id === id);

/**
 * 素材 → 元素数据。
 * 只把有值的字段带出来，剩下的交给 schema 默认值。
 */
export function elementFromLibrary(
  id: string,
  at?: { x: number; y: number },
): Partial<OverlayElement> & { kind: "svg" | "text" } {
  const item = getLibraryItem(id);
  if (!item) throw new Error(`素材库里没有 ${id}`);
  const out: Partial<OverlayElement> & { kind: "svg" | "text" } = {
    kind: item.kind,
    name: item.name,
    size: item.size,
    libraryId: item.id,
  };
  if (at) {
    out.x = at.x;
    out.y = at.y;
  }
  if (item.svg) out.svg = item.svg;
  if (item.viewBox) out.viewBox = item.viewBox;
  if (item.stroke !== undefined) out.stroke = item.stroke;
  if (item.strokeWidth !== undefined) out.strokeWidth = item.strokeWidth;
  if (item.text !== undefined) out.text = item.text;
  if (item.bg !== undefined) out.bg = item.bg;
  if (item.weight !== undefined) out.weight = item.weight;
  if (item.fill !== undefined) out.fill = item.fill;
  return out;
}
