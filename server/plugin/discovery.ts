/**
 * 插件发现：扫描目录、读清单、判断启用状态。
 *
 * ## 这里是"热更新"的全部秘密：**不做缓存**
 *
 * 每次调用都重新 `readdirSync` + `readFileSync`。原因是插件目录通常只有几个到几十个
 * 文件夹，一次全扫是毫秒级；而一旦缓存，就会出现「删了插件它还活着」「改了没反应」
 * 这类最难解释的问题——它们看起来像宿主坏了，实际是缓存。
 *
 * 对比一下：技能库（`server/skills.service.ts`）本来就是每次读文件，
 * 所以它天然热更新。这里沿用同一个选择，不引入新的一致性风险。
 *
 * ## 双目录
 *
 *   <repo>/plugins/                项目内，随仓库共享
 *   ~/.remotion-studio/plugins/    用户级，跨项目、升级不覆盖
 *
 * 两个都扫、都启用。同名 id 时**项目内优先**（项目内的是这个项目专用的，
 * 用户级的可能是通用件，项目内也应该有能力覆盖它）。
 *
 * `STUDIO_PLUGINS_DIR` 可覆盖项目内目录——测试用临时目录，不碰真实插件。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../root";
import { DATA_ROOT } from "../paths";
import {
  packageToManifest,
  parseManifest,
  toPluginId,
  type PluginManifest,
  type ProvideKind,
} from "./manifest";
import { declaresCodeEntry, isBrokenPackage, lintPackage, readPackageJson, resolvePluginEntry } from "./entry";

/** 项目内插件目录（相对工程根） */
export const PROJECT_PLUGIN_DIR_NAME = "plugins";

const overrideDir = process.env.STUDIO_PLUGINS_DIR?.trim();

/** 项目内插件目录的绝对路径 */
export const PROJECT_PLUGIN_DIR = overrideDir
  ? path.resolve(overrideDir)
  : path.join(ROOT, PROJECT_PLUGIN_DIR_NAME);

/** 用户级插件目录（跨项目） */
export const USER_PLUGIN_DIR = path.join(os.homedir(), ".remotion-studio", "plugins");

/** 启用状态文件（放 data/ 下，跟 tts-config.json 同一层） */
export const PLUGIN_STATE_FILE = path.join(DATA_ROOT, "plugins.json");
const STATE_FILE = PLUGIN_STATE_FILE;

export type PluginScope = "project" | "user";

export type DiscoveredPlugin = {
  id: string;
  /** 展示名（manifest.name，没 manifest 就用目录名） */
  name: string;
  version: string;
  dir: string;
  scope: PluginScope;
  /** 相对项目根的展示路径；用户级目录显示为绝对路径的 ~ 缩写 */
  pathLabel: string;
  /** 无 manifest 时为 null（隐式插件，按目录结构推断） */
  manifest: PluginManifest | null;
  /** 实际生效的贡献项（manifest 声明 + 目录推断的并集） */
  provides: ProvideKind[];
  enabled: boolean;
  warnings: string[];
  errors: string[];
};

export type PluginRoot = { dir: string; scope: PluginScope; exists: boolean };

/** 两个插件根目录（顺序 = 优先级：项目内在前） */
export function pluginRoots(): PluginRoot[] {
  return [
    { dir: PROJECT_PLUGIN_DIR, scope: "project", exists: fs.existsSync(PROJECT_PLUGIN_DIR) },
    { dir: USER_PLUGIN_DIR, scope: "user", exists: fs.existsSync(USER_PLUGIN_DIR) },
  ];
}

/**
 * 按目录结构推断 provides（无 manifest 时用）。
 *
 * 规则就是「有这个目录就算这项」：想让宿主认，不需要声明，把文件放到对的位置即可。
 * 这是 L0「丢个 md 就生效」的实现方式。
 */
