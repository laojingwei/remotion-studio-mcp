/**
 * 工作空间（data/public/out 迁移）单测。
 *
 *   npx tsx scripts/test-workspace.mts
 *
 * **只测"不该动手的那部分"**：错误参数、安全护栏、dryRun 方案、统计函数。
 * 真迁移会把仓库里的 data/public/out 搬走再建成链接，这种事不能放进 npm test。
 * 真迁移的手工验证流程写在验证脚本里（临时目录 → 迁 → 核对 → 搬回）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../server/root";
import {
  dirStats,
  freeSpace,
  getWorkspaceStatus,
  relocateWorkspace,
  resetWorkspace,
} from "../server/workspace.service";

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));

/* ────────────────────────── 统计 ────────────────────────── */

test("dirStats：递归统计文件数与字节", () => {
  const dir = path.join(tmpRoot, "stats");
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a.bin"), Buffer.alloc(100));
  fs.writeFileSync(path.join(dir, "sub", "b.bin"), Buffer.alloc(50));
  const st = dirStats(dir);
  assert.equal(st.files, 2);
  assert.equal(st.bytes, 150);
});

test("dirStats：目录不存在时返回 0，不抛错", () => {
  assert.deepEqual(dirStats(path.join(tmpRoot, "nope")), { files: 0, bytes: 0 });
});

test("freeSpace：能拿到工程目录所在盘的可用量", () => {
  const free = freeSpace(ROOT);
  assert.ok(free > 0, `应大于 0，实际 ${free}`);
});

test("freeSpace：路径不存在也能往上找到已存在的父目录", () => {
  const free = freeSpace(path.join(ROOT, "no", "such", "dir"));
  assert.ok(free > 0);
});

/* ────────────────────────── 状态 ────────────────────────── */

test("getWorkspaceStatus：三块目录都在，且指向工程目录", () => {
  const st = getWorkspaceStatus();
  assert.deepEqual(
    st.dirs.map((d) => d.name),
    ["data", "public", "out"],
  );
  for (const d of st.dirs) {
    assert.equal(path.resolve(d.path), path.resolve(path.join(ROOT, d.name)));
  }
  assert.ok(st.totalBytes >= 0);
  assert.ok(st.rootFree > 0);
});

/* ────────────────────────── 护栏 ────────────────────────── */

test("目标必须是绝对路径", () => {
  assert.throws(() => relocateWorkspace("./relative"), /绝对路径/);
  assert.throws(() => relocateWorkspace(""), /要给一个目标目录/);
});

test("目标不能是工程目录，也不能在工程目录里面（否则越搬越套娃）", () => {
  assert.throws(() => relocateWorkspace(ROOT), /搬回工程目录/);
  assert.throws(() => relocateWorkspace(path.join(ROOT, "sub-dir")), /不能放在工程目录里面/);
});

test("目标里已有非空的同名目录 → 拒绝（不覆盖别人的数据）", () => {
  const target = path.join(tmpRoot, "occupied");
  fs.mkdirSync(path.join(target, "data"), { recursive: true });
  fs.writeFileSync(path.join(target, "data", "keep.txt"), "x");
  assert.throws(() => relocateWorkspace(target, { dryRun: true }), /已经有 data\//);
});

/* ────────────────────────── dryRun ────────────────────────── */

test("dryRun：给出 3 个目录的方案，但一个文件都不动", () => {
  const target = path.join(tmpRoot, "plan");
  const before = getWorkspaceStatus();
  const r = relocateWorkspace(target, { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.moved.length, 0, "dryRun 不能搬任何东西");
  assert.equal(r.plan.length, 3);
  assert.ok(r.plan.every((p) => p.to.startsWith(target)));
  const after = getWorkspaceStatus();
  assert.equal(after.totalBytes, before.totalBytes, "dryRun 前后占用必须一致");
  assert.equal(after.workspaceDir, before.workspaceDir, "dryRun 不能改写配置");
});

test("dryRun：目标目录不存在时只报告，不真的建目录", () => {
  const target = path.join(tmpRoot, "will-not-exist");
  const r = relocateWorkspace(target, { dryRun: true });
  assert.ok(r.warnings.some((w) => w.includes("不存在")));
  assert.equal(fs.existsSync(target), false);
});

test("dryRun：未迁移时没有任何条目被标记为跳过", () => {
  const r = relocateWorkspace(path.join(tmpRoot, "plan2"), { dryRun: true });
  assert.equal(r.plan.filter((p) => p.skip).length, 0);
});

/* ────────────────────────── reset ────────────────────────── */

/**
 * reset 的前提是「本机迁过」。老写法直接断言 plan 为空 —— 只在没迁过的机器上成立，
 * 一旦开发者真的把工作区搬走（这台机器就搬到了 D:\dsh\Remotion workspace），
 * 用例必挂，后面所有人就习惯性忽略这条红。所以按实际状态分支判断。
 */
test("reset 只回滚真的迁移过的目录（没迁移过则无事可做）", () => {
  const migrated = !!getWorkspaceStatus().workspaceDir;
  const r = resetWorkspace({ dryRun: true });
  assert.equal(r.moved.length, 0, "dryRun 不能搬任何东西");
  if (migrated) {
    assert.ok(r.plan.length > 0, "已迁移时应该给出回滚计划");
    assert.ok(r.plan.every((p) => !p.skip), "回滚计划里每一项都该是真链接");
  } else {
    assert.equal(r.plan.length, 0);
  }
});

/* ────────────────────────── 收尾 ────────────────────────── */

test("清理临时目录", () => {
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
