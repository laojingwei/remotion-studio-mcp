/**
 * 颜色透明度工具：元素颜色（fill）要能单独调透明度，
 * 而浏览器 color input 只支持 #RRGGBB，所以自己把颜色解析成 rgba。
 */
export type Rgb = { r: number; g: number; b: number; a: number };

/** 解析 #RGB / #RRGGBB / #RRGGBBAA / rgb() / rgba()；解析不了返回 null */
export function parseColor(color: string): Rgb | null {
  const c = color.trim();
  const hex = c.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16);
      const g = parseInt(h[1] + h[1], 16);
      const b = parseInt(h[2] + h[2], 16);
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }
  const m = c.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const r = Math.round(Number(parts[0]));
      const g = Math.round(Number(parts[1]));
      const b = Math.round(Number(parts[2]));
      const a = parts[3] !== undefined ? Number(parts[3]) : 1;
      if ([r, g, b, a].every((n) => Number.isFinite(n))) {
        return { r, g, b, a: Math.max(0, Math.min(1, a)) };
      }
    }
  }
  return null;
}

/** 颜色的 alpha（0-1）；解析不了按 1 处理 */
export function colorAlpha(color: string): number {
  return parseColor(color)?.a ?? 1;
}

/** 换 alpha 后输出 rgba()；解析不了就原样返回 */
export function withColorAlpha(color: string, alpha: number): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Number(a.toFixed(3))})`;
}

/** 给 color input 用的十六进制（丢掉 alpha） */
export function toHex(color: string): string {
  const rgb = parseColor(color);
  if (!rgb) return "#ffffff";
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
}

/** 给原生 color input 用的 8 位十六进制（含 alpha，Chrome 的 alpha 色盘需要） */
export function toHex8(color: string): string {
  const rgb = parseColor(color);
  if (!rgb) return "#ffffffff";
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}${h(rgb.a * 255)}`;
}
