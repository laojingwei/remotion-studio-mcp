/**
 * scene3d 场景图 DSL 的校验测试。
 *
 * 为什么值得单独测：DSL 是**给 agent 写的**。它写错的时候，唯一能救它的就是
 * 一句看得懂的报错 —— 渲染出来一片黑，它既不知道自己错在哪，也没法自我修正。
 * 所以这里测的不是"能不能渲"，而是"错的时候说不说得清"。
 */
import assert from "node:assert/strict";
import { normalizeProps } from "../shared/sceneMetas";
import { dslIssues } from "../shared/scene3dDsl";

let passed = 0;
const failures: string[] = [];

const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${(err as Error).message.split("\n")[0]}`);
  }
};

/** 一个最小可用场景图，各用例在它上面做破坏 */
const okGraph = () => ({
  nodes: [
    { id: "a", geometry: { type: "sphere" }, material: { color: "primary" } },
    { id: "b", parent: "a", geometry: { type: "box" }, transform: { position: [1, 0, 0] } },
  ],
});

const graphOf = (patch: Record<string, unknown>) => ({ nodes: [], ...patch });

/** normalizeProps 抛出来的完整报错（含 zod 的 path 与 message） */
const errOf = (graph: unknown): string => {
  try {
    normalizeProps("scene3d", { graph });
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

console.log("[scene3d dsl] 合法输入");

test("最小图能过校验，且默认值被补齐", () => {
  const p = normalizeProps("scene3d", { graph: okGraph() }) as { graph: any };
  assert.equal(p.graph.nodes.length, 2);
  assert.equal(p.graph.nodes[0].geometry.radius, 0.6, "sphere 的 radius 默认值没补上");
  assert.equal(p.graph.nodes[0].material.type, "standard", "材质 type 默认值没补上");
  assert.equal(p.graph.nodes[0].material.body, true, "body 默认值没补上");
  assert.deepEqual(p.graph.nodes[0].transform ?? {}, {}, "transform 没写就该保持不写");
});

test("给了 graph 也不影响 preset 的默认值（渲染时 graph 优先）", () => {
  const p = normalizeProps("scene3d", { graph: okGraph(), preset: "waveform" }) as {
    preset: string;
  };
  assert.equal(p.preset, "waveform");
});

console.log("[scene3d dsl] 白名单");

test("未知几何体报错里带上可选值", () => {
  const msg = errOf(graphOf({ nodes: [{ id: "a", geometry: { type: "teapot" } }] }));
  assert.ok(msg.includes("teapot") || msg.includes("Invalid discriminator"), msg);
});

test("未知材质类型被拒", () => {
  const msg = errOf(
    graphOf({ nodes: [{ id: "a", geometry: { type: "sphere" }, material: { type: "glass" } }] }),
  );
  assert.ok(/glass|Invalid enum/.test(msg), msg);
});

test("分段数越界被拒", () => {
  const msg = errOf(graphOf({ nodes: [{ id: "a", geometry: { type: "sphere", segments: 500 } }] }));
  assert.ok(msg.length > 0, "500 段应该被挡下");
});

test("节点数超过 48 被拒", () => {
  const nodes = Array.from({ length: 49 }, (_, i) => ({ id: `n${i}`, geometry: { type: "box" } }));
  assert.ok(errOf(graphOf({ nodes })).length > 0);
});

console.log("[scene3d dsl] 结构问题");

test("id 重复被拦下", () => {
  const issues = dslIssues({
    nodes: [
      { id: "dup", geometry: { type: "box" } },
      { id: "dup", geometry: { type: "box" } },
    ],
  } as never);
  assert.ok(issues.some((m) => m.includes("id 重复")), issues.join());
  assert.ok(errOf({ nodes: [
    { id: "dup", geometry: { type: "box" } },
    { id: "dup", geometry: { type: "box" } },
  ] }).includes("id 重复"), "normalizeProps 没把结构问题抛出来");
});

test("parent 指向不存在的节点，报错里列出可用 id", () => {
  const msg = errOf(
    graphOf({
      nodes: [
        { id: "a", geometry: { type: "box" } },
        { id: "b", parent: "nope", geometry: { type: "box" } },
      ],
    }),
  );
  assert.ok(msg.includes("nope"), msg);
  assert.ok(msg.includes("a"), "报错没有把可用 id 列出来，agent 只能靠猜");
});

test("parent 成环被拦下（否则递归渲染会爆栈）", () => {
  const msg = errOf(
    graphOf({
      nodes: [
        { id: "a", parent: "b", geometry: { type: "box" } },
        { id: "b", parent: "a", geometry: { type: "box" } },
      ],
    }),
  );
  assert.ok(msg.includes("成环"), msg);
});

test("关键帧只有 from 没有 to 会被点名（静默失败最坑）", () => {
  const msg = errOf(
    graphOf({
      nodes: [
        {
          id: "a",
          geometry: { type: "box" },
          anim: [{ at: [0, 60], from: { rotY: 0 } }],
        },
      ],
    }),
  );
  assert.ok(msg.includes("没有 to"), msg);
});

test("关键帧 at 写反了会被点名", () => {
  const msg = errOf(
    graphOf({
      nodes: [
        {
          id: "a",
          geometry: { type: "box" },
          anim: [{ at: [60, 0], to: { rotY: 90 } }],
        },
      ],
    }),
  );
  assert.ok(msg.includes("end 小于 start"), msg);
});

/* ────────────────────────────── 光源 ────────────────────────────── */

test("lights 不写时整个字段为空，不会凭空多出灯", () => {
  const p = normalizeProps("scene3d", { graph: graphOf({ nodes: [{ id: "a", geometry: { type: "box" } }] }) }) as {
    graph: { lights?: unknown[] };
  };
  assert.equal(p.graph.lights, undefined);
});

test("lights 里没写的字段用默认值补齐（agent 只写 type=point 也要能跑）", () => {
  const p = normalizeProps("scene3d", {
    graph: graphOf({ nodes: [{ id: "a", geometry: { type: "box" } }], lights: [{ type: "point" }] }),
  }) as { graph: { lights: Array<Record<string, unknown>> } };
  const l = p.graph.lights[0];
  assert.equal(l.intensity, 6);
  assert.equal(l.decay, 2);
  assert.deepEqual(l.position, [0, 0, 0]);
  assert.equal(l.color, "text");
});

test("灯超过 8 盏会被拒（不是渲不动，是不给 agent 乱堆的余地）", () => {
  const msg = errOf(
    graphOf({
      nodes: [{ id: "a", geometry: { type: "box" } }],
      lights: Array.from({ length: 9 }, () => ({ type: "point" })),
    }),
  );
  assert.ok(msg.length > 0, "应当报错");
});

test("灯的 type 写错时把可选值列出来", () => {
  const msg = errOf(
    graphOf({
      nodes: [{ id: "a", geometry: { type: "box" } }],
      lights: [{ type: "sunlight" }],
    }),
  );
  assert.ok(msg.includes("ambient") && msg.includes("point"), msg);
});

console.log("");
if (failures.length) {
  console.log(`✗ ${failures.length} 个用例失败：${failures.join("、")}`);
  process.exit(1);
}
console.log(`全部通过：${passed} 个用例`);
