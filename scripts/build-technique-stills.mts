/**
 * 单技法（TK 段 26 条）缩略图：把每个效果**画出来**，而不是抽源站帧。
 *
 * ── 为什么不能沿用 prompt-library-stills.mts ────────────────────────
 * 那 153 张是从源站正片抽帧；TK 段是从 A–G 代码样片改写来的，**没有源站视频**。
 * 也不能给 26 条套一张「编号 + 名字」的统一卡片——用户刚因为「千篇一律」
 * 要求重做过全部风格样张，这里再犯一次等于白改。
 *
 * ── 画什么 ────────────────────────────────────────────────────────
 * 每条按它自己的视觉语法画一张 720×404 的 SVG：字雨就画落字堆积、
 * 粒子聚形就画点收拢成环、信号撕裂就画错位色条、老胶片就画齿孔与划痕。
 * 右下角只留一个极淡的 TK 编号，主体画面各不相同。
 *
 * 用确定性随机（mulberry32）：同一条重跑两次必须出一样的图，方便 diff。
 *
 * 用法：npx tsx scripts/build-technique-stills.mts [--force] [--only=TK001]
 * 依赖：系统 Edge/Chrome（Playwright）、带 libwebp 的 ffmpeg。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { ROOT } from "../server/root";
import { refreshStillVersion } from "./still-version.mts";

const W = 720;
const H = 404;
const OUT_DIR = path.join(ROOT, "server", "skills", "prompt-library", "08-技法");
const TMP_DIR = path.join(ROOT, ".tmp-technique-stills");

const KNOWN_FFMPEG = [
  "G:/共享/自动化/FFmpeg/bin/ffmpeg.exe",
  "D:/ffmpeg/bin/ffmpeg.exe",
  "C:/ffmpeg/bin/ffmpeg.exe",
];
const KNOWN_BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

/* ── SVG 小工具 ─────────────────────────────────────────────────── */

type Rnd = () => number;
function rng(seed: number): Rnd {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const n = (v: number): string => v.toFixed(1);
const circle = (x: number, y: number, r: number, fill: string, op = 1, extra = ""): string =>
  `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${fill}" opacity="${n(op)}" ${extra}/>`;
const rect = (x: number, y: number, w: number, h: number, fill: string, op = 1, extra = ""): string =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}" opacity="${n(op)}" ${extra}/>`;
const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, w = 1, op = 1): string =>
  `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${stroke}" stroke-width="${n(w)}" opacity="${n(op)}"/>`;
const text = (x: number, y: number, s: string, size: number, fill: string, extra = ""): string =>
  `<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}" fill="${fill}" font-family="Microsoft YaHei, sans-serif" ${extra}>${s}</text>`;
const badge = (id: string, light = false): string =>
  `<text x="${W - 14}" y="${H - 12}" text-anchor="end" font-size="11" font-family="monospace" fill="${light ? "#1A1A18" : "#FFFFFF"}" opacity="0.34">${id}</text>`;
const wrap = (inner: string, bg: string, defs = "", id = "", light = false): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  `<defs>${defs}</defs><rect width="${W}" height="${H}" fill="${bg}"/>${inner}${badge(id, light)}</svg>`;

const DARK = "#080B0E";
const PAPER = "#F1E7D4";
const WORDS = "话语压力重复说教";

/* ── 26 个效果 ──────────────────────────────────────────────────── */

