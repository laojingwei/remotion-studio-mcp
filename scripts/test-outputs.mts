/**
 * 产物清理策略单测（纯函数，不碰 out/ 真实文件）。
 *
 *   npm test
 *
 * 关键约束：
 *  - 必须**按工程**保留，不能拿全局最新 N 个把别的工程删光
 *  - 文件名不认识的一律不删（宁可留着）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupOutputs,
  deleteOutputs,
  outDirOf,
  parseOutputPath,
  planVideoRemoval,
  projectIdOfOutput,
  projectOutDir,
  removeProjectOutputs,
  type OutputFile,
} from "../server/outputs.service";

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

const f = (name: string, mtimeMs: number): OutputFile => ({
  name,
  mtimeMs,
  size: 1000,
  projectId: projectIdOfOutput(name),
});

/* ────────────────────────── 文件名解析 ────────────────────────── */

test("projectIdOfOutput：取自第一段", () => {
  assert.equal(projectIdOfOutput("p_abc12-task_xyz-portrait.mp4"), "p_abc12");
  assert.equal(projectIdOfOutput("demo-landscape-45.png"), "demo");
  assert.equal(projectIdOfOutput("verify_1a2b-task_a-square.mp4"), "verify_1a2b");
});

test("projectIdOfOutput：没有分隔符或非法字符返回 null", () => {
  assert.equal(projectIdOfOutput("no-separator-but-this-has-one.mp4"), "no");
  assert.equal(projectIdOfOutput("中文-任务.mp4"), null);
  assert.equal(projectIdOfOutput("plainfile.mp4"), null);
});

/* ────────────────────────── 保留策略 ────────────────────────── */

test("每个工程各保留最新 N 个，互不影响", () => {
  const files = [
    f("p_a-1-portrait.mp4", 100), // 旧，删
    f("p_a-2-portrait.mp4", 300), // 新，留
    f("p_a-3-portrait.mp4", 200), // 中，删（keep=1）
    f("p_b-1-portrait.mp4", 50), // keep=1 时保留
    f("p_b-2-portrait.mp4", 40), // 删
  ];
  const doomed = planVideoRemoval(files, 1).map((x) => x.name).sort();
  assert.deepEqual(doomed, ["p_a-1-portrait.mp4", "p_a-3-portrait.mp4", "p_b-2-portrait.mp4"]);
});

test("keep=2 时每工程各留两个", () => {
  const files = [
    f("p_a-1.mp4", 1),
    f("p_a-2.mp4", 2),
    f("p_a-3.mp4", 3),
    f("p_b-1.mp4", 1),
    f("p_b-2.mp4", 2),
    f("p_b-3.mp4", 3),
  ];
  const doomed = planVideoRemoval(files, 2).map((x) => x.name).sort();
  assert.deepEqual(doomed, ["p_a-1.mp4", "p_b-1.mp4"]);
});

test("认不出工程名的文件永远不删", () => {
  const files = [f("readme.txt", 1), f("中文-任务.mp4", 2), f("p_a-1.mp4", 3)];
  const doomed = planVideoRemoval(files, 1);
  assert.equal(doomed.length, 0);
});

test("keep 传 0 或负数时按 1 处理（不能一次删光）", () => {
  const files = [f("p_a-1.mp4", 1), f("p_a-2.mp4", 2)];
  assert.equal(planVideoRemoval(files, 0).length, 1);
  assert.equal(planVideoRemoval(files, -5).length, 1);
});

test("保留的是最新的那些（按 mtime 而不是文件名）", () => {
  const files = [f("p_a-old.mp4", 999), f("p_a-new.mp4", 1000)];
  const doomed = planVideoRemoval(files, 1).map((x) => x.name);
  assert.deepEqual(doomed, ["p_a-old.mp4"]);
});

/* ────────────────────────── 按工程分目录 ────────────────────────── */

const RID = Math.random().toString(36).slice(2, 8);
const FAKE = `p_testout_${RID}`;

