/**
 * 把项目主题换算成 anatomy 的 20 个 CSS 变量。
 *
 * 为什么需要这一层：anatomy 的配色是给「网页里的深灰卡片」调的，四档明暗
 * （--anatomy-shade-0..3）只差 4% 亮度。这套值放在静态大图里很高级，
 * 但**放进视频就糊成一片**：视频有压缩、有字幕压暗、还要过一遍辉光，
 * 相邻两档的 4% 差别到不了观众眼睛里。
 *
 * 所以这里不是「原样搬运主题色」，而是**拉开明暗**：
 * 面与面之间至少差 8%，顶面比暗面亮一倍。颜色仍然全部来自主题，不会跑出色系。
 *
 * 实测：不套这层，画面里只剩轮廓（几乎全黑）；套上之后底板、立柱、横臂、
 * 量块的体积都能读出来。
 */

const hex2rgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const rgb2hex = ([r, g, b]) =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

/** a、b 之间按 t 混合（t=0 → a，t=1 → b） */
export const mix = (a, b, t) => {
  const A = hex2rgb(a);
  const B = hex2rgb(b);
  return rgb2hex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
};

export const luminance = (hex) => {
  const [r, g, b] = hex2rgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/**
 * @param {Record<string,string>} palette 项目主题（background / surface / text / primary / accent / secondary）
 * @returns {string} 可以直接塞进 `<style>` 的 CSS 片段
 */
export function isoTheme(palette) {
  const bg = palette.background ?? "#0B0B10";
  const surface = palette.surface ?? mix(bg, "#ffffff", 0.08);
  const text = palette.text ?? "#F4F1EA";
  const primary = palette.primary ?? text;
  const dark = luminance(bg) < 0.35;

  /*
   * 提亮方向随主题反转：深底向白混，浅底向黑混。
   * 只判一次，后面所有 `t` 都是「离背景多远」的比例 —— 这样浅色主题不用另写一套。
   */
  const away = (t) => mix(bg, dark ? "#ffffff" : "#000000", t);

  // 面（paper）以 surface 为基准再抬一点：surface 本身是给面板用的，太贴近背景
  const paper = mix(surface, away(1), dark ? 0.12 : 0.06);

  return [
    `.iso{`,
    `--anatomy-page:${bg};`,
    `--anatomy-card:${surface};`,
    `--anatomy-text:${mix(text, bg, 0.28)};`,
    `--anatomy-strong:${text};`,
    `--anatomy-muted:${mix(text, bg, 0.52)};`,
    // 四档明暗拉开到 8% 一档（原版是 4%）：视频压缩之后还分得清朝向
    `--anatomy-paper:${paper};`,
    `--anatomy-face:${mix(paper, away(1), 0.16)};`,
    `--anatomy-top:${mix(paper, away(1), 0.3)};`,
    `--anatomy-shade-0:${mix(paper, bg, 0.45)};`,
    `--anatomy-shade-1:${mix(paper, bg, 0.22)};`,
    `--anatomy-shade-2:${paper};`,
    `--anatomy-shade-3:${mix(paper, away(1), 0.14)};`,
    `--anatomy-lit-top:${mix(paper, away(1), 0.5)};`,
    `--anatomy-lit-shade:${mix(paper, away(1), 0.34)};`,
    `--anatomy-hi:${text};`,
    `--anatomy-mid:${mix(text, bg, 0.45)};`,
    `--anatomy-lo:${mix(text, bg, 0.7)};`,
    `--anatomy-faint:${mix(text, bg, 0.86)};`,
    `--anatomy-lit:${dark ? "#ffffff" : "#000000"};`,
    `--anatomy-halo:${dark ? mix(bg, "#000000", 0.6) : mix(bg, "#ffffff", 0.5)};`,
    `--anatomy-halo-opacity:${dark ? 0.85 : 0.4};`,
    // 强调点用主题主色：图里唯一"有色"的几处（读数、指针、活动件）
    `--anatomy-dot:${primary};`,
    `}`,
  ].join("");
}
