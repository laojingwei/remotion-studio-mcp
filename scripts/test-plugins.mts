/**
 * 插件内核单测（纯 Node，不起服务、不开浏览器）。
 *
 *   npm test
 *
 * ## 为什么这个测试必须用**临时目录**
 *
 * 插件目录与 `data/` 都是"用户真实资产"：跑一次测试就把人家装的插件停用掉、
 * 或者把 `data/plugins.json` 改成测试的形状，是比没测试更糟的事。
 * 所以这里用 `STUDIO_PLUGINS_DIR` / `STUDIO_DATA_ROOT` 指到 mkdtemp 出来的目录，
 * 全程不碰仓库里的 plugins/ 与 data/。
 *
 * 这两个环境变量是在**模块加载时**读取的，所以被测模块必须用动态 `import()`，
 * 不能写在文件顶部的静态 import 里——静态 import 会提升到环境变量赋值之前执行。
 *
 * 盯七件事：
 *  1. 没有插件时不报错
 *  2. 无 manifest 的插件按目录结构推断（"丢个 md 就生效"是核心承诺）
 *  3. 有 manifest 时 id/name/version 正确
 *  4. 坏 manifest 只让这一个插件失败，不拖垮其余
 *  5. apiVersion 过高要拦住（否则是静默出错）
 *  6. 同名时内置优先（内置技能被 start_guide 引用，不能被顶掉）
 *  7. 停用/删除后立刻消失，且预设缓存按 mtime 失效
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../server/root";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "studio-plugins-"));
const PLUGIN_DIR = path.join(TMP, "plugins");
const DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(PLUGIN_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.STUDIO_PLUGINS_DIR = PLUGIN_DIR;
process.env.STUDIO_DATA_ROOT = DATA_DIR;
// 素材目录也指到临时目录：否则媒体测试会往仓库的 public/assets 里写文件、删文件，
// 而删除会撞上 safe-delete 的批量上限（静默失败 → 残留 → 断言指向完全错误的方向）
process.env.STUDIO_PUBLIC_DIR = path.join(TMP, "public");

const { scanPlugins, pluginRoots, setPluginEnabled, isPluginEnabled, seedExamplePluginsDisabled } = await import(
  "../server/plugin/discovery"
);
const { listSkills } = await import("../server/skills.service");
const { listStyles, presetOf } = await import("../server/styles.service");
const { briefSteps, briefStepsSource, coreSteps, stepMissingFields } = await import("../server/brief.service");
const { jsonToSceneMeta } = await import("../shared/pluginSceneMeta");
const { registerSceneMeta, unregisterSceneMeta } = await import("../shared/sceneMetas");
const { discoverSceneEntries, generatePluginEntry } = await import("../server/plugin/gen-entry");

let passed = 0;
const failures: string[] = [];
const test = (name: string, fn: () => void) => {
  try {
    const ret = (fn as () => unknown)();
    /*
     * 异步函数传进 `test()` 是**假绿**：这里不 await，断言失败不会进 failures，
     * 而是在收尾之后变成 unhandled rejection（2026-11-06 的 list_graph_presets 用例
     * 就这么"✓ 通过"了，一分钟后才炸）。所以直接拒掉，逼调用方用 testAsync。
     */
    if (ret && typeof (ret as Promise<unknown>).then === "function") {
      throw new Error("test() 收到异步函数：请改用 testAsync()，否则失败不会计入结果");
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  ✗ ${name}`);
    const msg = err instanceof Error ? err.message : String(err);
    for (const line of msg.split("\n")) console.error(`    ${line}`);
  }
};

const write = (rel: string, content: string) => {
  const file = path.join(PLUGIN_DIR, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
};

/** 清空插件目录（每个用例从干净状态开始，避免互相污染） */
const resetPlugins = () => {
  fs.rmSync(PLUGIN_DIR, { recursive: true, force: true });
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
};

console.log("插件内核");

/* ────────────────────────── 发现与推断 ────────────────────────── */

test("空目录：不报错，返回空清单", () => {
  resetPlugins();
  assert.deepEqual(scanPlugins(), []);
});

test("无 manifest：按目录结构推断（skills/*.md 即可用）", () => {
  resetPlugins();
  write("裸插件/skills/bare-skill.md", "# 裸技能\n\n正文\n");
  const found = scanPlugins();
  assert.equal(found.length, 1, "应该发现一个插件");
  // 纯中文目录名归一化后什么都不剩，走稳定哈希兜底（不能是固定值，否则多个中文插件会撞 id）
  assert.match(found[0].id, /^p[0-9a-z]+$/, `中文目录名应得到哈希 id，实际：${found[0].id}`);
  assert.deepEqual(found[0].provides, ["skill"]);
  assert.equal(found[0].manifest, null, "没有 manifest 时 manifest 应为 null");
  assert.deepEqual(found[0].errors, []);
});

test("两个中文目录名：id 不冲突，都能加载", () => {
  resetPlugins();
  write("我的风格/skills/one.md", "# 一\n");
  write("我的配乐/skills/two.md", "# 二\n");
  const list = scanPlugins().filter((p) => p.errors.length === 0);
  assert.equal(list.length, 2, `两个中文插件都该加载，实际 ${list.length} 个`);
  assert.notEqual(list[0].id, list[1].id, "两个中文插件的 id 不能相同");
});

test("无 manifest 且目录里没有可识别结构：静默跳过（不报错）", () => {
  resetPlugins();
  write("随便放的/readme.txt", "hello");
  assert.deepEqual(scanPlugins(), []);
});

test("有 manifest：id / name / version 按清单走", () => {
  resetPlugins();
  write(
    "anything/manifest.json",
    JSON.stringify({ id: "my-pack", name: "我的包", version: "2.1.0", apiVersion: 1, provides: ["skill"] }),
  );
  write("anything/skills/a.md", "# A\n");
  const p = scanPlugins()[0];
  assert.equal(p.id, "my-pack");
  assert.equal(p.name, "我的包");
  assert.equal(p.version, "2.1.0");
});

test("manifest 声明的 provides 与目录推断取并集", () => {
  resetPlugins();
  write(
    "p1/manifest.json",
    JSON.stringify({ id: "p1", name: "P1", version: "1.0.0", apiVersion: 1, provides: ["style"] }),
  );
  write("p1/skills/s.md", "# S\n");
  const p = scanPlugins()[0];
  assert.deepEqual([...p.provides].sort(), ["skill", "style"]);
});

/* ────────────────────────── 错误隔离 ────────────────────────── */

test("坏 manifest（JSON 语法错）：只坏它自己，不拖垮别的插件", () => {
  resetPlugins();
  write("broken/manifest.json", "{ 这不是 JSON");
  write("broken/skills/x.md", "# X\n");
  write("healthy/skills/y.md", "# Y\n");
  const list = scanPlugins();
  const broken = list.find((p) => p.dir.endsWith("broken"))!;
  const healthy = list.find((p) => p.dir.endsWith("healthy"))!;
  assert.ok(broken.errors.length > 0, "坏插件应该带错误");
  assert.deepEqual(healthy.errors, [], "好插件不该被牵连");
});

test("apiVersion 高于宿主：拦住并给原因", () => {
  resetPlugins();
  write(
    "future/manifest.json",
    JSON.stringify({ id: "future", name: "未来", version: "9.0.0", apiVersion: 99 }),
  );
  write("future/skills/f.md", "# F\n");
  const p = scanPlugins()[0];
  assert.ok(p.errors.some((e) => e.includes("apiVersion")), `应报 apiVersion 过高，实际：${p.errors}`);
});

test("未知 provides 项：忽略并记一条警告，不影响加载", () => {
  resetPlugins();
  write(
    "odd/manifest.json",
    JSON.stringify({ id: "odd", name: "Odd", version: "1.0.0", apiVersion: 1, provides: ["skill", "telepathy"] }),
  );
  write("odd/skills/o.md", "# O\n");
  const p = scanPlugins()[0];
  assert.deepEqual(p.errors, []);
  assert.ok(p.warnings.some((w) => w.includes("telepathy")), `应提示未知 provides，实际：${p.warnings}`);
  assert.deepEqual(p.provides, ["skill"]);
});

/* ────────────────────────── 与内置的关系 ────────────────────────── */

test("插件技能出现在 listSkills 里，并标 source=plugin", () => {
  resetPlugins();
  write("pack/skills/my-guide.md", "# 我的指南\n\n内容\n");
  const mine = listSkills().find((s) => s.name === "my-guide");
  assert.ok(mine, "插件技能应该出现在清单里");
  assert.equal(mine!.source, "plugin");
  assert.equal(mine!.title, "我的指南");
});

test("同名技能：内置优先，插件不覆盖", () => {
  resetPlugins();
  // manual 是内置技能，插件写同名文件不应该顶掉它
  write("pack/skills/manual.md", "# 冒牌手册\n");
  const manual = listSkills().find((s) => s.name === "manual");
  assert.ok(manual);
  assert.equal(manual!.source, "builtin", "同名时必须保留内置版本");
  assert.notEqual(manual!.title, "冒牌手册");
});

test("插件风格出现在 listStyles 里；没有预设也算合法", () => {
  resetPlugins();
  write("sty/styles/my-look.md", "# 我的风格\n\n规则\n");
  const s = listStyles().find((x) => x.slug === "my-look");
  assert.ok(s, "插件风格应该出现");
  assert.equal(s!.source, "plugin");
  assert.equal(s!.hasPreset, false, "没写 presets.json 就该是 false，而不是崩");
});

/* ────────────────────────── 热更新 ────────────────────────── */

test("停用后立刻从清单消失，重新启用又回来", () => {
  resetPlugins();
  write("toggle/skills/t.md", "# T\n");
  assert.ok(listSkills().some((s) => s.name === "t"), "启用状态下应在");

  setPluginEnabled("toggle", false);
  assert.ok(!listSkills().some((s) => s.name === "t"), "停用后不该在");

  setPluginEnabled("toggle", true);
  assert.ok(listSkills().some((s) => s.name === "t"), "重新启用后应回来");
});

test("删掉插件目录：下次扫描立刻消失（没有缓存）", () => {
  resetPlugins();
  write("vanish/skills/v.md", "# V\n");
  assert.ok(listSkills().some((s) => s.name === "v"));
  fs.rmSync(path.join(PLUGIN_DIR, "vanish"), { recursive: true, force: true });
  assert.ok(!listSkills().some((s) => s.name === "v"), "删掉后不该还能读到");
});

test("插件改 md 内容：下一次读取就是新内容", () => {
  resetPlugins();
  write("live/skills/live.md", "# 第一版\n");
  assert.equal(listSkills().find((s) => s.name === "live")!.title, "第一版");
  write("live/skills/live.md", "# 第二版\n");
  assert.equal(listSkills().find((s) => s.name === "live")!.title, "第二版");
});

test("插件 presets.json 改了就生效（缓存按 mtime 失效）", () => {
  resetPlugins();
  const preset = (name: string) => ({
    name,
    palette: {
      background: "#000000",
      surface: "#111111",
      text: "#EEEEEE",
      textMuted: "#999999",
      primary: "#C8A15A",
      secondary: "#8C1F28",
      accent: "#FFFFFF",
    },
    font: { heading: "Inter", body: "Inter" },
    radius: 8,
  });

  write("pre/styles/with-preset.md", "# 带预设\n");
  write("pre/styles/presets.json", JSON.stringify({ "with-preset": preset("第一版名") }));
  assert.equal(presetOf("with-preset")?.name, "第一版名");

  // 同一个文件、改内容：mtime 变了就应该重读
  write("pre/styles/presets.json", JSON.stringify({ "with-preset": preset("第二版名") }));
  assert.equal(presetOf("with-preset")?.name, "第二版名", "预设缓存没按 mtime 失效");
});

/* ────────────────────────── 问诊步骤 ────────────────────────── */

test("没有问诊插件：内置 11 步，必答 9 步", () => {
  resetPlugins();
  const steps = briefSteps();
  assert.equal(steps.length, 11, "内置应该是 11 步（1–9 必答 + 10 稿件 + 11 观感）");
  assert.equal(coreSteps(steps).length, 9, "必答应该是 9 步");
});

test("replace：整套换掉，步号按数组顺序自动分配（忽略用户写的 no）", () => {
  resetPlugins();
  write(
    "br/brief/steps.json",
    JSON.stringify({
      mode: "replace",
      steps: [
        { no: 99, title: "甲", required: [["goal", "目标"]], questions: [] },
        { no: 99, title: "乙", required: [["durationSec", "时长"]], questions: [] },
        { title: "丙", core: false, required: [], questions: [] },
      ],
    }),
  );
  const steps = briefSteps();
  assert.equal(steps.length, 3);
  assert.deepEqual(
    steps.map((s) => s.no),
    [1, 2, 3],
    "用户写的 no 必须被忽略——手写编号必然出现重复/跳号，而 no 是进度判定的键",
  );
  assert.deepEqual(
    steps.map((s) => s.title),
    ["甲", "乙", "丙"],
  );
  assert.equal(coreSteps(steps).length, 2, "core:false 的那步不进必答");
});

test("append：接在内置之后，编号顺延", () => {
  resetPlugins();
  write(
    "br/brief/steps.json",
    JSON.stringify({ mode: "append", steps: [{ title: "加一步", required: [["goal", "目标"]], questions: [] }] }),
  );
  const steps = briefSteps();
  assert.equal(steps.length, 12);
  assert.equal(steps[11].no, 12, "追加步的编号应从内置最大号 +1 开始");
  assert.equal(steps[11].title, "加一步");
});

test("直接给数组：等价于 replace", () => {
  resetPlugins();
  write("br/brief/steps.json", JSON.stringify([{ title: "只有一步", required: [["goal", "目标"]] }]));
  const src = briefStepsSource();
  assert.equal(src.source, "plugin");
  assert.equal(src.steps.length, 1);
});

test("坏 JSON：回退内置，并说明原因（不让问诊整个挂掉）", () => {
  resetPlugins();
  write("bad/brief/steps.json", "{ 这不是 JSON");
  const src = briefStepsSource();
  assert.equal(src.source, "builtin");
  assert.equal(src.steps.length, 11);
  assert.ok(
    src.issues.some((i) => i.includes("解析失败")),
    `应报解析失败，实际：${src.issues.join(" / ")}`,
  );
});

test("缺 title 的步骤被跳过，其余照用", () => {
  resetPlugins();
  write(
    "br/brief/steps.json",
    JSON.stringify({ steps: [{ title: "好的", required: [] }, { required: [] }, { title: "也好的", required: [] }] }),
  );
  const steps = briefSteps();
  assert.equal(steps.length, 2, "没有 title 的那步应被跳过");
  assert.ok(briefStepsSource().issues.some((i) => i.includes("缺 title")));
});

test("全部不合法：回退内置并明说", () => {
  resetPlugins();
  write("br/brief/steps.json", JSON.stringify({ steps: [{ required: [] }] }));
  const src = briefStepsSource();
  assert.equal(src.source, "builtin");
  assert.ok(
    src.issues.some((i) => i.includes("回退内置")),
    `应说明已回退，实际：${src.issues.join(" / ")}`,
  );
});

test("x. 扩展字段：填了才算齐（否则问诊会永远停在这一步）", () => {
  resetPlugins();
  write(
    "br/brief/steps.json",
    JSON.stringify({ steps: [{ title: "竞品", required: [["x.competitor", "主要竞品"]] }] }),
  );
  assert.deepEqual(stepMissingFields(1, {}), ["主要竞品"], "没填就该报缺");
  assert.deepEqual(stepMissingFields(1, { x: { competitor: "对手 A" } }), [], "填了就不该报缺");
  // 空字符串算没填（和内置字段一致）
  assert.deepEqual(stepMissingFields(1, { x: { competitor: "   " } }), ["主要竞品"], "空白字符串应算未填");
});

test("两个插件都提供问诊：只用第一个，并点名忽略了谁", () => {
  resetPlugins();
  write("aaa/brief/steps.json", JSON.stringify({ steps: [{ title: "A 的问诊", required: [] }] }));
  write("zzz/brief/steps.json", JSON.stringify({ steps: [{ title: "Z 的问诊", required: [] }] }));
  const src = briefStepsSource();
  assert.equal(src.pluginId, "aaa", "按 id 排序取第一个，结果要稳定");
  assert.ok(
    src.issues.some((i) => i.includes("zzz")),
    `应点名被忽略的插件，实际：${src.issues.join(" / ")}`,
  );
});

/* ────────────────────────── 插件场景：JSON → SceneMeta ────────────────────────── */

test("合法 json：字段转成 zod，默认值补进 defaultProps", () => {
  const { meta } = jsonToSceneMeta(
    {
      type: "t-rating",
      name: "评分",
      fields: [
        { key: "title", type: "text", label: "标题", default: "综合评分" },
        { key: "score", type: "number", label: "分数", default: 8.5, min: 0, max: 10 },
        { key: "on", type: "boolean", label: "开关", default: true },
        { key: "tone", type: "enum", label: "语气", options: ["克制", "热烈"], default: "克制" },
        { key: "tags", type: "stringArray", label: "标签", default: ["a"], maxItems: 5 },
      ],
    },
    "test",
  );
  assert.ok(meta, "应该解析成功");
  assert.equal(meta!.type, "t-rating");
  assert.deepEqual(meta!.defaultProps, {
    title: "综合评分",
    score: 8.5,
    on: true,
    tone: "克制",
    tags: ["a"],
  });
  // 空 props 必须能过（新建场景就是不传 props）
  const parsed = meta!.schema.parse({});
  assert.equal((parsed as any).score, 8.5);
});

test("字段没 default 也没 optional：报错并说明后果", () => {
  const { issues } = jsonToSceneMeta(
    { type: "t-bad", name: "坏", fields: [{ key: "x", type: "text", label: "X" }] },
    "test",
  );
  assert.ok(
    issues.some((i) => i.includes("既没有 default 也没标 optional")),
    `应提示缺默认值，实际：${issues.join(" / ")}`,
  );
});

test("缺 fields / type 非法 / 没有合法字段：都返回 null 而不是崩", () => {
  assert.equal(jsonToSceneMeta({ type: "t1" }, "t").meta, null);
  assert.equal(jsonToSceneMeta({ fields: [{ key: "a", type: "text", default: "x" }] }, "t").meta, null);
  assert.equal(jsonToSceneMeta({ type: "T_BAD", fields: [] }, "t").meta, null);
  assert.equal(jsonToSceneMeta({ type: "t2", fields: [{ key: "", type: "text" }] }, "t").meta, null);
});

test("enum 少于两个选项：拒绝（分段按钮至少要能二选一）", () => {
  const { meta, issues } = jsonToSceneMeta(
    { type: "t-enum", name: "E", fields: [{ key: "k", type: "enum", options: ["只有一个"], default: "只有一个" }] },
    "t",
  );
  assert.equal(meta, null);
  assert.ok(issues.some((i) => i.includes("options 少于 2")));
});

test("objectArray 没写 items：拒绝（否则编辑器加不出行）", () => {
  const { meta, issues } = jsonToSceneMeta(
    { type: "t-arr", name: "A", fields: [{ key: "rows", type: "objectArray", default: [] }] },
    "t",
  );
  assert.equal(meta, null);
  assert.ok(issues.some((i) => i.includes("没写 items")));
});

test("objectArray 子字段：默认值能补上（编辑器「添加一项」推的是空对象）", () => {
  const { meta } = jsonToSceneMeta(
    {
      type: "t-rows",
      name: "表",
      fields: [
        {
          key: "rows",
          type: "objectArray",
          label: "明细",
          default: [{ name: "甲", value: 1 }],
          items: [
            { key: "name", type: "text", default: "" },
            { key: "value", type: "number", default: 0 },
          ],
        },
      ],
    },
    "t",
  );
  assert.ok(meta);
  const parsed = meta!.schema.parse({ rows: [{ name: "乙" }] }) as any;
  assert.equal(parsed.rows[0].value, 0, "行内缺失的字段应补子字段默认值");
});

test("注册幂等：同 type 第二次注册被拒（不覆盖先注册的）", () => {
  const meta = jsonToSceneMeta(
    { type: "t-dup", name: "重复", fields: [{ key: "a", type: "text", default: "x" }] },
    "t",
  ).meta!;
  const first = registerSceneMeta(meta);
  assert.equal(first.ok, true);
  const second = registerSceneMeta(meta);
  assert.equal(second.ok, false, "第二次应被拒，否则「改了插件没变」会变成随机现象");
  assert.ok(second.reason?.includes("已被占用"));
  unregisterSceneMeta("t-dup");
});

/* ────────────────────────── 插件场景：生成器的配对检查 ────────────────────────── */

test("生成器：json 有组件文件才算场景，缺组件的给提示", () => {
  resetPlugins();
  write("sc/scenes/with-comp.json", JSON.stringify({ type: "t1", name: "A", fields: [] }));
  write("sc/scenes/with-comp.tsx", "export default function A() { return null; }");
  write("sc/scenes/no-comp.json", JSON.stringify({ type: "t2", name: "B", fields: [] }));

  const { entries, issues } = discoverSceneEntries(PLUGIN_DIR);
  assert.equal(entries.length, 1, "只有配对了组件的才算");
  assert.ok(entries[0].compFile.endsWith("with-comp.tsx"));
  assert.ok(
    issues.some((i) => i.includes("no-comp.json") && i.includes("同名组件")),
    `应提示缺组件，实际：${issues.join(" / ")}`,
  );
});

test("生成器：生成的文件里 import 路径不带 .tsx、json 带扩展名", () => {
  resetPlugins();
  write("sc/scenes/card.json", JSON.stringify({ type: "t-card", name: "卡", fields: [] }));
  write("sc/scenes/card.tsx", "export default function C() { return null; }");
  const out = path.join(TMP, "generated.ts");
  generatePluginEntry({ outFile: out });
  const text = fs.readFileSync(out, "utf8");
  assert.match(text, /from ".*card"\;/, "组件 import 不该带 .tsx（TS 默认不允许）");
  assert.match(text, /card\.json"/, "json import 要保留扩展名");
  assert.ok(text.includes("registerSceneComponent"), "生成文件要负责注册");
});

test("生成器：没有场景时生成空占位，不 import 任何东西", () => {
  resetPlugins();
  const out = path.join(TMP, "empty.ts");
  generatePluginEntry({ outFile: out });
  const text = fs.readFileSync(out, "utf8");
  assert.ok(text.includes("export const PLUGIN_SCENES"), "要有占位导出，否则编译报错");
  assert.ok(!text.includes("jsonToSceneMeta"), "空情况不该 import（会被 lint 判未使用）");
});

/* ────────────────────────── 钩子（批次 4） ────────────────────────── */

const { hasHook, runHook, ensurePluginHooks, hookStatus, hookKindsOf, resetHookCache, frozenSnapshot } =
  await import("../server/plugin/hooks");
const { auditBriefAgainstProject } = await import("../server/brief-audit.service");
const { recomputeDesignLock } = await import("../server/brief.service");
const { projects } = await import("../server/project.service");
const { writeProject, readProject } = await import("../server/store");
const { createSeedProject } = await import("../shared/ops");

/** 钩子加载是异步的，所以这一节需要自己的 async 版本 */
const testAsync = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  ✗ ${name}`);
    const msg = err instanceof Error ? err.message : String(err);
    for (const line of msg.split("\n")) console.error(`    ${line}`);
  }
};

