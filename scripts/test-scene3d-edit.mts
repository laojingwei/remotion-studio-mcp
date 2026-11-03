/**
 * scene3d 场景图**局部写回**的测试（update_graph_node 一族）。
 *
 * 为什么单独一组：这批 op 是「人和 agent 同时改同一幕」的接口。
 * 它们的失败方式不是报错，而是**画面看起来对、其实改错了地方**——
 * 换父级后行星飞出轨道、改半径把分段数重置、关键帧把拖动结果吃掉。
 * 所以这里测三件事：合并语义、世界变换守恒、错误必须说人话。
 */
import assert from "node:assert/strict";
import { applyOps, createSeedProject, type Op } from "../shared/ops";
import type { Project } from "../shared/schema";
import { composeTrs, decomposeTrs, invert, multiply, trsOfNode } from "../shared/scene3dTransform";

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
    console.log(`         ${(err as Error).message.split("\n").slice(0, 3).join("\n         ")}`);
  }
};

type Graph = { nodes: Record<string, any>[]; camera?: any; lights?: any[]; particles?: any; post?: any };

/** 建一个带 graph 的 scene3d 场景 */
const withGraph = (graph: Graph): { project: Project; sceneId: string } => {
  const project = applyOps(createSeedProject("t_edit"), [
    { op: "add_scene", type: "scene3d", props: { graph } } as Op,
  ]).project;
  return { project, sceneId: project.scenes[project.scenes.length - 1].id };
};

const twoBalls = (): Graph => ({
  nodes: [
    { id: "sun", label: "太阳", geometry: { type: "sphere", radius: 2 }, material: { color: "#FFD27A" } },
    {
      id: "earth",
      label: "地球",
      parent: "sun",
      geometry: { type: "sphere", radius: 0.4, segments: 24 },
      transform: { position: [3, 0, 0] },
    },
  ],
});

const run = (project: Project, op: Op) => applyOps(project, [op]);
const sceneOf = (p: Project, id: string) => p.scenes.find((s) => s.id === id)!;
const graphOf = (p: Project, id: string) => (sceneOf(p, id).props as { graph?: Graph }).graph!;
const nodeOf = (p: Project, id: string, nodeId: string) =>
  graphOf(p, id).nodes.find((n) => n.id === nodeId)!;

const errOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

/* ────────────────────────── 变换数学 ────────────────────────── */

console.log("[scene3d edit] 变换数学（换父级靠它，错一点行星就飞）");

test("compose → decompose → compose 自洽（含旋转 + 非等比缩放）", () => {
  const trs = {
    position: [1.5, -2, 3] as [number, number, number],
    rotation: [23.5, 47, -12] as [number, number, number],
    scale: [1.5, 0.5, 2.25] as [number, number, number],
  };
  const again = decomposeTrs(composeTrs(trs));
  assert.ok(Math.abs(again.position[0] - 1.5) < 1e-9);
  assert.ok(Math.abs(again.position[1] + 2) < 1e-9);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(again.rotation[i] - trs.rotation[i]) < 1e-6, `rot${i}`);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(again.scale[i] - trs.scale[i]) < 1e-9, `scale${i}`);
});

test("矩阵求逆：M · M⁻¹ = I", () => {
  const m = composeTrs({
    position: [2, 3, -4],
    rotation: [10, 20, 30],
    scale: [2, 2, 2],
  });
  const p = multiply(m, invert(m));
  for (let i = 0; i < 16; i++) {
    const expect = i % 5 === 0 ? 1 : 0;
    assert.ok(Math.abs(p[i] - expect) < 1e-9, `第 ${i} 项 ${p[i]}`);
  }
});

test("trsOfNode：scaleXYZ 优先于 scale（和渲染层同一个规则）", () => {
  const a = trsOfNode({ transform: { scale: 3, scaleXYZ: [1, 2, 3] } });
  assert.deepEqual(a.scale, [1, 2, 3]);
  const b = trsOfNode({ transform: { scale: 3 } });
  assert.deepEqual(b.scale, [3, 3, 3]);
});

