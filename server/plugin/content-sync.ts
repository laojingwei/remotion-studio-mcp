/**
 * 内容型注册表的同步：把 `plugins/*` 里的 JSON 数据灌进 `shared/` 里的注册表。
 *
 * ## 为什么需要这一层
 *
 * `shared/` 是纯函数、不碰 fs（渲染 bundle 与 web bundle 也引它），
 * 所以「插件提供了什么」只能由服务端读盘后**注入**。
 * `shared/sceneMetas.ts#registerSceneMeta` 是同一个套路，这里把它复制到数据类贡献项上。
 *
 * ## 为什么自己算指纹，而不复用 ensurePluginScenes 的那次
 *
 * 场景那次的指纹只覆盖 `scenes/*.json`——用户**只加一个 skies.json** 时它不会变，
 * 于是"插件明明加了天空却一直不生效"。所以这里自己扫一遍候选文件（每个插件目录 1 次存在性判断），
 * 变了才去调 `pluginFiles()`（那个会全量扫目录，贵）。
 *
 * ## 幂等
 *
 * 同名 id 重复注册 = 文件被改了，直接替换；文件消失/插件停用 → 注销。
 * 所以可以重复调用，不需要调用方记状态。
 */

import fs from "node:fs";
import path from "node:path";
import { PLUGIN_STATE_FILE, pluginFiles, pluginRoots } from "./discovery";
import { generatePluginEntry } from "./gen-entry";
import { registerWorldSky, unregisterWorldSky } from "../../shared/worldPresets";
import { registerTemplate, unregisterTemplate } from "../../shared/templates";
import { registerLibraryItem, unregisterLibraryItem } from "../../shared/elementLibrary";
import { registerLook, unregisterLook } from "../../shared/scene3dLooks";

type Candidate = { file: string; pluginId: string };

function safeReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 不查启用状态、不解析清单，只按目录结构捞出候选文件。
 * 这是**热路径**（每请求一次），所以刻意廉价：两三个 readdir + 每插件一次 existsSync。
 */