/** 写一个钩子插件，返回它的插件 id */
const writeHookPlugin = (dir: string, body: string): string => {
  write(`${dir}/plugin.ts`, body);
  return dir;
};

const auditCtx = () => ({ brief: {}, project: {}, lock: null }) as never;

await testAsync("没有钩子插件：hasHook 全假，runHook 返回空意见（不崩）", async () => {
  resetPlugins();
  resetHookCache();
  await ensurePluginHooks();
  assert.equal(hasHook("audit:rules"), false);
  assert.deepEqual(runHook("audit:rules", auditCtx()).warnings, []);
});

await testAsync("plugin.ts 提供 audit:rules：加载后生效，意见带插件 id 前缀", async () => {
  resetPlugins();
  writeHookPlugin("gate", 'export default { "audit:rules": () => ({ warnings: ["字幕太长"] }) };');
  resetHookCache();
  await ensurePluginHooks();
  assert.equal(hasHook("audit:rules"), true);
  const v = runHook("audit:rules", auditCtx());
  assert.deepEqual(v.warnings, ["[gate] 字幕太长"], "插件意见必须带归属前缀");
  assert.deepEqual(hookKindsOf("gate"), ["audit:rules"]);
});

await testAsync("返回值乱写（null / 数字 / 空串）：当没说话，不抛错", async () => {
  resetPlugins();
  writeHookPlugin(
    "sloppy",
    'export default { "audit:rules": () => ({ warnings: [1, null, "  ", "有用的一条"] }) };',
  );
  writeHookPlugin("nil", 'export default { "audit:rules": () => undefined };');
  resetHookCache();
  await ensurePluginHooks();
  const v = runHook("audit:rules", auditCtx());
  assert.deepEqual(v.warnings, ["[sloppy] 有用的一条"], "只保留真正的字符串，且不受别的插件影响");
});

await testAsync("一个插件抛错：其余照常，错误进 hookStatus", async () => {
  resetPlugins();
  writeHookPlugin("boom", 'export default { "audit:rules": () => { throw new Error("我坏了"); } };');
  writeHookPlugin("fine", 'export default { "audit:rules": () => ({ warnings: ["我还行"] }) };');
  resetHookCache();
  await ensurePluginHooks();
  const v = runHook("audit:rules", auditCtx());
  assert.deepEqual(v.warnings, ["[fine] 我还行"], "坏插件不能连带别人");
  const errs = hookStatus().errors;
  assert.ok(
    errs.some((e) => e.pluginId === "boom" && e.message.includes("我坏了")),
    `错误要能指回插件，实际：${JSON.stringify(errs)}`,
  );
});

await testAsync("连续失败 3 次：自动摘除（否则每次保存都刷一条堆栈）", async () => {
  resetPlugins();
  writeHookPlugin("cursed", 'export default { "audit:rules": () => { throw new Error("永远坏"); } };');
  resetHookCache();
  await ensurePluginHooks();
  assert.equal(hasHook("audit:rules"), true);
  runHook("audit:rules", auditCtx());
  runHook("audit:rules", auditCtx());
  runHook("audit:rules", auditCtx());
  assert.equal(hasHook("audit:rules"), false, "第 3 次后应被摘除");
  assert.ok(
    hookStatus().errors.some((e) => e.message.includes("已停用")),
    "摘除要有记录，不能悄悄消失",
  );
});

await testAsync("改 plugin.ts：重新 ensure 后新逻辑生效（热更新）", async () => {
  resetPlugins();
  writeHookPlugin("hot", 'export default { "audit:rules": () => ({ warnings: ["v1"] }) };');
  resetHookCache();
  await ensurePluginHooks();
  assert.deepEqual(runHook("audit:rules", auditCtx()).warnings, ["[hot] v1"]);

  // 同一毫秒内写入也要能被发现：指纹里有 size
  writeHookPlugin("hot", 'export default { "audit:rules": () => ({ warnings: ["v2 改过了"] }) };');
  await ensurePluginHooks();
  assert.deepEqual(runHook("audit:rules", auditCtx()).warnings, ["[hot] v2 改过了"]);
});

await testAsync("入参是深冻结快照：插件改它会抛错（而不是把宿主改坏）", async () => {
  resetPlugins();
  writeHookPlugin(
    "hacker",
    'export default { "audit:rules": (ctx) => { try { ctx.brief.hacked = 1; return { warnings: ["没冻结"] }; } catch { return { warnings: ["已冻结"] }; } } };',
  );
  resetHookCache();
  await ensurePluginHooks();
  // 快照由调用方准备（runHook 刻意不替调用方冻结，避免冻住宿主的活对象）
  const ctx = { brief: frozenSnapshot({ real: true }), project: frozenSnapshot({}), lock: null };
  assert.deepEqual(runHook("audit:rules", ctx as never).warnings, ["[hacker] 已冻结"]);
});

await testAsync("声明了 hooks 但没有入口文件：报错指路，服务不崩", async () => {
  resetPlugins();
  write(
    "empty-hook/manifest.json",
    JSON.stringify({ apiVersion: 1, id: "empty-hook", name: "空钩子", provides: ["hooks"] }),
  );
  resetHookCache();
  await ensurePluginHooks();
  assert.equal(hasHook("audit:rules"), false);
  assert.ok(
    hookStatus().errors.some((e) => e.pluginId === "empty-hook" && e.message.includes("入口文件")),
    "要说清是缺入口文件，而不是静默不生效",
  );
});

await testAsync("停用插件：钩子立刻消失（文件不动）", async () => {
  resetPlugins();
  writeHookPlugin("toggled", 'export default { "audit:rules": () => ({ warnings: ["在"] }) };');
  resetHookCache();
  await ensurePluginHooks();
  assert.equal(hasHook("audit:rules"), true);

  setPluginEnabled("toggled", false);
  await ensurePluginHooks();
  assert.equal(hasHook("audit:rules"), false, "停用后不该还挂着一个已停用插件的钩子");
  setPluginEnabled("toggled", true);
  await ensurePluginHooks();
  assert.equal(hasHook("audit:rules"), true, "重新启用要能恢复");
});

/* ── 三个真实消费点：不是只测 runHook，而是测它真的接上了 ── */

await testAsync("接进自检：插件报 blocking 会让体检不通过", async () => {
  resetPlugins();
  writeHookPlugin(
    "strict",
    'export default { "audit:rules": () => ({ blocking: ["画面里没有人脸"], passed: ["时长合规"] }) };',
  );
  resetHookCache();
  await ensurePluginHooks();

  const r = auditBriefAgainstProject({} as never, { fps: 30, scenes: [] } as never);
  assert.equal(r.ok, false, "插件说 must-fix，体检就必须不通过");
  assert.ok(
    r.blocking.some((x) => x.includes("[strict] 画面里没有人脸")),
    `blocking 里要有插件项，实际：${JSON.stringify(r.blocking)}`,
  );
  assert.ok(r.passed.some((x) => x.includes("[strict] 时长合规")));
});

await testAsync("接进设计锁：brief:derive 的规则出现在 rules 里", async () => {
  resetPlugins();
  writeHookPlugin(
    "derive",
    'export default { "brief:derive": (ctx) => ({ lockRules: [`竞品：${ctx.brief.x?.competitor ?? "无"}`] }) };',
  );
  resetHookCache();
  await ensurePluginHooks();

  const lock = recomputeDesignLock({ form: "口播讲解", x: { competitor: "某品牌" } } as never);
  assert.ok(
    lock.rules.some((r) => r.includes("[derive] 竞品：某品牌")),
    `自定义问诊字段要能变成验收规则，实际：${JSON.stringify(lock.rules)}`,
  );
  // 判定字段不能被插件改：这条边界是设计锁的可信度来源
  assert.equal(typeof lock.maxTextElements, "number", "插件不能影响判定字段");
});

await testAsync("接进写入：ops:review 的提醒出现在 apply 的回执里", async () => {
  resetPlugins();
  writeHookPlugin(
    "watcher",
    'export default { "ops:review": (ctx) => ({ warnings: [`这批 ${ctx.ops.length} 条操作`] }) };',
  );
  resetHookCache();
  await ensurePluginHooks();

  const seed = { ...createSeedProject(), id: "hooktest", rev: 1 };
  writeProject(seed as never);
  const res = projects.apply("hooktest", [{ op: "update_project", patch: { name: "改个名" } } as never]);
  assert.ok(
    res.summary.some((s) => s.includes("[watcher] 这批 1 条操作")),
    `写入回执里要能看到插件复盘，实际：${JSON.stringify(res.summary)}`,
  );
});

