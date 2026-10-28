/**
 * zip 读写器与工程包素材名校验的单测（不需要起服务）。
 *
 *   npm test
 *
 * 重点：round-trip、UTF-8 文件名、deflate 兼容（用户可能用系统工具重压过包）、
 * 损坏包必须报错而不是静默产出空文件。
 */
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { createZip, crc32, readZip } from "../server/zip";
import { assetFileFromEntry } from "../shared/customTemplate";

let passed = 0;
const failures: string[] = [];

const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  [fail] ${name}`);
    const detail = err instanceof Error ? err.message : String(err);
    for (const line of detail.split("\n")) console.error(`    ${line}`);
  }
};

/** 构造一个 method=8（deflate）的 zip，用来验证"别人重新压缩过的包"也能读 */
const makeDeflateZip = (entries: { name: string; data: Buffer }[]): Buffer => {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const comp = deflateRawSync(e.data);
    const crc = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);

    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
};

/* ────────────────────────── crc32 ────────────────────────── */

test("crc32 对已知向量正确", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.from("")), 0);
});

/* ────────────────────────── 写入 / 读回 ────────────────────────── */

test("round-trip：文本 / 二进制 / 空文件 / 中文文件名", () => {
  const entries = [
    { name: "project.json", data: Buffer.from('{"name":"工程"}') },
    { name: "assets/图片-01.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]) },
    { name: "empty.txt", data: Buffer.from("") },
  ];
  const zip = createZip(entries);
  const back = readZip(zip);
  assert.equal(back.length, 3);
  const byName = new Map(back.map((e) => [e.name, Buffer.from(e.data)]));
  assert.equal(byName.get("project.json")!.toString("utf8"), '{"name":"工程"}');
  assert.deepEqual([...byName.get("assets/图片-01.png")!], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  assert.equal(byName.get("empty.txt")!.length, 0);
});

test("readZip：deflate 压缩的包也能读", () => {
  const zip = makeDeflateZip([
    { name: "a.txt", data: Buffer.from("hello deflate ".repeat(20)) },
    { name: "b.bin", data: Buffer.from([1, 2, 3, 4, 5]) },
  ]);
  const back = readZip(zip);
  assert.equal(back.length, 2);
  const a = back.find((e) => e.name === "a.txt")!;
  assert.equal(Buffer.from(a.data).toString("utf8"), "hello deflate ".repeat(20));
  const b = back.find((e) => e.name === "b.bin")!;
  assert.deepEqual([...b.data], [1, 2, 3, 4, 5]);
});

/* ────────────────────────── 坏包 ────────────────────────── */

test("readZip：不是 zip 直接报错", () => {
  assert.throws(() => readZip(Buffer.from("this is not a zip file")), /不是有效的 zip/);
});

test("readZip：截断的数据报错而不是返回半截文件", () => {
  const zip = createZip([{ name: "a.txt", data: Buffer.from("hello") }]);
  const cut = zip.subarray(0, zip.length - 10);
  assert.throws(() => readZip(cut), /zip|中央目录|越界/);
});

test("readZip：内容被篡改时 CRC 校验失败", () => {
  const zip = Buffer.from(createZip([{ name: "a.txt", data: Buffer.from("hello") }]));
  // 本地头 30 字节 + 文件名 5 字节之后是数据
  zip[30 + 5] = 0x48; // 'h' → 'H'
  assert.throws(() => readZip(zip), /校验失败/);
});

/* ────────────────────────── 素材条目名校验 ────────────────────────── */

test("assetFileFromEntry：接受 assets/<相对路径>（v0.98 起素材分层）", () => {
  assert.equal(assetFileFromEntry("assets/pic-01.png"), "pic-01.png");
  assert.equal(assetFileFromEntry("assets/a.b.c.webp"), "a.b.c.webp");
  assert.equal(assetFileFromEntry("assets/projects/p_x/a.png"), "projects/p_x/a.png");
  assert.equal(assetFileFromEntry("assets/library/b.mp3"), "library/b.mp3");
});

test("assetFileFromEntry：挡住路径穿越 / 隐藏文件 / 反斜杠", () => {
  assert.equal(assetFileFromEntry("assets/../secret.txt"), null);
  assert.equal(assetFileFromEntry("assets/.hidden"), null);
  assert.equal(assetFileFromEntry("/assets/pic.png"), null);
  assert.equal(assetFileFromEntry("assets/pic.png/../../x"), null);
  assert.equal(assetFileFromEntry("assets//pic.png"), null);
  assert.equal(assetFileFromEntry("assets/sub\\pic.png"), null);
  assert.equal(assetFileFromEntry("assets/sub/.hidden"), null);
  assert.equal(assetFileFromEntry("project.json"), null);
});

/* ────────────────────────── 汇总 ────────────────────────── */

console.log("");
if (failures.length) {
  console.error(`${failures.length} 个用例失败（通过 ${passed} 个）`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过：${passed} 个用例`);