/* ────────────────────────── update_graph_node ────────────────────────── */

console.log("\n[scene3d edit] update_graph_node");

test("改半径：同 type 深合并，segments 不会被重置", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const { project: after } = run(project, {
    op: "update_graph_node",
    sceneId,
    nodeId: "earth",
    patch: { geometry: { radius: 0.8 } },
  } as Op);
  const g = nodeOf(after, sceneId, "earth").geometry;
  assert.equal(g.radius, 0.8);
  assert.equal(g.segments, 24, "segments 被重置说明走成了整表替换");
});

test("换形状：整份替换（旧形状的参数不该带到新形状里）", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const { project: after } = run(project, {
    op: "update_graph_node",
    sceneId,
    nodeId: "earth",
    patch: { geometry: { type: "box", width: 2 } },
  } as Op);
  const g = nodeOf(after, sceneId, "earth").geometry;
  assert.equal(g.type, "box");
  assert.equal(g.width, 2);
  assert.equal(g.radius, undefined);
  assert.equal(g.height, 1, "没给的高度应取 schema 默认值");
});

test("材质深合并：改颜色不动金属度；map:null 清掉贴图", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const a = run(project, {
    op: "update_graph_node",
    sceneId,
    nodeId: "sun",
    patch: { material: { metalness: 0.9, map: { src: "/assets/x.png" } } },
  } as Op).project;
  const m1 = nodeOf(a, sceneId, "sun").material;
  assert.equal(m1.metalness, 0.9);
  assert.equal(m1.color, "#FFD27A", "颜色被覆盖说明是整表替换");
  const b = run(a, {
    op: "update_graph_node",
    sceneId,
    nodeId: "sun",
    patch: { material: { map: null } },
  } as Op).project;
  assert.equal(nodeOf(b, sceneId, "sun").material.map, undefined);
  assert.equal(nodeOf(b, sceneId, "sun").material.metalness, 0.9);
});

test("变换深合并：position 整个替换，rotation 保留", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const a = run(project, {
    op: "update_graph_node",
    sceneId,
    nodeId: "earth",
    patch: { transform: { rotation: [0, 45, 0] } },
  } as Op).project;
  const b = run(a, {
    op: "update_graph_node",
    sceneId,
    nodeId: "earth",
    patch: { transform: { position: [5, 0, 0] } },
  } as Op).project;
  const t = nodeOf(b, sceneId, "earth").transform;
  assert.deepEqual(t.position, [5, 0, 0]);
  assert.deepEqual(t.rotation, [0, 45, 0]);
});

test("label / hidden / locked：设置与清空", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const a = run(project, {
    op: "update_graph_node",
    sceneId,
    nodeId: "earth",
    patch: { label: "  地球 ", hidden: true, locked: true },
  } as Op).project;
  const n = nodeOf(a, sceneId, "earth");
  assert.equal(n.label, "地球", "label 要 trim");
  assert.equal(n.hidden, true);
  assert.equal(n.locked, true);
  const b = run(a, {
    op: "update_graph_node",
    sceneId,
    nodeId: "earth",
    patch: { label: null, hidden: false },
  } as Op).project;
  const n2 = nodeOf(b, sceneId, "earth");
  assert.equal(n2.label, undefined);
  assert.equal(n2.hidden, undefined, "false 应该删键而不是留一个 false");
});

test("有 anim 的节点改基础变换：回执必须警告「动画会覆盖」", () => {
  const { project, sceneId } = withGraph({
    nodes: [
      {
        id: "earth",
        geometry: { type: "sphere" },
        anim: [{ at: [0, 60], to: { posX: 5 } }],
      },
    ],
  });
  const res = run(project, {
    op: "update_graph_node",
    sceneId,
    nodeId: "earth",
    patch: { transform: { position: [1, 0, 0] } },
  } as Op);
  assert.ok(
    res.summary.some((s) => s.includes("关键帧覆盖")),
    `回执没提关键帧：${res.summary.join(" | ")}`,
  );
});

