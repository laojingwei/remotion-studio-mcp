/**
 * 版式注册表的一致性测试。
 *
 * 为什么单独一个脚本：新增版式是「三步」（写 meta、写组件、在 components.tsx 登记），
 * 少一步不会报错，只会在用到的时候才炸：
 *   - 只写 meta 不登记组件 → 选择器里能选，选完画面全白；
 *   - 只登记组件不写 meta → agent 永远看不到这个版式，人肉也找不到；
 *   - 只加进 MOTION/BACKDROP 名单 → 白名单放行了一个不存在的类型。
 *
 * 另外一条是踩出来的：marquee 的 defaultProps 一开始写了 4 行文案，
 * 而 schema 是 max(3)。类型检查、单测全绿，直到抽帧建工程时才在
 * normalizeProps 里炸出来。默认值必须自己过一遍 schema —— 这条现在自动验。
 */
import assert from "node:assert/strict";
import { SCENE_METAS, MIN_SCENE_FRAMES, normalizeProps, isAgentVisible, metaList } from "../shared/sceneMetas";
import { SCENE_COMPONENTS } from "../src/scenes/components";
import { AGENT_VISIBLE_BUILTIN_TYPES, BACKDROP_TYPES, MOTION_SCENE_TYPES, isAgentVisibleBuiltinType, isBackdropType, isMotionScene } from "../shared/sceneKinds";
import { jsonToSceneMeta } from "../shared/pluginSceneMeta";
import { describeFields, getMeta, SCENE_METAS } from "../shared/sceneMetas";
import type { z } from "zod";

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

console.log("\n[registry] 版式 / 组件 / 名单 三方一致");

test("每个 meta 都有对应组件", () => {
  const missing = SCENE_METAS.filter((m) => !SCENE_COMPONENTS[m.type]).map((m) => m.type);
  assert.deepEqual(missing, [], `这些版式没有登记组件：${missing.join(", ")}`);
});

test("每个组件都有对应 meta（防止死代码 / agent 看不见的版式）", () => {
  const types = new Set(SCENE_METAS.map((m) => m.type));
  const orphan = Object.keys(SCENE_COMPONENTS).filter((t) => !types.has(t));
  assert.deepEqual(orphan, [], `这些组件没有 meta：${orphan.join(", ")}`);
});

test("MOTION 名单里的类型都真实存在", () => {
  for (const t of MOTION_SCENE_TYPES) {
    assert.ok(SCENE_METAS.some((m) => m.type === t), `MOTION 里有不存在的类型：${t}`);
    assert.ok(SCENE_COMPONENTS[t], `MOTION 里的 ${t} 没有组件`);
  }
});

test("BACKDROP 名单是 MOTION 的子集（氛围层也是动效）", () => {
  for (const t of BACKDROP_TYPES) {
    assert.ok(isMotionScene(t), `BACKDROP 里的 ${t} 不在 MOTION 名单，设计锁会按版面口径审计它`);
    assert.ok(isBackdropType(t), `${t} 自己都过不了 isBackdropType`);
    assert.ok(SCENE_COMPONENTS[t], `BACKDROP 里的 ${t} 没有组件`);
  }
});

test("BACKDROP 名单不得包含带正文的版式（垫在别的版式下会出现两套字）", () => {
  // 这些版式的画面主体是文案本身 —— 曾因批量替换把 wave/slot 误加进白名单
  const WITH_COPY = new Set([
    "typewriter",
    "counter",
    "gradienttext",
    "scramble",
    "highlight",
    "stomp",
    "wipe",
    "marquee",
    "wave",
    "slot",
  ]);
  for (const t of BACKDROP_TYPES) {
    assert.ok(!WITH_COPY.has(t), `BACKDROP 里的 ${t} 带正文，当氛围层会同时出现两套字`);
  }
});

test("名单里没有重复项", () => {
  assert.equal(new Set(BACKDROP_TYPES).size, BACKDROP_TYPES.length);
  assert.equal(MOTION_SCENE_TYPES.size, [...MOTION_SCENE_TYPES].length);
});

console.log("\n[visibility] 场景可见性标签（agent 清单只回白名单）");

test("每一个场景都有显式的 agentVisible 标签", () => {
  const missing = SCENE_METAS.filter((m) => typeof m.agentVisible !== "boolean").map((m) => m.type);
  assert.deepEqual(missing, [], `这些场景没打标签：${missing.join(", ")}`);
});

test("白名单是注册表的子集，且每个都有组件", () => {
  for (const t of AGENT_VISIBLE_BUILTIN_TYPES) {
    assert.ok(getMeta(t), `白名单里有不存在的类型：${t}`);
    assert.ok(SCENE_COMPONENTS[t], `白名单里的 ${t} 没有组件`);
  }
});

test("默认可见：3D / 图解 / 空白 / 自由画布 / 动效 / 氛围", () => {
  for (const t of ["scene3d", "iso", "empty", "freeform", "glow", "typewriter", "bokeh", "confetti", "wave"]) {
    const m = getMeta(t);
    assert.ok(m, `缺 ${t}`);
    assert.equal(isAgentVisible(m), true, `${t} 应该默认对 agent 可见`);
    assert.ok(isAgentVisibleBuiltinType(t), `${t} 应该落在白名单常量里`);
  }
});

