#!/usr/bin/env node
/**
 * 量一张画面的「填充率」：内容包围盒占画面多少、墨水占比多少。
 *
 *   node scripts/fill-rate.mjs out/projects/<id>/stills/*.png
 *
 * 为什么需要它：`check_project` 查得出越界/字幕/素材，查不出「这页看着空」。
 * 「空」在数值上就是内容包围盒太小 —— 横屏片最常见的问题是内容只占左边 50%，
 * 右边整片空白。这个脚本把「空」变成可比较的数字，改版式前后跑一遍就知道有没有变好。
 *
 * 判定基准（内容包围盒）：
 *   16:9  宽 ≥ 75%   纵 ≥ 30%（标题页可到 25%）
 *   9:16  宽 ≥ 70%   纵 ≥ 25%
 * 低于基准只说明「可能空」，具体还要看图 —— 有些版式（环形、二维码）本来就该小。
 *
 * 纯 stdlib：自己解 PNG（只支持 8bit RGB/RGBA，Chrome 截图都是这两种），不装依赖。
 */
import fs from "node:fs";
import zlib from "node:zlib";

function decode(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  let W = 0, H = 0, ct = 6, bd = 8;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      W = data.readUInt32BE(0); H = data.readUInt32BE(4); bd = data[8]; ct = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bd !== 8) throw new Error("只支持 8bit PNG");
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : 0;
  if (!ch) throw new Error("不支持的 colorType " + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = W * ch;
  const out = Buffer.alloc(W * H * ch);
  let p = 0;
  for (let y = 0; y < H; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
  }
  return { W, H, ch, px: out };
}

/** 与背景的亮度差超过它才算「有内容」。背景是缓慢漂移的渐变，所以基准取亮度众数，不取角落像素 */
const T = 45;

function measure(file) {
  const { W, H, ch, px } = decode(file);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < W * H; i++) {
    const o = i * ch;
    hist[Math.round(0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2])]++;
  }
  let mode = 0;
  for (let v = 0; v < 256; v++) if (hist[v] > hist[mode]) mode = v;

  let minX = W, maxX = -1, minY = H, maxY = -1, ink = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      if (Math.abs(lum - mode) <= T) continue;
      ink++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { W, H, w: 0, h: 0, area: 0, ink: 0 };
  return {
    W, H,
    w: (maxX - minX + 1) / W,
    h: (maxY - minY + 1) / H,
    area: ((maxX - minX + 1) * (maxY - minY + 1)) / (W * H),
    ink: ink / (W * H),
  };
}

const pct = (n) => `${(n * 100).toFixed(0)}%`.padStart(4);

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法：node scripts/fill-rate.mjs <png...>");
  process.exit(2);
}

console.log("文件".padEnd(34), "宽   高   包围盒  墨水  判定");
for (const f of files) {
  const m = measure(f);
  const landscape = m.W >= m.H;
  const minW = landscape ? 0.75 : 0.7;
  // 只把「横向没铺开」当问题：竖屏永远铺不开（本来就窄），
  // 而单行金句、两三条要点这类版式天然就矮，用高度判它们会天天误报
  const notes = [];
  if (m.w < minW) notes.push(`横向只占 ${Math.round(m.w * 100)}%，右边空着`);
  if (m.h < 0.2) notes.push("内容太单薄（单行/单条版式可忽略）");
  const note = notes.length ? notes.join("；") : "ok";
  console.log(
    (f.split(/[\\/]/).pop() ?? f).slice(0, 32).padEnd(32),
    pct(m.w), pct(m.h), pct(m.area).padStart(7), pct(m.ink).padStart(6), " ", note,
  );
}
