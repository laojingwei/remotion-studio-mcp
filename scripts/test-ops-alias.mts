/**
 * 批内 id 引用（as / @别名）单测 —— 纯函数，不需要浏览器、不需要起服务。
 *
 *   tsx scripts/test-ops-alias.mts
 *
 * 为什么值得单测：
 * 这是"220 次写入压到 60 次"的结构性前提。以前 add_scene/add_element 的 id 是随机的、
 * 同一批里引用不了，于是只能「建 → 读回 id → 再改」，每多一轮就多一次完整往返。
 * 别名如果解析错了，改的会是**别的元素**——静默改错比报错危险得多。
 */
import assert from "node:assert/strict";
import { applyOps, createSeedProject, type Op } from "../shared/ops";
import type { Project } from "../shared/schema";

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

/** 带别名的 op 类型：`as` 是批内别名，不落库 */
type AliasedOp = Op & { as?: string };
const seed = (): Project => createSeedProject("t_alias");
const run = (p: Project, ops: AliasedOp[]) => applyOps(p, ops as Op[]);

console.log("[as / @别名] 批内引用");

test("建幕 + 往里加元素 + 改它：一批搞定，别名表回真实 id", () => {
  const p = seed();
  const res = run(p, [
    { op: "add_scene", type: "freeform", as: "s1" },
    {
      op: "add_freeform_element",
      sceneId: "@s1",
      as: "e1",
      element: { type: "text", text: "标题", x: 50, y: 30, size: 6 },
    } as AliasedOp,
    { op: "update_freeform_element", sceneId: "@s1", elementId: "@e1", patch: { opacity: 0.5 } },
  ]);

  assert.equal(res.createdIds.s1?.startsWith("scene_"), true, JSON.stringify(res.createdIds));
  // freeform 元素的 id 是短的（如 f1/f2），叠加层才是 el_ 前缀 —— 只要求"是个真实 id"
  assert.equal(!!res.createdIds.e1 && !res.createdIds.e1.startsWith("@"), true, JSON.stringify(res.createdIds));

  const scene = res.project.scenes.find((s) => s.id === res.createdIds.s1)!;
  assert.ok(scene, "别名指向的场景应该真的存在");
  // freeform 的元素在 props.elements 里
  const el = ((scene.props as { elements?: { id: string; opacity?: number }[] }).elements ?? []).find(
    (e) => e.id === res.createdIds.e1,
  )!;
  assert.ok(el, "别名指向的元素应该真的在这个场景里");
  assert.equal(el.opacity, 0.5, "改的必须是刚建的那个元素");
});

test("整批仍然只有 1 个 rev（原子性没被破坏）", () => {
  const p = seed();
  const res = run(p, [
    { op: "add_scene", type: "freeform", as: "a" },
    { op: "add_scene", type: "freeform", as: "b" },
    { op: "add_freeform_element", sceneId: "@a", element: { type: "text", text: "A", x: 50, y: 50 } } as AliasedOp,
    { op: "add_freeform_element", sceneId: "@b", element: { type: "text", text: "B", x: 50, y: 50 } } as AliasedOp,
  ]);
  assert.equal(res.project.rev, p.rev + 1);
  const texts = (id: string) =>
    ((res.project.scenes.find((s) => s.id === id)!.props as { elements?: { text?: string }[] }).elements ?? []).map(
      (e) => e.text,
    );
  assert.ok(texts(res.createdIds.a).includes("A"), JSON.stringify(texts(res.createdIds.a)));
  assert.ok(texts(res.createdIds.b).includes("B"), JSON.stringify(texts(res.createdIds.b)));
});

test("别名只在同一批内有效（跨批引用必须报错，而不是碰巧改到别的东西）", () => {
  const p = seed();
  const res = run(p, [
    { op: "add_scene", type: "freeform", as: "sx" },
    { op: "add_freeform_element", sceneId: "@sx", element: { type: "text", text: "x", x: 50, y: 50 } },
  ]);
  assert.throws(
    () =>
      applyOps(res.project, [
        { op: "update_scene", sceneId: "@sx", patch: { name: "改不到" } } as Op,
      ]),
    /未定义的别名 @sx/,
  );
});