/**
 * `ops:before`：写入**前**的把关，只给否决权。
 *
 * 三条边界都要守住：① 否决后工程一个字不动（rev/历史/文件）；② 只提醒不否决时照常写；
 * ③ 钩子自己炸了不拦（坏插件不该让人存不了盘）。
 */
await testAsync("写入前把关：blocking 非空 → 整批被拒，工程一个字没动", async () => {
  resetPlugins();
  writeHookPlugin(
    "gate2",
    // 只拦"改名成 新名"这一种，用来验证否决是按批、按内容判断的，不是一刀切
    'export default { "ops:before": (ctx) => ({ blocking: ctx.ops.some((o) => o.op === "update_project" && o.patch?.name === "新名") ? ["不许叫这个名字"] : [] }) };',
  );
  resetHookCache();
  await ensurePluginHooks();

  const seed = { ...createSeedProject(), id: "veto1", rev: 1, name: "原名" };
  writeProject(seed as never);
  const before = projects.get("veto1");
  const histBefore = projects.history("veto1").length;

  assert.throws(
    () => projects.apply("veto1", [{ op: "update_project", patch: { name: "新名" } } as never]),
    /拒绝这批写入/,
    "必须抛错，不能静默放行",
  );

  const after = projects.get("veto1");
  assert.equal(after.rev, before.rev, "rev 不能涨");
  assert.equal(after.name, "原名", "内容不能变");
  assert.equal(projects.history("veto1").length, histBefore, "历史里不能多出一笔");
  // 回读磁盘：不能是"内存没变但已经落盘了"
  assert.equal(readProject("veto1").name, "原名", "磁盘上也不能变");

  // 换成不被禁的名字就应当放行：否决是按内容/按批的，不是把这个工程锁死
  projects.apply("veto1", [{ op: "update_project", patch: { name: "别的名字" } } as never]);
  assert.equal(projects.get("veto1").name, "别的名字", "不触发规则时不该被拦");
  assert.ok(projects.get("veto1").rev > before.rev, "放行后 rev 正常上涨");
});

await testAsync("写入前把关：只给 warnings 时照常写入，并把提醒放进回执", async () => {
  resetPlugins();
  writeHookPlugin("softgate", 'export default { "ops:before": () => ({ warnings: ["记得抽帧核对"] }) };');
  resetHookCache();
  await ensurePluginHooks();

  const seed = { ...createSeedProject(), id: "veto2", rev: 1 };
  writeProject(seed as never);
  const res = projects.apply("veto2", [{ op: "update_project", patch: { name: "放行了" } } as never]);
  assert.equal(projects.get("veto2").name, "放行了", "只提醒不该拦");
  assert.ok(
    res.summary.some((s) => s.includes("[softgate] 记得抽帧核对")),
    `提醒要进回执，实际：${JSON.stringify(res.summary)}`,
  );
});

await testAsync("写入前把关：钩子自己抛错 → 不拦，照常写入", async () => {
  resetPlugins();
  writeHookPlugin("badgate", 'export default { "ops:before": () => { throw new Error("我坏了"); } };');
  resetHookCache();
  await ensurePluginHooks();

  const seed = { ...createSeedProject(), id: "veto3", rev: 1 };
  writeProject(seed as never);
  assert.doesNotThrow(
    () => projects.apply("veto3", [{ op: "update_project", patch: { name: "照写" } } as never]),
    "坏钩子不能让用户存不了盘",
  );
  assert.equal(projects.get("veto3").name, "照写");
});

/* ────────────────────────── 工具插件（批次 4b） ────────────────────────── */

const { ensurePluginTools, pluginToolStatus, resetPluginToolCache } = await import(
  "../server/plugin/plugin-tools"
);
const { PERMISSIONS, parseManifest } = await import("../server/plugin/manifest");
const { pluginTools } = await import("../server/plugin/tool-registry");
const { buildParamShape } = await import("../server/plugin/tool-params");

/** 写一个只含 tools 的插件（返回工具必须显式调用，插件体里不自动执行） */
const writeToolPlugin = (dir: string, toolsBody: string, permissions: string[] = []) => {
  write(
    `${dir}/manifest.json`,
    JSON.stringify({ apiVersion: 1, id: dir, name: dir, provides: ["hooks"], permissions }),
  );
  write(`${dir}/plugin.ts`, `export default { tools: ${toolsBody} };`);
};

const toolByName = (name: string) => pluginTools().find((t) => t.name === name);

await testAsync("权限表：白名单里只有能执法的读/写两条（写了别的会被忽略并说明）", async () => {
  assert.deepEqual([...PERMISSIONS], ["project:read", "project:write"]);
  /*
   * 白名单缩小的意义就在这条：作者写了 `net` / `render`，必须**当场**得到反馈，
   * 而不是以为自己在某个版本里能用。这是「能声明却不生效」的唯一出口。
   */
  const parsed = parseManifest(
    { id: "p", name: "p", version: "1.0.0", provides: [], permissions: ["project:read", "net", "exec"] },
    { dirId: "p" },
  );
  assert.deepEqual(parsed.manifest?.permissions, ["project:read"], "未在册的权限要被过滤掉");
  assert.ok(
    parsed.warnings.some((w) => w.includes("net") && w.includes("未知权限")),
    `未知权限要有警告，实际：${JSON.stringify(parsed.warnings)}`,
  );
});

await testAsync("参数声明：各类型都能转成 zod，必填/可选/default 各自生效", async () => {
  const { shape, issues } = buildParamShape({
    a: { type: "string", required: true, desc: "必填文本" },
    b: { type: "number", min: 1, max: 9 },
    c: { type: "boolean", default: true },
    d: { type: "enum", values: ["x", "y"] },
    e: { type: "stringArray" },
  });
  assert.deepEqual(issues, []);
  assert.equal(shape.a.safeParse(undefined).success, false, "required 要拒空");
  assert.equal(shape.b.safeParse(0).success, false, "min 要生效");
  assert.equal(shape.c.parse(undefined), true, "default 要生效");
  assert.equal(shape.d.safeParse("z").success, false, "enum 要拒非法值");
  assert.equal(shape.e.safeParse(["k"]).success, true);
});

await testAsync("参数声明写坏：报出来且不注册（参数错的工具比没有更糟）", async () => {
  const bad1 = buildParamShape({ e: { type: "enum", values: ["only"] } });
  assert.ok(bad1.issues.some((x) => x.includes("values 少于两个")), JSON.stringify(bad1.issues));
  const bad2 = buildParamShape({ "Bad-Name": { type: "string" } });
  assert.ok(bad2.issues.some((x) => x.includes("不合法")));
  const bad3 = buildParamShape({ x: { type: "object" } });
  assert.ok(bad3.issues.some((x) => x.includes("不支持")));
});

await testAsync("工具注册：注册后能按名查到，参数 schema 已建好", async () => {
  resetPlugins();
  writeToolPlugin(
    "tk",
    '[{ name: "tk_hello", description: "打个招呼", params: { who: { type: "string", required: true, desc: "谁" } }, run: (a) => `hi ${a.who}` }]',
  );
  resetPluginToolCache();
  const st = await ensurePluginTools();
  assert.equal(st.count, 1);
  assert.deepEqual(st.plugins, ["tk"]);
  const def = toolByName("tk_hello")!;
  assert.ok(def, "工具应能被查到");
  assert.equal(def.shape.who.safeParse(undefined).success, false);
});

await testAsync("工具名撞内置 / 撞别的插件：拒绝注册并说明原因", async () => {
  resetPlugins();
  writeToolPlugin("dup", '[{ name: "preview_frames", description: "撞内置", run: () => "x" }]');
  writeToolPlugin("dup2", '[{ name: "dup2_a", description: "占位", run: () => "x" }]');
  writeToolPlugin("dup3", '[{ name: "dup2_a", description: "撞别人的", run: () => "x" }]');
  resetPluginToolCache();
  const st = await ensurePluginTools();
  assert.ok(
    st.errors.some((e) => e.pluginId === "dup" && e.message.includes("内置工具重名")),
    `要指出撞了内置：${JSON.stringify(st.errors)}`,
  );
  assert.ok(
    st.errors.some((e) => e.pluginId === "dup3" && e.message.includes("别的插件工具重名")),
    `要指出撞了别的插件：${JSON.stringify(st.errors)}`,
  );
  assert.ok(toolByName("dup2_a"), "没撞名的那个要留下");
  assert.equal(toolByName("preview_frames"), undefined, "撞内置的不能覆盖内置");
});

await testAsync("工具名不合法 / 缺 description / 缺 run：三个都拒，且不拖垮别的", async () => {
  resetPlugins();
  writeToolPlugin(
    "bad",
    '[' +
      '{ name: "Bad Name", description: "名字不合法", run: () => "x" },' +
      '{ name: "bad_nodesc", run: () => "x" },' +
      '{ name: "bad_norun", description: "没有 run" },' +
      '{ name: "bad_ok", description: "这个是对的", run: () => "ok" }' +
      "]",
  );
  resetPluginToolCache();
  const st = await ensurePluginTools();
  assert.equal(st.count, 1, "只该注册那条合法的");
  assert.equal(st.errors.length, 3, `三条错各报一次，实际：${JSON.stringify(st.errors)}`);
  assert.ok(toolByName("bad_ok"));
});

await testAsync("权限：没声明就读工程 → PermissionDenied，报错说清缺哪条", async () => {
  resetPlugins();
  writeToolPlugin(
    "noperm",
    '[{ name: "noperm_read", description: "读但不声明权限", run: (a, ctx) => JSON.stringify(ctx.listProjects()) }]',
  );
  resetPluginToolCache();
  await ensurePluginTools();
  const def = toolByName("noperm_read")!;
  await assert.rejects(
    () => def.run({}),
    (err: Error) => err.message.includes("project:read") && err.message.includes("没有声明"),
    "没声明权限必须抛错，不能静默返回空",
  );
});

await testAsync("权限：声明了 project:read 就能读真工程", async () => {
  resetPlugins();
  writeToolPlugin(
    "canread",
    '[{ name: "canread_get", description: "读工程名", params: { id: { type: "string", required: true, desc: "工程 id" } }, run: (a, ctx) => String((ctx.readProject(a.id) as any).name) }]',
    ["project:read"],
  );
  resetPluginToolCache();
  await ensurePluginTools();
  const seed = { ...createSeedProject(), id: "permtest", name: "有权限能读" };
  writeProject(seed as never);
  const out = await toolByName("canread_get")!.run({ id: "permtest" });
  assert.equal(out, "有权限能读");
});

await testAsync("权限：没 project:write 就改不了工程（读了也不能顺手写）", async () => {
  resetPlugins();
  writeToolPlugin(
    "readonly",
    '[{ name: "readonly_write", description: "只声明了读却想写", run: (a, ctx) => JSON.stringify(ctx.applyOps("permtest", [{ op: "update_project", patch: { name: "被改了" } }])) }]',
    ["project:read"],
  );
  resetPluginToolCache();
  await ensurePluginTools();
  await assert.rejects(
    () => toolByName("readonly_write")!.run({}),
    (err: Error) => err.message.includes("project:write"),
  );
});

await testAsync("权限：声明 project:write 后写入真的落库，actor 记为 plugin:<id>", async () => {
  resetPlugins();
  writeToolPlugin(
    "writer",
    '[{ name: "writer_rename", description: "改工程名", run: (a, ctx) => JSON.stringify(ctx.applyOps("permtest", [{ op: "update_project", patch: { name: "插件改的名" } }])) }]',
    ["project:read", "project:write"],
  );
  resetPluginToolCache();
  await ensurePluginTools();
  const out = JSON.parse(String(await toolByName("writer_rename")!.run({})));
  assert.ok(out.rev > 0, "要回新的 rev");
  const after = readProject("permtest");
  assert.equal(after.name, "插件改的名");
  const hist = projects.history("permtest")[0];
  assert.equal(hist?.actor, "plugin:writer", `历史里要看出是插件改的，实际：${hist?.actor}`);
});

await testAsync("返回值不是字符串：序列化成 JSON（别让 agent 收到空回执）", async () => {
  resetPlugins();
  writeToolPlugin(
    "objret",
    '[{ name: "objret_echo", description: "返回对象", run: () => ({ a: 1 }) }]',
  );
  resetPluginToolCache();
  await ensurePluginTools();
  assert.equal(await toolByName("objret_echo")!.run({}), '{\n  "a": 1\n}');
});

await testAsync("改代码后重新 ensure：工具描述跟着变（热更新）", async () => {
  resetPlugins();
  writeToolPlugin("hot2", '[{ name: "hot2_t", description: "v1 描述", run: () => "x" }]');
  resetPluginToolCache();
  await ensurePluginTools();
  assert.equal(toolByName("hot2_t")!.description, "v1 描述");

  writeToolPlugin("hot2", '[{ name: "hot2_t", description: "v2 改过了", run: () => "x" }]');
  await ensurePluginTools();
  assert.equal(toolByName("hot2_t")!.description, "v2 改过了");
});

await testAsync("停用插件：它加的工具立刻消失", async () => {
  resetPlugins();
  writeToolPlugin("offme", '[{ name: "offme_t", description: "会被停用", run: () => "x" }]');
  resetPluginToolCache();
  await ensurePluginTools();
  assert.ok(toolByName("offme_t"));

  setPluginEnabled("offme", false);
  await ensurePluginTools();
  assert.equal(toolByName("offme_t"), undefined, "停用后工具不能还挂着");
  setPluginEnabled("offme", true);
});

await testAsync("加载失败的工具插件：不抛、不连累别人，错误由钩子侧报出", async () => {
  resetPlugins();
  write("broken/plugin.ts", "export default { tools: [ 这不是合法 JS ][ };");
  writeToolPlugin("goodone", '[{ name: "goodone_t", description: "正常的工具", run: () => "ok" }]');
  resetPluginToolCache();
  resetHookCache();
  const st = await ensurePluginTools(); // 不该抛
  assert.equal(st.count, 1, "好插件的工具要照常注册");
  assert.ok(toolByName("goodone_t"), "坏插件不能连累好插件");
  await ensurePluginHooks();
  assert.ok(
    hookStatus().errors.some((e) => e.pluginId === "broken" && e.message.includes("入口加载失败")),
    `加载失败必须有地方说清楚：${JSON.stringify(hookStatus().errors)}`,
  );
});

/* ────────────────────────── 文本处理链（字幕/稿件） ────────────────────────── */

const { runTextPipeline, textStepsToNote } = await import("../server/plugin/hooks");

/** 写一个只做文本处理的插件 */
const writeTextPlugin = (dir: string, body: string) => {
  write(`${dir}/plugin.ts`, `export default { "text:transform": ${body} };`);
};

const runText = (text: string, kind: "subtitle" | "script" | "brief" = "subtitle") =>
  runTextPipeline(text, { kind, projectId: "t", sceneId: "s1" });

await testAsync("文本链：没有插件时原样返回（changed=false）", async () => {
  resetPlugins();
  resetHookCache();
  await ensurePluginHooks();
  const r = runText("然后我们的产品很好用");
  assert.equal(r.changed, false);
  assert.equal(r.text, "然后我们的产品很好用");
  assert.deepEqual(r.steps, []);
});

await testAsync("文本链：单个插件能改字，并记下改了哪一步", async () => {
  resetPlugins();
  writeTextPlugin("t1", '(ctx) => ctx.text.replace("我们的产品", "星河 OS")');
  resetHookCache();
  await ensurePluginHooks();
  const r = runText("我们的产品上线了");
  assert.equal(r.text, "星河 OS上线了");
  assert.equal(r.changed, true);
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].pluginId, "t1");
  assert.match(textStepsToNote(r), /t1/);
});

