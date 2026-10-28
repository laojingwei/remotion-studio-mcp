/**
 * store 层脏数据自愈测试（不启服务，直接读写 data/projects 下的临时工程）。
 *
 * 背景：v2 验证报告 N-02 的连锁问题——一个工程里 subtitleStyle.bold 是布尔，
 * 会让 projectSchema.parse 抛错，进而 /api/health、/api/projects 全 500（服务等于挂了）。
 * 复验方明确说这条「黑盒无法注入坏数据，未复验」，所以在这里用单测锁住。
 *
 * 注意：会创建 p_selftest_* 临时工程，用例结束即删（精确 id，不碰真工程）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createSeedProject } from "../shared/ops";
import { DATA_DIR, deleteProjectDir, readProject, repairKnownDirtyValues, writeProject } from "../server/store";

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  [ok] ${name}`);
};

const tmpId = `p_selftest_${Date.now().toString(36)}`;
const tmpDir = path.join(DATA_DIR, tmpId);
const cleanup = () => {
  if (fs.existsSync(tmpDir)) deleteProjectDir(tmpId);
};

try {
  /* ── 纯函数：repairKnownDirtyValues ── */
  test("bold:true → 700，返回已修改", () => {
    const raw = { scenes: [{ subtitleStyle: { bold: true } }] };
    assert.equal(repairKnownDirtyValues(raw), true);
    assert.equal((raw.scenes[0].subtitleStyle as Record<string, unknown>).bold, 700);
  });

  test("bold:false → 400", () => {
    const raw = { scenes: [{ subtitleStyle: { bold: false } }] };
    repairKnownDirtyValues(raw);
    assert.equal((raw.scenes[0].subtitleStyle as Record<string, unknown>).bold, 400);
  });

  test("transforms 里的 \"undefined\" 键被删；空了整块删掉", () => {
    const raw = { scenes: [{ transforms: { undefined: { x: 5 } } }] };
    assert.equal(repairKnownDirtyValues(raw), true);
    assert.equal("transforms" in raw.scenes[0], false);
  });

  test("干净数据返回 false（不误伤）", () => {
    const raw = { scenes: [{ subtitleStyle: { bold: 600 }, transforms: { title: { x: 1 } } }] };
    assert.equal(repairKnownDirtyValues(raw), false);
  });

  /* ── 端到端：readProject 读到脏工程时自愈并写回 ── */
  const seed = createSeedProject();
  const dirty = {
    ...seed,
    id: tmpId,
    name: "自愈测试-可删",
    scenes: seed.scenes.map((s) => ({ ...s, subtitleStyle: { bold: true } })),
  };
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "project.json"), JSON.stringify(dirty, null, 2), "utf8");

  const healed = readProject(tmpId);
  test("readProject 对布尔字重自愈（不抛错）", () => {
    assert.equal(healed.scenes[0].subtitleStyle?.bold, 700);
  });
  test("自愈结果已写回磁盘", () => {
    const disk = JSON.parse(fs.readFileSync(path.join(tmpDir, "project.json"), "utf8"));
    assert.equal(disk.scenes[0].subtitleStyle.bold, 700);
  });

  /* ── 无法自愈时必须抛错且带工程 id（不静默返回半个工程） ── */
  const broken = { ...seed, id: tmpId, name: 123 };
  fs.writeFileSync(path.join(tmpDir, "project.json"), JSON.stringify(broken), "utf8");
  test("无法自愈的坏数据抛错并带工程 id", () => {
    assert.throws(() => readProject(tmpId), new RegExp(tmpId));
  });

  /* ── 正常工程读出来字段完整 ── */
  writeProject({ ...seed, id: tmpId, name: "自愈测试-可删" });
  test("正常工程 round-trip 无损", () => {
    const p = readProject(tmpId);
    assert.equal(p.name, "自愈测试-可删");
    assert.equal(p.scenes.length, seed.scenes.length);
  });
} finally {
  cleanup();
  const leftovers = fs.existsSync(tmpDir);
  console.log(`\nstore 自愈测试：${passed} 例通过${leftovers ? "（⚠️ 临时目录未清理干净）" : ""}`);
  if (leftovers) process.exitCode = 1;
}