export function inferProvides(dir: string): ProvideKind[] {
  const out: ProvideKind[] = [];
  const has = (rel: string) => fs.existsSync(path.join(dir, rel));

  const hasMd = (relDir: string) => {
    const d = path.join(dir, relDir);
    if (!fs.existsSync(d)) return false;
    try {
      return fs.readdirSync(d).some((f) => f.endsWith(".md"));
    } catch {
      return false;
    }
  };
  const hasJson = (relDir: string) => {
    const d = path.join(dir, relDir);
    if (!fs.existsSync(d)) return false;
    try {
      return fs.readdirSync(d).some((f) => f.endsWith(".json"));
    } catch {
      return false;
    }
  };

  if (hasMd("skills")) out.push("skill");
  if (hasMd("styles")) out.push("style");
  if (hasJson("templates")) out.push("template");
  if (hasJson("elements")) out.push("elements");
  if (has("scene3d/skies.json")) out.push("scene3d.sky");
  if (has("scene3d/presets.json")) out.push("scene3d.preset");
  if (has("scene3d/looks.json")) out.push("scene3d.look");
  if (has("brief/steps.json")) out.push("brief.steps");
  // 场景组件：scenes 目录里有 .json 就算（同名的 .tsx 由生成器配对检查）
  if (hasJson("scenes")) out.push("scene");
  /*
   * 代码插件：能不能解析出一个入口（单文件 plugin.ts，或 package.json 指向的
   * 已构建 dist/）。判断交给 `resolvePluginEntry`，不在两处各维护一份文件名表——
   * 那正是最早那个"改了一边忘另一边"的坑。
   */
  const pkg = readPackageJson(dir);
  // 已构建（能解析出入口）**或**声明了入口但还没构建 —— 两种都算代码插件。
  // 后者必须被发现，否则用户 clone 下来还没 build 时，插件会凭空消失。
  if (resolvePluginEntry(dir).kind !== "unbuilt" || declaresCodeEntry(pkg)) out.push("hooks");
  return out;
}

type PluginState = { disabled: string[] };

function readState(): PluginState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as PluginState;
    return { disabled: Array.isArray(raw?.disabled) ? raw.disabled.filter((x) => typeof x === "string") : [] };
  } catch {
    return { disabled: [] };
  }
}