test("parseOutputPath：只认 projects/<id>/<类>/<文件>", () => {
  assert.deepEqual(parseOutputPath(`projects/${FAKE}/videos/a.mp4`), {
    projectId: FAKE,
    kind: "video",
    file: "a.mp4",
  });
  assert.equal(parseOutputPath(`projects/${FAKE}/stills/p-0.png`)?.kind, "still");
  assert.equal(parseOutputPath(`projects/${FAKE}/subtitles/s.srt`)?.kind, "subtitle");
});

test("parseOutputPath：挡住穿越与旧扁平路径", () => {
  assert.equal(parseOutputPath(`videos/a.mp4`), null);
  assert.equal(parseOutputPath(`projects/${FAKE}/a.mp4`), null);
  assert.equal(parseOutputPath(`projects/../videos/a.mp4`), null);
  assert.equal(parseOutputPath(`projects/${FAKE}/videos/../../x.mp4`), null);
  assert.equal(parseOutputPath(`projects/${FAKE}/videos/.hidden.mp4`), null);
  assert.equal(parseOutputPath(`projects/${FAKE}/other/a.mp4`), null);
  assert.equal(parseOutputPath(`projects/${FAKE}/videos/a/b.mp4`), null);
});

test("parseOutputPath：中文成片名能删（工程名进文件名是常态）", () => {
  const rel = `projects/${FAKE}/videos/未命名项目_2026-10-28_23-01-01_landscape__${FAKE}.mp4`;
  assert.deepEqual(parseOutputPath(rel), {
    projectId: FAKE,
    kind: "video",
    file: `未命名项目_2026-10-28_23-01-01_landscape__${FAKE}.mp4`,
  });
  assert.equal(parseOutputPath(`projects/${FAKE}/videos/..`), null);
  assert.equal(parseOutputPath(`projects/${FAKE}/videos/a b.mp4`)?.file, "a b.mp4");
});

test("projectOutDir：非法 id 直接报错（不能拼出 out 之外的路径）", () => {
  assert.throws(() => projectOutDir("../etc"));
  assert.throws(() => projectOutDir("a/b"));
  assert.ok(projectOutDir(FAKE).endsWith(path.join("out", "projects", FAKE)));
});

test("删除：按相对路径删文件，删完收掉空目录", () => {
  const dir = outDirOf(FAKE, "video");
  fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, "a.mp4");
  const b = path.join(dir, "b.mp4");
  fs.writeFileSync(a, Buffer.alloc(10));
  fs.writeFileSync(b, Buffer.alloc(20));

  const r = deleteOutputs([`projects/${FAKE}/videos/a.mp4`, `projects/${FAKE}/videos/../x.mp4`]);
  assert.equal(r.deleted, 1);
  assert.equal(r.missing, 1, "非法路径只算 missing，不报错也不删");
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), true);

  const rest = removeProjectOutputs(FAKE);
  assert.equal(rest.removed, 1);
  assert.equal(fs.existsSync(projectOutDir(FAKE)), false, "整个工程产物目录要收掉");
});

test("清理：工程已删的产物目录算孤儿，dryRun 只报不动手", () => {
  const dir = outDirOf(FAKE, "video");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.mp4"), Buffer.alloc(10));
  fs.writeFileSync(path.join(dir, "b.mp4"), Buffer.alloc(10));

  const dry = cleanupOutputs({ onlyProjectIds: [FAKE], dryRun: true });
  assert.equal(dry.removedOrphanDirs, 1);
  assert.equal(dry.removedFiles, 2);
  assert.equal(fs.existsSync(projectOutDir(FAKE)), true, "dryRun 不能真删");

  const real = cleanupOutputs({ onlyProjectIds: [FAKE] });
  assert.equal(real.removedFiles, 2);
  assert.equal(fs.existsSync(projectOutDir(FAKE)), false);
});

/* ────────────────────────── 汇总 ────────────────────────── */

console.log("");
if (failures.length) {
  console.error(`${failures.length} 个用例失败（通过 ${passed} 个）`);
  for (const f2 of failures) console.error(`  - ${f2}`);
  process.exit(1);
}
console.log(`全部通过：${passed} 个用例`);
