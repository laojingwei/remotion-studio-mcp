/**
 * 生成 `src/_plugins.generated.ts`：把插件场景的组件与 meta 静态引入 bundle。
 *
 * ## 为什么必须"生成文件"而不是运行时加载
 *
 * 渲染端是 `bundle({ entryPoint: src/index.ts })` —— webpack 做**静态依赖分析**。
 * `require(任意运行时路径)` 或 `import(variable)` 会打进一个空壳，运行时报找不到模块。
 * 唯一可靠的办法是让这些路径在**编译期就是字面量**，也就是生成一个真代码文件。
 *
 * ## 为什么只扫 `<repo>/plugins/`
 *
 * webpack 的 loader 规则与 tsconfig 的 include 都只覆盖工程根之内。
 * 2026-11-06 之前还有一个用户级目录（家目录下），它恰好落在这个范围之外——
 * 装进去的场景组件永远打不进 bundle，且宿主不报错。那个目录已经删了，
 * 现在"插件目录"和"能被打包的目录"是同一个，这个坑从结构上消失了。
 *
 * ## 谁会调它
 *
 * - `scripts/gen-plugin-entry.mts`（手动 / CI --check）
 * - `server/render.service.ts` 的 `getServeUrl()`：检测到插件变化、重新打包**之前**
 *   （顺序很重要：先生成再打包，否则打进去的还是上一版）
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../root";
import { PROJECT_PLUGIN_DIR, isPluginEnabled, scanPlugins } from "./discovery";
import { pluginBriefSteps } from "./brief-steps";

/** 生成文件的默认位置（相对工程根） */
export const GENERATED_ENTRY_REL = "src/_plugins.generated.ts";

export type PluginSceneEntry = {
  metaFile: string;
  compFile: string;
  pluginId: string;
};

/** 插件贡献的元素（纯数据，没有组件文件可配对） */
export type PluginElementEntry = {
  file: string;
  pluginId: string;
  items: unknown[];
};

export type GenResult = {
  changed: boolean;
  count: number;
  /** 顺带生成进去的插件元素条数（0 = 没有这类插件） */
  elementCount: number;
  issues: string[];
  outFile: string;
};

const toPosix = (p: string) => p.split(path.sep).join("/");

/**
 * import 路径：相对生成文件所在目录，正斜杠（webpack/vite 都认）。
 *
 * 组件**去掉扩展名**：TS 默认不允许 `import "./x.tsx"`（要开 allowImportingTsExtensions），
 * 而 webpack/vite 都会按 resolve.extensions 自动补。
 * JSON **保留扩展名**：不带的话可能被解析成同名 .ts。
 */
const importPath = (abs: string, outDir: string, opts: { keepExt?: boolean } = {}) => {
  let rel = path.relative(outDir, abs);
  if (!opts.keepExt) rel = rel.replace(/\.(tsx|jsx|ts)$/i, "");
  return toPosix(rel.startsWith(".") ? rel : `./${rel}`);
};

function safeDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 扫出所有"json + 同名组件"成对的场景。
 *
 * 约定：`plugins/<插件>/scenes/<type>.json` 配 `plugins/<插件>/scenes/<type>.tsx`。
 * 同名不同扩展名——少一个字段要记，但类型与组件永远对得上，不会配错。
 */
export function discoverSceneEntries(pluginDir = PROJECT_PLUGIN_DIR): { entries: PluginSceneEntry[]; issues: string[] } {
  const entries: PluginSceneEntry[] = [];
  const issues: string[] = [];

  for (const plugin of safeDir(pluginDir)) {
    if (!plugin.isDirectory() || plugin.name.startsWith(".") || plugin.name === "node_modules") continue;
    const scenesDir = path.join(pluginDir, plugin.name, "scenes");
    if (!fs.existsSync(scenesDir)) continue;

    const files = safeDir(scenesDir);
    for (const f of files) {
      if (!f.isFile() || !f.name.toLowerCase().endsWith(".json")) continue;
      const stem = f.name.replace(/\.json$/i, "");
      const hit = files.find(
        (c) => c.isFile() && [`${stem}.tsx`, `${stem}.jsx`, `${stem}.ts`].some((n) => n.toLowerCase() === c.name.toLowerCase()),
      );
      if (!hit) {
        issues.push(`${plugin.name}/scenes/${stem}.json 没有同名组件文件（需要 ${stem}.tsx）`);
        continue;
      }
      entries.push({
        metaFile: path.join(scenesDir, f.name),
        compFile: path.join(scenesDir, hit.name),
        pluginId: plugin.name,
      });
    }
  }

  return { entries: entries.sort((a, b) => a.metaFile.localeCompare(b.metaFile)), issues };
}