test("默认隐藏：内置固定版式（title / bullets / chart / stats …）", () => {
  for (const t of ["title", "bullets", "chart", "stats", "quote", "outro", "hero", "pricing", "gallery", "linechart"]) {
    const m = getMeta(t);
    assert.ok(m, `缺 ${t}`);
    assert.equal(isAgentVisible(m), false, `${t} 是固定版式，应该默认隐藏`);
    assert.ok(!isAgentVisibleBuiltinType(t), `${t} 不该落在白名单常量里`);
  }
});

test("清单两个视图：编辑器全量、agent 只回标签允许的类型", () => {
  const all = metaList();
  const agent = metaList({ agentOnly: true });
  assert.equal(all.length, SCENE_METAS.length, "编辑器视图必须是全量（隐藏只影响列清单）");
  assert.ok(all.every((t) => typeof t.agentVisible === "boolean"), "全量清单每一项都要带标签");
  assert.ok(agent.length < all.length, "agent 清单必须比全量少");
  assert.ok(agent.every((t) => t.agentVisible), "agent 清单里混进了隐藏类型");
  assert.deepEqual(
    agent.map((t) => t.type).sort(),
    [...AGENT_VISIBLE_BUILTIN_TYPES].sort(),
    "agent 清单应当正好等于白名单（插件场景由服务端额外注册）",
  );
});

test("被隐藏的固定版式仍然有 meta 和组件（老工程照常渲染）", () => {
  const hidden = SCENE_METAS.filter((m) => !isAgentVisible(m));
  assert.ok(hidden.length > 0, "应当有一批默认隐藏的固定版式");
  for (const m of hidden) {
    assert.ok(getMeta(m.type), `${m.type} 隐藏后连 meta 都没了`);
    assert.ok(SCENE_COMPONENTS[m.type], `${m.type} 隐藏后连组件都没了，老工程会白屏`);
  }
});

test("插件场景默认可见，写 false 才隐藏", () => {
  const base = {
    type: "t-vis-probe",
    name: "可见性探针",
    fields: [{ key: "title", type: "text", label: "标题", default: "探针" }],
  };
  const a = jsonToSceneMeta(base, "test");
  assert.ok(a.meta, `插件 meta 解析失败：${a.issues.join("; ")}`);
  assert.equal(a.meta!.agentVisible, true, "插件场景必须默认让 agent 查到");
  const b = jsonToSceneMeta({ ...base, agentVisible: false }, "test");
  assert.ok(b.meta, `插件 meta 解析失败：${b.issues.join("; ")}`);
  assert.equal(b.meta!.agentVisible, false, "插件写了 agentVisible:false 就该藏起来");
});

console.log("\n[defaults] 默认值能过自己的 schema");

for (const m of SCENE_METAS) {
  test(`${m.type} 的 defaultProps 过 schema`, () => {
    const out = normalizeProps(m.type, {});
    // 归一化后的值必须再被 schema 接受一次（缺字段会被 default 补上）
    const parsed = m.schema.safeParse(out);
    assert.ok(parsed.success, `${m.type} 默认值非法：${parsed.success ? "" : parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  });
}

console.log("\n[duration] 时长下限统一");

test("所有版式的 min 都等于 MIN_SCENE_FRAMES", () => {
  const bad = SCENE_METAS.filter((m) => m.duration.min !== MIN_SCENE_FRAMES).map((m) => m.type);
  assert.deepEqual(bad, [], `这些版式写了自己的下限（时间轴会拖不动）：${bad.join(", ")}`);
});

test("所有版式的默认时长落在 [min, max] 内", () => {
  for (const m of SCENE_METAS) {
    assert.ok(
      m.duration.default >= m.duration.min && m.duration.default <= m.duration.max,
      `${m.type} 默认 ${m.duration.default} 不在 [${m.duration.min}, ${m.duration.max}]`,
    );
  }
});

console.log(`\n全部通过：${passed} 个用例`);
if (failures.length) {
  console.error(`失败 ${failures.length} 个：${failures.join(" / ")}`);
  process.exit(1);
}

test("字符串/数字数组字段必须产出 itemKind（否则编辑器添加一项会推进空对象）", () => {
  for (const meta of SCENE_METAS) {
    const fields = describeFields(meta.schema as z.ZodObject<z.ZodRawShape>);
    for (const f of fields) {
      if (f.kind !== "array") continue;
      if (f.itemShape && f.itemShape.length) continue; // 对象数组走 itemShape
      assert.ok(
        f.itemKind === "string" || f.itemKind === "number",
        `${meta.type}.${f.key} 是标量数组但没给 itemKind，编辑器会写坏数据`,
      );
    }
  }
});

test("跑马灯的默认值能被自己的 schema 接住，且编辑器可增删行", () => {
  const meta = getMeta("marquee")!;
  const fields = describeFields(meta.schema as z.ZodObject<z.ZodRawShape>);
  const rows = fields.find((f) => f.key === "rows")!;
  assert.equal(rows.itemKind, "string");
});

test("场景类型不能重复注册（重复会在选择器里出现两张一样的卡，list_scene_types 也会列两遍）", () => {
  const seen = new Map<string, number>();
  for (const m of SCENE_METAS) seen.set(m.type, (seen.get(m.type) ?? 0) + 1);
  const dup = [...seen].filter(([, n]) => n > 1).map(([t, n]) => `${t}×${n}`);
  assert.equal(dup.length, 0, `重复注册：${dup.join("、")}`);
});
