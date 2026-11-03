/**
 * 读 PNG 算"中心区域平均亮度"，用来量化比对"编辑器视口 vs 成片"这类截图差异。
 * 不引第三方依赖：PNG 解码只做本工具需要的子集（8bit RGB/RGBA，非隔行）。
 *
 * 用法：node scripts/png-luma.mjs a.png b.png ...
 */
import fs from "node:fs";
import zlib from "node:zlib";

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

const decode = (file) => {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: 不是 PNG`);
  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let ctype = 0;
  let interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`${file}: 只支持 8bit 非隔行`);
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : 0;
  if (!ch) throw new Error(`${file}: 只支持 RGB/RGBA`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? row[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= ch ? prev[i - ch] : 0;
      const v = src[i];
      row[i] =
        filter === 0 ? v : filter === 1 ? (v + a) & 255 : filter === 2 ? (v + b) & 255
          : filter === 3 ? (v + ((a + b) >> 1)) & 255 : (v + paeth(a, b, c)) & 255;
    }
  }
  return { w, h, ch, px: out };
};

for (const file of process.argv.slice(2)) {
  const { w, h, ch, px } = decode(file);
  let sum = 0;
  let n = 0;
  const x0 = Math.round(w * 0.3);
  const x1 = Math.round(w * 0.7);
  const y0 = Math.round(h * 0.25);
  const y1 = Math.round(h * 0.65);
  for (let y = y0; y < y1; y += 3) {
    for (let x = x0; x < x1; x += 3) {
      const i = (y * w + x) * ch;
      sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      n++;
    }
  }
  console.log(`${file}: ${w}x${h} 中心平均亮度 ${(sum / n).toFixed(1)}`);
}