function candidateFiles(relPath: string): Candidate[] {
  const out: Candidate[] = [];
  for (const root of pluginRoots()) {
    if (!root.exists) continue;
    for (const d of safeReadDir(root.dir)) {
      if (!d.isDirectory() || d.name.startsWith(".") || d.name === "node_modules") continue;
      const file = path.join(root.dir, d.name, relPath);
      if (fs.existsSync(file)) out.push({ file, pluginId: d.name });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** 路径 + mtime + size：只算 mtime 会漏掉"同一秒保存两次" */
function fingerprint(files: Candidate[]): string {
  let key = "";
  for (const f of files) {
    try {
      const st = fs.statSync(f.file);
      key += `${f.file}@${st.mtimeMs}@${st.size}|`;
    } catch {
      key += `${f.file}@gone|`;
    }
  }
  // 启用状态也要进指纹：停用插件不会改它的文件，但会让它的贡献失效
  try {
    key += `#state@${fs.statSync(PLUGIN_STATE_FILE).mtimeMs}`;
  } catch {
    key += "#state@none";
  }
  return key;
}

/** 本模块注册过的天空 id（只有这些才允许注销，避免误删内置） */
const ownedSkies = new Set<string>();
let skyKey = "";
let skyIssues: string[] = [];

/**
 * 把 `scene3d/skies.json` 里声明的配方登记进 `shared/worldPresets`。
 *
 * 文件形态两种都收，作者不用记：
 *   `{ "skies": [ ... ] }`（推荐，留了加别的字段的余地）
 *   `[ ... ]`（纯数组，最省事）
 */
export function syncPluginWorldSkies(): { count: number; issues: string[] } {
  const key = fingerprint(candidateFiles(path.join("scene3d", "skies.json")));
  if (key === skyKey) return { count: ownedSkies.size, issues: [...skyIssues] };

  // 走到这里才扫全目录：pluginFiles 会排除停用的插件，正好是我们要的语义
  const files = pluginFiles("scene3d.sky", ".json");
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const { file, pluginId } of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      issues.push(`${pluginId}/scene3d/skies.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { skies?: unknown }).skies)
        ? ((raw as { skies: unknown[] }).skies as unknown[])
        : null;
    if (!list) {
      issues.push(`${pluginId}/scene3d/skies.json 的形态不对：要 {"skies":[...]} 或 [...]`);
      continue;
    }

    for (const item of list) {
      const reg = registerWorldSky(item, pluginId);
      if (!reg.ok) {
        issues.push(`${pluginId}/scene3d/skies.json：${reg.reason}`);
        continue;
      }
      const id = (item as { id: string }).id.trim();
      seen.add(id);
      ownedSkies.add(id);
    }
  }

  // 撤销：这次没读到（插件停用 / 文件被删 / id 改了）且是我们注册的
  for (const id of [...ownedSkies]) {
    if (seen.has(id)) continue;
    if (unregisterWorldSky(id)) ownedSkies.delete(id);
  }

  skyKey = key;
  skyIssues = issues;
  return { count: ownedSkies.size, issues: [...issues] };
}

/** 诊断用：当前由插件提供的天空 id */
export const pluginWorldSkyIds = (): string[] => [...ownedSkies].sort();

/* ─────────────────────────── 整片模板 ─────────────────────────── */

const ownedTemplates = new Set<string>();
let tplKey = "";
let tplIssues: string[] = [];

/**
 * 目录型候选：`<plugin>/templates/*.json` 可能有多个文件，和 skies 那种"一个固定文件名"不同。
 * 同样只看目录结构、不解析清单，保持热路径廉价。
 */
function candidateDirFiles(relDir: string): Candidate[] {
  const out: Candidate[] = [];
  for (const root of pluginRoots()) {
    if (!root.exists) continue;
    for (const d of safeReadDir(root.dir)) {
      if (!d.isDirectory() || d.name.startsWith(".") || d.name === "node_modules") continue;
      const dir = path.join(root.dir, d.name, relDir);
      // 先用 existsSync 挡一下：绝大多数插件没有 templates/，靠 readdir 抛 ENOENT 再 catch
      // 就是每请求几十次异常（Windows 上尤其贵），热路径上不值得
      if (!fs.existsSync(dir)) continue;
      for (const f of safeReadDir(dir)) {
        if (!f.isFile() || !f.name.toLowerCase().endsWith(".json")) continue;
        out.push({ file: path.join(dir, f.name), pluginId: d.name });
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * 把 `templates/*.json` 里声明的整片模板登记进 `shared/templates`。
 *
 * 支持三种文件形态（作者不用记规则）：
 *   `{ "templates": [ ... ] }`  一个文件放多个（推荐）
 *   `[ ... ]`                   纯数组
 *   `{ "key": "...", "scenes": [...] }`  一个文件一个模板
 */
export function syncPluginTemplates(): { count: number; issues: string[] } {
  const key = fingerprint(candidateDirFiles("templates"));
  if (key === tplKey) return { count: ownedTemplates.size, issues: [...tplIssues] };

  const files = pluginFiles("template", ".json");
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const { file, pluginId } of files) {
    const where = `${pluginId}/templates/${path.basename(file)}`;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      issues.push(`${where} 解析失败：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const list: unknown[] = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { templates?: unknown }).templates)
        ? ((raw as { templates: unknown[] }).templates as unknown[])
        : raw && typeof raw === "object" && "key" in raw
          ? [raw]
          : [];
    if (!list.length) {
      issues.push(`${where} 的形态不对：要 {"templates":[...]}、[...] 或 {"key":"...","scenes":[...]}`);
      continue;
    }

    for (const item of list) {
      const reg = registerTemplate(item, pluginId);
      if (!reg.ok) {
        issues.push(`${where}：${reg.reason}`);
        continue;
      }
      const k = String((item as { key: string }).key).trim();
      seen.add(k);
      ownedTemplates.add(k);
    }
  }

  for (const k of [...ownedTemplates]) {
    if (seen.has(k)) continue;
    if (unregisterTemplate(k)) ownedTemplates.delete(k);
  }

  tplKey = key;
  tplIssues = issues;
  return { count: ownedTemplates.size, issues: [...issues] };
}

/** 诊断用：当前由插件提供的模板 key */
export const pluginTemplateKeys = (): string[] => [...ownedTemplates].sort();

/* ─────────────────────────── 元素素材 ─────────────────────────── */

const ownedElements = new Set<string>();
let elKey = "";
let elIssues: string[] = [];

/**
 * 把 `elements/*.json` 登记进 `shared/elementLibrary`。
 *
 * ## 这条路只服务服务端
 *
 * 编辑器与渲染端的元素来自**生成文件**（`src/_plugins.generated.ts`）——
 * 它们是独立 bundle，读不到这里的注册表。所以两处必须都接：
 *  - 这里：MCP 的 `list_element_library` / `add_element { libraryId }` 能用插件元素
 *  - 生成文件：面板、预览、两条时间轴能用
 *
 * 同一份 JSON、同一个校验函数，两边不会漂。
 */
export function syncPluginElements(): { count: number; issues: string[] } {
  const key = fingerprint(candidateDirFiles("elements"));
  if (key === elKey) return { count: ownedElements.size, issues: [...elIssues] };

  const files = pluginFiles("elements", ".json");
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const { file, pluginId } of files) {
    const where = `${pluginId}/elements/${path.basename(file)}`;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      issues.push(`${where} 解析失败：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const list: unknown[] = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { elements?: unknown }).elements)
        ? ((raw as { elements: unknown[] }).elements as unknown[])
        : raw && typeof raw === "object" && "id" in raw
          ? [raw]
          : [];
    if (!list.length) {
      issues.push(`${where} 的形态不对：要 {"elements":[...]}、[...] 或 {"id":"...", ...}`);
      continue;
    }
    for (const item of list) {
      const reg = registerLibraryItem(item);
      if (!reg.ok) {
        issues.push(`${where}：${reg.reason}`);
        continue;
      }
      const id = String((item as { id: string }).id).trim();
      seen.add(id);
      ownedElements.add(id);
    }
  }

  for (const id of [...ownedElements]) {
    if (seen.has(id)) continue;
    if (unregisterLibraryItem(id)) ownedElements.delete(id);
  }

  elKey = key;
  elIssues = issues;
  return { count: ownedElements.size, issues: [...issues] };
}

/** 诊断用：当前由插件提供的元素 id */
export const pluginElementIds = (): string[] => [...ownedElements].sort();

/* ─────────────────────────── 3D 光线风格 ─────────────────────────── */

const ownedLooks = new Set<string>();
let lookKey = "";
let lookIssues: string[] = [];

/**
 * 把 `scene3d/looks.json` 登记进 `shared/scene3dLooks`。
 *
 * 服务端要这份是因为 `/api/scene-types` 的 `look` 字段选项来自注册表——
 * agent 只能选它看得见的 id。渲染端另外从生成文件拿（bundle 独立）。
 */
export function syncPluginLooks(): { count: number; issues: string[] } {
  const key = fingerprint(candidateFiles(path.join("scene3d", "looks.json")));
  if (key === lookKey) return { count: ownedLooks.size, issues: [...lookIssues] };

  const files = pluginFiles("scene3d.look", ".json");
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const { file, pluginId } of files) {
    const where = `${pluginId}/scene3d/looks.json`;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      issues.push(`${where} 解析失败：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const list: unknown[] = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { looks?: unknown }).looks)
        ? ((raw as { looks: unknown[] }).looks as unknown[])
        : raw && typeof raw === "object" && "id" in raw
          ? [raw]
          : [];
    if (!list.length) {
      issues.push(`${where} 的形态不对：要 {"looks":[...]}、[...] 或 {"id":"...", ...}`);
      continue;
    }
    for (const item of list) {
      const id = String((item as { id?: string })?.id ?? "").trim();
      const reg = registerLook(id, item);
      if (!reg.ok) {
        issues.push(`${where}：${reg.reason}`);
        continue;
      }
      seen.add(id);
      ownedLooks.add(id);
    }
  }

  for (const id of [...ownedLooks]) {
    if (seen.has(id)) continue;
    if (unregisterLook(id)) ownedLooks.delete(id);
  }

  lookKey = key;
  lookIssues = issues;
  return { count: ownedLooks.size, issues: [...issues] };
}

/** 诊断用：当前由插件提供的 look id */
export const pluginLookIds = (): string[] => [...ownedLooks].sort();

/* ───────────────────── 生成文件（web/渲染端那一份） ───────────────────── */

let entryKey = "";

/**
 * 插件内容变了就重新生成 `src/_plugins.generated.ts`。
 *
 * ## 为什么非要有这一步
 *
 * 场景的工作流是"渲染前一定重新打包，打包前一定重新生成"，所以它从不缺这一步。
 * 元素不一样：它的消费者是**编辑器面板**，用户装完插件打开面板就要看见，
 * 中间可能一次渲染都没跑过。没有这个触发器，`elements/` 要等到下次渲染才生效——
 * 表现就是"装了没反应"。
 *
 * 成本：只 stat（场景与元素 json + 状态文件），变了才解析与写文件；没变就是十几次 stat。
 * 这与 `ensurePluginScenes` 每请求已经做的扫描同一量级。
 */
export function ensurePluginEntryFresh(): { changed: boolean; issues: string[] } {
  const candidates = [
    ...candidateDirFiles("scenes"),
    ...candidateDirFiles("elements"),
    ...candidateFiles(path.join("scene3d", "looks.json")),
  ];
  const key = fingerprint(candidates);
  if (key === entryKey) return { changed: false, issues: [] };
  const res = generatePluginEntry();
  entryKey = key;
  return { changed: res.changed, issues: res.issues };
}
