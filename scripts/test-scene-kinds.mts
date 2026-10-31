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
import { SCENE_METAS, MIN_SCENE_FRAMES, normalizeProps } from "../shared/sceneMetas";
import { SCENE_COMPONENTS } from "../src/scenes/components";
import { BACKDROP_TYPES, MOTION_SCENE_TYPES, isBackdropType, isMotionScene } from "../shared/sceneKinds";

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

test("名单里没有重复项", () => {
  assert.equal(new Set(BACKDROP_TYPES).size, BACKDROP_TYPES.length);
  assert.equal(MOTION_SCENE_TYPES.size, [...MOTION_SCENE_TYPES].length);
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
