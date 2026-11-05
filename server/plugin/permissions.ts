/**
 * 权限：声明式，默认拒绝。
 *
 * ## 为什么这一层在 L0 就建起来
 *
 * L0 插件一个权限都不需要——它只提供数据（md / json），不读工程、不写文件。
 * 但「权限」这件事必须在**第一批插件存在之前**就有定义，否则等到批次 4
 * 引入代码插件时才补，会出现一批"没声明权限也要跑"的历史插件，
 * 那时候再加校验就是破坏性变更。
 *
 * 所以这里先把定义与判定逻辑立住，L0 只是不用它；批次 4 的代码插件
 * 直接继承同一套语义，没有迁移成本。
 */

import type { Permission, PluginManifest } from "./manifest";
import { PERMISSIONS } from "./manifest";

/** 权限的中文说明（`list_plugins` 要展示给人看，光给 `project:write` 看不懂） */
const PERMISSION_DESC: Record<Permission, string> = {
  "project:read": "读工程数据",
  "project:write": "改工程数据（能删幕、改文案、动主题）",
  "assets:read": "读素材库与上传的文件",
  "assets:write": "写/删素材文件",
  render: "起渲染（占 CPU 与磁盘，能生成成片）",
  net: "发起网络请求",
  exec: "起子进程（等于这台机器上的一切，默认拒绝）",
};

export const describePermission = (p: Permission): string => PERMISSION_DESC[p] ?? p;

/** 人话描述一组权限；空数组给一句"不需要任何权限" */
export function describePermissions(list: Permission[]): string {
  if (!list.length) return "不需要任何权限（只提供数据）";
  return list.map((p) => `${p}（${describePermission(p)}）`).join("；");
}

export class PermissionDenied extends Error {
  constructor(
    readonly pluginId: string,
    readonly permission: Permission,
  ) {
    super(
      `插件「${pluginId}」没有声明 ${permission}（${describePermission(permission)}）权限，已拒绝。` +
        `确实需要就在它的 manifest.json 的 permissions 里加上 "${permission}"；` +
        `不确定要不要给，就别给——插件只是没这个能力，不会因此坏掉`,
    );
    this.name = "PermissionDenied";
  }
}

/**
 * 断言插件有某个权限，没有就抛 `PermissionDenied`。
 *
 * 调用方是宿主的能力边界（批次 4 的写工程 / 起渲染 / 联网入口）。
 * 抛错而不是返回 false，是因为调用点几乎都是"没有就没法继续"，
 * 返回布尔会让每个调用点都写一遍 `if (!ok) throw`，忘一个就是一个洞。
 */
export function assertPermission(plugin: PluginManifest | null, permission: Permission): void {
  const id = plugin?.id ?? "(未知插件)";
  if (!plugin) throw new PermissionDenied(id, permission);
  if (!plugin.permissions.includes(permission)) throw new PermissionDenied(id, permission);
}

/** 权限清单是否合法（manifest 解析时已过滤，这里给测试与诊断用） */
export function invalidPermissions(list: unknown[]): string[] {
  return list.filter((p) => typeof p !== "string" || !(PERMISSIONS as readonly string[]).includes(p)) as string[];
}