test("不认识的 patch 字段直接拒（不静默忽略）", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const msg = errOf(() =>
    run(project, { op: "update_graph_node", sceneId, nodeId: "earth", patch: { color: "red" } } as Op),
  );
  assert.match(msg, /不认识的字段.*color/);
});

test("节点不存在：报错里要列出可用 id", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const msg = errOf(() =>
    run(project, { op: "update_graph_node", sceneId, nodeId: "mars", patch: { label: "火星" } } as Op),
  );
  assert.match(msg, /没有节点「mars」/);
  assert.match(msg, /sun、earth/);
});

test("非法取值不写入：原工程对象保持原样（纯函数 + 不留半成品）", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const msg = errOf(() =>
    run(project, {
      op: "update_graph_node",
      sceneId,
      nodeId: "earth",
      patch: { geometry: { radius: -1 } },
    } as Op),
  );
  assert.match(msg, /不合法|超出范围/);
  assert.equal(
    (project.scenes.find((s) => s.id === sceneId)!.props as { graph: Graph }).graph.nodes[1].geometry.radius,
    0.4,
  );
});

test("没 graph 的场景：报错要教怎么才有 graph", () => {
  const project = applyOps(createSeedProject("t_edit"), [{ op: "add_scene", type: "scene3d" } as Op]).project;
  const sceneId = project.scenes[project.scenes.length - 1].id;
  const msg = errOf(() => run(project, { op: "set_graph_post", sceneId, post: { bloom: 2 } } as Op));
  assert.match(msg, /预置场景/);
  assert.match(msg, /get_guide\("scene3d"\)/);
});

/* ────────────────────────── 增删 / 换父级 ────────────────────────── */

console.log("\n[scene3d edit] 增删 / 换父级");

test("add_graph_node：自动起名 n1/n2，之后追加在末尾", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const a = run(project, { op: "add_graph_node", sceneId, node: { geometry: { type: "torus" } } } as Op).project;
  const b = run(a, { op: "add_graph_node", sceneId, node: { geometry: { type: "ring" } } } as Op).project;
  const ids = graphOf(b, sceneId).nodes.map((n) => n.id);
  assert.deepEqual(ids, ["sun", "earth", "n1", "n2"]);
});

test("add_graph_node：afterId 决定插入位置与大纲顺序", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const a = run(project, {
    op: "add_graph_node",
    sceneId,
    node: { id: "moon", geometry: { type: "sphere" }, parent: "earth" },
    afterId: "earth",
  } as Op).project;
  assert.deepEqual(graphOf(a, sceneId).nodes.map((n) => n.id), ["sun", "earth", "moon"]);
  assert.equal(nodeOf(a, sceneId, "moon").parent, "earth");
});

test("add_graph_node：重名 / 父级不存在 / 未知字段都要拒", () => {
  const { project, sceneId } = withGraph(twoBalls());
  assert.match(
    errOf(() => run(project, { op: "add_graph_node", sceneId, node: { id: "sun", geometry: { type: "box" } } } as Op)),
    /已存在/,
  );
  assert.match(
    errOf(() =>
      run(project, { op: "add_graph_node", sceneId, node: { geometry: { type: "box" }, parent: "mars" } } as Op),
    ),
    /parent「mars」不存在/,
  );
  assert.match(
    errOf(() =>
      run(project, { op: "add_graph_node", sceneId, node: { geometry: { type: "box" }, colour: "red" } } as Op),
    ),
    /不认识的字段.*colour/,
  );
});

