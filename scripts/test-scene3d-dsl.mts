/**
 * scene3d 场景图 DSL 的校验测试。
 *
 * 为什么值得单独测：DSL 是**给 agent 写的**。它写错的时候，唯一能救它的就是
 * 一句看得懂的报错 —— 渲染出来一片黑，它既不知道自己错在哪，也没法自我修正。
 * 所以这里测的不是"能不能渲"，而是"错的时候说不说得清"。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { describeTypeDeep, normalizeProps } from "../shared/sceneMetas";
import { dslIssues } from "../shared/scene3dDsl";
import { resolveSkillName } from "../server/skills.service";

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

/* post 的三个收尾效果：默认全关，写错范围要被拒 */
{
  const oneNode = [{ id: "a", geometry: { type: "sphere" } }];
  const ok = normalizeProps("scene3d", { graph: { nodes: oneNode, post: { vignette: 0.3, chroma: 0.15, grain: 0.2 } } });
  const post = (ok.graph as { post: Record<string, number> }).post;
  assert.equal(post.vignette, 0.3);
  assert.equal(post.chroma, 0.15);
  assert.equal(post.grain, 0.2);
  const plain = normalizeProps("scene3d", { graph: { nodes: oneNode } });
  const p2 = (plain.graph as { post?: Record<string, number> }).post;
  assert.equal(p2?.vignette, undefined, "不写就该是 undefined（关）");
  assert.ok(errOf({ nodes: oneNode, post: { vignette: 1.5 } }).length > 0, "vignette 超过 1 要拒");
  assert.ok(errOf({ nodes: oneNode, post: { grain: -0.1 } }).length > 0, "负数要拒");
}

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

console.log("[scene3d dsl] 材质贴图（map）");

test("map 默认值补齐：不写 repeat/offset/rotation/center 也要能跑", () => {
  const p = normalizeProps("scene3d", {
    graph: {
      nodes: [
        { id: "a", geometry: { type: "plane" }, material: { map: { src: "/assets/x.png" } } },
      ],
    },
  }) as { graph: { nodes: Array<{ material: { map: Record<string, unknown> } }> } };
  const m = p.graph.nodes[0].material.map;
  assert.deepEqual(m.repeat, [1, 1]);
  assert.deepEqual(m.offset, [0, 0]);
  assert.equal(m.rotation, 0);
  assert.deepEqual(m.center, [0.5, 0.5]);
});

test("三种合法 src 形态都放行：/assets/、https、data:", () => {
  for (const src of ["/assets/x.png", "https://cdn.example.com/x.jpg", "data:image/png;base64,AAAA"]) {
    const p = normalizeProps("scene3d", {
      graph: {
        nodes: [{ id: "a", geometry: { type: "plane" }, material: { map: { src } } }],
      },
    }) as { graph: { nodes: Array<{ material: { map: { src: string } } }> } };
    assert.equal(p.graph.nodes[0].material.map.src, src);
  }
});

test("多面体 + map 直接报错，且文案指路 sphere+flatShading", () => {
  for (const type of ["icosahedron", "dodecahedron", "octahedron"]) {
    const msg = errOf(
      graphOf({
        nodes: [{ id: "a", geometry: { type }, material: { map: { src: "/assets/x.png" } } }],
      }),
    );
    assert.ok(msg.includes("sphere") && msg.includes("flatShading"), `${type}: ${msg}`);
  }
  // 同样的 map 放到 sphere 上必须能过——报错只拦 UV 碎的几何体，不拦贴图本身
  const p = normalizeProps("scene3d", {
    graph: {
      nodes: [{ id: "a", geometry: { type: "sphere" }, material: { map: { src: "/assets/x.png" } } }],
    },
  });
  assert.ok(p, "sphere + map 不应报错");
});

test("src 写成相对路径/越界路径时报错，并把可用形态列出来", () => {
  for (const src of ["assets/x.png", "../secret.png", "./x.png"]) {
    const msg = errOf(
      graphOf({
        nodes: [{ id: "a", geometry: { type: "plane" }, material: { map: { src } } }],
      }),
    );
    assert.ok(msg.includes("/assets/"), `${src}: ${msg}`);
  }
});

test("repeat 必须 > 0（0 和负数是「贴不出来」而不是「不平铺」，直接报错）", () => {
  const msg = errOf(
    graphOf({
      nodes: [
        {
          id: "a",
          geometry: { type: "plane" },
          material: { map: { src: "/assets/x.png", repeat: [0, 1] } },
        },
      ],
    }),
  );
  assert.ok(msg.length > 0, "repeat=0 应当报错");
});

/* ───────── 字段表与文档：agent 不读源码也能拼对 graph ───────── */

test("字段表要展开到 graph 内层（nodes/lights/geometry 变体），不能只到 object", () => {
  const t = describeTypeDeep("scene3d");
  assert.ok(t, "scene3d 应当有字段表");
  for (const token of ["- nodes array", "└ 元素形状", "· sphere:", "· dashRing:", "- lights array", "- particles object", "- post object", "parent text"]) {
    assert.ok(t.includes(token), `字段表缺少「${token}」——agent 又得去翻源码了`);
  }
});

test("有默认值的字段不能标成必填（否则 agent 会以为每个键都非给不可）", () => {
  const t = describeTypeDeep("scene3d")!;
  const preset = t.split("\n").find((l) => l.includes("- preset enum")) ?? "";
  assert.ok(!preset.includes("必填"), `preset 有默认值却被标必填：${preset}`);
  const id = t.split("\n").find((l) => l.trim().startsWith("- id text")) ?? "";
  assert.ok(id.includes("必填"), `节点 id 没默认值，应当标必填：${id}`);
});

test("指南里的示例必须过 zod：文档不能写一份跑不通的 graph", () => {
  const md = fs.readFileSync("server/skills/scene3d.md", "utf8");
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    // 只挑「完整对象」的示例（片段用来说明单个字段，不单独可解析）
    .filter((s) => s.trim().startsWith("{") && s.includes('"props"'));
  assert.ok(blocks.length >= 2, `scene3d.md 里的完整示例太少（${blocks.length}）`);
  for (const raw of blocks) {
    const doc = JSON.parse(raw);
    const p = normalizeProps(doc.type ?? "scene3d", doc.props);
    if (p.graph) assert.equal(dslIssues(p.graph).length, 0, `示例有结构问题：${dslIssues(p.graph).join(" / ")}`);
  }
});

test("get_guide 的别名要认得「3d」「iso」「太空」这些按能力猜的名字", () => {
  assert.equal(resolveSkillName("3d").name, "scene3d");
  assert.equal(resolveSkillName("3D 场景").name, "scene3d");
  assert.equal(resolveSkillName("iso").name, "external-tools");
  assert.equal(resolveSkillName("anatomy").name, "external-tools");
  const miss = resolveSkillName("太空");
  assert.ok(miss.hint?.includes("scene3d"), `没命中时应当指路到 scene3d：${miss.hint}`);
});

console.log("");
if (failures.length) {
  console.log(`✗ ${failures.length} 个用例失败：${failures.join("、")}`);
  process.exit(1);
}
console.log(`全部通过：${passed} 个用例`);
