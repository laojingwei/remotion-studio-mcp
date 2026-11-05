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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "studio-plugins-"));
const PLUGIN_DIR = path.join(TMP, "plugins");
const DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(PLUGIN_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.STUDIO_PLUGINS_DIR = PLUGIN_DIR;
process.env.STUDIO_DATA_ROOT = DATA_DIR;

const { scanPlugins, setPluginEnabled } = await import("../server/plugin/discovery");
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
    fn();
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

/* ────────────────────────── 工具插件（批次 4b） ────────────────────────── */

const { ensurePluginTools, pluginToolStatus, resetPluginToolCache, WIRED_PERMISSIONS } = await import(
  "../server/plugin/plugin-tools"
);
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

await testAsync("权限表：只接线读/写两条（其余只有定义，不能假装能用）", async () => {
  assert.deepEqual(WIRED_PERMISSIONS, ["project:read", "project:write"]);
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

/* ────────────────────────── 收尾 ────────────────────────── */

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n插件内核：${passed} 通过${failures.length ? `，${failures.length} 失败` : ""}`);
if (failures.length) {
  console.error(`失败项：${failures.join("、")}`);
  process.exit(1);
}
