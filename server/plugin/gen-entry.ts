/**
 * 生成 `src/_plugins.generated.ts`：把插件场景的组件与 meta 静态引入 bundle。
 *
 * ## 为什么必须"生成文件"而不是运行时加载
 *
 * 渲染端是 `bundle({ entryPoint: src/index.ts })` —— webpack 做**静态依赖分析**。
 * `require(任意运行时路径)` 或 `import(variable)` 会打进一个空壳，运行时报找不到模块。
 * 唯一可靠的办法是让这些路径在**编译期就是字面量**，也就是生成一个真代码文件。
 *
 * ## 为什么只扫项目内的 plugins/
 *
 * `~/.remotion-studio/plugins/` 在项目外，webpack 的 loader 规则与 tsconfig 的
 * include 都覆盖不到。所以规则是：
 * **内容类插件（技能/风格/问诊）可以放用户级；渲染类（场景组件）必须放项目内。**
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
import { PROJECT_PLUGIN_DIR } from "./discovery";
import { pluginBriefSteps } from "./brief-steps";

/** 生成文件的默认位置（相对工程根） */
export const GENERATED_ENTRY_REL = "src/_plugins.generated.ts";

export type PluginSceneEntry = {
  metaFile: string;
  compFile: string;
  pluginId: string;
};

export type GenResult = {
  changed: boolean;
  count: number;
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

function render(entries: PluginSceneEntry[], issues: string[], outDir: string): string {
  const header = [
    "/* eslint-disable */",
    "/**",
    " * 这个文件由 server/plugin/gen-entry.ts 生成，**不要手改**。",
    " * 它把插件场景的组件与 meta 以静态 import 的方式引入 bundle ——",
    " * 渲染端是 webpack 静态分析，运行时加载任意路径会失败。",
    " *",
    " * 改了插件之后：服务端重新打包前会自动重新生成（见 render.service.ts）。",
    " */",
  ];

  // 空插件时只留占位数组：import 了却不调用会被 lint 判未使用
  if (!entries.length) {
    return [
      ...header,
      ...(issues.length ? ["", ...issues.map((i) => `// ⚠ ${i}`)] : []),
      "",
      '/** 没有插件场景时的占位：保持文件存在，让编译不依赖「装没装插件」 */',
      "export const PLUGIN_SCENES: { meta: unknown; Component: unknown; from: string; file: string }[] = [];",
      "",
    ].join("\n");
  }

  const lines: string[] = [
    ...header,
    'import { jsonToSceneMeta } from "../shared/pluginSceneMeta";',
    'import { registerSceneMeta } from "../shared/sceneMetas";',
    'import { registerSceneComponent } from "./scenes/components";',
  ];

  if (issues.length) lines.push("", ...issues.map((i) => `// ⚠ ${i}`));

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
  const next = render(entries, issues, outDir);

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

  return { changed, count: entries.length, issues: [...issues, ...briefIssues], outFile };
}