/**
 * 扫出插件贡献的元素（`elements/*.json`）。
 *
 * ## 为什么这里要按启用状态过滤，而场景不用
 *
 * 场景的可见性由服务端 `/api/scene-types` 决定（那里已经过滤了停用插件），所以
 * 生成文件里多注册几个不影响用户看到什么。元素不一样：它的可见性**就在客户端注册表里**
 * （面板直接读 `allLibraryItems()`），不过滤的话"停用了插件的图标还挂在面板里"。
 *
 * 文件形态三种都收：`{"elements":[...]}` / `[...]` / 单个元素对象。
 */
export function discoverElementEntries(
  pluginDir = PROJECT_PLUGIN_DIR,
): { entries: PluginElementEntry[]; issues: string[] } {
  const entries: PluginElementEntry[] = [];
  const issues: string[] = [];
  // 用 scanPlugins 取启用状态：id 可能来自 manifest（不等于目录名），别自己再算一遍
  const enabled = new Set(
    scanPlugins()
      .filter((p) => p.enabled && !p.errors.length)
      .map((p) => path.resolve(p.dir)),
  );

  for (const plugin of safeDir(pluginDir)) {
    if (!plugin.isDirectory() || plugin.name.startsWith(".") || plugin.name === "node_modules") continue;
    const dir = path.join(pluginDir, plugin.name);
    if (!enabled.has(path.resolve(dir))) continue;
    const elementsDir = path.join(dir, "elements");
    if (!fs.existsSync(elementsDir)) continue;

    for (const f of safeDir(elementsDir)) {
      if (!f.isFile() || !f.name.toLowerCase().endsWith(".json")) continue;
      const file = path.join(elementsDir, f.name);
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (err) {
        issues.push(`${plugin.name}/elements/${f.name} 解析失败：${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const items = Array.isArray(raw)
        ? raw
        : raw && typeof raw === "object" && Array.isArray((raw as { elements?: unknown }).elements)
          ? ((raw as { elements: unknown[] }).elements as unknown[])
          : raw && typeof raw === "object" && "id" in raw
            ? [raw]
            : null;
      if (!items) {
        issues.push(`${plugin.name}/elements/${f.name} 的形态不对：要 {"elements":[...]}、[...] 或 {"id":"...", ...}`);
        continue;
      }
      entries.push({ file, pluginId: plugin.name, items });
    }
  }

  return { entries: entries.sort((a, b) => a.file.localeCompare(b.file)), issues };
}

function render(
  entries: PluginSceneEntry[],
  elements: PluginElementEntry[],
  issues: string[],
  outDir: string,
): string {
  const header = [
    "/* eslint-disable */",
    "/**",
    " * 这个文件由 server/plugin/gen-entry.ts 生成，**不要手改**。",
    " * 它把插件的场景组件、meta、元素以静态 import / 内联数据的方式引入 bundle ——",
    " * 渲染端是 webpack 静态分析，运行时加载任意路径会失败。",
    " *",
    " * 改了插件之后：服务端会在插件变化时自动重新生成（见 content-sync.ts 的 ensurePluginEntryFresh）。",
    " */",
  ];

  const issueLines = issues.length ? ["", ...issues.map((i) => `// ⚠ ${i}`)] : [];

  /*
   * 元素是纯数据，直接内联成字面量，不需要 import 什么文件。
   * 这也是它比场景简单的地方：没有 loader/路径问题，只要内容对就能用。
   */
  const elementRows: string[] = [];
  for (const e of elements) {
    elementRows.push(
      `  { from: ${JSON.stringify(e.pluginId)}, file: ${JSON.stringify(path.basename(e.file))}, items: ${JSON.stringify(e.items)} },`,
    );
  }

  // 两样都没有：只留占位数组，让编译不依赖"装没装插件"
  if (!entries.length && !elements.length) {
    return [
      ...header,
      ...issueLines,
      "",
      "/** 没有插件场景时的占位：保持文件存在，让编译不依赖「装没装插件」 */",
      "export const PLUGIN_SCENES: { meta: unknown; Component: unknown; from: string; file: string }[] = [];",
      "",
      "/** 没有插件元素时的占位 */",
      "export const PLUGIN_ELEMENTS: { from: string; file: string; items: unknown[] }[] = [];",
      "",
    ].join("\n");
  }

  const lines: string[] = [
    ...header,
    'import { jsonToSceneMeta } from "../shared/pluginSceneMeta";',
    'import { registerSceneMeta } from "../shared/sceneMetas";',
    'import { registerSceneComponent } from "./scenes/components";',
    'import { registerLibraryItem } from "../shared/elementLibrary";',
  ];

  if (issueLines.length) lines.push(...issueLines);

  const rows: string[] = [];
  entries.forEach((e, i) => {
    lines.push(
      `import * as comp${i} from ${JSON.stringify(importPath(e.compFile, outDir))};`,
      `import meta${i} from ${JSON.stringify(importPath(e.metaFile, outDir, { keepExt: true }))};`,
    );
    rows.push(
      `  { meta: meta${i} as unknown, Component: (comp${i} as any).default, from: ${JSON.stringify(e.pluginId)}, file: ${JSON.stringify(path.basename(e.metaFile))} },`,
    );
  });

  lines.push(
    "",
    "const candidates: { meta: unknown; Component: any; from: string; file: string }[] = [",
    ...rows,
    "];",
    "",
    "export const PLUGIN_SCENES = candidates;",
    "",
    "/** 注册必须在模块顶层执行：生成文件被 src/index.ts 引入，早于任何渲染 */",
    "for (const c of candidates) {",
    "  const parsed = jsonToSceneMeta(c.meta, `${c.from}/${c.file}`);",
    "  if (!parsed.meta) {",
    "    console.warn('[plugin] 场景 ' + c.from + '/' + c.file + ' 定义不合法，已跳过：' + parsed.issues.join('; '));",
    "    continue;",
    "  }",
    "  const reg = registerSceneMeta(parsed.meta);",
    "  if (!reg.ok) {",
    "    console.warn('[plugin] ' + reg.reason);",
    "    continue;",
    "  }",
    "  if (typeof c.Component !== 'function') {",
    "    console.warn('[plugin] 场景 ' + parsed.meta.type + ' 的组件文件没有 default export，画面会是空白');",
    "  }",
    "  registerSceneComponent(parsed.meta.type, c.Component);",
    "}",
    "",
    "/** 插件元素：纯数据，注册即生效（面板/预览/时间轴读的是同一份注册表） */",
    "export const PLUGIN_ELEMENTS: { from: string; file: string; items: unknown[] }[] = [",
    ...elementRows,
    "];",
    "",
    "for (const e of PLUGIN_ELEMENTS) {",
    "  for (const item of e.items) {",
    "    const r = registerLibraryItem(item);",
    "    if (!r.ok) console.warn('[plugin] 元素 ' + e.from + '/' + e.file + ' 已跳过：' + r.reason);",
    "  }",
    "}",
  );

  return lines.join("\n") + "\n";
}

/**
 * 生成（或检查）插件入口文件。
 *
 * `check: true` 时只比对不写文件，给 CI 用——漂移的生成文件在运行时表现为
 * "装了插件但选择器里没有"，极难定位，所以要有一个能被 CI 抓住的地方。
 */
export function generatePluginEntry(opts: { pluginDir?: string; outFile?: string; check?: boolean } = {}): GenResult {
  const pluginDir = opts.pluginDir ?? PROJECT_PLUGIN_DIR;
  const outFile = opts.outFile ?? path.join(ROOT, GENERATED_ENTRY_REL);
  const outDir = path.dirname(outFile);

  const { entries, issues } = discoverSceneEntries(pluginDir);
  const els = discoverElementEntries(pluginDir);
  const allIssues = [...issues, ...els.issues];
  const next = render(entries, els.entries, allIssues, outDir);

  let prev = "";
  try {
    prev = fs.readFileSync(outFile, "utf8");
  } catch {
    prev = "";
  }
  const changed = prev !== next;

  if (changed && !opts.check) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outFile, next, "utf8");
  }

  // 问诊插件的读取问题顺带报出来：它和场景插件是同一批目录，
  // 让用户在一次输出里看到全部问题，不用逐个工具试
  const briefIssues = pluginBriefSteps().issues;
  const elementCount = els.entries.reduce((n, e) => n + e.items.length, 0);

  return { changed, count: entries.length, elementCount, issues: [...allIssues, ...briefIssues], outFile };
}
