/**
 * 工程归档的回归：归档是「从列表收起来」，任何一步做错都会变成「工程不见了」。
 *
 *   npx tsx scripts/test-archive.mts
 *
 * 重点保四件事：
 *  1. archive.json 坏了 **不能** 让工程列表崩——它是辅助数据，坏了当「没归档」处理
 *  2. 归档只写 archive.json，**不碰 project.json**（不动 rev、不进历史）
 *  3. 取消归档 / 删工程后不留孤儿项（否则 id 被复用时新工程会凭空"已归档"）
 *  4. prune 只清指向已不存在工程的项，不动别的
 *
 * 用临时数据根（STUDIO_DATA_ROOT）跑：paths.ts 在 import 时读这个变量，
 * 所以必须先设环境变量再动态 import 服务模块。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rms-archive-"));
process.env.STUDIO_DATA_ROOT = tmpRoot;

const {
  ARCHIVE_FILE,
  archivedAt,
  archivedCount,
  forgetArchived,
  isArchived,
  parseArchive,
  pruneArchived,
  readArchive,
  setArchived,
} = await import("../server/archive.service");

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

const reset = () => {
  try {
    fs.rmSync(ARCHIVE_FILE, { force: true });
  } catch {
    /* 不存在就算了 */
  }
};

console.log("parseArchive：坏数据一律当「没归档」");

test("null / 空串 / 坏 JSON 都是空表", () => {
  assert.deepEqual(parseArchive(null), {});
  assert.deepEqual(parseArchive(""), {});
  assert.deepEqual(parseArchive("{不是 json"), {});
  assert.deepEqual(parseArchive("[]"), {});
  assert.deepEqual(parseArchive('"str"'), {});
});

test("缺 at 的项丢掉，有 note 的空串归一为「没有 note」", () => {
  const map = parseArchive(
    JSON.stringify({
      p_a: { at: "2026-11-04T10:00:00.000Z" },
      p_b: { at: "2026-11-04T10:00:00.000Z", note: "   " },
      p_c: { at: "" },
      p_d: { note: "缺时间戳" },
      p_e: 42,
    }),
  );
  assert.deepEqual(Object.keys(map).sort(), ["p_a", "p_b"]);
  assert.equal(map.p_b.note, undefined);
  assert.equal(map.p_a.at, "2026-11-04T10:00:00.000Z");
});

test("兼容早期「只写时间戳字符串」的形态", () => {
  const map = parseArchive(JSON.stringify({ p_old: "2026-10-01T00:00:00.000Z", p_bad: "  " }));
  assert.deepEqual(Object.keys(map), ["p_old"]);
  assert.equal(map.p_old.at, "2026-10-01T00:00:00.000Z");
});

console.log("读写：只动 archive.json");

test("归档 → 查得到；取消 → 查不到", () => {
  reset();
  assert.equal(isArchived("p_a"), false);
  const entry = setArchived("p_a", true, "自检产生");
  assert.ok(entry?.at);
  assert.equal(isArchived("p_a"), true);
  assert.equal(archivedAt("p_a"), entry!.at);
  assert.equal(readArchive().p_a.note, "自检产生");
  assert.equal(archivedCount(), 1);

  assert.equal(setArchived("p_a", false), null);
  assert.equal(isArchived("p_a"), false);
  assert.equal(archivedCount(), 0);
});

test("重复归档只更新时间，不会长出两条", () => {
  reset();
  setArchived("p_a", true, "第一次");
  setArchived("p_a", true, "第二次");
  const map = readArchive();
  assert.deepEqual(Object.keys(map), ["p_a"]);
  assert.equal(map.p_a.note, "第二次");
});

test("空白 note 不写进文件（避免出现 note:\"\" 这种脏值）", () => {
  reset();
  setArchived("p_a", true, "   ");
  assert.equal("note" in readArchive().p_a, false);
});

test("取消不存在的项：不报错、也不写文件", () => {
  reset();
  assert.equal(setArchived("p_none", false), null);
  assert.equal(fs.existsSync(ARCHIVE_FILE), false);
});

console.log("清理：不留孤儿项");

test("forgetArchived 只清指定的", () => {
  reset();
  setArchived("p_a", true);
  setArchived("p_b", true);
  assert.equal(forgetArchived("p_a"), true);
  assert.deepEqual(Object.keys(readArchive()), ["p_b"]);
  assert.equal(forgetArchived("p_a"), false);
});

test("pruneArchived 只清指向已不存在工程的项", () => {
  reset();
  setArchived("p_alive", true);
  setArchived("p_gone", true);
  const removed = pruneArchived(["p_alive", "p_other"]);
  assert.equal(removed, 1);
  assert.deepEqual(Object.keys(readArchive()), ["p_alive"]);
  // 没有孤儿时不写盘（避免每次启动都碰一次文件）
  assert.equal(pruneArchived(["p_alive"]), 0);
});

test("archive.json 写坏后仍能读（返回空表）并继续写", () => {
  reset();
  fs.writeFileSync(ARCHIVE_FILE, "{坏掉的", "utf8");
  assert.deepEqual(readArchive(), {});
  assert.equal(isArchived("p_a"), false);
  setArchived("p_a", true);
  assert.equal(isArchived("p_a"), true);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
