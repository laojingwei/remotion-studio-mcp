import * as THREE from "three";
import type { Theme } from "../../../shared/schema";

/**
 * 3D 用色的公共函数：预设和 DSL 都走这里，避免两套调色逻辑对不上。
 */

/**
 * 颜色乘系数（压暗/提亮）。
 *
 * **直接在 sRGB 数值上乘**，不要走 `Color.multiplyScalar`——后者作用在 linear 空间，
 * 而 sRGB 是约 2.4 次幂的映射：`multiplyScalar(0.1)` 出来的是人眼看到的 **0.32 倍**亮度。
 * 典型症状是"想压到很暗、渲出来还是中绿"，然后被迫一路往下试 0.05、0.02……
 */
export const shade = (hex: string, k: number): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
};

/**
 * 金属本体色：**降饱和 + 压暗到目标亮度**，不是"把主题色乘个系数"。
 *
 * 主题色直接当金属本体，是 3D 里最容易翻车的一步。默认主题的主色 `#C6F24E` 是一支
 * 高饱和柠檬绿，金属度拉满之后它整颗都在反射环境光，渲出来永远是"果冻/塑料球"——
 * 而且 `metalness / roughness / envMapIntensity` 这三个参数**救不回来**，它们只改变
 * 高光的形状和锐度，不改变本体色。这就是"怎么调都是糖果"的真正原因。
 *
 * 用"目标亮度"而不是"乘系数"：主题主色可能是亮柠檬绿（lum 220），也可能是深藏蓝（lum 65），
 * 乘同一个系数会一个变黑一个不够暗。归一化之后，任何主题下本体的明度都在同一条基准线上。
 */
export const metalBody = (hex: string, targetLum = 0.26, sat = 0.18): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const k = (targetLum * 255) / Math.max(1, lum);
  const mix = (v: number) => Math.max(0, Math.min(255, Math.round((lum + (v - lum) * sat) * k)));
  return `#${((1 << 24) | (mix(r) << 16) | (mix(g) << 8) | mix(b)).toString(16).slice(1)}`;
};

/** 主题语义色 → 实际色值；已经是 `#RRGGBB` 或未知值就原样返回 */
export const resolveColor = (token: string, theme: Theme): string => {
  const p = theme.palette;
  switch (token) {
    case "primary":
      return p.primary;
    case "accent":
      return p.accent;
    case "secondary":
      return p.secondary;
    case "text":
      return p.text;
    case "muted":
      return p.textMuted;
    case "background":
      return p.background;
    default:
      return token;
  }
};

/** 十六进制色的相对亮度：决定辉光分档 */
export const luminance = (hex: string): number => {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

/**
 * 径向渐变贴图，用来做"光晕"。
 *
 * 之前试过用加法混合的半透明球壳做光晕：在低不透明度（0.14）下，它在 ANGLE/SwiftShader 上
 * 会被渲成一个**方形暗块**包住发光核（透明度调到 0.7 才看不出），换几何体、换分段数都没用。
 * 所以在 3D 里做柔光，一律用贴图 + sprite，不靠几何体轮廓。
 */
let glowCache: THREE.CanvasTexture | null = null;
export const glowTexture = (): THREE.CanvasTexture | null => {
  if (glowCache) return glowCache;
  if (typeof document === "undefined") return null;
  const size = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.22, "rgba(255,255,255,0.55)");
  g.addColorStop(0.55, "rgba(255,255,255,0.14)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowCache = new THREE.CanvasTexture(cv);
  glowCache.colorSpace = THREE.SRGBColorSpace;
  return glowCache;
};

/** 确定性伪随机：同一 (i,k) 永远同一个值，绝不依赖 Math.random */
export const hash01 = (i: number, k: number): number => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};