function writeState(state: PluginState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** 某个插件是否被显式停用 */
export function isPluginEnabled(id: string): boolean {
  return !readState().disabled.includes(id);
}

/**
 * 启用/停用插件。
 *
 * 用**黑名单**（disabled）而不是白名单：新插件放进来默认就是活的。
 * 白名单会让"我放好了怎么没反应"变成一个必须翻文档才能解决的问题，
 * 与「放进去就用」的目标相反。
 */
export function setPluginEnabled(id: string, enabled: boolean): void {
  const state = readState();
  const set = new Set(state.disabled);
  if (enabled) set.delete(id);
  else set.add(id);
  writeState({ disabled: [...set].sort() });
}

function safeReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const label = (dir: string, scope: PluginScope): string => {
  if (scope === "project") return path.relative(ROOT, dir).split(path.sep).join("/") || ".";
  const home = os.homedir();
  return dir.startsWith(home) ? "~" + dir.slice(home.length).split(path.sep).join("/") : dir;
};

/**
 * 扫描全部插件。**每次现扫**（见文件头注释：这是热更新的实现方式）。
 *
 * 返回的列表包含有错误的插件（`errors` 非空），因为「看不见坏插件」
 * 比「看见一个坏插件」更难排查。调用方自己决定要不要展示。
 */
export function scanPlugins(): DiscoveredPlugin[] {
  const found: DiscoveredPlugin[] = [];
  const seen = new Set<string>();

  for (const root of pluginRoots()) {
    if (!root.exists) continue;
    for (const entry of safeReadDir(root.dir)) {
      if (!entry.isDirectory()) continue;
      // 隐藏目录 + node_modules 一律跳过（编辑器/依赖的垃圾不算插件）
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const dir = path.join(root.dir, entry.name);
      const dirId = toPluginId(entry.name);
      const warnings: string[] = [];
      const errors: string[] = [];

      const manifestFile = path.join(dir, "manifest.json");
      let manifest: PluginManifest | null = null;

      const pkg = readPackageJson(dir);
      const entryInfo = resolvePluginEntry(dir);

      if (fs.existsSync(manifestFile)) {
        let raw: unknown = null;
        try {
          raw = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        } catch (err) {
          errors.push(`manifest.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
        }
        if (raw !== null) {
          const parsed = parseManifest(raw, { dirId });
          manifest = parsed.manifest;
          warnings.push(...parsed.warnings);
          errors.push(...parsed.errors);
        }
        if (pkg) warnings.push(...lintPackage(pkg));
      } else if (pkg && isBrokenPackage(pkg)) {
        errors.push("package.json 存在但解析失败（JSON 语法错误？）——修好它，或者删掉它改用单文件 plugin.ts");
      } else if (pkg) {
        /*
         * 没有 manifest.json 时，package.json 就是清单。
         *
         * 但**有 package.json 不等于就是插件**：用户的 plugins/ 下可能躺着一个
         * 随手拷进来的 npm 包。判据三条，命中任一才算：
         *   1. 写了 `remotionStudio` 字段（作者明确声明）
         *   2. 能解析出代码入口（它至少能 export 钩子/工具/处理链）
         *   3. 声明了 `main` / `module` / `exports`，但产物**还没构建**
         *
         * 第三条是刻意放宽的。只认前两条的话，用户 git clone 一个插件、还没跑
         * `npm install && npm run build` 时，宿主**完全看不见它**——不报错、不提示，
         * 现象就是"我装了但没生效"，而这正是最难自查的一类问题。
         * 宁可多认一个待构建的目录（它会显示成"未构建 + 该跑什么命令"），
         * 也不要让插件凭空消失。
         */
        const hasPluginField = pkg.remotionStudio && typeof pkg.remotionStudio === "object";
        if (hasPluginField || entryInfo.kind !== "unbuilt" || declaresCodeEntry(pkg)) {
          const parsed = parseManifest(packageToManifest(pkg, dirId), { dirId });
          manifest = parsed.manifest;
          warnings.push(...parsed.warnings);
          errors.push(...parsed.errors);
          warnings.push(...lintPackage(pkg));
        }
      }

      const inferred = inferProvides(dir);
      // manifest 声明 + 目录推断取并集：声明漏了但目录里有，也算数（少让人踩坑）
      const provides = [...new Set([...(manifest?.provides ?? []), ...inferred])];

      if (!manifest && !provides.length) {
        // 目录里既没有清单也没有可识别的结构：不是插件，静默跳过。
        // 不报错——用户可能只是在 plugins/ 下放了个 README 或临时文件夹。
        continue;
      }

      const id = manifest?.id ?? dirId;
      if (seen.has(id)) {
        // 项目内优先：先扫到的（project scope）留下，后面的跳过并记一条
        warnings.push(`id「${id}」与更高优先级的插件重复，本插件未加载`);
        found.push({
          id,
          name: manifest?.name ?? entry.name,
          version: manifest?.version ?? "0.0.0",
          dir,
          scope: root.scope,
          pathLabel: label(dir, root.scope),
          manifest,
          provides,
          enabled: false,
          warnings,
          errors: [...errors, `id 冲突：${id}`],
        });
        continue;
      }
      seen.add(id);

      found.push({
        id,
        name: manifest?.name ?? entry.name,
        version: manifest?.version ?? "0.0.0",
        dir,
        scope: root.scope,
        pathLabel: label(dir, root.scope),
        manifest,
        provides,
        enabled: isPluginEnabled(id),
        warnings,
        errors,
      });
    }
  }

  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 可用的插件（无错误且启用）。
 *
 * 所有 L0 消费点（技能/风格/元素/3D 配方）都走这里，
 * 保证"停用一个插件"对所有类型同时生效，不会出现"风格没了但技能还在"。
 */
export function activePlugins(): DiscoveredPlugin[] {
  return scanPlugins().filter((p) => p.enabled && p.errors.length === 0);
}

export type PluginFile = {
  /** 绝对路径 */
  file: string;
  /** 所属插件 id（报错时能指回是哪个插件的问题） */
  pluginId: string;
};

/**
 * 取某类贡献项的文件清单。
 *
 * 各消费点自己解析文件内容（而不是在 registry 里统一解析），
 * 是为了避免循环依赖：`shared/elementLibrary` 要调这里，
 * 如果这里反过来 import 元素库的类型，ESM 会成环。
 */
export function pluginFiles(kind: ProvideKind, ext: string): PluginFile[] {
  const out: PluginFile[] = [];
  for (const p of activePlugins()) {
    if (!p.provides.includes(kind)) continue;
    // 贡献项 → 目录映射。放错目录就不算，规则要能一句话说清
    const rel =
      kind === "skill"
        ? "skills"
        : kind === "style"
          ? "styles"
          : kind === "template"
            ? "templates"
            : kind === "elements"
              ? "elements"
              : kind === "brief.steps"
                ? "brief"
                : "scene3d";
    const dir = path.join(p.dir, rel);
    for (const e of safeReadDir(dir)) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith(ext)) continue;
      // scene3d 与 brief 目录里按文件名精确挑，避免把 presets 当 skies 读
      if (rel === "scene3d") {
        const want = kind === "scene3d.sky" ? "skies" : kind === "scene3d.preset" ? "presets" : "looks";
        if (path.basename(e.name, ext).toLowerCase() !== want) continue;
      }
      if (rel === "brief" && path.basename(e.name, ext).toLowerCase() !== "steps") continue;
      out.push({ file: path.join(dir, e.name), pluginId: p.id });
    }
  }
  return out;
}