const ART: Record<string, () => string> = {
  // A 字：这一组的看点是「字本身在做什么」，不是排版
  TK001: () => {
    const r = rng(101);
    let s = "";
    for (let c = 0; c < 26; c++) {
      const x = 12 + c * 27;
      const count = 6 + Math.floor(r() * 12);
      const y0 = r() * 170 - 70;
      const size = 11 + Math.floor(r() * 5) * 4;
      for (let i = 0; i < count; i++) {
        const y = y0 + i * 20;
        if (y > H - 26) break;
        s += text(x, y, WORDS[Math.floor(r() * WORDS.length)], size, "#B8E986",
          `opacity="${n(0.12 + (1 - i / count) * 0.78)}" font-family="monospace"`);
      }
    }
    for (let i = 0; i < 90; i++) {
      s += text(r() * W, H - 28 - r() * 18, WORDS[Math.floor(r() * WORDS.length)], 9 + r() * 9,
        "#7FA04A", `opacity="0.30" font-family="monospace"`);
    }
    return wrap(s, "#05080A", "", "TK001");
  },

  TK002: () => {
    const phrase = "让视频像写代码一样被调度";
    const shown = phrase.slice(0, 8);
    let s = rect(0, H / 2 - 48, W, 96, "#0E1319");
    s += text(48, 64, "$ run --draft", 17, "#3E6B50", 'font-family="monospace"');
    s += text(48, H / 2 + 12, shown, 34, "#E6F1E6", 'font-family="monospace" letter-spacing="1"');
    s += rect(48 + shown.length * 34 + 6, H / 2 - 22, 16, 38, "#7CFF9B");
    s += text(48, H / 2 + 76, "▌ 停 0.4 秒，再一字一字删掉", 15, "#4A6B52", 'font-family="monospace"');
    s += text(48, 348, "一行字，一个光标，没有别的", 14, "#2E4A38");
    return wrap(s, "#070A0D", "", "TK002");
  },

  TK003: () => {
    let s = text(42, 148, "新", 92, "#FFFFFF", 'opacity="0.14" font-weight="900"');
    s += text(168, 258, "发", 136, "#FFFFFF", 'opacity="0.40" font-weight="900"');
    s += text(340, 356, "布", 188, "#FF4A38", 'font-weight="900"');
    for (let i = 0; i < 7; i++) s += line(300 + i * 12, 344, 470 + i * 12, 344, "#FF4A38", 1, 0.18 + i * 0.03);
    return wrap(s, "#0A0A0C", "", "TK003");
  },

  TK004: () => {
    let s = "";
    const chars = ["同", "一", "句", "话"];
    for (let i = 8; i >= 0; i--) {
      const k = (i + 1) / 10;
      const w = W * 0.90 * k, h = H * 0.86 * k;
      const x = (W - w) / 2, y = (H - h) / 2;
      s += `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="none" stroke="#6FE3C4" stroke-width="1" opacity="${n(0.08 + (1 - k) * 0.5)}"/>`;
      // 四个字沿这一圈的四边分布，圈与圈之间错开一点角度，才有「往里钻」的旋转感。
      // 早期把整句话放在每圈同一个点上，9 层字全叠在画面顶部成一坨（实测）。
      const sz = 9 + 20 * k;
      const rot = i * 0.26;
      chars.forEach((ch, j) => {
        const a = rot + (j * Math.PI) / 2;
        const px = W / 2 + Math.cos(a) * w * 0.5;
        const py = H / 2 + Math.sin(a) * h * 0.5;
        s += text(px, py + sz * 0.34, ch, sz, "#9FFFE4",
          `text-anchor="middle" opacity="${n(0.22 + k * 0.68)}"`);
      });
    }
    return wrap(s, "#03080A", "", "TK004");
  },

  TK005: () => {
    const r = rng(505);
    let s = "";
    for (let i = 0; i < 110; i++) {
      const x = 20 + r() * 300, y = 40 + r() * 320;
      s += rect(x, y, 2 + r() * 3, 2 + r() * 3, "#8AD9C0", 0.25 + r() * 0.5);
    }
    s += text(430, 250, "换", 150, "#EAFBF4", 'text-anchor="middle" font-weight="900" opacity="0.92"');
    for (let i = 0; i < 46; i++) {
      const t = r();
      s += circle(340 + t * 120, 90 + r() * 250, 1 + r() * 2, "#8AD9C0", 0.3 + t * 0.6);
    }
    s += line(330, 202, 386, 202, "#8AD9C0", 2, 0.7);
    return wrap(s, "#0A1714", "", "TK005");
  },

  // B 粒子与光
  TK006: () => {
    let s = "";
    const colors = ["#7FD8FF", "#B18CFF", "#FF9BC4", "#8FF2C8", "#FFD48A"];
    for (let j = 0; j < 5; j++) {
      let d = `M0 ${n(120 + j * 42)}`;
      for (let x = 0; x <= W; x += 12) {
        const y = 120 + j * 42 + Math.sin(x / 82 + j * 1.1) * (34 + j * 7) + Math.sin(x / 31 + j) * 6;
        d += ` L${x} ${n(y)}`;
      }
      s += `<path d="${d}" fill="none" stroke="${colors[j]}" stroke-width="${n(3.2 - j * 0.4)}" opacity="${n(0.72 - j * 0.1)}" stroke-linecap="round"/>`;
    }
    return wrap(s, "#0A0D18", "", "TK006");
  },

  TK007: () => {
    const r = rng(707);
    let s = "";
    for (let i = 0; i < 105; i++) {
      const x = r() * W, y = r() * H, rad = 1 + r() * 3.6, op = 0.25 + r() * 0.7;
      s += circle(x, y, rad * 3.4, "#FFD98A", op * 0.13);
      s += circle(x, y, rad, "#FFE9B0", op);
    }
    return wrap(s, "#0A1220", "", "TK007");
  },

  TK008: () => {
    const r = rng(808);
    let s = "";
    for (let g = 0; g < 6; g++) {
      const t = g / 5;
      const cx = 90 + g * 105, cy = 200;
      for (let i = 0; i < 62; i++) {
        const a = (i / 62) * Math.PI * 2;
        const rad = 12 + 52 * t;
        const sx = cx + Math.cos(a) * rad * t + (r() - 0.5) * (1 - t) * 130;
        const sy = cy + Math.sin(a) * rad * t + (r() - 0.5) * (1 - t) * 110;
        s += circle(sx, sy, 1.9, "#C8FFF0", 0.35 + t * 0.6);
      }
    }
    return wrap(s, "#05100C", "", "TK008");
  },

  TK009: () => {
    const r = rng(909);
    const pts = Array.from({ length: 58 }, () => ({ x: 24 + r() * (W - 48), y: 24 + r() * (H - 48) }));
    let s = "";
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        if (d < 132) s += line(pts[i].x, pts[i].y, pts[j].x, pts[j].y, "#7FA8FF", 1, 0.72 * (1 - d / 132));
      }
    }
    pts.forEach((p, i) => { s += circle(p.x, p.y, i % 7 === 0 ? 4 : 2.6, "#DCE8FF", 0.95); });
    return wrap(s, "#060A14", "", "TK009");
  },

  TK010: () => {
    let s = "";
    for (let i = 7; i >= 0; i--) {
      const rad = 24 + i * 24;
      s += `<circle cx="${W / 2}" cy="${H / 2}" r="${rad}" fill="none" stroke="#8FE6D8" stroke-width="${n(1 + (7 - i) * 0.42)}" opacity="${n(0.12 + (7 - i) * 0.11)}"/>`;
    }
    s += circle(W / 2, H / 2, 13, "#BFFFF0", 0.92);
    return wrap(s, "#071411", "", "TK010");
  },

  // C 墨与水
  TK011: () => {
    const defs =
      `<filter id="ink" x="-40%" y="-40%" width="180%" height="180%">` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.028" numOctaves="3" seed="7" result="nz"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="nz" scale="46" xChannelSelector="R" yChannelSelector="G"/></filter>`;
    let s = "";
    s += circle(352, 196, 118, "#1B1A17", 0.14, 'filter="url(#ink)"');
    s += circle(352, 196, 92, "#1B1A17", 0.32, 'filter="url(#ink)"');
    s += circle(352, 196, 66, "#141310", 0.86, 'filter="url(#ink)"');
    s += circle(318, 168, 22, "#3D3A32", 0.28, 'filter="url(#ink)"');
    s += text(40, 62, "一笔落纸，边缘自己长出去", 15, "#6B6154");
    return wrap(s, PAPER, defs, "TK011", true);
  },

  TK012: () => {
    const d =
      "M56 268 C 110 120, 168 330, 226 196 S 336 78, 392 210 S 512 322, 566 158 S 646 118, 676 176";
    let s = `<path d="${d}" fill="none" stroke="#3A2A1E" stroke-width="4.5" stroke-linecap="round"/>`;
    s += `<path d="${d}" fill="none" stroke="#EFE3C8" stroke-width="4.5" stroke-dasharray="16 500" stroke-dashoffset="-214"/>`;
    s += text(40, 60, "一根线，不断笔", 15, "#8B7156");
    return wrap(s, PAPER, "", "TK012", true);
  },

  TK013: () => {
    let s = "";
    for (let j = 0; j < 9; j++) {
      const base = 92 + j * 27;
      let d = `M0 ${base}`;
      for (let x = 0; x <= W; x += 10) {
        const bump = Math.exp(-((x - 250) ** 2) / (2 * 110 ** 2)) * (52 + j * 5);
        const bump2 = Math.exp(-((x - 520) ** 2) / (2 * 90 ** 2)) * (30 + j * 4);
        const y = base - bump - bump2 + Math.sin(x / 44 + j * 0.6) * 7;
        d += ` L${x} ${n(y)}`;
      }
      s += `<path d="${d}" fill="none" stroke="#2C4A6B" stroke-width="${n(j === 4 ? 2 : 1)}" opacity="${n(0.32 + j * 0.07)}"/>`;
    }
    s += text(40, 52, "情绪被画成地形", 15, "#6B6154");
    return wrap(s, "#F4EDDF", "", "TK013", true);
  },

  TK014: () => {
    let s = "";
    for (let i = 8; i >= 0; i--) {
      const rx = 26 + i * 38, ry = rx * 0.34;
      s += `<ellipse cx="${W / 2}" cy="${H / 2 + 20}" rx="${rx}" ry="${ry}" fill="none" stroke="#9FE8FF" stroke-width="${n(1 + (8 - i) * 0.3)}" opacity="${n(0.1 + (8 - i) * 0.09)}"/>`;
    }
    s += circle(W / 2, H / 2 + 8, 6, "#E6FAFF", 0.95);
    s += line(W / 2, H / 2 - 40, W / 2, H / 2 + 2, "#BFF2FF", 1.4, 0.55);
    return wrap(s, "#071C28", "", "TK014");
  },

  TK015: () => {
    const defs = `<filter id="blur"><feGaussianBlur stdDeviation="17"/></filter>`;
    let s = `<g filter="url(#blur)" opacity="0.85">` +
      rect(70, 60, 190, 230, "#C96A3E") + rect(280, 120, 170, 210, "#3E7A8C") +
      rect(470, 40, 190, 260, "#D8B25A") + `</g>`;
    const r = rng(1515);
    for (let i = 0; i < 46; i++) {
      const x = r() * W, y = r() * H, rad = 2 + r() * 7;
      s += `<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(rad * 0.7)}" ry="${n(rad)}" fill="#DCEFFF" opacity="0.22"/>`;
      s += circle(x - rad * 0.25, y - rad * 0.35, rad * 0.18, "#FFFFFF", 0.6);
    }
    for (let i = 0; i < 9; i++) {
      const x = 40 + i * 82;
      s += `<path d="M${x} ${n(r() * 70)} q 4 90 -2 170" fill="none" stroke="#FFFFFF" stroke-width="1.4" opacity="0.16"/>`;
    }
    return wrap(s, "#1B2B33", defs, "TK015");
  },

  // D 光与天气
  TK016: () => {
    const r = rng(1616);
    let s = `<path d="M150 -20 L470 -20 L330 ${H + 20} L-30 ${H + 20} Z" fill="#FFE6B0" opacity="0.10"/>`;
    s += `<path d="M210 -20 L360 -20 L250 ${H + 20} L70 ${H + 20} Z" fill="#FFF1CF" opacity="0.07"/>`;
    for (let i = 0; i < 78; i++) {
      const x = r() * W, y = r() * H;
      const t = (x + (H - y) * 0.55) / W;
      const inBeam = t > 0.12 && t < 0.58;
      s += circle(x, y, 0.8 + r() * 1.8, "#FFE6B0", inBeam ? 0.35 + r() * 0.55 : 0.05 + r() * 0.12);
    }
    s += rect(0, 0, 8, H, "#0A0C10");
    return wrap(s, "#121317", "", "TK016");
  },

  TK017: () => {
    const r = rng(1717);
    let s = rect(0, 0, W, H * 0.5, "#132132", 0.62);
    s += rect(0, H * 0.5, W, H * 0.5, "#2A1712", 0.45);
    for (let i = 0; i < 150; i++) {
      const x = r() * W, y = r() * (H * 0.5);
      s += circle(x, y, 1.4 + r() * 3, "#E8F4FF", 0.5 + r() * 0.5);
      s += line(x, y - 6, x - 3, y - 16 - r() * 12, "#DCEEFF", 1, 0.3);
    }
    for (let i = 0; i < 96; i++) {
      const x = r() * W, y = H * 0.5 + r() * (H * 0.5);
      s += circle(x, y, 1.4 + r() * 2.8, "#FFB066", 0.55 + r() * 0.45);
      s += line(x, y + 6, x + 3, y + 16 + r() * 12, "#FF9A4A", 1, 0.34);
    }
    s += line(0, H * 0.5, W, H * 0.5, "#8A99A8", 1, 0.38);
    s += text(40, 44, "雪 · 向下", 16, "#BBD8F5", 'opacity="0.8"');
    s += text(40, H - 28, "火星 · 向上", 16, "#FFC08A", 'opacity="0.8"');
    return wrap(s, "#101820", "", "TK017");
  },

  TK018: () => {
    const defs =
      `<linearGradient id="sky" x1="0" y1="0" x2="1" y2="0">` +
      `<stop offset="0" stop-color="#0A1030"/><stop offset="0.35" stop-color="#3B2A62"/>` +
      `<stop offset="0.68" stop-color="#C96463"/><stop offset="1" stop-color="#F7C98A"/></linearGradient>`;
    const r = rng(1818);
    let s = rect(0, 0, W, H, "url(#sky)");
    for (let i = 0; i < 26; i++) s += circle(r() * 300, r() * 150, 0.8, "#FFFFFF", 0.2 + r() * 0.5);
    s += circle(568, 250, 46, "#FFE1A0", 0.92);
    s += rect(0, 288, W, 116, "#1A1A24", 0.9);
    s += rect(0, 286, W, 2, "#F7C98A", 0.5);
    s += text(40, 60, "一夜", 17, "#FFFFFF", 'opacity="0.55"');
    s += text(630, 60, "天亮", 17, "#3A2318", 'opacity="0.7" text-anchor="end"');
    return wrap(s, DARK, defs, "TK018");
  },

  // E 形与介质
  TK019: () => {
    let s = circle(190, 150, 74, "#E2634B");
    s += rect(300, 84, 132, 132, "#2F6E8E", 1, 'transform="rotate(-9 366 150)"');
    s += `<path d="M520 84 L610 218 L430 218 Z" fill="#E0A32E"/>`;
    s += circle(248, 292, 26, "#241F1B", 0.8);
    s += rect(464, 268, 96, 14, "#241F1B", 0.65, 'transform="rotate(12 512 275)"');
    return wrap(s, "#F2E8D5", "", "TK019", true);
  },

  TK020: () => {
    let s = "";
    const spec = [
      { x: 300, y: 214, w: 420, h: 240, rot: -5, fill: "#C9BFA8" },
      { x: 286, y: 204, w: 372, h: 214, rot: 3, fill: "#E0D3B6" },
      { x: 270, y: 190, w: 316, h: 186, rot: -2, fill: "#D2452F" },
      { x: 254, y: 176, w: 248, h: 152, rot: 2, fill: "#F4EAD6" },
    ];
    for (const L of spec) {
      s += rect(L.x + 7, L.y + 10, L.w, L.h, "#000000", 0.13, `transform="rotate(${L.rot} ${L.x} ${L.y})" rx="2"`);
      s += rect(L.x, L.y, L.w, L.h, L.fill, 1, `transform="rotate(${L.rot} ${L.x} ${L.y})" rx="2"`);
    }
    return wrap(s, "#EDE3CE", "", "TK020", true);
  },

  TK021: () => {
    const chars = "@%#*+=-:. ";
    const r = rng(2121);
    let s = "";
    for (let row = 0; row < 22; row++) {
      let rowText = "";
      for (let col = 0; col < 58; col++) {
        const d = Math.hypot(col - 29, (row - 11) * 1.7) / 32;
        const idx = Math.min(chars.length - 1, Math.floor(d * chars.length + r() * 1.4));
        rowText += chars[idx];
      }
      s += text(8, 24 + row * 17, rowText, 13, "#7CFF9B", 'font-family="monospace" opacity="0.86"');
    }
    return wrap(s, "#040A06", "", "TK021");
  },

  // F 信息
  TK022: () => {
    const vals = [0.28, 0.42, 0.36, 0.61, 0.55, 0.78, 0.92];
    let s = "";
    let pts = "";
    vals.forEach((v, i) => {
      const x = 70 + i * 88, h = v * 250;
      s += rect(x, 330 - h, 46, h, i === 6 ? "#FFC928" : "#3C6DF0", 0.28 + v * 0.5, 'rx="2"');
      pts += `${n(x + 23)},${n(330 - h)} `;
    });
    s += `<polyline points="${pts.trim()}" fill="none" stroke="#FF7A45" stroke-width="3"/>`;
    for (const p of pts.trim().split(" ")) {
      const [x, y] = p.split(",").map(Number);
      s += circle(x, y, 4, "#FFF1E0");
    }
    s += line(48, 330, 690, 330, "#8A96A6", 1, 0.5);
    return wrap(s, "#0E1218", "", "TK022");
  },

  TK023: () => {
    const defs = `<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#58C4DE"/></marker>`;
    const nodes = [
      { x: 130, y: 110 }, { x: 330, y: 72 }, { x: 560, y: 130 },
      { x: 190, y: 290 }, { x: 400, y: 250 }, { x: 610, y: 310 },
    ];
    const edges = [[0, 1], [1, 2], [0, 3], [1, 4], [2, 5], [3, 4], [4, 5]];
    let s = "";
    for (const [a, b] of edges) {
      const A = nodes[a], B = nodes[b];
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2 - 24;
      s += `<path d="M${A.x} ${A.y} Q${mx} ${my} ${B.x} ${B.y}" fill="none" stroke="#58C4DE" stroke-width="1.6" opacity="0.55" marker-end="url(#ar)"/>`;
    }
    nodes.forEach((p, i) => {
      s += circle(p.x, p.y, i === 4 ? 22 : 14, i === 4 ? "#FFC928" : "#1B2A34", 1, 'stroke="#58C4DE" stroke-width="2"');
    });
    return wrap(s, "#0A1016", defs, "TK023");
  },

  TK024: () => {
    let s = "";
    for (let i = 0; i < 4; i++) {
      s += rect(42, 62 + i * 76, 232, 48, "#4A86C4", 0.28 + i * 0.14, 'rx="2"');
      s += rect(446, 62 + i * 76, 232, 48, "#E07A45", 0.28 + i * 0.14, 'rx="2"');
    }
    s += line(W / 2, 24, W / 2, H - 24, "#F2F5F7", 2, 0.9);
    for (let i = 0; i < 7; i++) s += line(W / 2 - 7, 60 + i * 48, W / 2 + 7, 60 + i * 48, "#F2F5F7", 1, 0.55);
    s += text(150, 42, "方案 A", 15, "#9FC2E8", 'text-anchor="middle"');
    s += text(570, 42, "方案 B", 15, "#F0B58E", 'text-anchor="middle"');
    return wrap(s, "#0B0F14", "", "TK024");
  },

  // G 年代质感
  TK025: () => {
    const r = rng(2525);
    let s = rect(74, 44, 572, 316, "#D8CDB4");
    s += rect(90, 62, 540, 280, "#B9AE96", 0.65);
    for (let i = 0; i < 10; i++) {
      s += rect(38, 60 + i * 32, 22, 18, "#EDE3CE", 0.85, 'rx="3"');
      s += rect(660, 60 + i * 32, 22, 18, "#EDE3CE", 0.85, 'rx="3"');
    }
    s += text(360, 216, "REEL 04", 42, "#2E2A24", 'text-anchor="middle" opacity="0.55" font-family="Georgia, serif" letter-spacing="6"');
    for (let i = 0; i < 16; i++) {
      const x = 90 + r() * 540;
      s += line(x, 62, x + (r() - 0.5) * 5, 342, "#3A322A", 0.6 + r(), 0.10 + r() * 0.18);
    }
    for (let i = 0; i < 90; i++) s += circle(90 + r() * 540, 62 + r() * 280, 0.6 + r() * 1.2, "#2E2A24", 0.08 + r() * 0.16);
    return wrap(s, "#0A0907", "", "TK025");
  },

  TK026: () => {
    const r = rng(2626);
    let s = "";
    for (let i = 0; i < 13; i++) {
      const y = r() * H, h = 3 + r() * 22, dx = (r() - 0.5) * 90;
      s += rect(dx, y, W, h, i % 3 === 0 ? "#FF2E88" : i % 3 === 1 ? "#1FD1D1" : "#F2F5F7", 0.12 + r() * 0.3);
    }
    s += text(360, 176, "信号", 92, "#1FD1D1", 'text-anchor="middle" font-weight="900" opacity="0.85" transform="translate(-7 0)"');
    s += text(360, 176, "信号", 92, "#FF2E88", 'text-anchor="middle" font-weight="900" opacity="0.72" transform="translate(8 0)"');
    s += text(360, 252, "撕 裂", 62, "#F2F5F7", 'text-anchor="middle" font-weight="900"');
    for (let y = 0; y < H; y += 4) s += line(0, y, W, y, "#000000", 1, 0.16);
    s += rect(0, 292, W, 26, "#FF2E88", 0.32);
    s += rect(0, 96, W, 9, "#1FD1D1", 0.5);
    return wrap(s, "#0B0710", "", "TK026");
  },
};

