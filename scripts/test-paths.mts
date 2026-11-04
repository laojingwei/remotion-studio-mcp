/**
 * 路径底座的自检：ROOT 必须指向工程根，而不是 server/。
 *
 * 为什么单独一个测试：
 * 2026-11 把 mcp-tools.ts 拆成 server/tools/* 时，`ROOT` 是按**文件位置**算的
 * （`dirname(import.meta.url) + ".."`），搬到 server/tools/ 之后就少了一层，
 * 变成 server/。它不报错，只是到处找不到文件，于是同时坏三件事：
 *   · check_project 把每个 /assets/* 报成「素材缺失」（p_asb6mt 一次误报 5 个）
 *   · export_project 把 zip 写进 server/out/project-bundles/
 *   · ensureServer 拉起服务时 spawn 不到 tsx 与 server/index.ts
 * 这些都是"跑起来才知道"的问题，而 CI 的 E2E 只覆盖 UI 主路径，抓不到。
 *
 * 所以这里直接把根目录钉死：ROOT 必须等于工程根，且几个关键路径必须存在。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT as ROOT_FROM_SHARED } from "../server/tools/_shared";
import { ROOT as ROOT_FROM_ROOT_TS } from "../server/root";
import { DATA_ROOT, PROJECTS_ROOT } from "../server/paths";

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, "..");

let failed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  [ok] ${name}`);
  } catch (err) {
    failed++;
    console.log(`  [fail] ${name}\n        ${err instanceof Error ? err.message : String(err)}`);
  }
};

console.log("\n路径底座\n");

test("ROOT 与 server/root.ts 是同一个值（单一来源）", () => {
  assert.equal(ROOT_FROM_SHARED, ROOT_FROM_ROOT_TS);
});

test("ROOT 指向工程根，不是 server/", () => {
  assert.equal(ROOT_FROM_SHARED, path.resolve(REPO));
  assert.notEqual(path.basename(ROOT_FROM_SHARED), "server", "ROOT 落到了 server/");
});

test("ROOT 下确实有工程该有的东西", () => {
  for (const rel of ["package.json", "server/index.ts", "node_modules/tsx/dist/cli.mjs"]) {
    assert.ok(fs.existsSync(path.join(ROOT_FROM_SHARED, rel)), `${rel} 不在 ROOT 下：${ROOT_FROM_SHARED}`);
  }
});

test("out/ 与 public/ 的拼接落在工程根下", () => {
  for (const rel of ["out/project-bundles", "public/assets"]) {
    const dir = path.join(ROOT_FROM_SHARED, rel);
    // 目录可以还没建（全新 clone），但父级必须是工程根里的那一层
    assert.equal(path.resolve(dir.split(path.sep + "assets")[0]).startsWith(ROOT_FROM_SHARED), true);
    assert.ok(path.resolve(dir).startsWith(ROOT_FROM_SHARED + path.sep), `${rel} 跑出了工程根`);
    assert.ok(!path.resolve(dir).includes(`${path.sep}server${path.sep}out`), `${rel} 落到了 server/ 里`);
  }
});

test("数据目录默认在 ROOT/data 下（未被 STUDIO_DATA_ROOT 覆盖时）", () => {
  if (process.env.STUDIO_DATA_ROOT) {
    console.log("        （设了 STUDIO_DATA_ROOT，跳过默认路径断言）");
    return;
  }
  assert.equal(DATA_ROOT, path.join(ROOT_FROM_SHARED, "data"));
  assert.equal(PROJECTS_ROOT, path.join(ROOT_FROM_SHARED, "data", "projects"));
});

console.log(failed === 0 ? "\n路径底座正常\n" : `\n${failed} 项不通过\n`);
process.exit(failed === 0 ? 0 : 1);
