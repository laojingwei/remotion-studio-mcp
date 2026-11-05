/**
 * 服务端的插件场景注册。
 *
 * ## 三端要看到同一份场景表
 *
 *   服务端（agent 工具、参数校验）  ← 这里：读 JSON → 转 SceneMeta → registerSceneMeta
 *   编辑器（属性面板、选择器）      ← 走 `/api/scene-types`，读的就是上面注册后的 SCENE_METAS
 *   渲染端（Remotion）              ← 走 `src/_plugins.generated.ts` 的静态 import
 *
 * 三者必须一致。差一个就会出现最坏的情况：**agent 能选、编辑器能编辑、渲染出来是白屏**。
 * 所以这里和生成器用**同一份 JSON、同一个转换函数**（`shared/pluginSceneMeta`）。
 *
 * ## 为什么带缓存又"看起来每次都扫"
 *
 * 指纹是「所有场景 json 的 路径+mtime+大小」。没变就直接返回上次结论（一次 stat 十几个文件），
 * 变了才重读。这样 `list_scene_types` 这种高频调用不会被磁盘 I/O 拖住，
 * 而改插件之后第一次调用就能看到新内容。
 */

import fs from "node:fs";
import path from "node:path";
import { discoverSceneEntries } from "./gen-entry";
import { activePlugins, PLUGIN_STATE_FILE } from "./discovery";
import { jsonToSceneMeta } from "../../shared/pluginSceneMeta";
import { registerSceneMeta, unregisterSceneMeta } from "../../shared/sceneMetas";

/** 本模块注册过的 type（只有这些才允许注销，避免误删内置场景） */
const owned = new Set<string>();

let lastKey = "";
let lastResult: { total: number; issues: string[] } = { total: 0, issues: [] };

/** 插件目录（`plugins/<名>`），用来和启用状态对上 */
const pluginDirOf = (metaFile: string) => path.dirname(path.dirname(metaFile));

/**
 * 确保插件场景都已注册。**幂等**，可高频调用。
 *
 * 停用的插件会被注销（`toggle_plugin` 之后立刻从场景选择器消失）。
 */
export function ensurePluginScenes(): { total: number; issues: string[] } {
  const { entries, issues: pairIssues } = discoverSceneEntries();

  // 指纹：路径 + mtime + size。只算 mtime 的话，编辑器"同一秒保存两次"会漏检
  let key = "";
  for (const e of entries) {
    try {
      const st = fs.statSync(e.metaFile);
      key += `${e.metaFile}@${st.mtimeMs}@${st.size}|`;
    } catch {
      key += `${e.metaFile}@gone|`;
    }
  }

  /*
   * 启用状态也要进指纹，但**不能靠调 `activePlugins()` 去算** ——
   * 那个函数会遍历所有插件目录做十几次 fs 调用，而本函数会被
   * `list_scene_types` / `add_scene` 这类高频工具调用。
   * 用状态文件的 mtime 当代理：`toggle_plugin` 一定改写这个文件。
   */
  try {
    key += `#state@${fs.statSync(PLUGIN_STATE_FILE).mtimeMs}`;
  } catch {
    key += "#state@none";
  }

  if (key === lastKey) return lastResult;

  // 指纹变了才去读启用状态（这一步贵）
  const enabledDirs = new Set(activePlugins().map((p) => p.dir));

  const issues: string[] = [...pairIssues];
  const stillValid = new Set<string>();

  for (const entry of entries) {
    const pluginDir = pluginDirOf(entry.metaFile);

    // 停用的插件：把它注册过的场景撤掉
    if (!enabledDirs.has(pluginDir)) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(entry.metaFile, "utf8"));
    } catch (err) {
      issues.push(
        `${path.basename(entry.metaFile)} 解析失败：${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const { meta, issues: metaIssues } = jsonToSceneMeta(raw, path.basename(pluginDir));
    for (const i of metaIssues) issues.push(i);
    if (!meta) continue;

    stillValid.add(meta.type);
    if (owned.has(meta.type)) continue; // 已经注册过，且内容变化不影响 schema 的注册（meta 是快照）

    const reg = registerSceneMeta(meta);
    if (reg.ok) owned.add(meta.type);
    else issues.push(reg.reason ?? `${meta.type} 注册失败`);
  }

  // 撤销：不再有效（被停用 / 文件被删）且是我们注册的
  for (const type of [...owned]) {
    if (stillValid.has(type)) continue;
    if (unregisterSceneMeta(type)) {
      owned.delete(type);
    }
  }

  lastKey = key;
  lastResult = { total: owned.size, issues };
  return lastResult;
}

/** 当前由插件提供的场景 type（给诊断工具用） */
export function pluginSceneTypes(): string[] {
  return [...owned].sort();
}