/* ── 渲染 ───────────────────────────────────────────────────────── */

function ffmpegOf(): string {
  for (const p of KNOWN_FFMPEG) if (fs.existsSync(p)) return p;
  return "ffmpeg";
}

async function launchBrowser() {
  for (const p of KNOWN_BROWSERS) {
    if (fs.existsSync(p)) return chromium.launch({ headless: true, executablePath: p });
  }
  // 没找到系统浏览器就退回 Playwright 自带（需要 npx playwright install）
  return chromium.launch({ headless: true });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const only = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);

  const mds = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".md") && /^TK\d{3}_/.test(f)).sort();
  const missingArt = mds.filter((f) => !ART[f.slice(0, 5)]);
  if (missingArt.length) throw new Error(`这些技法还没写效果生成器：${missingArt.join("、")}`);
  if (Object.keys(ART).length !== mds.length) {
    throw new Error(`效果生成器 ${Object.keys(ART).length} 个，md ${mds.length} 个，数量对不上`);
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const ffmpeg = ffmpegOf();
  let made = 0, skipped = 0;
  const failed: string[] = [];

  try {
    for (const md of mds) {
      const id = md.slice(0, 5);
      if (only && id !== only) continue;
      const out = path.join(OUT_DIR, md.replace(/\.md$/, ".webp"));
      if (fs.existsSync(out) && !force) { skipped++; continue; }
      const svg = ART[id]();
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#000}svg{display:block}</style></head><body>${svg}</body></html>`,
        { waitUntil: "load" },
      );
      await page.evaluate(async () => { await document.fonts.ready; });
      const png = path.join(TMP_DIR, `${id}.png`);
      await page.screenshot({ path: png, clip: { x: 0, y: 0, width: W, height: H } });
      try {
        execFileSync(ffmpeg, [
          "-y", "-hide_banner", "-loglevel", "error", "-i", png,
          "-c:v", "libwebp", "-quality", "82", "-compression_level", "6", out,
        ], { stdio: "pipe" });
        made++;
      } catch (err) {
        failed.push(`${id}: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
      }
    }
  } finally {
    await browser.close();
    for (const f of fs.readdirSync(TMP_DIR)) fs.unlinkSync(path.join(TMP_DIR, f));
    fs.rmdirSync(TMP_DIR, { recursive: true });
  }

  const v = refreshStillVersion();
  console.log(
    `技法缩略图：新出 ${made} 张${skipped ? `，跳过已有 ${skipped} 张` : ""}，` +
      `目录内共 ${fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".webp")).length} 张` +
      `${v ? `；版本戳 ${v}` : ""}`,
  );
  if (failed.length) {
    console.log("失败：");
    for (const f of failed) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

await main();