await testAsync("文本链：多插件按顺序串（上一个的输出是下一个的输入）", async () => {
  resetPlugins();
  writeTextPlugin("aa", '(ctx) => ctx.text.replace("甲", "乙")');
  writeTextPlugin("bb", '(ctx) => ctx.text.replace("乙", "丙")');
  resetHookCache();
  await ensurePluginHooks();
  const r = runText("甲方案");
  assert.equal(r.text, "丙方案", "两段替换都该生效");
  assert.deepEqual(
    r.steps.map((s) => s.pluginId),
    ["aa", "bb"],
    "顺序要按插件 id 稳定（否则每次结果可能不一样）",
  );
});

await testAsync("文本链：返回 { text } 也认", async () => {
  resetPlugins();
  writeTextPlugin("obj", '(ctx) => ({ text: ctx.text + "！" })');
  resetHookCache();
  await ensurePluginHooks();
  assert.equal(runText("好").text, "好！");
});

await testAsync("文本链：返回空字符串 → 拒收（不能一句话把字幕清空）", async () => {
  resetPlugins();
  writeTextPlugin("wipe", '() => ""');
  resetHookCache();
  await ensurePluginHooks();
  const r = runText("这句话不能没");
  assert.equal(r.text, "这句话不能没");
  assert.equal(r.changed, false);
  assert.ok(r.warnings.some((w) => w.includes("空文本")), JSON.stringify(r.warnings));
});

await testAsync("文本链：输出暴涨 → 拒收（多半是把整句换成了模板）", async () => {
  resetPlugins();
  writeTextPlugin("boom", '() => "很长".repeat(500)');
  resetHookCache();
  await ensurePluginHooks();
  const r = runText("短句");
  assert.equal(r.text, "短句");
  assert.ok(r.warnings.some((w) => w.includes("输出长度异常")), JSON.stringify(r.warnings));
});

await testAsync("文本链：一个插件抛错，其余照常，警告里说清是谁", async () => {
  resetPlugins();
  writeTextPlugin("bad", '() => { throw new Error("我坏了"); }');
  writeTextPlugin("good", '(ctx) => ctx.text + "。"');
  resetHookCache();
  await ensurePluginHooks();
  const r = runText("句子");
  assert.equal(r.text, "句子。");
  assert.ok(r.warnings.some((w) => w.includes("bad") && w.includes("出错")), JSON.stringify(r.warnings));
});

await testAsync("文本链：返回非文本（数字）→ 跳过，不崩", async () => {
  resetPlugins();
  writeTextPlugin("num", "() => 42");
  resetHookCache();
  await ensurePluginHooks();
  const r = runText("原样");
  assert.equal(r.text, "原样");
  assert.ok(r.warnings.some((w) => w.includes("没返回文本")), JSON.stringify(r.warnings));
});

await testAsync("文本链：超长文本整条跳过（它跑在保存路径上）", async () => {
  resetPlugins();
  writeTextPlugin("slow", '(ctx) => ctx.text + "x"');
  resetHookCache();
  await ensurePluginHooks();
  const huge = "字".repeat(20001);
  const r = runText(huge);
  assert.equal(r.changed, false);
  assert.equal(r.text.length, 20001);
  assert.ok(r.warnings.some((w) => w.includes("超过处理上限")), JSON.stringify(r.warnings));
});

await testAsync("文本链：kind 会传给插件（brief 可以自己决定不动手）", async () => {
  resetPlugins();
  writeTextPlugin("kinder", '(ctx) => (ctx.kind === "brief" ? ctx.text : ctx.text + "[改]")');
  resetHookCache();
  await ensurePluginHooks();
  assert.equal(runText("x", "brief").text, "x");
  assert.equal(runText("x", "script").text, "x[改]");
});

await testAsync("文本链：幂等（跑两次和跑一次一样）", async () => {
  resetPlugins();
  // 这是示例插件的核心写法：替换后不再命中、口头禅删到删不动
  writeTextPlugin(
    "idem",
    `(ctx) => {
      let s = ctx.text.replace(/我们的产品/g, "星河 OS");
      s = s.split("\\n").map((line) => {
        let prev = line, cur = line.replace(/^(然后|就是说)[，,]?/, "");
        while (cur !== prev) { prev = cur; cur = cur.replace(/^(然后|就是说)[，,]?/, ""); }
        return cur;
      }).join("\\n");
      return s;
    }`,
  );
  resetHookCache();
  await ensurePluginHooks();
  const once = runText("然后就是说我们的产品上线了");
  const twice = runText(once.text);
  assert.equal(twice.text, once.text, `非幂等会让 agent 反复保存越改越远：${once.text} → ${twice.text}`);
  assert.equal(twice.changed, false, "第二次不该再有改动");
});

/* ────────────────────────── 工程化插件（package.json） ────────────────────────── */

const { resolvePluginEntry, lintPackage } = await import("../server/plugin/entry");

/** 造一个工程化插件目录 */
const mkEng = (
  dir: string,
  pkg: Record<string, unknown>,
  dist: string | null,
  extra: Record<string, string> = {},
): string => {
  write(`${dir}/package.json`, JSON.stringify(pkg, null, 2));
  if (dist !== null) write(`${dir}/dist/index.mjs`, dist);
  for (const [rel, content] of Object.entries(extra)) write(`${dir}/${rel}`, content);
  return path.join(PLUGIN_DIR, dir);
};

test("工程化：exports 指向已构建产物 → module 模式（不交给 esbuild）", () => {
  resetPlugins();
  const dir = mkEng("eng1", { name: "e1", version: "1.0.0", exports: { ".": "./dist/index.mjs" } }, "export default {};");
  const r = resolvePluginEntry(dir);
  assert.equal(r.kind, "module");
  assert.ok(r.file?.endsWith(path.join("dist", "index.mjs")), `入口不对：${r.file}`);
  assert.match(r.detail, /不打包/);
});

test("工程化：main 也能认（很多包只写 main）", () => {
  resetPlugins();
  const dir = mkEng("eng2", { name: "e2", version: "1.0.0", main: "./dist/main.mjs" }, null, {
    "dist/main.mjs": "export default {};",
  });
  assert.equal(resolvePluginEntry(dir).kind, "module");
});

test("工程化：exports 省略 \".\" 的常见写法也认", () => {
  resetPlugins();
  const dir = mkEng("eng3", { name: "e3", version: "1.0.0", exports: { import: "./dist/i.mjs", require: "./dist/i.cjs" } }, null, {
    "dist/i.mjs": "export default {};",
  });
  const r = resolvePluginEntry(dir);
  assert.equal(r.kind, "module");
  assert.ok(r.file?.endsWith("i.mjs"), "应优先 ESM 入口");
});

test("工程化：exports 写成字符串也认", () => {
  resetPlugins();
  const dir = mkEng("eng4", { name: "e4", version: "1.0.0", exports: "./dist/s.mjs" }, null, {
    "dist/s.mjs": "export default {};",
  });
  assert.equal(resolvePluginEntry(dir).kind, "module");
});

test("工程化：没写 main/exports 但按约定有 dist/index.mjs → 也能用", () => {
  resetPlugins();
  const dir = mkEng("eng5", { name: "e5", version: "1.0.0" }, "export default {};");
  const r = resolvePluginEntry(dir);
  assert.equal(r.kind, "module");
  assert.match(r.detail, /按约定/);
});

test("工程化：入口指向不存在的文件 → unbuilt，且提示要跑哪两条命令", () => {
  resetPlugins();
  const dir = mkEng("eng6", {
    name: "e6",
    version: "1.0.0",
    exports: { ".": "./dist/index.mjs" },
    scripts: { build: "tsc" },
  }, null);
  const r = resolvePluginEntry(dir);
  assert.equal(r.kind, "unbuilt");
  assert.match(r.detail, /不存在/);
  assert.match(r.hint!, /npm install && npm run build/, `提示要具体到命令：${r.hint}`);
});

test("工程化：没写 build 脚本时，提示不硬编 npm run build", () => {
  resetPlugins();
  const dir = mkEng("eng7", { name: "e7", version: "1.0.0", exports: { ".": "./dist/x.mjs" }, dependencies: { a: "1" } }, null);
  const r = resolvePluginEntry(dir);
  assert.equal(r.kind, "unbuilt");
  assert.match(r.hint!, /npm install/);
  assert.ok(!/npm run build/.test(r.hint!), `没有 build 脚本就不该让人跑 build：${r.hint}`);
});

test("工程化：package.json 坏了 → unbuilt，且说清是 JSON 问题", () => {
  resetPlugins();
  write("eng8/package.json", "{ 这不是 JSON }");
  const r = resolvePluginEntry(path.join(PLUGIN_DIR, "eng8"));
  assert.equal(r.kind, "unbuilt");
  assert.match(r.detail, /解析失败/);
});

test("普通 npm 包目录（不像插件）：静默跳过，不误报成坏插件", () => {
  resetPlugins();
  write("somedep/package.json", JSON.stringify({ name: "lodash-like", version: "1.0.0" }));
  write("somedep/README.md", "一个跟本宿主无关的包");
  assert.deepEqual(scanPlugins(), [], "有 package.json 不等于就是插件");
});

test("工程化：package.json 就是清单（name/version/remotionStudio 生效）", () => {
  resetPlugins();
  mkEng(
    "engpkg",
    {
      name: "@scope/rhythm",
      version: "3.2.1",
      description: "节奏检查",
      exports: { ".": "./dist/index.mjs" },
      remotionStudio: { provides: ["hooks"], permissions: [] },
    },
    "export default {};",
  );
  const p = scanPlugins().find((x) => x.id === "engpkg");
  assert.ok(p, "应被发现");
  assert.equal(p.name, "@scope/rhythm");
  assert.equal(p.version, "3.2.1");
  assert.deepEqual(p.provides, ["hooks"]);
  assert.equal(p.manifest?.description, "节奏检查");
});

test("id 取目录名而不是 npm 包名（@scope/x 不能当启用键）", () => {
  resetPlugins();
  mkEng("scoped", { name: "@scope/some-thing", version: "1.0.0", exports: { ".": "./dist/index.mjs" } }, "export default {};");
  const p = scanPlugins().find((x) => x.id === "scoped");
  assert.ok(p, `应能用目录名找到，实际：${scanPlugins().map((x) => x.id).join(",")}`);
});

test("lintPackage：把 react 写进 dependencies 要警告（否则渲染时 Invalid hook call）", () => {
  const w = lintPackage({ dependencies: { react: "^18", remotion: "4" } });
  assert.ok(w.some((x) => x.includes("peerDependencies")), `应提示改 peerDependencies：${w.join("/")}`);
});

await testAsync("工程化插件能用自己 node_modules 里的依赖（关键能力）", async () => {
  resetPlugins();
  mkEng(
    "engdep",
    { name: "engdep", version: "1.0.0", exports: { ".": "./dist/index.mjs" } },
    'import { tag } from "tiny-helper";\nexport default { "audit:rules": () => ({ warnings: ["dep:" + tag] }) };\n',
    {
      "node_modules/tiny-helper/package.json": JSON.stringify({ name: "tiny-helper", version: "1.0.0", type: "module", main: "index.js" }),
      "node_modules/tiny-helper/index.js": 'export const tag = "OK";\n',
    },
  );
  resetHookCache();
  await ensurePluginHooks();
  const v = runHook("audit:rules", auditCtx());
  assert.ok(
    v.warnings.some((w) => w.includes("dep:OK")),
    `依赖没解析到（单文件模式会编译失败，工程模式应该成功）：${v.warnings.join("/")}`,
  );
});

await testAsync("工程化插件热更新：改 dist 后重新 ensure 生效", async () => {
  resetPlugins();
  mkEng(
    "enghot",
    { name: "enghot", version: "1.0.0", exports: { ".": "./dist/index.mjs" } },
    'export default { "audit:rules": () => ({ warnings: ["v1"] }) };\n',
  );
  resetHookCache();
  await ensurePluginHooks();
  assert.deepEqual(runHook("audit:rules", auditCtx()).warnings, ["[enghot] v1"]);

  // 内容变长 → size 与 mtime 都变 → 指纹变 → 重新 import
  write("enghot/dist/index.mjs", 'export default { "audit:rules": () => ({ warnings: ["v2 改过了"] }) };\n');
  resetHookCache();
  await ensurePluginHooks();
  assert.deepEqual(runHook("audit:rules", auditCtx()).warnings, ["[enghot] v2 改过了"]);
});

await testAsync("工程化插件未构建：报错指路，且不拖垮别的插件", async () => {
  resetPlugins();
  mkEng("engbad", { name: "engbad", version: "1.0.0", exports: { ".": "./dist/index.mjs" } }, null);
  mkEng(
    "enggood",
    { name: "enggood", version: "1.0.0", exports: { ".": "./dist/index.mjs" } },
    'export default { "audit:rules": () => ({ warnings: ["我好着"] }) };\n',
  );
  resetHookCache();
  const st = await ensurePluginHooks();

  const bad = st.errors.find((e) => e.pluginId === "engbad");
  assert.ok(bad, `未构建要报出来：${JSON.stringify(st.errors)}`);
  assert.match(bad!.message, /dist\/index\.mjs/, "要说清是哪条路径不对");
  assert.deepEqual(runHook("audit:rules", auditCtx()).warnings, ["[enggood] 我好着"], "好的那个必须照常工作");
});

await testAsync("单文件与工程共存：两种插件同时生效", async () => {
  resetPlugins();
  writeHookPlugin("legacy", 'export default { "audit:rules": () => ({ warnings: ["单文件"] }) };');
  mkEng(
    "modern",
    { name: "modern", version: "1.0.0", exports: { ".": "./dist/index.mjs" } },
    'export default { "audit:rules": () => ({ warnings: ["工程"] }) };\n',
  );
  resetHookCache();
  await ensurePluginHooks();
  const ws = runHook("audit:rules", auditCtx()).warnings;
  assert.ok(ws.some((w) => w.includes("单文件")), `单文件插件失效了：${ws.join("/")}`);
  assert.ok(ws.some((w) => w.includes("工程")), `工程插件失效了：${ws.join("/")}`);
});

/* ────────────────────────── 文件处理链 ────────────────────────── */

const { hasMediaProcessor, runMediaPipeline, mediaStepsToNote } = await import("../server/plugin/hooks");
const { ingestAsset, reprocessProjectAssets, readProvenance, processorFingerprint } = await import(
  "../server/asset-pipeline.service"
);
const { projectAssetDir } = await import("../server/assets.service");

/** 造一个"媒体文件"。宿主按扩展名分类、按字节流处理，不解码，所以内容随便写 */
const mkMedia = (name: string, content: string): string => {
  const f = path.join(TMP, "media", name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
};

/**
 * 装载一批媒体处理器插件（每个 dir 一段源码）。
 *
 * 必须显式 `setPluginEnabled(dir, true)`：停用状态是持久化在 data/plugins.json 里的，
 * `resetPlugins()` 只删目录、不清状态。所以"上一个用例停用了同名插件"会静默影响
 * 下一个用例——现象是插件明明写了却没生效。
 */
const loadMedia = async (plugins: Record<string, string>) => {
  resetPlugins();
  for (const [dir, body] of Object.entries(plugins)) {
    writeHookPlugin(dir, body);
    setPluginEnabled(dir, true);
  }
  resetHookCache();
  await ensurePluginHooks();
};

await testAsync("没有文件处理器：不读文件、buffer 为空（开销为零）", async () => {
  resetPlugins();
  resetHookCache();
  await ensurePluginHooks();
  assert.equal(hasMediaProcessor(), false);
  const f = mkMedia("a.png", "原始内容");
  const r = await runMediaPipeline({ file: f, fileName: "a.png", kind: "image" });
  assert.equal(r.changed, false);
  assert.equal(r.buffer.length, 0, "没有处理器时不该把文件读进内存");
  assert.deepEqual(r.steps, []);
});

await testAsync("处理器返回 buffer：内容被替换，记一步并带 note", async () => {
  await loadMedia({
    img: 'export default { "media:process": (ctx) => ctx.kind === "image" ? { buffer: Buffer.from("处理过"), note: "打了个标" } : null };',
  });
  const f = mkMedia("b.png", "原始内容");
  const r = await runMediaPipeline({ file: f, fileName: "b.png", kind: "image" });
  assert.equal(r.changed, true);
  assert.equal(r.buffer.toString(), "处理过");
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].pluginId, "img");
  assert.match(mediaStepsToNote(r), /img/);
});

