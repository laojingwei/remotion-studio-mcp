/**
 * 时间码批注的回归：增 / 读 / 标已修 / 删 / 边界。
 *
 *   npx tsx scripts/test-annotations.mts
 *
 * 为什么值得单测：批注是「用户说哪一帧不对」的唯一精确载体。它错一位，
 * agent 就会照着错的帧去改，比没有批注更糟。重点保三件事：
 *  1. 幕内帧原样存原样读（不能四舍五入到别处）
 *  2. resolved 只是标记，不删数据（用户可能反悔「还没改好」）
 *  3. 工程 id 不能穿越路径（`../` 之类不许写到 data/projects 外面）
 *
 * 用临时数据根（STUDIO_DATA_ROOT）跑，不碰真实工程：paths.ts 在 import 时读这个变量，
 * 所以必须先设环境变量再动态 import 服务模块。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rms-anno-"));
process.env.STUDIO_DATA_ROOT = tmpRoot;
const projectId = "probe_anno";
fs.mkdirSync(path.join(tmpRoot, "projects", projectId), { recursive: true });

const { addAnnotation, deleteAnnotation, listAnnotations, openAnnotationCount, resolveAnnotations } =
  await import("../server/annotation.service");

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
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
  }
};

console.log("\n时间码批注\n");

test("新增一条：幕内帧原样保存，默认未解决", () => {
  const a = addAnnotation(projectId, { sceneId: "scene_a", frameInScene: 37, text: "转场太硬" });
  assert.equal(a.frameInScene, 37);
  assert.equal(a.sceneId, "scene_a");
  assert.equal(a.resolved, false);
  assert.match(a.id, /^an_/);

  const all = listAnnotations(projectId);
  assert.equal(all.length, 1);
  assert.equal(all[0].text, "转场太硬");
  assert.equal(openAnnotationCount(projectId), 1);
});

test("两条都读回来，顺序稳定（按写入顺序）", () => {
  addAnnotation(projectId, { sceneId: "scene_b", frameInScene: 5, text: "字幕读不完" });
  const all = listAnnotations(projectId);
  assert.deepEqual(
    all.map((a) => a.sceneId),
    ["scene_a", "scene_b"],
  );
  assert.equal(openAnnotationCount(projectId), 2);
});

test("frameInScene 取整且不接受负数", () => {
  const a = addAnnotation(projectId, { sceneId: "scene_a", frameInScene: -9, text: "边界" });
  assert.equal(a.frameInScene, 0);
  const b = addAnnotation(projectId, { sceneId: "scene_a", frameInScene: 12.6, text: "取整" });
  assert.equal(b.frameInScene, 13);
});

test("空文本 / 缺 sceneId 直接拒（不要让空批注混进列表）", () => {
  assert.throws(() => addAnnotation(projectId, { sceneId: "scene_a", frameInScene: 1, text: "   " }));
  assert.throws(() => addAnnotation(projectId, { sceneId: "", frameInScene: 1, text: "x" }));
});

test("标已修：只改标记，条目还在（用户可能反悔）", () => {
  const target = listAnnotations(projectId).find((a) => a.text === "转场太硬")!;
  const r = resolveAnnotations(projectId, [target.id], true);
  assert.equal(r.changed, 1);
  assert.equal(r.remaining, openAnnotationCount(projectId));

  const after = listAnnotations(projectId).find((a) => a.id === target.id)!;
  assert.equal(after.resolved, true);
  assert.ok(after.resolvedAt);
  // 总数没变（列表是重新读盘的，不是同一个对象，只能比 id）
  assert.equal(listAnnotations(projectId).filter((a) => a.id === after.id).length, 1);
});

test("恢复未解决：resolvedAt 要清掉，不能留个假时间", () => {
  const target = listAnnotations(projectId).find((a) => a.text === "转场太硬")!;
  resolveAnnotations(projectId, [target.id], false);
  const after = listAnnotations(projectId).find((a) => a.id === target.id)!;
  assert.equal(after.resolved, false);
  assert.equal(after.resolvedAt, undefined);
});

test("标不存在的 id：changed=0，不报错不改数据", () => {
  const before = listAnnotations(projectId).length;
  const r = resolveAnnotations(projectId, ["an_notexist"], true);
  assert.equal(r.changed, 0);
  assert.equal(listAnnotations(projectId).length, before);
});

test("删除：命中返回 true，二次删返回 false", () => {
  const victim = listAnnotations(projectId)[0];
  assert.equal(deleteAnnotation(projectId, victim.id), true);
  assert.equal(deleteAnnotation(projectId, victim.id), false);
  assert.equal(
    listAnnotations(projectId).some((a) => a.id === victim.id),
    false,
  );
});

test("工程 id 不能穿越路径", () => {
  assert.throws(() => listAnnotations("../../etc"));
  assert.throws(() => addAnnotation("a/b", { sceneId: "s", frameInScene: 0, text: "x" }));
});

test("没有批注文件的工程：返回空数组，不抛错", () => {
  assert.deepEqual(listAnnotations("probe_empty_project"), []);
  assert.equal(openAnnotationCount("probe_empty_project"), 0);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log("");
if (failures.length) {
  console.error(`✗ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`✓ 批注全部通过（${passed} 项）`);
