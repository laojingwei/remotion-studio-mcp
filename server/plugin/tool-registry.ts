/**
 * 插件工具的注册表。
 *
 * 为什么单独一个文件、而不是直接 `TOOLS.push(...)`：
 *
 * `TOOLS` 在 `mcp-tools.ts` 里，而那个文件又 import 插件子系统（`./plugin/hooks`）。
 * 如果插件加载器反过来 import `TOOLS`，就成环。把"插件贡献的工具"放这里，
 * 依赖方向就永远是单向的：`mcp-tools → tool-registry ← plugin-tools`。
 *
 * 门面模式（`tool_search` / `tool_call` 每次调用重新遍历）让这件事不需要热替换：
 * 数组内容变了，下一次调用自然看得见，宿主的 `tools/list` 一个字都不用改。
 */

import type { ToolDef } from "../tools/_shared";

export type PluginToolEntry = {
  pluginId: string;
  def: ToolDef;
};

let entries: PluginToolEntry[] = [];

/** 当前可用的插件工具（`tool_search` / `tool_call` 每次都重新取） */
export function pluginTools(): ToolDef[] {
  return entries.map((e) => e.def);
}

/** 带归属的完整清单（诊断 / `list_plugins` 用） */
export function pluginToolEntries(): PluginToolEntry[] {
  return entries;
}

/** 整批替换（重载时用；不做增量合并，避免"删掉的工具还活着"） */
export function replacePluginTools(next: PluginToolEntry[]): void {
  entries = next;
}

/** 某个插件贡献了哪些工具（`list_plugins` 展示用） */
export function pluginToolNamesOf(pluginId: string): string[] {
  return entries.filter((e) => e.pluginId === pluginId).map((e) => e.def.name);
}
