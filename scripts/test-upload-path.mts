/**
 * 上传路径解析的回归：这些报错是 agent 唯一能看到的"为什么传不上去"。
 *
 *   npx tsx scripts/test-upload-path.mts
 *
 * 每一条都在替 agent 回答一个它自己看不出来的问题：
 *  - 路径是相对谁解析的？（以前抛裸 ENOENT，它只能反复换写法）
 *  - 是不是把目录当文件了？
 *  - 名字是不是差了一个字符？（给候选文件比让它猜快得多）
 *  - 空文件 / 超大文件要说清"该去重新生成 / 该压缩"，而不是"读失败"
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { MAX_UPLOAD_BYTES, loadUploadFile, normalizeUploadPath, suggestFiles } = await import(
  "../server/upload-path"
);

let failed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  [ok] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
  }
};
const throws = (fn: () => unknown, re: RegExp, label?: string) => {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, re, label ?? `报错文案没说到点上：${msg}`);
    return msg;
  }
  throw new Error(label ?? "本该报错却成功了");
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rms-upload-"));
const withSpace = path.join(root, "我的 图片.png");
fs.writeFileSync(withSpace, Buffer.from("hello"));
const iconPng = path.join(root, "icon.png");
fs.writeFileSync(iconPng, Buffer.from("pngdata"));
const empty = path.join(root, "空的.png");
fs.writeFileSync(empty, Buffer.alloc(0));
const sub = path.join(root, "素材");
fs.mkdirSync(sub);
fs.writeFileSync(path.join(sub, "inner.jpg"), Buffer.from("jpg"));

console.log("归一：引号 / 相对路径 / ~");

test("Windows「复制为路径」带的双引号会被去掉", () => {
  assert.equal(normalizeUploadPath(`"${iconPng}"`, root), iconPng);
  assert.equal(normalizeUploadPath(`'${iconPng}'`, root), iconPng);
});

test("相对路径按传入的 cwd 解析，不是按进程 cwd", () => {
  assert.equal(normalizeUploadPath("icon.png", root), iconPng);
  assert.equal(normalizeUploadPath("./x/../icon.png", root), iconPng);
});

test("空输入归一成空串（由 loadUploadFile 报错，不在这里抛）", () => {
  assert.equal(normalizeUploadPath("   ", root), "");
});

console.log("读文件：成功路径");

test("正常文件：拿到绝对路径 / 文件名 / 字节数", () => {
  const f = loadUploadFile(withSpace, root);
  assert.equal(f.abs, withSpace);
  assert.equal(f.name, "我的 图片.png", "带空格的中文名要原样保留");
  assert.equal(f.bytes, 5);
  assert.equal(f.buf.toString(), "hello");
});

console.log("读文件：每一类失败都要给下一步");

test("空路径：告诉它要给绝对路径", () => {
  throws(() => loadUploadFile("  ", root), /path 是空的/);
});

test("文件不存在：带绝对路径、cwd、父目录是否存在、排查清单", () => {
  const missing = path.join(root, "不存在的.png");
  const msg = throws(() => loadUploadFile(missing, root), /文件不存在/);
  assert.match(msg, new RegExp(missing.replace(/\\/g, "\\\\")));
  assert.match(msg, /当前工作目录（相对路径按它解析）/);
  assert.match(msg, /存在，但没有这个文件名/, "父目录存在时必须说清是「名字不对」而不是「路径不对」");
  assert.match(msg, /反斜杠在 JSON 里要写成双份/);
});

test("父目录也不存在时，文案要区分开", () => {
  const missing = path.join(root, "没有这个目录", "a.png");
  const msg = throws(() => loadUploadFile(missing, root), /文件不存在/);
  assert.match(msg, /也不存在/);
});

test("名字差一个字符：给出同目录的候选文件", () => {
  const typo = path.join(root, "icno.png");
  const msg = throws(() => loadUploadFile(typo, root), /文件不存在/);
  assert.match(msg, /名字接近/);
  assert.match(msg, /icon\.png/);
});

test("把目录当文件：列里面的文件让它挑", () => {
  const msg = throws(() => loadUploadFile(sub, root), /这是个目录/);
  assert.match(msg, /inner\.jpg/);
});

test("0 字节：指向「重新生成」，而不是「读失败」", () => {
  const msg = throws(() => loadUploadFile(empty, root), /0 字节/);
  assert.match(msg, /生成失败|重新生成/);
});

test("超过 40MB：读之前就拦住，并说该压缩", () => {
  const big = path.join(root, "big.bin");
  const fd = fs.openSync(big, "w");
  fs.ftruncateSync(fd, MAX_UPLOAD_BYTES + 1024);
  fs.closeSync(fd);
  const msg = throws(() => loadUploadFile(big, root), /超过 40MB|超过 40/);
  assert.match(msg, /压缩|裁剪/);
  fs.rmSync(big, { force: true });
});

console.log("候选文件：宁缺勿滥");

test("名字差太远的，不当候选", () => {
  assert.deepEqual(suggestFiles(path.join(root, "zzzzzzzzzzzz.png"), 3), []);
});

test("候选只列文件，不列目录", () => {
  const got = suggestFiles(path.join(root, "素材e"), 5);
  assert.ok(!got.includes(sub), "目录不该出现在候选里");
});

fs.rmSync(root, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