await testAsync("返回 null = 看过但不动手：不算一步，也不算故障", async () => {
  await loadMedia({ picky: 'export default { "media:process": () => null };' });
  const f = mkMedia("c.png", "原样");
  const r = await runMediaPipeline({ file: f, fileName: "c.png", kind: "image" });
  assert.equal(r.changed, false);
  assert.deepEqual(r.warnings, [], "不处理是设计，不该进警告");
});

await testAsync("返回空文件：拒收（否则素材会变成 0 字节）", async () => {
  await loadMedia({ zero: 'export default { "media:process": () => ({ buffer: Buffer.alloc(0) }) };' });
  const f = mkMedia("d.png", "有内容");
  const r = await runMediaPipeline({ file: f, fileName: "d.png", kind: "image" });
  assert.equal(r.changed, false);
  assert.ok(r.warnings.some((w) => w.includes("空文件")), `应有空文件警告：${r.warnings.join("/")}`);
});

await testAsync("输出暴涨：拒收（防插件把 2MB 图变成 200MB）", async () => {
  await loadMedia({ fat: 'export default { "media:process": () => ({ buffer: Buffer.alloc(8 * 1024 * 1024) }) };' });
  const f = mkMedia("e.png", "x".repeat(200));
  const r = await runMediaPipeline({ file: f, fileName: "e.png", kind: "image" });
  assert.equal(r.changed, false);
  assert.ok(r.warnings.some((w) => w.includes("体积异常")), `应有体积警告：${r.warnings.join("/")}`);
});

await testAsync("抛错只跳过自己，后面的插件照常跑", async () => {
  await loadMedia({
    boom: 'export default { "media:process": () => { throw new Error("我坏了"); } };',
    fine: 'export default { "media:process": () => ({ buffer: Buffer.from("fine 处理了") }) };',
  });
  const f = mkMedia("f.png", "原始");
  const r = await runMediaPipeline({ file: f, fileName: "f.png", kind: "image" });
  assert.equal(r.changed, true, "坏插件不该让整条链失效");
  assert.equal(r.buffer.toString(), "fine 处理了");
  assert.ok(r.warnings.some((w) => w.includes("boom")), "出错的插件要被点名");
});

await testAsync("多处理器是流水线：后一个拿到前一个的结果", async () => {
  await loadMedia({
    "a-wrap": 'export default { "media:process": (ctx) => ({ buffer: Buffer.from("[" + ctx.buffer.toString() + "]") }) };',
    "b-bang": 'export default { "media:process": (ctx) => ({ buffer: Buffer.from(ctx.buffer.toString() + "!") }) };',
  });
  const f = mkMedia("g.png", "x");
  const r = await runMediaPipeline({ file: f, fileName: "g.png", kind: "image" });
  assert.equal(r.buffer.toString(), "[x]!");
  assert.deepEqual(r.steps.map((s) => s.pluginId), ["a-wrap", "b-bang"]);
});

test("runHook 遇到异步钩子直接报错（不静默返回空意见）", () => {
  assert.throws(
    () => runHook("media:process" as never, {} as never),
    /异步钩子/,
    "异步钩子被当成 verdict 用会得到空结果，必须当场炸",
  );
});

/* ── 落盘：原文件必须永远保留 ── */

const PID = "__test_media__";
/**
 * 删掉本用例自己的那几个文件。
 *
 * ## 为什么不做"清空整个目录"
 *
 * 本机有 safe-delete 钩子：**任何**删除操作（`rmSync` 和 `unlinkSync` 都算）累计到
 * 50 个文件就整轮拒绝（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。而 `npm test` 会先跑
 * 十几个别的脚本，到这一节时配额已经快用完了 —— 删除被静默拒绝，文件就留在目录里，
 * 后面的断言看到一堆别人的文件，报出「6 !== 2」这种完全指错方向的错。
 *
 * 所以改成两个更稳的做法：
 *  1. 每个用例用**独有的文件名**（shot / a / b / same / plain / old1 / old2），互不覆盖
 *  2. 断言只数自己那几个（`startsWith` 过滤），不去数整个目录
 *
 * 这比"清空再断言"更能说明测试在测什么：它测的是"我这个文件被怎么处理了"，
 * 不是"目录里一共有几个文件"。
 */
/** 按前缀删（产物名带指纹后缀，事先算不出来，只能按前缀清） */
const rmPrefix = (...prefixes: string[]) => {
  const dir = projectAssetDir(PID);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const f of files) {
    if (!prefixes.some((p) => f.startsWith(p))) continue;
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* 同上 */
    }
  }
};

const rmFiles = (...names: string[]) => {
  const dir = projectAssetDir(PID);
  for (const n of names) {
    try {
      fs.unlinkSync(path.join(dir, n));
    } catch {
      /* 不存在就跳过；被钩子拒了也不影响——断言只数自己的文件 */
    }
  }
};

await testAsync("ingestAsset：原文件保留 + 产物带指纹后缀 + 溯源可查", async () => {
  rmFiles("shot.png");
  await loadMedia({ tag: 'export default { "media:process": () => ({ buffer: Buffer.from("TAGGED"), note: "打标" }) };' });
  const out = await ingestAsset(PID, "shot.png", Buffer.from("ORIGINAL"));
  assert.equal(out.processed, true, `应被处理：${JSON.stringify(out.warnings)}`);
  assert.match(out.name, /^shot@[a-z0-9]{5}\.png$/, `产物名应带指纹：${out.name}`);

  const dir = projectAssetDir(PID);
  assert.equal(fs.readFileSync(path.join(dir, "shot.png"), "utf8"), "ORIGINAL", "原文件必须还在（回滚全靠它）");
  assert.equal(fs.readFileSync(path.join(dir, out.name), "utf8"), "TAGGED");

  const prov = readProvenance(PID);
  assert.equal(prov[out.name]?.origin, "shot.png");
  assert.deepEqual(prov[out.name]?.plugins, ["tag"]);
});

await testAsync("两个不同原文件 → 两个不同产物（插件给固定文件名也不能互相覆盖）", async () => {
  rmFiles("a.png", "b.png");
  // 插件返回固定的 fileName —— 示例插件就是这么写的（"clean.jpg"）
  await loadMedia({
    fixname: 'export default { "media:process": () => ({ buffer: Buffer.from("CLEAN"), fileName: "clean.jpg" }) };',
  });
  const a = await ingestAsset(PID, "a.png", Buffer.from("A"));
  const b = await ingestAsset(PID, "b.png", Buffer.from("B"));
  assert.notEqual(a.name, b.name, `两个产物不能同名（否则第二张覆盖第一张）：${a.name}`);
  assert.match(a.name, /^a@[a-z0-9]{5}\.jpg$/, "base 要取原文件名，扩展名采纳插件的");
  assert.match(b.name, /^b@[a-z0-9]{5}\.jpg$/);
  assert.equal(fs.readFileSync(path.join(projectAssetDir(PID), a.name), "utf8"), "CLEAN");
});

await testAsync("重复 ingest 同一文件：产物同名（幂等，不堆副本）", async () => {
  rmFiles("same.png");
  await loadMedia({ tag: 'export default { "media:process": () => ({ buffer: Buffer.from("TAGGED") }) };' });
  const one = await ingestAsset(PID, "same.png", Buffer.from("X"));
  const two = await ingestAsset(PID, "same.png", Buffer.from("X"));
  assert.equal(two.name, one.name, "同一套处理器重跑应得到同一个文件名");
  const mine = fs.readdirSync(projectAssetDir(PID)).filter((f) => f.startsWith("same"));
  assert.equal(mine.length, 2, `应只有原文件 + 一个产物，实际：${mine.join("、")}`);
});

await testAsync("停用插件后：新上传不再处理，产物仍是原文件", async () => {
  rmFiles("plain.png");
  await loadMedia({ tag: 'export default { "media:process": () => ({ buffer: Buffer.from("TAGGED") }) };' });
  setPluginEnabled("tag", false);
  resetHookCache();
  await ensurePluginHooks();
  const out = await ingestAsset(PID, "plain.png", Buffer.from("ASIS"));
  assert.equal(out.processed, false);
  assert.equal(out.name, "plain.png", "没插件就该直接落原名");
  assert.equal(fs.readFileSync(path.join(projectAssetDir(PID), "plain.png"), "utf8"), "ASIS");
});

await testAsync("reprocess：dryRun 不写盘，false 才写，已是当前指纹的跳过", async () => {
  await loadMedia({ tag: 'export default { "media:process": () => ({ buffer: Buffer.from("TAGGED") }) };' });
  const dir = projectAssetDir(PID);
  fs.mkdirSync(dir, { recursive: true });
  // 连上一轮遗留的产物一起清（产物名带指纹，只能按前缀删）
  rmPrefix("old");
  fs.writeFileSync(path.join(dir, "old1.png"), "ONE");
  fs.writeFileSync(path.join(dir, "old2.png"), "TWO");

  const fp = processorFingerprint();
  // 目录里可能还有别的用例的文件，只断言 old* 这一组
  const mineOf = (items: { name: string; action: string }[]) => items.filter((i) => i.name.startsWith("old"));

  const dry = await reprocessProjectAssets(PID, {});
  const dryMine = mineOf(dry.items).filter((i) => i.action === "process");
  assert.equal(dryMine.length, 2, `应识别出两个待处理：${JSON.stringify(mineOf(dry.items))}`);
  assert.equal(fs.existsSync(path.join(dir, `old1@${fp}.png`)), false, "dryRun 不能写盘");

  const real = await reprocessProjectAssets(PID, { dryRun: false });
  assert.equal(mineOf(real.items).filter((i) => i.action === "process").length, 2);
  assert.equal(fs.readFileSync(path.join(dir, `old1@${fp}.png`), "utf8"), "TAGGED");

  // 再跑一次：已是当前指纹的产物要被跳过，不能 @fp@fp 叠名字
  const again = await reprocessProjectAssets(PID, { dryRun: false });
  assert.equal(
    mineOf(again.items).filter((i) => i.action === "process").length,
    0,
    `第二次不该再处理：${JSON.stringify(mineOf(again.items))}`,
  );
  const oldFiles = fs.readdirSync(dir).filter((f) => f.startsWith("old"));
  assert.equal(oldFiles.length, 4, `old1/old2 应各有原文件+产物，实际：${oldFiles.join("、")}`);
});

await testAsync("reprocess：没装处理器时明确说链是空的（不是静默 0）", async () => {
  resetPlugins();
  resetHookCache();
  await ensurePluginHooks();
  const r = await reprocessProjectAssets(PID, {});
  assert.equal(r.processed, 0);
  assert.ok(r.warnings.some((w) => w.includes("没有装")), `应说明原因：${r.warnings.join("/")}`);
});

/* ────────────────────────── 安装器：来源识别与目标命名 ────────────────────────── */

const {
  detectSourceKind,
  guessTargetName,
  normalizeGitUrl,
  splitNpmSpec,
  safeDirName,
  startInstall,
  cleanupPluginStaging,
} = await import("../server/plugin/installer.service");

test("安装器：git / npm / 本地目录三种来源都能认出来", () => {
  assert.equal(detectSourceKind("https://github.com/a/b"), "git");
  assert.equal(detectSourceKind("git@github.com:a/b.git"), "git");
  assert.equal(detectSourceKind("a/b"), "git");
  assert.equal(detectSourceKind("ssh://git@host/x.git"), "git");
  assert.equal(detectSourceKind("@scope/pkg"), "npm");
  assert.equal(detectSourceKind("pkg@1.2.3"), "npm");
  assert.equal(detectSourceKind("npm:pkg"), "npm");
  assert.equal(detectSourceKind(PLUGIN_DIR), "local");
});

test("安装器：认不出的来源返回 null，而不是硬猜", () => {
  assert.equal(detectSourceKind(""), null);
  assert.equal(detectSourceKind("这不是一个来源，还有中文"), null);
});

test("安装器：git 简写补成完整 URL，完整 URL 原样保留", () => {
  assert.equal(normalizeGitUrl("a/b"), "https://github.com/a/b.git");
  assert.equal(normalizeGitUrl("https://x.com/a/b"), "https://x.com/a/b");
});

test("安装器：npm spec 拆包名与版本（含 scoped）", () => {
  assert.deepEqual(splitNpmSpec("@scope/pkg@1.2.3"), { name: "@scope/pkg", version: "1.2.3" });
  assert.deepEqual(splitNpmSpec("pkg@^2"), { name: "pkg", version: "^2" });
  assert.deepEqual(splitNpmSpec("pkg"), { name: "pkg", version: "" });
  assert.deepEqual(splitNpmSpec("npm:pkg"), { name: "pkg", version: "" });
});

test("安装器：目标目录名取包名/仓库名，中文保留、非法字符替换", () => {
  assert.equal(guessTargetName("npm", "@scope/pkg"), "pkg");
  assert.equal(guessTargetName("git", "https://github.com/a/my-plugin.git"), "my-plugin");
  assert.equal(safeDirName("我的插件"), "我的插件");
  assert.equal(safeDirName("../etc/passwd"), "etc-passwd");
  assert.equal(safeDirName("a b  c"), "a-b-c");
});

test("安装器：本地目录优先用 package.json 的 name 当目录名", () => {
  const dir = path.join(TMP, "pkg-named");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@me/cool-plugin" }));
  assert.equal(guessTargetName("local", dir), "cool-plugin");
});

test("安装器：空来源 / 目标已存在都会立刻报错（不会起子进程）", () => {
  assert.throws(() => startInstall({ source: "   " }), /不能为空/);
  const dup = path.join(PLUGIN_DIR, "already-there");
  fs.mkdirSync(dup, { recursive: true });
  fs.writeFileSync(path.join(dup, "plugin.ts"), "export default {};\n");
  assert.throws(() => startInstall({ source: dup }), /已存在/);
});

test("安装器：启动时清掉残留的暂存目录", () => {
  const staging = path.join(PLUGIN_DIR, ".staging", "job-x");
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, "junk.txt"), "x");
  const cleaned = cleanupPluginStaging();
  assert.ok(cleaned.includes("job-x"), `应报告清理了 job-x：${cleaned.join("/")}`);
  assert.equal(fs.existsSync(staging), false);
});

await testAsync("预检：registry 清单里没有任何插件标志 → 拒绝下载", async () => {
  const { manifestRejectsPlugin } = await import("../server/plugin/installer.service");
  // 三种"明确是插件"的声明，一个都不能误杀
  assert.equal(manifestRejectsPlugin({ remotionStudio: { provides: ["hooks"] } }, "a"), null);
  assert.equal(manifestRejectsPlugin({ main: "dist/index.mjs" }, "a"), null);
  assert.equal(manifestRejectsPlugin({ exports: { ".": "./dist/index.js" } }, "a"), null);
  assert.equal(manifestRejectsPlugin({ keywords: ["remotion-studio", "plugin"] }, "a"), null);
  assert.equal(manifestRejectsPlugin({ files: ["skills", "README.md"] }, "a"), null);
  // 什么都没有 → 给出理由
  const why = manifestRejectsPlugin({ keywords: ["remotion", "mcp"], files: ["server", "web"] }, "some-app");
  assert.ok(why && why.includes("没有任何插件标志"), `应拒绝：${why}`);
});

