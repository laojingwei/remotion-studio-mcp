/**
 * 素材 / 产物静态服务单测。
 *
 *   npx tsx scripts/test-static.mts
 *
 * 锁住的是一个**曾经真实出现**的 bug：hono 的 serveStatic 给 wav/mp3 回
 * `application/octet-stream`，Chromium 对 octet-stream 的音视频直接拒绝解码，
 * 表现是「素材详情面板里播放器在、点播放没反应」，而图片一直正常（<img> 不校验 MIME），
 * 非常容易误判成前端问题。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { mimeOf, parseRange, serveFiles } from "../server/static.service";

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

const testAsync = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  [fail] ${name}`);
    const detail = err instanceof Error ? err.message : String(err);
    for (const line of detail.split("\n")) console.error(`    ${line}`);
  }
};

/* ────────────────────────── MIME ────────────────────────── */

test("音视频必须带自己的 Content-Type（不能是 octet-stream）", () => {
  const want: Record<string, string> = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/mp4",
  };
  for (const [ext, type] of Object.entries(want)) {
    assert.equal(mimeOf(`a${ext}`), type, `${ext} 应该是 ${type}`);
  }
});

test("图片 / 字幕 / 工程包的类型也对", () => {
  assert.equal(mimeOf("a.png"), "image/png");
  assert.equal(mimeOf("a.webp"), "image/webp");
  assert.equal(mimeOf("a.svg"), "image/svg+xml");
  assert.equal(mimeOf("a.srt"), "text/plain; charset=utf-8");
  assert.equal(mimeOf("a.vtt"), "text/vtt; charset=utf-8");
  assert.equal(mimeOf("a.zip"), "application/zip");
});

test("扩展名大小写不敏感；认不出才回 octet-stream", () => {
  assert.equal(mimeOf("A.WAV"), "audio/wav");
  assert.equal(mimeOf("a.Mp3"), "audio/mpeg");
  assert.equal(mimeOf("a.unknownext"), "application/octet-stream");
  assert.equal(mimeOf("noext"), "application/octet-stream");
});

/* ────────────────────────── Range ────────────────────────── */

test("parseRange：单区间三种写法", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=500-", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange("bytes=-50", 1000), { start: 950, end: 999 });
});

test("parseRange：越界/非法一律 invalid（让调用方回 416）", () => {
  assert.equal(parseRange("bytes=2000-3000", 1000), "invalid");
  assert.equal(parseRange("bytes=900-100", 1000), "invalid");
  assert.equal(parseRange("bytes=-0", 1000), "invalid");
  assert.equal(parseRange("bytes=-", 1000), "invalid");
});

test("parseRange：没头 / 多区间都当全量（不做多段拼接）", () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange("bytes=0-10,20-30", 1000), null);
  assert.equal(parseRange("items=0-10", 1000), null);
});

test("parseRange：末尾越界会被夹到文件尾", () => {
  const s = parseRange("bytes=0-99999", 100);
  assert.deepEqual(s, { start: 0, end: 99 });
});

/* ────────────────────────── 真实响应头（Hono 直调，不起端口） ────────────────────────── */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "static-test-"));
const assetsDir = path.join(tmpRoot, "assets");
fs.mkdirSync(path.join(assetsDir, "projects", "p_x"), { recursive: true });
const WAV = Buffer.alloc(1000, 7);
fs.writeFileSync(path.join(assetsDir, "a.wav"), WAV);
fs.writeFileSync(path.join(assetsDir, "projects", "p_x", "b.mp4"), Buffer.alloc(2000, 3));
fs.writeFileSync(path.join(tmpRoot, "secret.txt"), "nope");

// rootDir = URL 前缀对应路径的**父目录**（生产里 /assets/* 的 root 就是 public/）
const app = new Hono();
app.use("/assets/*", serveFiles(tmpRoot));

const main = async () => {
  await testAsync("音频响应带正确 content-type 与 accept-ranges", async () => {
    const res = await app.request("/assets/a.wav");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/wav");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(res.headers.get("content-length"), "1000");
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 1000);
    assert.equal(buf[0], 7);
  });

  await testAsync("Range 请求回 206 且只给那一段（进度条靠它）", async () => {
    const res = await app.request("/assets/a.wav", { headers: { range: "bytes=0-99" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 0-99/1000");
    assert.equal(res.headers.get("content-length"), "100");
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 100);
  });

  await testAsync("越界的 Range 回 416，并说明真实长度", async () => {
    const res = await app.request("/assets/a.wav", { headers: { range: "bytes=5000-6000" } });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get("content-range"), "bytes */1000");
  });

  await testAsync("子目录里的视频也能取到（分目录布局）", async () => {
    const res = await app.request("/assets/projects/p_x/b.mp4");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(Number(res.headers.get("content-length")), 2000);
  });

  await testAsync("路径穿越 / 不存在都回 404（不泄露目录结构）", async () => {
    for (const p of [
      "/assets/../secret.txt",
      "/assets/%2e%2e/secret.txt",
      "/assets/..%2fsecret.txt",
      "/assets/a.wav/../../secret.txt",
      "/assets/nope.wav",
      "/assets",
    ]) {
      const res = await app.request(p);
      assert.equal(res.status, 404, `${p} 应该 404，实际 ${res.status}`);
    }
  });

  await testAsync("条件请求命中 ETag 回 304", async () => {
    const first = await app.request("/assets/a.wav");
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const second = await app.request("/assets/a.wav", { headers: { "if-none-match": etag! } });
    assert.equal(second.status, 304);
  });

  /* ────────────────────────── 收尾 ────────────────────────── */

  await testAsync("清理临时目录", async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    assert.equal(fs.existsSync(tmpRoot), false);
  });

  console.log("");
  if (failures.length) {
    console.error(`${failures.length} 个用例失败（通过 ${passed} 个）`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`全部通过：${passed} 个用例`);
};

void main();
