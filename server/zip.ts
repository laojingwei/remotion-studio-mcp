import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * 最小 ZIP 读写器（不引第三方依赖）。
 *
 * - 写：一律 stored（method 0），不压缩。素材图片/音频本来就压过，再 deflate 收益很小，
 *   但实现和排查成本低很多（central directory 与 local header 的尺寸字段一致）。
 * - 读：支持 stored 和 deflate（用户可能用系统工具把导出的包重新压一遍）。
 * - CRC32 自己实现，读的时候会校验，坏包会直接报错而不是写进工程。
 */
export type ZipEntry = { name: string; data: Uint8Array };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export const crc32 = (data: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** DOS 时间格式（zip 用），本地时区即可，只影响解压后显示的时间 */
const dosDateTime = (d = new Date()) => {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date =
    (((Math.max(1980, d.getFullYear()) - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  return { time, date };
};

export function createZip(entries: ZipEntry[]): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  const { time, date } = dosDateTime();
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // bit 11 = 文件名是 UTF-8
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // central directory header
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30); // extra
    cen.writeUInt16LE(0, 32); // comment
    cen.writeUInt16LE(0, 34); // disk
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(0, 38); // external attrs
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);

    offset += local.length + name.length + data.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([...chunks, cd, eocd]));
}

export function readZip(input: Uint8Array): ZipEntry[] {
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);

  // 从尾部找 EOCD（可能带注释，最多回退 64KB）
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip（找不到中央目录结尾）");

  const count = b.readUInt16LE(eocd + 10);
  const cdOffset = b.readUInt32LE(eocd + 16);
  if (count > 5000) throw new Error(`压缩包条目过多（${count}）`);
  if (cdOffset >= b.length) throw new Error("zip 中央目录偏移越界");

  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) {
      throw new Error("zip 中央目录损坏");
    }
    const method = b.readUInt16LE(p + 10);
    const expectedCrc = b.readUInt32LE(p + 16);
    const csize = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const localOffset = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);

    if (localOffset + 30 > b.length || b.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`zip 本地头损坏：${name}`);
    }
    const localNameLen = b.readUInt16LE(localOffset + 26);
    const localExtraLen = b.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + csize > b.length) throw new Error(`zip 数据越界：${name}`);

    const raw = b.subarray(dataStart, dataStart + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method}：${name}`);

    if (crc32(data) !== expectedCrc) throw new Error(`zip 校验失败（文件损坏）：${name}`);

    out.push({ name, data: new Uint8Array(data) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
