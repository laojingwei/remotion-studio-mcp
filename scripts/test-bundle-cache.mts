/**
 * bundle 目录管理的测试（纯函数 + 真实临时目录，不需要浏览器）。
 *
 * 覆盖三件事：
 *  1. 清理只碰「我们自己的前缀」，Temp 里别的一概不动；
 *  2. 太新的目录不删 —— 可能是另一个正在跑的实例在用；
 *  3. .remotion-bundle 已被 gitignore —— 打包产物进仓库会把 100MB 的散件提交进去。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUNDLE_OUT_DIR_NAME,
  LEGACY_BUNDLE_PREFIX,
  bundleOutDir,
  cleanupLegacyBundles,
  listLegacyBundles,
} from "../server/bundle-cache";
import { ROOT } from "../server/root";

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

console.log("\n[bundle-cache] 目录与清单");

test("bundleOutDir 挂在项目根下", () => {
  assert.equal(bundleOutDir(ROOT), path.join(ROOT, BUNDLE_OUT_DIR_NAME));
  assert.ok(path.isAbsolute(bundleOutDir(ROOT)));
});

test(".gitignore 已忽略打包目录", () => {
  const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.ok(gi.includes(BUNDLE_OUT_DIR_NAME), `gitignore 里没有 ${BUNDLE_OUT_DIR_NAME}`);
});

console.log("\n[bundle-cache] 清理只碰自己的东西");

/** 在指定 tmp 下造一个「旧 bundle 目录」，返回路径 */
const mkLegacy = (tmp: string, name: string, ageMs: number, files = 1) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `f${i}.js`), "x");
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, old, old);
  return dir;
};

test("只删带前缀的旧目录，别的文件不碰", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bcache-test-"));
  try {
    const old1 = mkLegacy(tmp, `${LEGACY_BUNDLE_PREFIX}aaa`, 60 * 60 * 1000);
    const stranger = mkLegacy(tmp, "some-other-tool-cache", 60 * 60 * 1000);
    const r = cleanupLegacyBundles(tmp);
    assert.equal(r.removed, 1);
    assert.ok(!fs.existsSync(old1));
    assert.ok(fs.existsSync(stranger), "把别人的缓存删了");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("太新的目录不删（可能正被别的实例用）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bcache-test-"));
  try {
    const fresh = mkLegacy(tmp, `${LEGACY_BUNDLE_PREFIX}fresh`, 60 * 1000);
    const r = cleanupLegacyBundles(tmp);
    assert.equal(r.removed, 0);
    assert.ok(fs.existsSync(fresh));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("删除失败只计数不抛错", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bcache-test-"));
  let handle: number | undefined;
  try {
    // Windows 上「被打开的文件」删不掉 —— 这是最接近真实占用（僵尸进程渲染中）的构造
    const doomed = mkLegacy(tmp, `${LEGACY_BUNDLE_PREFIX}locked`, 60 * 60 * 1000, 1);
    handle = fs.openSync(path.join(doomed, "f0.js"), "r");
    const r = cleanupLegacyBundles(tmp);
    assert.equal(r.removed + r.kept, 1, "每个目录要么删掉要么记为 kept");
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("listLegacyBundles 对不存在的 tmp 返回空", () => {
  assert.deepEqual(listLegacyBundles(path.join(os.tmpdir(), "bcache-nope-xyz")), []);
});

console.log("\n[bundle-cache] 首层保险");

test("不递归子目录（嵌套在前缀目录里的同名目录不匹配）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bcache-test-"));
  try {
    const outer = mkLegacy(tmp, `${LEGACY_BUNDLE_PREFIX}outer`, 60 * 60 * 1000);
    mkLegacy(path.join(outer, "nested"), `${LEGACY_BUNDLE_PREFIX}inner`, 60 * 60 * 1000);
    // 在里面建目录会更新外层 mtime，把「旧」补回去（不补的话外层会被当成太新而跳过）
    const older = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(outer, older, older);
    assert.equal(listLegacyBundles(tmp).length, 1, "只认第一层");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n全部通过：${passed} 个用例`);
if (failures.length) {
  console.error(`失败 ${failures.length} 个：${failures.join(" / ")}`);
  process.exit(1);
}
