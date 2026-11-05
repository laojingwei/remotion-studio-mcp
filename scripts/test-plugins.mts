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
// 素材目录也指到临时目录：否则媒体测试会往仓库的 public/assets 里写文件、删文件，
// 而删除会撞上 safe-delete 的批量上限（静默失败 → 残留 → 断言指向完全错误的方向）
process.env.STUDIO_PUBLIC_DIR = path.join(TMP, "public");

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

// 收尾清掉本文件自己造的文件（不删整个目录：safe-delete 会按数量拦）
rmFiles("shot.png", "a.png", "b.png", "same.png", "plain.png", "old1.png", "old2.png");

/* ────────────────────────── 收尾 ────────────────────────── */

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n插件内核：${passed} 通过${failures.length ? `，${failures.length} 失败` : ""}`);
if (failures.length) {
  console.error(`失败项：${failures.join("、")}`);
  process.exit(1);
}
