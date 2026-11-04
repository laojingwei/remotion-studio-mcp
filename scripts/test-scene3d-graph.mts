/**
 * scene3d 场景图的三处（2026-11-04 3D 专项实测后补的）：
 *
 *  1. **纯枢轴**：`geometry` 可省略 / 可写 `{type:"group"}`，整组一起动不用再拿隐形方块凑
 *  2. **自定义灯的暗部**：`dslWarnings` 要在「高金属 + 低 ambient」时说人话，
 *     而在天文场景（低 ambient 是故意的）里闭嘴
 *  3. **接缝交叠区**：`seamBlendWindows` 报出的窗口必须和 `seamOverlaps` 的渲染口径一致
 *     —— 不然提示说"这帧有交叠"、画面却是干净的，比不提示更坏
 */
import assert from "node:assert/strict";
import { dslSchema, dslWarnings, dslIssues } from "../shared/scene3dDsl";
import { seamBlendWindows, seamOverlaps } from "../shared/transitions";
import { applyOps, createSeedProject, type Op } from "../shared/ops";

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}：${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ✗ ${name}`);
  }
}

const parse = (raw: unknown) => dslSchema.parse(raw);

/* ── ① 纯枢轴 ── */
test("geometry 省略 = group 纯枢轴（不再被判必填）", () => {
  const spec = parse({ nodes: [{ id: "train" }, { id: "body", parent: "train", geometry: { type: "box" } }] });
  assert.equal(spec.nodes[0].geometry.type, "group");
});

test("显式 {type:\"group\"} 与省略等价", () => {
  const spec = parse({ nodes: [{ id: "p", geometry: { type: "group" } }] });
  assert.equal(spec.nodes[0].geometry.type, "group");
});

test("group 不会被当成几何体报错（dslIssues 干净）", () => {
  const spec = parse({
    nodes: [{ id: "rig", geometry: { type: "group" } }, { id: "part", parent: "rig", geometry: { type: "sphere" } }],
  });
  assert.deepEqual(dslIssues(spec), []);
});

test("空枢轴（没有子节点）给提示，但不拦写入", () => {
  const spec = parse({ nodes: [{ id: "rig" }] });
  const warns = dslWarnings(spec);
  assert.ok(
    warns.some((w) => w.includes("rig") && w.includes("没有")),
    `应提示空枢轴：${warns.join(" / ")}`,
  );
  // 关键：dslIssues 里不能有它（否则 agent「先建枢轴再加子节点」的流程会被拒）
  assert.deepEqual(dslIssues(spec), []);
});

test("枢轴上挂 material 会被点名（group 没有表面）", () => {
  const spec = parse({ nodes: [{ id: "rig", material: { color: "#fff" } }] });
  assert.ok(dslWarnings(spec).some((w) => w.includes("material")));
});

/* ── ② 自定义灯的暗部 ── */
const lit = (lights: unknown[], nodes: unknown[] = [{ id: "m", geometry: { type: "box" } }]) =>
  dslWarnings(parse({ nodes, lights }) as never);

test("高金属 + ambient 0.55：提示会渲成剪影，并给数值", () => {
  const warns = lit(
    [
      { type: "ambient", intensity: 0.55 },
      { type: "directional", intensity: 2.4, position: [7, 9, 6] },
      { type: "directional", intensity: 1.5, position: [-7, 4, -7] },
    ],
    [{ id: "car", geometry: { type: "box" }, material: { metalness: 0.85 } }],
  );
  const hit = warns.find((w) => w.includes("金属"));
  assert.ok(hit, `应提示金属偏暗：${warns.join(" / ")}`);
  assert.match(hit!, /1\.2–2\.0/, "要给出可照抄的 ambient 区间");
});

test("天文场景（ambient 0.1 + 强 directional + 低金属）不误报偏暗", () => {
  const warns = lit(
    [
      { type: "ambient", intensity: 0.1 },
      { type: "directional", intensity: 3.4, position: [4.2, 3.6, 4.2] },
    ],
    [{ id: "earth", geometry: { type: "sphere" }, material: { metalness: 0.1, roughness: 0.9 } }],
  );
  assert.equal(warns.length, 0, `不该有警告：${warns.join(" / ")}`);
});

test("完全没写 ambient：提示兜底只有 0.35", () => {
  const warns = lit([{ type: "directional", intensity: 2, position: [3, 5, 3] }]);
  assert.ok(warns.some((w) => w.includes("ambient") && w.includes("0.35")));
});

test("没给自定义灯（用 look 的灯）时不输出灯光警告", () => {
  assert.deepEqual(lit(undefined as never), []);
});

/* ── ③ 接缝交叠区 ── */
test("seamBlendWindows 与 seamOverlaps 的口径一致", () => {
  const scenes = [
    { id: "a", name: "开场", transitionIn: null },
    { id: "b", name: "3D", transitionIn: { type: "fade", durationInFrames: 12 } },
  ];
  const spans = [
    { start: 0, dur: 120, end: 120, track: 0 },
    { start: 120, dur: 200, end: 320, track: 0 },
  ];
  const overlaps = seamOverlaps(scenes, spans);
  assert.equal(overlaps[0], 12, "上一幕应多渲 12 帧");

  const wins = seamBlendWindows(scenes, spans);
  assert.equal(wins.length, 1);
  assert.equal(wins[0].start, 120, "交叠区从下一幕起点开始");
  assert.equal(wins[0].end, 132, "长度 = transitionIn 时长");
  assert.equal(wins[0].frames, overlaps[0]);
  assert.equal(wins[0].from, "开场");
  assert.equal(wins[0].to, "3D");
});

test("硬切（transitionIn=none）没有交叠区", () => {
  const scenes = [{ id: "a" }, { id: "b", transitionIn: { type: "none", durationInFrames: 0 } }];
  const spans = [
    { start: 0, dur: 60, end: 60, track: 0 },
    { start: 60, dur: 60, end: 120, track: 0 },
  ];
  assert.equal(seamBlendWindows(scenes, spans).length, 0);
});

test("交叠帧数被幕长夹住时，窗口跟着变短（不报出画面里没有的帧）", () => {
  const scenes = [
    { id: "a", name: "短幕" },
    { id: "b", name: "下一幕", transitionIn: { type: "slide", durationInFrames: 40 } },
  ];
  const spans = [
    { start: 0, dur: 10, end: 10, track: 0 }, // 只有 10 帧，转场要 40 帧
    { start: 10, dur: 100, end: 110, track: 0 },
  ];
  const wins = seamBlendWindows(scenes, spans);
  assert.equal(wins[0].frames, 9, "前一幕要留 1 帧给自己");
  assert.equal(wins[0].end, 19);
});
/* ── ④ 世界 / 地面 / 后期（2026-11-04 晚，真实感改造） ── */
test("world:省略时各字段有默认值（haze/vignette 不为 0）", () => {
  const spec = parse({ nodes: [{ id: "a", geometry: { type: "box" } }], world: { mode: "auto" } });
  assert.equal(spec.world!.mode, "auto");
  assert.equal(spec.world!.haze, 0.35);
  assert.equal(spec.world!.vignette, 0.32);
});

test("world:mode=gradient 缺 top/bottom 不报错（渲染端有 auto 兜底）", () => {
  const spec = parse({ nodes: [{ id: "a" }], world: { mode: "gradient", bottom: "#2B3342" } });
  assert.equal(spec.world!.bottom, "#2B3342");
});

test("ground:不写 y 也能过校验（渲染端自动取节点最低点）", () => {
  const spec = parse({ nodes: [{ id: "a" }], ground: { color: "#20242B" } });
  assert.equal(spec.ground!.shadow, true);
  assert.equal(spec.ground!.size, 160);
});

test("post:tonemap 默认 aces、exposure 默认 1.25", () => {
  const spec = parse({ nodes: [{ id: "a" }], post: { bloom: 0.5 } });
  assert.equal(spec.post!.tonemap, "aces");
  assert.equal(spec.post!.exposure, 1.25);
});

test("material:envMapIntensity 槽位（金属亮度的直接旋钮）", () => {
  const spec = parse({
    nodes: [{ id: "a", geometry: { type: "box" }, material: { metalness: 0.9, envMapIntensity: 1.6 } }],
  });
  assert.equal(spec.nodes[0].material!.envMapIntensity, 1.6);
});

test("ops:set_graph_world / set_graph_ground 走 ops 流水线写回 graph", () => {
  const proj0 = applyOps(createSeedProject("t-world"), [
    { op: "add_scene", type: "scene3d", props: { graph: { nodes: [{ id: "a", geometry: { type: "box" } }] } } },
  ]);
  const sceneId = proj0.createdSceneIds[0];
  const res = applyOps(proj0.project, [
    { op: "set_graph_world", sceneId, world: { mode: "auto", haze: 0.5 } },
    { op: "set_graph_ground", sceneId, ground: { y: -0.62 } },
    { op: "set_graph_post", sceneId, post: { tonemap: "none" } },
  ]);
  assert.ok(res.summary.some((s) => s.includes("世界")));
  assert.ok(res.summary.some((s) => s.includes("地面")));
  const g = res.project.scenes.find((s) => s.id === sceneId)!.props.graph as Record<string, any>;
  assert.equal(g.world.haze, 0.5);
  assert.equal(g.ground.y, -0.62);
  assert.equal(g.post.tonemap, "none");
  // null 清掉
  const res2 = applyOps(res.project, [
    { op: "set_graph_world", sceneId, world: null },
    { op: "set_graph_ground", sceneId, ground: null },
  ]);
  const g2 = res2.project.scenes.find((s) => s.id === sceneId)!.props.graph as Record<string, any>;
  assert.equal(g2.world, undefined);
  assert.equal(g2.ground, undefined);
  assert.ok(res2.summary.some((s) => s.includes("回到 auto")));
});

/* ── ⑤ 全景图世界 / 只接阴影的地面（2026-11-04 晚） ── */
test("world:image 模式默认 imageLighting=true、imageIntensity=1", () => {
  const spec = parse({
    nodes: [{ id: "a" }],
    world: { mode: "image", image: "/assets/library/world/belfast_sunset_2k.hdr" },
  });
  assert.equal(spec.world!.image, "/assets/library/world/belfast_sunset_2k.hdr");
  assert.equal(spec.world!.imageLighting, true);
  assert.equal(spec.world!.imageIntensity, 1);
});

test("ground:mode 默认 solid，可切 shadow（配全景图的正确用法）", () => {
  const a = parse({ nodes: [{ id: "a" }], ground: {} });
  assert.equal(a.ground!.mode, "solid");
  const b = parse({ nodes: [{ id: "a" }], ground: { mode: "shadow", shadowOpacity: 0.7 } });
  assert.equal(b.ground!.mode, "shadow");
  assert.equal(b.ground!.shadowOpacity, 0.7);
});

test("全景图当照明时，不再提示「抬 ambient 到 1.2–2.0」", () => {
  const graph = {
    nodes: [{ id: "t", geometry: { type: "box" }, material: { metalness: 0.9 } }],
    world: { mode: "image", image: "/assets/x.hdr", imageLighting: true },
    lights: [{ type: "ambient", intensity: 0.4 }],
  };
  assert.equal(dslWarnings(parse(graph)).some((w) => w.includes("ambient 抬到")), false);
  // 关掉 imageLighting 就退回原规则（环境反射只剩 55%）
  const off = { ...graph, world: { ...graph.world, imageLighting: false } };
  assert.equal(dslWarnings(parse(off)).some((w) => w.includes("ambient 抬到")), true);
});

/* ── ⑥ 世界预设（2026-11-04 深夜） ── */
test("worldPreset：整组套用（背景图 + 档位 + 补光 + 地面 + 后期），preset 不落盘", () => {
  const seeded = applyOps(createSeedProject("t-sky"), [
    { op: "add_scene", type: "scene3d", props: { graph: { nodes: [{ id: "a", geometry: { type: "box" } }] } } },
  ]);
  const sceneId = seeded.createdSceneIds[0];
  const proj = seeded.project;

  const res = applyOps(proj, [{ op: "set_graph_world", sceneId, preset: "city-night" }]);
  const g = res.project.scenes.find((s) => s.id === sceneId)!.props.graph as Record<string, any>;

  assert.equal(g.world.mode, "image");
  assert.ok(g.world.image.endsWith("/modern_buildings_night_2k.hdr"), g.world.image);
  assert.equal(g.world.imageLighting, true);
  assert.equal(g.world.envIntensity, 0.22);
  assert.equal(g.world.imageIntensity, 0.36);
  // 灯跟着一起换（夜景那组是高强度暖主光）
  assert.ok(Array.isArray(g.lights) && g.lights.length >= 2, JSON.stringify(g.lights));
  assert.ok(g.lights.some((l: any) => l.intensity >= 3), "夜景主光应该是高强度");
  // 全景图必须配 shadow 地面
  assert.equal(g.ground.mode, "shadow");
  assert.ok(g.post && typeof g.post.bloom === "number", JSON.stringify(g.post));
  // preset 只是入参，不该被写进工程
  assert.equal(g.world.preset, undefined);
  assert.ok(res.summary.some((s) => s.includes("city-night")));
  assert.ok(res.summary.some((s) => s.includes("起点不是保证值")));
});

test("worldPreset：world 里的字段覆盖预设，其余保持预设值", () => {
  const seeded = applyOps(createSeedProject("t-sky2"), [
    { op: "add_scene", type: "scene3d", props: { graph: { nodes: [{ id: "a" }] } } },
  ]);
  const sceneId = seeded.createdSceneIds[0];
  const res = applyOps(seeded.project, [
    { op: "set_graph_world", sceneId, preset: "milky-way", world: { envIntensity: 2.2, imageRotation: 40 } },
  ]);
  const g = res.project.scenes.find((s) => s.id === sceneId)!.props.graph as Record<string, any>;
  assert.equal(g.world.envIntensity, 2.2);
  assert.equal(g.world.imageRotation, 40);
  // 没覆盖的保持预设（银河 haze 必须是 0，否则银河被雾洗掉）
  assert.equal(g.world.haze, 0);
  assert.ok(res.summary.some((s) => s.includes("envIntensity")), "回执要说明哪些字段被覆盖");
});

test("worldPreset：写进 world.preset 也能识别；未知 id 报错并列出可选", () => {
  const seeded = applyOps(createSeedProject("t-sky3"), [
    { op: "add_scene", type: "scene3d", props: { graph: { nodes: [{ id: "a" }] } } },
  ]);
  const sceneId = seeded.createdSceneIds[0];
  const ok = applyOps(seeded.project, [
    { op: "set_graph_world", sceneId, world: { preset: "winter-snow" } },
  ]);
  const g = ok.project.scenes.find((s) => s.id === sceneId)!.props.graph as Record<string, any>;
  assert.ok(g.world.image.endsWith("/snowy_hillside_02_2k.hdr"));
  assert.equal(g.world.preset, undefined);

  assert.throws(
    () => applyOps(ok.project, [{ op: "set_graph_world", sceneId, preset: "no-such-sky" }]),
    /没有这个世界预设/,
  );
});

test("findWorldSky 认 id / Poly Haven 资产名 / 文件名", async () => {
  const { findWorldSky, WORLD_SKIES } = await import("../shared/worldPresets");
  assert.equal(findWorldSky("golden-hour")!.id, "golden-hour");
  assert.equal(findWorldSky("belfast_sunset")!.id, "golden-hour");
  assert.equal(findWorldSky("belfast_sunset_2k.hdr")!.id, "golden-hour");
  assert.equal(findWorldSky("nope"), undefined);
  // 每个预设都必须写出 image 路径与档位，别留空给运行时猜
  for (const s of WORLD_SKIES) {
    assert.ok(s.world.envIntensity > 0 && s.world.imageIntensity > 0, s.id);
    assert.ok(s.note.length > 4, s.id);
  }
});


test("dslIssues:序列帧贴图的参数校验", () => {
  // 缺 seqTo/seqTo<=seqFrom → 报
  const bad = dslIssues({
    nodes: [
      { id: "a", geometry: { type: "box" }, material: { map: { src: "http://x/{frame}.png" } } },
      { id: "b", geometry: { type: "box" }, material: { map: { src: "http://x/{frame}.png", seqFrom: 10, seqTo: 5 } } },
    ],
  } as never);
  assert.ok(bad.some((x) => x.includes("a") && x.includes("seqTo")));
  assert.ok(bad.some((x) => x.includes("b") && x.includes("seqTo")));

  // 给了 seqFrom/seqTo 但 src 没写 {frame} → 提醒序列不会动
  const noPattern = dslIssues({
    nodes: [
      { id: "c", geometry: { type: "box" }, material: { map: { src: "http://x/t.png", seqFrom: 1, seqTo: 10 } } },
    ],
  } as never);
  assert.ok(noPattern.some((x) => x.includes("c") && x.includes("{frame}")));

  // 参数齐全 → 不报
  const ok = dslIssues({
    nodes: [
      {
        id: "d",
        geometry: { type: "box" },
        material: { map: { src: "http://x/{frame}.png", seqFrom: 1, seqTo: 240, frameDigits: 4, seqFps: 30 } },
      },
    ],
  } as never);
  assert.ok(!ok.some((x) => x.includes("d")));
});

console.log("");
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);