test("remove_graph_node：默认删父带子", () => {
  const { project, sceneId } = withGraph({
    nodes: [
      { id: "a", geometry: { type: "sphere" } },
      { id: "b", parent: "a", geometry: { type: "box" } },
      { id: "c", parent: "b", geometry: { type: "box" } },
      { id: "d", geometry: { type: "box" } },
    ],
  });
  const after = run(project, { op: "remove_graph_node", sceneId, nodeId: "a" } as Op).project;
  assert.deepEqual(graphOf(after, sceneId).nodes.map((n) => n.id), ["d"]);
});

test("remove_graph_node：withChildren:false 遇到子节点要拒（子节点会被甩到错误位置）", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const msg = errOf(() =>
    run(project, { op: "remove_graph_node", sceneId, nodeId: "sun", withChildren: false } as Op),
  );
  assert.match(msg, /还有 1 个子节点/);
  assert.match(msg, /withChildren:true/);
});

test("remove_graph_node：不能删到 0 个", () => {
  const { project, sceneId } = withGraph({ nodes: [{ id: "only", geometry: { type: "sphere" } }] });
  assert.match(
    errOf(() => run(project, { op: "remove_graph_node", sceneId, nodeId: "only" } as Op)),
    /至少要留一个节点/,
  );
});

test("换父级：世界位置不变（父级带平移 + 缩放）", () => {
  const { project, sceneId } = withGraph({
    nodes: [
      { id: "pivot", geometry: { type: "sphere" }, transform: { position: [2, 0, 0], scale: 2 } },
      { id: "kid", parent: "pivot", geometry: { type: "sphere" }, transform: { position: [1, 0, 0] } },
    ],
  });
  // 世界位置 = 2 + 2×1 = 4
  const after = run(project, { op: "update_graph_node", sceneId, nodeId: "kid", patch: { parent: null } } as Op)
    .project;
  const t = nodeOf(after, sceneId, "kid").transform;
  assert.ok(Math.abs(t.position[0] - 4) < 1e-6, `期望 x=4，实际 ${t.position[0]}`);
  assert.ok(Math.abs(t.scale - 2) < 1e-6, `期望整体缩放 2，实际 ${t.scale}`);
  assert.equal(nodeOf(after, sceneId, "kid").parent, undefined);
});

test("换父级：父级带旋转时位置也不跳", () => {
  const { project, sceneId } = withGraph({
    nodes: [
      { id: "pivot", geometry: { type: "sphere" }, transform: { rotation: [0, 90, 0] } },
      { id: "kid", parent: "pivot", geometry: { type: "sphere" }, transform: { position: [1, 0, 0] } },
    ],
  });
  // 绕 Y 转 90°：世界位置 = (0, 0, -1)
  const after = run(project, { op: "update_graph_node", sceneId, nodeId: "kid", patch: { parent: null } } as Op)
    .project;
  const p = nodeOf(after, sceneId, "kid").transform.position;
  assert.ok(Math.abs(p[0]) < 1e-6, `x 应为 0，实际 ${p[0]}`);
  assert.ok(Math.abs(p[2] + 1) < 1e-6, `z 应为 -1，实际 ${p[2]}`);
});

test("换父级：挂到自己的子孙下面要拒（成环）", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const msg = errOf(() =>
    run(project, { op: "update_graph_node", sceneId, nodeId: "sun", patch: { parent: "earth" } } as Op),
  );
  assert.match(msg, /成环/);
});

/* ────────────────────────── 场景级 ────────────────────────── */

console.log("\n[scene3d edit] 相机 / 灯光 / 粒子 / 后期");

test("set_graph_camera：局部合并，null 交还自动取景", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const a = run(project, { op: "set_graph_camera", sceneId, camera: { fov: 55 } } as Op).project;
  const cam = graphOf(a, sceneId).camera;
  assert.equal(cam.fov, 55);
  assert.ok(Array.isArray(cam.position), "没给 position 应落默认值");
  const b = run(a, { op: "set_graph_camera", sceneId, camera: { position: [0, 2, 9] } } as Op).project;
  assert.deepEqual(graphOf(b, sceneId).camera.position, [0, 2, 9]);
  assert.equal(graphOf(b, sceneId).camera.fov, 55);
  const c = run(b, { op: "set_graph_camera", sceneId, camera: null } as Op).project;
  assert.equal(graphOf(c, sceneId).camera, undefined);
});