await testAsync("预检：仓库目录树里有 skills/manifest.json 就算插件", async () => {
  const { treeLooksLikePlugin } = await import("../server/plugin/installer.service");
  assert.equal(treeLooksLikePlugin(["skills/a.md", "README.md"], null), true);
  assert.equal(treeLooksLikePlugin(["manifest.json"], null), true);
  assert.equal(treeLooksLikePlugin(["plugin.ts"], null), true);
  assert.equal(treeLooksLikePlugin(["src/index.ts", "package.json"], {}), false);
  assert.equal(treeLooksLikePlugin(["src/index.ts"], { main: "dist/x.js" }), true);
  assert.equal(treeLooksLikePlugin(["a.ts"], { remotionStudio: {} }), true);
});

await testAsync("未识别目录：装进来的包会列出来（可见），纯碎文件不打扰", async () => {
  const { scanOrphanDirs } = await import("../server/plugin/installer.service");

  // 有 package.json、没有插件标志 = 一次装错的痕迹
  const bad = path.join(PLUGIN_DIR, "wrong-pkg");
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, "package.json"), JSON.stringify({ name: "wrong-pkg", version: "1.0.0" }));
  fs.writeFileSync(path.join(bad, "index.js"), "module.exports = 1;\n");

  // 只有一个 README 的临时文件夹：不是安装痕迹，不该出现
  const scratch = path.join(PLUGIN_DIR, "scratch-notes");
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, "README.md"), "# 随手放的\n");

  const list = scanOrphanDirs();
  const names = list.map((o) => o.name);
  assert.ok(names.includes("wrong-pkg"), `应列出 wrong-pkg：${names.join("/")}`);
  assert.ok(!names.includes("scratch-notes"), "只有一个 README 的目录不该出现");

  const one = list.find((o) => o.name === "wrong-pkg")!;
  assert.ok(one.bytes > 0, "应统计到体积");
  assert.match(one.reason, /插件标志/);
});

await testAsync("未识别目录：能删（挪进回收站），删完就不在列表里", async () => {
  const { scanOrphanDirs, removeOrphanDir } = await import("../server/plugin/installer.service");
  const r = removeOrphanDir(path.join(PLUGIN_DIR, "wrong-pkg"));
  assert.ok(fs.existsSync(r.trash), `回收站里应有一份：${r.trash}`);
  assert.equal(fs.existsSync(r.dir), false);
  assert.ok(!scanOrphanDirs().some((o) => o.name === "wrong-pkg"));
});

await testAsync("未识别目录：拒绝删除插件目录之外的东西", async () => {
  const { removeOrphanDir } = await import("../server/plugin/installer.service");
  assert.throws(() => removeOrphanDir(path.join(TMP, "not-a-plugin")), /不在插件目录内/);
});

// 收尾清掉本文件自己造的文件（不删整个目录：safe-delete 会按数量拦）
rmFiles("shot.png", "a.png", "b.png", "same.png", "plain.png", "old1.png", "old2.png");

/* ────────────────────────── 首次启动：示例插件种子 ────────────────────────── */

/*
 * 这组用例直接操作 data/plugins.json（种子机制的对象），放在最后跑，
 * 不与前面"停用状态持久化"的用例互相污染。
 */
{
  const stateFile = path.join(DATA_DIR, "plugins.json");
  fs.rmSync(stateFile, { force: true });
  resetPlugins();
  write("_example-demo/skills/a.md", "# 示例");
  write("example-other/styles/a.md", "# 示例");
  write("real-plugin/styles/a.md", "# 真插件");
}

test("示例种子：全新环境把 _example-* / example-* 停用，真插件不动", () => {
  const seeded = seedExamplePluginsDisabled();
  assert.deepEqual(seeded.sort(), ["example-demo", "example-other"].sort());
  assert.equal(isPluginEnabled("example-demo"), false, "示例应被停用");
  assert.equal(isPluginEnabled("real-plugin"), true, "普通插件必须照常默认启用");
});

test("示例种子：文件已存在就不再介入（用户意愿优先）", () => {
  setPluginEnabled("example-demo", true); // 用户手动启用 → 文件已存在
  const again = seedExamplePluginsDisabled();
  assert.deepEqual(again, [], "已有状态文件时不应返回/写入任何东西");
  assert.equal(isPluginEnabled("example-demo"), true, "用户的启用不能被翻回去");
});

test("示例种子：停用种子后扫描出来的 enabled 状态正确", () => {
  setPluginEnabled("example-demo", false);
  resetPlugins();
  write("only-example/skills/a.md", "# 只有示例，没有真插件");
  // 状态文件存在（上一条用例写的），所以这次种子不会再跑 → 只有已记录的停用生效
  seedExamplePluginsDisabled();
  const found = scanPlugins().find((p) => p.id === "example-demo");
  // example-demo 目录已删，但 real-plugin 应该照常启用
  assert.equal(scanPlugins().every((p) => p.enabled || p.id === "example-demo"), true);
});

fs.rmSync(path.join(DATA_DIR, "plugins.json"), { force: true });

/* ────────────────── 单目录（2026-11-06 删除用户级目录） ────────────────── */

/**
 * 守两件事：
 *  1. 插件根只有一个——用户级目录已经删了，不能再冒出来第二个（那会让"装完不生效"复发）
 *  2. 那个目录本来就不该存在：`pluginRoots()` 是扫描面，多一个根就是多一处
 *     "装了但打包不进去"的可能
 */
test("插件根：只有一个，且就是 plugins/", () => {
  const roots = pluginRoots();
  assert.equal(roots.length, 1, `插件根应该只有一个，实际：${JSON.stringify(roots)}`);
  assert.equal(roots[0].dir, PLUGIN_DIR);
  assert.equal(roots[0].scope, "project");
});

test("插件能装进这个唯一的根（安装目标 = 扫描目标，不会再出现「装上了看不见」）", () => {
  resetPlugins();
  write("single/demo.json", JSON.stringify({ id: "single", name: "单根", version: "1.0.0", apiVersion: 1, provides: [] }));
  write("single/skills/a.md", "# 单根测试");
  const p = scanPlugins().find((x) => x.id === "single");
  assert.ok(p, "应当被发现");
  assert.equal(p.scope, "project");
  assert.equal(path.resolve(p.dir), path.join(PLUGIN_DIR, "single"));
  resetPlugins();
});

/* ──────────────── 数据型贡献项：3D 天空配方 / 整片模板 ──────────────── */

const { syncPluginWorldSkies, syncPluginTemplates } = await import("../server/plugin/content-sync");
const { allWorldSkies, findWorldSky, unregisterWorldSky } = await import("../shared/worldPresets");
const { templateList, getTemplate, buildFromTemplate, unregisterTemplate } = await import("../shared/templates");

/**
 * 这两类以前是「能声明、能识别、没有消费方」——放进去的文件宿主根本不读，
 * list_plugins 还老老实实写着"提供：3D 天空"。现在接上了，所以要守两件事：
 *  1. 放了就真的出现在消费点的表里（list_world_skies / /api/templates 读的是同一份）
 *  2. 停用插件后要**撤掉**，不能"停用了但还能选"
 */

const pluginSky = {
  id: "sea-dusk",
  label: "海边黄昏",
  asset: "sea_dusk_test",
  category: "time",
  note: "测试用",
  world: { imageIntensity: 0.9, envIntensity: 0.5, haze: 0.35, vignette: 0.3 },
  lights: [{ type: "ambient", color: "#8899AA", intensity: 1.2 }],
  ground: { mode: "shadow", shadowOpacity: 0.5 },
};

test("3D 天空：插件的 skies.json 进注册表，停用后撤掉", () => {
  resetPlugins();
  write("sky/scene3d/skies.json", JSON.stringify({ skies: [pluginSky] }));

  const first = syncPluginWorldSkies();
  assert.equal(first.issues.length, 0, `不该有报错：${JSON.stringify(first.issues)}`);
  assert.ok(allWorldSkies().some((s) => s.id === "sea-dusk"), "插件的配方应出现在全集里");
  assert.equal(findWorldSky("sea-dusk")?.label, "海边黄昏");
  // 也接受按 asset id 找（agent 常把资产 id 当预设 id 给）
  assert.equal(findWorldSky("sea_dusk_test")?.id, "sea-dusk");

  setPluginEnabled("sky", false);
  syncPluginWorldSkies();
  assert.equal(findWorldSky("sea-dusk"), undefined, "停用插件后不该还能选到它的天空");
  setPluginEnabled("sky", true);
  resetPlugins();
  syncPluginWorldSkies();
  unregisterWorldSky("sea-dusk");
});

test("3D 天空：内置 id 不能被插件顶掉（agent 的指南引用的是内置 id）", () => {
  resetPlugins();
  const builtinId = allWorldSkies()[0].id;
  write("sky2/scene3d/skies.json", JSON.stringify([{ ...pluginSky, id: builtinId }]));
  const r = syncPluginWorldSkies();
  assert.ok(r.issues.some((i) => i.includes("内置")), `要报"与内置重名"，实际：${JSON.stringify(r.issues)}`);
  assert.notEqual(findWorldSky(builtinId)?.label, "海边黄昏", "内置配方不能被改写");
  resetPlugins();
  syncPluginWorldSkies();
});

test("整片模板：插件的 templates/*.json 能列出来，也能真的套用", () => {
  resetPlugins();
  write(
    "tpl/templates/demo.json",
    JSON.stringify({
      templates: [
        {
          key: "tpl-plugin-demo",
          name: "插件示范模板",
          description: "两幕，足够验证套用链路",
          tags: ["测试"],
          scenes: [{ type: "hero", durationInFrames: 40, props: { title: "插件模板" } }],
        },
      ],
    }),
  );

  const r = syncPluginTemplates();
  assert.equal(r.issues.length, 0, `不该有报错：${JSON.stringify(r.issues)}`);
  const card = templateList().find((t) => t.key === "tpl-plugin-demo");
  assert.ok(card, "模板应出现在 templateList（/api/templates 读的就是它）");
  assert.equal(card?.sceneCount, 1);

  const project = buildFromTemplate("tpl-plugin-demo", "套用测试", "tplapply01");
  assert.equal(project.scenes.length, 1);
  assert.equal(project.scenes[0].type, "hero");
  assert.equal(project.name, "套用测试");

  setPluginEnabled("tpl", false);
  syncPluginTemplates();
  assert.equal(getTemplate("tpl-plugin-demo"), undefined, "停用后不该还能套用");
  setPluginEnabled("tpl", true);
  resetPlugins();
  syncPluginTemplates();
  unregisterTemplate("tpl-plugin-demo");
});

test("整片模板：坏数据（没有 scenes / key 非法）报出来且不登记", () => {
  resetPlugins();
  write("tpl2/templates/bad.json", JSON.stringify({ key: "Bad Key", name: "x", scenes: [] }));
  const r = syncPluginTemplates();
  assert.ok(r.issues.some((i) => i.includes("key")), `要报 key 非法，实际：${JSON.stringify(r.issues)}`);
  assert.equal(getTemplate("Bad Key"), undefined);
  resetPlugins();
  syncPluginTemplates();
});

/* ──────────────── 元素素材（2026-11-06 第 5 步） ──────────────── */

const { syncPluginElements, ensurePluginEntryFresh } = await import("../server/plugin/content-sync");
const { allLibraryItems, allLibraryCats, registerLibraryItem, unregisterLibraryItem } = await import(
  "../shared/elementLibrary"
);

const pluginIcon = {
  id: "brand-logo",
  name: "品牌标",
  cat: "品牌图标",
  kind: "svg",
  size: 10,
  stroke: true,
  strokeWidth: 2,
  svg: '<path d="M4 12h16M12 4v16"/>',
};

test("元素：插件的 elements/*.json 进注册表，分类跟着长出来", () => {
  resetPlugins();
  write("els/elements/icons.json", JSON.stringify({ elements: [pluginIcon] }));

  const r = syncPluginElements();
  assert.equal(r.issues.length, 0, `不该有报错：${JSON.stringify(r.issues)}`);
  assert.ok(allLibraryItems().some((i) => i.id === "brand-logo"), "元素应出现在全集里");
  // 分类是作者自定义的：面板的筛选项必须自动多一个，否则元素存在但筛不到
  assert.ok(allLibraryCats().includes("品牌图标"), `分类应自动追加，实际：${JSON.stringify(allLibraryCats())}`);
  // 内置分类顺序不变（前 5 个是内置的，不能被打乱）
  assert.deepEqual(allLibraryCats().slice(0, 5), ["标记", "箭头", "形状", "符号", "标签"]);

  setPluginEnabled("els", false);
  syncPluginElements();
  assert.equal(allLibraryItems().some((i) => i.id === "brand-logo"), false, "停用插件后元素应消失");
  setPluginEnabled("els", true);
  resetPlugins();
  syncPluginElements();
  unregisterLibraryItem("brand-logo");
});

test("元素：内置 id 不能被顶掉；坏数据（缺 svg / 带 script）被拒", () => {
  resetPlugins();
  const builtinId = allLibraryItems()[0].id;
  const dup = registerLibraryItem({ ...pluginIcon, id: builtinId });
  assert.equal(dup.ok, false);
  assert.ok(dup.reason?.includes("内置"), `要说明与内置重名，实际：${dup.reason}`);

  const bad1 = registerLibraryItem({ ...pluginIcon, id: "no-svg", svg: undefined });
  assert.equal(bad1.ok, false);
  const bad2 = registerLibraryItem({ ...pluginIcon, id: "evil", svg: "<script>alert(1)</script>" });
  assert.equal(bad2.ok, false);
  assert.ok(bad2.reason?.includes("script"));
  const bad3 = registerLibraryItem({ ...pluginIcon, id: "no-size", size: 0 });
  assert.equal(bad3.ok, false);
});

/**
 * 这条守的是 9.5 的第一个前提：`elements/` 变化必须能触发重新生成。
 * 生成文件是编辑器拿到元素的唯一通道（web 是独立 bundle），
 * 触发器漏了就等于"插件元素永远只存在于服务端"。
 */
test("元素：改 elements/ 会触发重新生成，且生成文件里带上了它", () => {
  resetPlugins();
  const out = path.join(TMP, "gen", "_plugins.generated.ts");
  fs.mkdirSync(path.dirname(out), { recursive: true });

  // 先跑一次空的，占住"上一次"的状态
  generatePluginEntry({ outFile: out });
  write("els2/elements/icons.json", JSON.stringify([pluginIcon]));

  const res = generatePluginEntry({ outFile: out });
  assert.equal(res.elementCount, 1, `应统计到 1 个元素，实际：${res.elementCount}`);
  const text = fs.readFileSync(out, "utf8");
  assert.ok(text.includes("PLUGIN_ELEMENTS"), "生成文件要导出 PLUGIN_ELEMENTS");
  assert.ok(text.includes("brand-logo"), "生成文件要内联元素数据");
  assert.ok(text.includes("registerLibraryItem"), "生成文件要在模块顶层注册它");

  // 停用后重新生成：元素要不在了（否则"停用了图标还挂在面板里"）
  setPluginEnabled("els2", false);
  const res2 = generatePluginEntry({ outFile: out });
  assert.equal(res2.elementCount, 0, "停用的插件不该把元素写进生成文件");
  assert.ok(!fs.readFileSync(out, "utf8").includes("brand-logo"));

  setPluginEnabled("els2", true);
  resetPlugins();
  generatePluginEntry({ outFile: out });
  fs.rmSync(out, { force: true });
});

