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

/* ────────────────────────── 收尾 ────────────────────────── */

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n插件内核：${passed} 通过${failures.length ? `，${failures.length} 失败` : ""}`);
if (failures.length) {
  console.error(`失败项：${failures.join("、")}`);
  process.exit(1);
}