test("set_graph_lights：整组替换，上限 8 盏，null 撤销", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const a = run(project, {
    op: "set_graph_lights",
    sceneId,
    lights: [{ type: "point", position: [0, 0, 0], intensity: 20 }],
  } as Op).project;
  assert.equal(graphOf(a, sceneId).lights!.length, 1);
  assert.equal(graphOf(a, sceneId).lights![0].color, "text", "没给的颜色应落默认值");
  const nine = Array.from({ length: 9 }, () => ({ type: "point" }));
  assert.match(errOf(() => run(a, { op: "set_graph_lights", sceneId, lights: nine } as Op)), /最多 8 盏/);
  const b = run(a, { op: "set_graph_lights", sceneId, lights: null } as Op).project;
  assert.equal(graphOf(b, sceneId).lights, undefined);
});

test("set_graph_particles / set_graph_post：合并与清空", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const a = run(project, { op: "set_graph_particles", sceneId, particles: { count: 1200 } } as Op).project;
  assert.equal(graphOf(a, sceneId).particles!.count, 1200);
  assert.equal(graphOf(a, sceneId).particles!.size, 0.06, "没给的字段应落默认值");
  const b = run(a, { op: "set_graph_post", sceneId, post: { bloom: 1.6 } } as Op).project;
  assert.equal(graphOf(b, sceneId).post!.bloom, 1.6);
  const c = run(b, { op: "set_graph_particles", sceneId, particles: null } as Op).project;
  assert.equal(graphOf(c, sceneId).particles, undefined);
  const d = run(c, { op: "set_graph_post", sceneId, post: null } as Op).project;
  assert.equal(graphOf(d, sceneId).post, undefined);
});

/* ────────────────────────── 约束 ────────────────────────── */

console.log("\n[scene3d edit] 边界");

test("不在 scene3d 场景上调用：说清楚是版式不对", () => {
  const project = applyOps(createSeedProject("t_edit"), [{ op: "add_scene", type: "quote" } as Op]).project;
  const sceneId = project.scenes[project.scenes.length - 1].id;
  const msg = errOf(() => run(project, { op: "set_graph_post", sceneId, post: { bloom: 2 } } as Op));
  assert.match(msg, /是 quote 版式/);
});

test("op 字段白名单覆盖新 op（写错字段名不会被静默丢弃）", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const msg = errOf(() =>
    // @ts-expect-error 故意写错字段名
    run(project, { op: "set_graph_post", sceneId, post: { bloom: 2 }, bloom: 3 } as Op),
  );
  assert.match(msg, /有未知字段：bloom/);
});

test("多个 op 串联：加节点 + 改 + 换父级，一次落库", () => {
  const { project, sceneId } = withGraph(twoBalls());
  const after = applyOps(project, [
    { op: "add_graph_node", sceneId, node: { id: "moon", geometry: { type: "sphere", radius: 0.15 }, parent: "earth", transform: { position: [1, 0, 0] } } },
    { op: "update_graph_node", sceneId, nodeId: "moon", patch: { material: { color: "#C8C8D0" } } },
    { op: "update_graph_node", sceneId, nodeId: "moon", patch: { parent: "sun" } },
  ] as Op[]).project;
  const moon = nodeOf(after, sceneId, "moon");
  assert.equal(moon.parent, "sun");
  assert.equal(moon.material.color, "#C8C8D0");
  // 世界位置应该还在 earth 旁边：earth 局部 (3,0,0) + moon 局部 (1,0,0) = (4,0,0)
  assert.ok(Math.abs(moon.transform.position[0] - 4) < 1e-6, `实际 x=${moon.transform.position[0]}`);
});

console.log("");
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败，${passed} 项通过`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项通过`);