test("非 id 字段里的 @ 一律不动（回归：音频 src「@remotion-studio」曾被当成别名）", () => {
  const p = seed();
  const res = run(p, [
    { op: "add_scene", type: "freeform", as: "sa" },
    {
      op: "add_element",
      sceneId: "@sa",
      element: { kind: "audio", src: "@remotion-studio", name: "旁白" },
    } as AliasedOp,
  ]);
  const sc = res.project.scenes.find((s) => s.id === res.createdIds.sa)!;
  const src = ((sc.elements ?? []) as { src?: string }[]).map((e) => e.src);
  assert.ok(src.includes("@remotion-studio"), `src 不该被解析成 id：${JSON.stringify(src)}`);
});

test("正文里的 @ 不受影响（只有整串才是引用）", () => {
  const p = seed();
  const res = run(p, [
    { op: "add_scene", type: "freeform", as: "s2" },
    {
      op: "add_freeform_element",
      sceneId: "@s2",
      element: { type: "text", text: "@某某品牌 官方账号", x: 50, y: 50 },
    } as AliasedOp,
  ]);
  const sc = res.project.scenes.find((s) => s.id === res.createdIds.s2)!;
  const texts = ((sc.props as { elements?: { text?: string }[] }).elements ?? []).map((e) => e.text);
  assert.ok(texts.includes("@某某品牌 官方账号"), `正文不该被当成引用替换掉：${JSON.stringify(texts)}`);
});

test("引用未定义的别名 → 明确报错（不静默改成空）", () => {
  const p = seed();
  assert.throws(
    () => run(p, [{ op: "add_element", sceneId: "@nope", element: { kind: "text", text: "x" } } as AliasedOp]),
    /未定义的别名 @nope/,
  );
});

test("顺序颠倒（先引用后创建）→ 报错，而不是碰运气", () => {
  const p = seed();
  assert.throws(
    () =>
      run(p, [
        { op: "add_element", sceneId: "@late", element: { kind: "text", text: "x" } } as AliasedOp,
        { op: "add_scene", type: "freeform", as: "late" },
      ]),
    /未定义的别名 @late/,
  );
});

test("as 用在非创建类 op 上 → 明确报错", () => {
  const p = seed();
  const first = p.scenes[0].id;
  assert.throws(
    () => run(p, [{ op: "update_scene", sceneId: first, as: "x", patch: {} } as AliasedOp]),
    /不是创建类操作/,
  );
});

test("同一批里别名重复定义 → 报错", () => {
  const p = seed();
  assert.throws(
    () =>
      run(p, [
        { op: "add_scene", type: "freeform", as: "dup" },
        { op: "add_scene", type: "freeform", as: "dup" },
      ]),
    /重复定义/,
  );
});

test("duplicate_scene 也能 as（复制出来的那一幕可继续改）", () => {
  const p = seed();
  const src = p.scenes[0].id;
  const res = run(p, [
    { op: "duplicate_scene", sceneId: src, as: "copy" },
    { op: "update_scene", sceneId: "@copy", patch: { name: "复制品" } },
  ]);
  const copied = res.project.scenes.find((s) => s.id === res.createdIds.copy)!;
  assert.equal(copied.name, "复制品");
});

test("别名不落库（工程里不该出现 as 字段）", () => {
  const p = seed();
  const res = run(p, [{ op: "add_scene", type: "freeform", as: "s3" }]);
  const json = JSON.stringify(res.project);
  assert.ok(!json.includes('"as"'), "as 不该被写进工程数据");
});

console.log(failures.length ? `\n失败 ${failures.length} 项` : `\n全部通过：${passed} 个用例`);
if (failures.length) process.exit(1);