test("元素：ensurePluginEntryFresh 会自己发现 elements/ 变化（不需要先渲染一次）", () => {
  resetPlugins();
  // 它写的是仓库里那个真实文件；测完要还原成"没插件元素"的状态
  const real = path.join(ROOT, "src", "_plugins.generated.ts");
  const before = fs.existsSync(real) ? fs.readFileSync(real, "utf8") : "";
  try {
    ensurePluginEntryFresh();
    write("els3/elements/icons.json", JSON.stringify([{ ...pluginIcon, id: "fresh-check" }]));
    const r = ensurePluginEntryFresh();
    assert.ok(fs.readFileSync(real, "utf8").includes("fresh-check"), "生成文件应带上新元素");
    assert.equal(r.changed, true, "有变化就要报告 changed");
  } finally {
    resetPlugins();
    ensurePluginEntryFresh();
    if (before) fs.writeFileSync(real, before, "utf8");
  }
});

/* ──────────────── 3D 光线风格（2026-11-06 第 6 步） ──────────────── */

const { syncPluginLooks } = await import("../server/plugin/content-sync");
const { allLookIds, lookSpecOf, registerLook, unregisterLook, lookLabelOf } = await import("../shared/scene3dLooks");
const { getMeta, describeFields } = await import("../shared/sceneMetas");

/** 一套"看就知道是插件给的"风格：暖色、低环境、强 bloom */
const pluginLook = {
  id: "noir-warm",
  label: "暖夜",
  ambient: 0.12,
  env: 0.2,
  key: { pos: [3, 5, 4], intensity: 2.8, color: "#FFB27A" },
  rimA: { pos: [-5, 2, -6], intensity: 2.1, color: "cool" },
  rimB: null,
  fill: null,
  bloom: { strength: 0.7, radius: 0.5, threshold: 0.72 },
  summary: "暖主光 + 冷边光，测试用",
};

test("3D 风格：插件的 looks.json 进注册表，停用后撤掉", () => {
  resetPlugins();
  write("lk/scene3d/looks.json", JSON.stringify({ looks: [pluginLook] }));

  const r = syncPluginLooks();
  assert.equal(r.issues.length, 0, `不该有报错：${JSON.stringify(r.issues)}`);
  assert.ok(allLookIds().includes("noir-warm"), "插件风格应出现在可选列表里");
  assert.equal(lookSpecOf("noir-warm")?.key.intensity, 2.8);
  assert.equal(lookLabelOf("noir-warm"), "暖夜");

  setPluginEnabled("lk", false);
  syncPluginLooks();
  assert.equal(lookSpecOf("noir-warm"), undefined, "停用插件后不该还能选到它的风格");
  setPluginEnabled("lk", true);
  resetPlugins();
  syncPluginLooks();
  unregisterLook("noir-warm");
});

test("3D 风格：内置 id 与 auto 不能被占；坏 spec 被拒", () => {
  assert.equal(registerLook("auto", pluginLook).ok, false, "auto 是保留字");
  const dup = registerLook("cyber", pluginLook);
  assert.equal(dup.ok, false);
  assert.ok(dup.reason?.includes("内置"), `要说明与内置重名，实际：${dup.reason}`);

  const bad1 = registerLook("bad1", { ...pluginLook, ambient: -1 });
  assert.equal(bad1.ok, false, "负环境光要拒");
  const bad2 = registerLook("bad2", { ...pluginLook, key: { pos: [1, 2], intensity: 1, color: "#fff" } });
  assert.equal(bad2.ok, false, "灯位不是三元组要拒");
  const bad3 = registerLook("bad3", { ...pluginLook, bloom: { strength: 9, radius: 0.5, threshold: 0.7 } });
  assert.equal(bad3.ok, false, "bloom 越界要拒");
});

/**
 * 这条是「面板/agent 能选到」的判据。
 *
 * `look` 的 schema 只能是 string（插件 id 编译期不存在），如果 describeFields 不把
 * 注册表补进 options，面板就会退化成自由文本、agent 也没有可选清单 ——
 * 那等于"能注册但选不到"，比没接好不了多少。
 */
test("3D 风格：describeFields 把插件 id 注入 look 选项", () => {
  resetPlugins();
  write("lk2/scene3d/looks.json", JSON.stringify([pluginLook]));
  syncPluginLooks();

  const meta = getMeta("scene3d")!;
  const look = describeFields(meta.schema).find((f) => f.key === "look")!;
  assert.equal(look.kind, "enum", "必须是下拉框，不是自由文本");
  assert.ok(look.options?.includes("auto"), "auto 要在选项里");
  assert.ok(look.options?.includes("cyber"), "内置项要在选项里");
  assert.ok(look.options?.includes("noir-warm"), "插件项要在选项里");

  resetPlugins();
  syncPluginLooks();
  const after = describeFields(meta.schema).find((f) => f.key === "look")!;
  assert.ok(!after.options?.includes("noir-warm"), "停用后选项里不该还有它");
});

test("3D 风格：写进生成文件（渲染端只有这一条通道）", () => {
  resetPlugins();
  const out = path.join(TMP, "gen2", "_plugins.generated.ts");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  generatePluginEntry({ outFile: out });
  write("lk3/scene3d/looks.json", JSON.stringify({ looks: [pluginLook] }));

  const res = generatePluginEntry({ outFile: out });
  assert.equal(res.lookCount, 1, `应统计到 1 套风格，实际：${res.lookCount}`);
  const text = fs.readFileSync(out, "utf8");
  assert.ok(text.includes("PLUGIN_LOOKS"), "生成文件要导出 PLUGIN_LOOKS");
  assert.ok(text.includes("registerLook"), "生成文件要导入并调用 registerLook");
  assert.ok(text.includes("noir-warm"), "生成文件要内联风格数据");

  resetPlugins();
  generatePluginEntry({ outFile: out });
  fs.rmSync(out, { force: true });
});

/* ──────────────── 3D 图形配方（scene3d.preset 的新语义） ──────────────── */

const { syncPluginGraphPresets } = await import("../server/plugin/content-sync");
const { allGraphPresets, graphPresetOf, unregisterGraphPreset } = await import("../shared/scene3dPresets");

const pluginGraph = {
  nodes: [
    { id: "core", geometry: { type: "sphere" }, material: { color: "primary" } },
    { id: "ring", parent: "core", geometry: { type: "box" }, transform: { position: [1.4, 0, 0] } },
  ],
  camera: { position: [0, 1.5, 6], target: [0, 0, 0] },
};

const pluginPreset = {
  id: "hero-orbit",
  label: "开场环绕",
  summary: "一个球 + 一个方块，固定机位，用来验证配方链路",
  graph: pluginGraph,
};

test("图形配方：插件的 presets.json 进注册表，停用后撤掉", () => {
  resetPlugins();
  write("gp/scene3d/presets.json", JSON.stringify({ presets: [pluginPreset] }));

  const r = syncPluginGraphPresets();
  assert.equal(r.issues.length, 0, `不该有报错：${JSON.stringify(r.issues)}`);
  const got = graphPresetOf("hero-orbit");
  assert.ok(got, "配方应能按 id 取到");
  assert.equal(got?.graph.nodes.length, 2);
  assert.equal(got?.from, "gp", "要记得它来自哪个插件");

  setPluginEnabled("gp", false);
  syncPluginGraphPresets();
  assert.equal(graphPresetOf("hero-orbit"), undefined, "停用插件后不该还能套用");

  setPluginEnabled("gp", true);
  resetPlugins();
  syncPluginGraphPresets();
  unregisterGraphPreset("hero-orbit");
});

/**
 * 配方写坏必须在**注册时**就拦住，而不是等 agent 套用之后渲出半张黑屏。
 * 这里用的是和用户写入完全相同的校验路径（dslSchema + dslIssues）。
 */
test("图形配方：不合 DSL 的 graph 被拒，且报出具体位置", () => {
  resetPlugins();
  write(
    "gp2/scene3d/presets.json",
    JSON.stringify({
      presets: [
        { ...pluginPreset, id: "bad-geo", graph: { nodes: [{ id: "x", geometry: { type: "teapot" } }] } },
        { ...pluginPreset, id: "bad-id", id2: "x", graph: { nodes: [] }, label: "" },
      ],
    }),
  );
  const r = syncPluginGraphPresets();
  assert.ok(r.issues.length >= 2, `两条坏配方都要报：${JSON.stringify(r.issues)}`);
  assert.equal(graphPresetOf("bad-geo"), undefined);
  assert.equal(graphPresetOf("bad-id"), undefined);
  // 合法的那份不该被坏数据连累
  resetPlugins();
  syncPluginGraphPresets();
});

test("图形配方：结构问题（悬空 parent）在注册时被 dslIssues 拦下", () => {
  resetPlugins();
  write(
    "gp3/scene3d/presets.json",
    JSON.stringify({ presets: [{ ...pluginPreset, id: "orphan", graph: { nodes: [{ id: "a", parent: "nope", geometry: { type: "box" } }] } }] }),
  );
  const r = syncPluginGraphPresets();
  assert.ok(r.issues.some((i) => i.includes("parent") || i.includes("不存在")), `要报悬空父级：${JSON.stringify(r.issues)}`);
  assert.equal(graphPresetOf("orphan"), undefined);
  resetPlugins();
  syncPluginGraphPresets();
});

await testAsync("图形配方：list_graph_presets 能列出来（agent 的发现入口）", async () => {
  resetPlugins();
  write("gp4/scene3d/presets.json", JSON.stringify({ presets: [pluginPreset] }));
  const { TOOLS } = await import("../server/mcp-tools");
  const tool = TOOLS.find((t) => t.name === "list_graph_presets");
  assert.ok(tool, "工具必须存在");
  const text = String(await tool!.run({} as never));
  assert.ok(text.includes("hero-orbit"), `输出里要有配方 id：${text.slice(0, 200)}`);
  assert.ok(text.includes("2 个节点"), "要报节点数");

  /*
   * 套用入口的错分支也测：写错 id 必须在**发请求之前**就报错并列出可用的，
   * 而不是丢给服务端变成一句"未知字段/场景不存在"。
   * （成功分支要真起服务，属于 e2e，见计划文档 9.6。）
   */
  const applyTool = TOOLS.find((t) => t.name === "set_graph_scene")!;
  await assert.rejects(
    () => applyTool.run({ projectId: "nope", sceneId: "nope", graphPreset: "not-a-preset" } as never),
    (err: Error) => err.message.includes("没有这个图形配方") && err.message.includes("hero-orbit"),
    "写错配方 id 要报错并列出可用的",
  );

  resetPlugins();
  syncPluginGraphPresets();
});

/* ──────────────── 3D 后期 pass（受控 GLSL，2026-11-06） ──────────────── */

const { syncPluginPasses } = await import("../server/plugin/content-sync");
const { allPassDefs, allPassIds, passDefOf, unregisterPassDef, registerPassDef } = await import(
  "../shared/scene3dPasses"
);

/** 一段能过文本校验的 fragment（真要编译还要 GL 上下文，那部分在渲染端自检） */
const FRAG_OK = `
uniform sampler2D tDiffuse;
uniform float uAmount;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tDiffuse, vUv) * uAmount;
}
`;

const pluginPass = {
  id: "vhs-scan",
  label: "VHS 扫描线",
  summary: "老录像带的横向扫过",
  params: { lines: { min: 10, max: 400, default: 120 } },
  fragment: FRAG_OK,
};

test("后期 pass：插件的 passes.json 进注册表，参数与来源都在", () => {
  resetPlugins();
  write("pp/scene3d/passes.json", JSON.stringify({ passes: [pluginPass] }));

  const r = syncPluginPasses();
  assert.equal(r.issues.length, 0, `不该有报错：${JSON.stringify(r.issues)}`);
  const def = passDefOf("vhs-scan");
  assert.ok(def, "注册表里要有它");
  assert.equal(def?.from, "pp", "要记得来自哪个插件");
  assert.equal(def?.params.lines.default, 120);
  assert.ok(allPassIds().includes("vhs-scan"));

  setPluginEnabled("pp", false);
  syncPluginPasses();
  assert.equal(passDefOf("vhs-scan"), undefined, "停用插件后不该还能选到");
  setPluginEnabled("pp", true);
  resetPlugins();
  syncPluginPasses();
  unregisterPassDef("vhs-scan");
});

/**
 * 文本级校验（服务端能做的那一半）。
 *
 * 另一半是"真编一次"——那要 GL 上下文，在 `bloom.ts` 的 compileCheck。
 * 这里卡住的每一条都对应一种"装了会静默出事"的写法。
 */
test("后期 pass：六种坏定义分别被拒，且理由说清", () => {
  const cases: [string, unknown, RegExp][] = [
    ["id 非法", { ...pluginPass, id: "VHS Scan" }, /id/],
    ["没有 gl_FragColor", { ...pluginPass, id: "no-out", fragment: "uniform sampler2D tDiffuse;\nvoid main(){}" }, /gl_FragColor/],
    ["写了 #version", { ...pluginPass, id: "ver", fragment: "#version 300 es\nvoid main(){ gl_FragColor = vec4(1.0); }" }, /#version/],
    ["声明了第二个 sampler", { ...pluginPass, id: "tex2", fragment: "uniform sampler2D tDiffuse;\nuniform sampler2D uOther;\nvoid main(){ gl_FragColor = texture2D(uOther, vec2(0.5)); }" }, /tDiffuse/],
    ["参数名和内置 uniform 冲突", { ...pluginPass, id: "clash", params: { uFrame: { min: 0, max: 1, default: 0 } } }, /内置/],
    ["参数范围反了", { ...pluginPass, id: "range", params: { x: { min: 10, max: 1, default: 5 } } }, /min/],
  ];
  for (const [name, raw, re] of cases) {
    const r = registerPassDef(raw, "pp");
    assert.equal(r.ok, false, `${name} 应该被拒`);
    assert.match(String(r.reason), re, `${name} 的理由要指明问题：${r.reason}`);
  }
  // 一个都不该进注册表
  assert.equal(passDefOf("no-out"), undefined);
  assert.equal(passDefOf("ver"), undefined);
});

test("后期 pass：同一 id 被两个插件抢 → 第二个被拒（先装的优先）", () => {
  resetPlugins();
  write("pp2/scene3d/passes.json", JSON.stringify({ passes: [pluginPass] }));
  write("pp3/scene3d/passes.json", JSON.stringify({ passes: [{ ...pluginPass, label: "抢注的" }] }));
  const r = syncPluginPasses();
  assert.ok(r.issues.some((i) => i.includes("占用")), `要报 id 冲突：${JSON.stringify(r.issues)}`);
  assert.equal(passDefOf("vhs-scan")?.label, "VHS 扫描线", "先注册的不该被顶掉");
  resetPlugins();
  syncPluginPasses();
  unregisterPassDef("vhs-scan");
});

test("后期 pass：写进生成文件（渲染端只有这一条通道，源码必须进 bundle）", () => {
  resetPlugins();
  const out = path.join(TMP, "gen-pass", "_plugins.generated.ts");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  generatePluginEntry({ outFile: out });
  write("pp4/scene3d/passes.json", JSON.stringify({ passes: [pluginPass] }));

  const res = generatePluginEntry({ outFile: out });
  assert.equal(res.passCount, 1, `应统计到 1 个 pass，实际：${res.passCount}`);
  const text = fs.readFileSync(out, "utf8");
  assert.ok(text.includes("PLUGIN_PASSES"), "要导出 PLUGIN_PASSES");
  assert.ok(text.includes("registerPassDef"), "要在模块顶层注册");
  assert.ok(text.includes("vhs-scan"), "要内联 id");
  assert.ok(text.includes("gl_FragColor"), "**源码本身**也要内联——自检编译要用它");

  resetPlugins();
  generatePluginEntry({ outFile: out });
  fs.rmSync(out, { force: true });
});

/**
 * 写入时严格：写错 pass id 必须在发请求之前就报错并列出可用的。
 * （渲染时宽容是另一条路径：跳过 + 告警，见 bloom.ts。两者刻意不对称。）
 */
await testAsync("后期 pass：set_graph_scene 写错 id 立刻报错并列出可用项", async () => {
  resetPlugins();
  write("pp5/scene3d/passes.json", JSON.stringify({ passes: [pluginPass] }));
  syncPluginPasses();

  const { TOOLS } = await import("../server/mcp-tools");
  const setScene = TOOLS.find((t) => t.name === "set_graph_scene")!;
  await assert.rejects(
    () => setScene.run({ projectId: "nope", sceneId: "nope", post: { passes: [{ id: "not-a-pass" }] } } as never),
    (err: Error) => err.message.includes("没有这些后期 pass") && err.message.includes("vhs-scan"),
    "写错 id 要报错并列出可用的",
  );

  const list = TOOLS.find((t) => t.name === "list_plugin_passes")!;
  const text = String(await list.run({} as never));
  assert.ok(text.includes("vhs-scan"), "列表工具要能列出它");
  assert.ok(text.includes("lines 10–400"), `要报可调参数范围：${text.slice(0, 300)}`);

  resetPlugins();
  syncPluginPasses();
  unregisterPassDef("vhs-scan");
});

/* ──────────────── 插件转场（2026-11-06） ──────────────── */

const {
  registerPluginTransition,
  unregisterPluginTransition,
  allTransitionIds,
  allTransitionOptions,
  pluginTransitionIds,
  transitionStyle,
  exitStyle,
} = await import("../shared/transitions");
const { syncPluginTransitions } = await import("../server/plugin/content-sync");
const { normalizeTransition } = await import("../shared/ops");

/** 一个"看得见方向"的转场：p 越大越亮、越不模糊 */
const spinner = (p: number, ctx: { phase: string }) => ({
  opacity: p,
  filter: `blur(${(1 - p) * 12}px)`,
  transform: `rotate(${p * 30}deg)`,
  // 记下 phase，测试要用它验"出场是反向播的"
  ...(ctx.phase === "out" ? { transitionDuration: "0" } : {}),
});

test("转场：注册插件转场后能选、能算样式", () => {
  const reg = registerPluginTransition("my-spin", {
    default: spinner,
    meta: { label: "自转", hint: "边转边显", params: [{ key: "amp", min: 0, max: 2, default: 1 }] },
  });
  assert.equal(reg.ok, true, `注册该成功：${reg.reason}`);
  assert.ok(allTransitionIds().includes("my-spin"), "id 要进合法集合（写入校验靠它）");
  const opt = allTransitionOptions().find((o) => o.key === "my-spin")!;
  assert.equal(opt.label, "自转");
  assert.equal(opt.params.length, 1, "参数表要能被面板/工具读到");

  const st = transitionStyle("my-spin", 6, 12, 12, {});
  assert.equal(st.opacity, 0.5, `p 应该是 0.5，实际 ${JSON.stringify(st)}`);
  // 插件返回值不做数值格式化（那是作者的事），所以是 6px 不是 6.00px
  assert.match(String(st.filter), /blur\(6px\)/);
  unregisterPluginTransition("my-spin");
  assert.equal(allTransitionIds().includes("my-spin"), false, "注销后不该还在");
});

test("转场：内置 id 不可覆盖，没有 default 函数要拒", () => {
  const dup = registerPluginTransition("fade", { default: spinner });
  assert.equal(dup.ok, false);
  assert.match(String(dup.reason), /内置/);
  const noImpl = registerPluginTransition("no-impl", { meta: { label: "空" } });
  assert.equal(noImpl.ok, false);
  assert.match(String(noImpl.reason), /default/);
  const badId = registerPluginTransition("Bad Id", { default: spinner });
  assert.equal(badId.ok, false);
});

/**
 * 这条是"出入场都支持"的核心判据。
 *
 * 宿主在 out 阶段用 `(1-p)` 再调一次同一个函数，并把 phase 传进去 ——
 * 所以插件**只写一个方向**就能拿到成对的出入场，而想区分方向的也能区分。
 */
test("转场：出场自动反向（同一个函数、p 反着走、phase=out）", () => {
  const seen: { p: number; phase: string }[] = [];
  registerPluginTransition("probe-dir", {
    default: (p: number, ctx: { phase: string }) => {
      seen.push({ p, phase: ctx.phase });
      return { opacity: p };
    },
  });

  transitionStyle("probe-dir", 3, 12, 12); // 入场：p≈0.25
  const inCall = seen.at(-1)!;
  assert.equal(inCall.phase, "in");

  // 出场窗口 12 帧，走到窗口末尾附近 → p 应该接近 0（反向）
  exitStyle({ type: "probe-dir", durationInFrames: 12 }, 11, 12, 120);
  const outCall = seen.at(-1)!;
  assert.equal(outCall.phase, "out", "出场必须告诉插件这是 out");
  assert.ok(outCall.p < 0.2, `出场末尾的 p 应该接近 0（反向），实际 ${outCall.p}`);

  unregisterPluginTransition("probe-dir");
});

test("转场：插件抛错 / 返回非法属性都不会毁掉画面", () => {
  registerPluginTransition("boom", {
    default: () => {
      throw new Error("我坏了");
    },
  });
  const st = transitionStyle("boom", 6, 12, 12);
  assert.equal(st.opacity, 0.5, "抛错要退回淡入（opacity=p），不是空白也不是崩");
  unregisterPluginTransition("boom");

  registerPluginTransition("bad-style", {
    // position 不在白名单：它会把整片排版搞坏，而表现像"版面错"根本查不到转场上
    default: () => ({ position: "fixed", width: "200%", transform: "scale(2)" }) as never,
  });
  const st2 = transitionStyle("bad-style", 6, 12, 12);
  assert.equal(st2.position, undefined, "布局属性必须被丢掉");
  assert.equal(st2.width, undefined);
  assert.equal(st2.transform, "scale(2)", "白名单内的要保留");
  unregisterPluginTransition("bad-style");

  // 返回 null/数组这类形状错误也不能崩
  registerPluginTransition("null-style", { default: () => null as never });
  assert.deepEqual(transitionStyle("null-style", 3, 12), {});
  unregisterPluginTransition("null-style");
});

test("转场：工程里存着已卸载插件的 id → 退回 fade，不会打不开", () => {
  // 模拟"插件被删了，工程里 transitionIn.type 还留着它"
  const st = transitionStyle("gone-plugin", 6, 12, 12);
  assert.equal(st.opacity, 0.5, "未知 id 应该走 fade 分支（opacity=p），不是抛错");
});

test("转场：服务端按文件名认 id（不执行插件代码），停用即撤销", () => {
  resetPlugins();
  write("tr/transitions/wipe-custom.ts", "export default (p) => ({ opacity: p });");
  write("tr/transitions/glitch2.tsx", "export default (p) => ({ opacity: p });");
  write("tr/transitions/README.md", "不是实现文件，应被忽略");

  const r = syncPluginTransitions();
  assert.equal(r.issues.length, 0, `不该有报错：${JSON.stringify(r.issues)}`);
  assert.ok(pluginTransitionIds().includes("wipe-custom"), "id 来自文件名");
  assert.ok(pluginTransitionIds().includes("glitch2"), "tsx 也算");
  assert.equal(pluginTransitionIds().includes("README"), false, "非代码文件不能变成转场");

  // normalizeTransition 要接受它（写入路径的校验靠 allTransitionIds）
  const t = normalizeTransition({ type: "wipe-custom", durationInFrames: 10, params: { amp: 2, note: "x" } }, "t");
  assert.equal(t.type, "wipe-custom");
  assert.equal(t.params?.amp, 2);
  assert.equal(t.params?.note, "x");

  setPluginEnabled("tr", false);
  syncPluginTransitions();
  assert.equal(pluginTransitionIds().includes("wipe-custom"), false, "停用插件后不该还能选");
  assert.throws(() => normalizeTransition({ type: "wipe-custom", durationInFrames: 10 }, "t"), /不合法/);

  setPluginEnabled("tr", true);
  resetPlugins();
  syncPluginTransitions();
});

test("转场：写进生成文件（编辑器与成片读同一份，预览必然一致）", () => {
  resetPlugins();
  const out = path.join(TMP, "gen-tr", "_plugins.generated.ts");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  generatePluginEntry({ outFile: out });
  write("tr2/transitions/liquid.ts", "export const meta = { label: '液体' };\nexport default (p) => ({ opacity: p });");

  const res = generatePluginEntry({ outFile: out });
  assert.equal(res.transitionCount, 1, `应统计到 1 个转场，实际：${res.transitionCount}`);
  const text = fs.readFileSync(out, "utf8");
  assert.ok(text.includes("PLUGIN_TRANSITIONS"), "要导出 PLUGIN_TRANSITIONS");
  assert.ok(text.includes("registerPluginTransition"), "要在模块顶层注册");
  assert.ok(text.includes("transitions/liquid"), "要静态 import 那个实现文件");
  assert.ok(text.includes('"liquid"'), "id 用文件名");

  resetPlugins();
  generatePluginEntry({ outFile: out });
  fs.rmSync(out, { force: true });
});

/* ──────────────── 语音 provider（2026-11-06） ──────────────── */

const { ensureTtsProviders, resetTtsProviders, ttsProviderCatalog, getTtsProvider } = await import(
  "../server/plugin/tts-providers"
);

/**
 * 插件 provider 的加载与"内置优先/先装优先"。
 *
 * 这里只验注册表这一层：真合成要起网络或写盘，属于 e2e（单独跑）。
 * 但**注册表搞错了整条链就废**——比如 id 冲突时后装的静默覆盖前面的，
 * 用户会看到"我装的 provider 一会被换掉"这种查不动的问题。
 */
await testAsync("语音 provider：插件入口导出的 ttsProviders 能被发现", async () => {
  resetPlugins();
  resetTtsProviders();
  write(
    "vt/plugin.ts",
    `export const ttsProviders = {
      "probe-tts": {
        meta: { label: "探针语音", configFields: [{ key: "token", secret: true, required: true }] },
        voices: () => [{ id: "v1", label: "音色一" }],
        synthesize: async () => ({ audio: new Uint8Array([1, 2, 3]) }),
      },
    };`,
  );

  const r = await ensureTtsProviders();
  assert.equal(r.errors.length, 0, `不该有报错：${JSON.stringify(r.errors)}`);
  const cat = await ttsProviderCatalog();
  const p = cat.providers.find((x) => x.id === "probe-tts");
  assert.ok(p, "provider 应被收集");
  assert.equal(p?.label, "探针语音");
  assert.equal(p?.pluginId, "vt");
  assert.equal(p?.configFields[0].key, "token");
  assert.equal(p?.configFields[0].secret, true);
  assert.equal(p?.hasVoices, true, "有 voices 要标出来（面板/工具据此显示「能列音色」）");

  // 真拿到模块（合成时要用）
  const got = await getTtsProvider("probe-tts");
  assert.equal(typeof got?.mod.synthesize, "function");

  setPluginEnabled("vt", false);
  resetTtsProviders();
  const off = await ttsProviderCatalog();
  assert.equal(off.providers.some((x) => x.id === "probe-tts"), false, "停用插件后 provider 不该还在");

  setPluginEnabled("vt", true);
  resetPlugins();
  resetTtsProviders();
});

await testAsync("语音 provider：内置 id 不可占、缺 synthesize 要报、重名先装优先", async () => {
  resetPlugins();
  resetTtsProviders();
  write(
    "vt2/plugin.ts",
    `export const ttsProviders = {
      openai: { synthesize: async () => ({ audio: new Uint8Array([1]) }) },
      "no-synth": { meta: { label: "空的" } },
      "Bad Id": { synthesize: async () => ({ audio: new Uint8Array([1]) }) },
    };`,
  );
  const r = await ensureTtsProviders();
  assert.ok(r.errors.some((e) => e.includes("与内置重名")), `要报内置重名：${JSON.stringify(r.errors)}`);
  assert.ok(r.errors.some((e) => e.includes("synthesize")), `要报缺 synthesize：${JSON.stringify(r.errors)}`);
  assert.ok(r.errors.some((e) => e.includes("不合法")), `要报 id 非法：${JSON.stringify(r.errors)}`);
  const cat = await ttsProviderCatalog();
  assert.equal(cat.providers.length, 0, "三个都该被拒");

  // 两个插件抢同一个 id：先扫到的留下，后者报"被占用"
  resetPlugins();
  resetTtsProviders();
  write("vt3/plugin.ts", `export const ttsProviders = { dup: { synthesize: async () => ({ audio: new Uint8Array([1]) }) } };`);
  write("vt4/plugin.ts", `export const ttsProviders = { dup: { synthesize: async () => ({ audio: new Uint8Array([2]) }) } };`);
  const r2 = await ensureTtsProviders();
  assert.ok(r2.errors.some((e) => e.includes("占用")), `要报 id 冲突：${JSON.stringify(r2.errors)}`);
  const cat2 = await ttsProviderCatalog();
  assert.equal(cat2.providers.filter((x) => x.id === "dup").length, 1, "同名只留一个");

  resetPlugins();
  resetTtsProviders();
});

/* ──────────────── 插件自制界面：配置存储（2026-11-06） ──────────────── */

const { getPluginConfig, savePluginConfig, pluginConfigStats } = await import("../server/plugin-config.service");

/**
 * 插件配置是"插件自己决定的任意 JSON"，宿主只保证**能存、能按 key 合并、不炸**。
 *
 * 这里守的是三条最容易出事的：合并语义（别把别家的 key 清了）、
 * 大小上限（防插件把缓存塞进来拖慢每次读）、坏输入不抛（面板会因此白屏）。
 */
test("插件配置：写入 / 按 key 合并 / 大小上限 / 坏输入不炸", () => {
  const r1 = savePluginConfig("ui-demo", { endpoint: "https://a.test", token: "t1" });
  assert.equal(r1.ok, true);
  assert.equal(getPluginConfig("ui-demo").token, "t1");

  // 第二次只改一个 key：之前的必须还在（面板一次只改一栏）
  const r2 = savePluginConfig("ui-demo", { voice: "v1" });
  assert.equal(r2.ok, true);
  const cfg = getPluginConfig("ui-demo");
  assert.equal(cfg.token, "t1", "合并不能清掉已有的 key");
  assert.equal(cfg.voice, "v1");

  // 不同插件互不影响
  savePluginConfig("other", { x: 1 });
  assert.equal(getPluginConfig("ui-demo").x, undefined);
  assert.equal(getPluginConfig("other").x, 1);
  assert.ok(pluginConfigStats().plugins.includes("ui-demo"));

  // 超过 64KB 要拒（不是截断：截断出来的 JSON 是坏的）
  const big = savePluginConfig("ui-demo", { blob: "x".repeat(70 * 1024) });
  assert.equal(big.ok, false);
  assert.match(String((big as { error: string }).error), /太大/);
  assert.equal(getPluginConfig("ui-demo").blob, undefined, "被拒之后不能留下半截");

  // 坏输入：数组 / null / 非法 id
  assert.equal(savePluginConfig("ui-demo", [1, 2, 3] as never).ok, false);
  assert.equal(savePluginConfig("ui-demo", null as never).ok, false);
  assert.equal(savePluginConfig("../evil", { a: 1 }).ok, false, "id 里的路径字符要拒");
  assert.deepEqual(getPluginConfig("../evil"), {}, "读非法 id 返回空对象而不是抛");
});

/* ────────────────────────── 收尾 ────────────────────────── */
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n插件内核：${passed} 通过${failures.length ? `，${failures.length} 失败` : ""}`);
if (failures.length) {
  console.error(`失败项：${failures.join("、")}`);
  process.exit(1);
}
