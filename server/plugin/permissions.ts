/**
 * 断言能力边界的辅助物：`PermissionDenied` + 人话描述。
 *
 * ## 真正的执法点不在这里
 *
 * 有个 `assertPermission(manifest, perm)` 曾定义在这里，但零调用点——
 * 实际执法走 `plugin-tools.ts#capabilitiesFor` 里的 `require(perm)`（它拿得到
 * 当前插件的 id，报错才说得清是谁干的）。2026-11-06 把这个死函数删了：
 * 留着它会让人以为"加一个 assert 就安全了"，而真正的门控在别处。
 *
 * ## 必须先说清：权限不是沙箱
 *
 * `plugin.ts` 是被 `import()` 执行的任意代码，顶层直接 `import fs` 就能绕过所有检查。
 * 权限声明的真实作用是**知情同意**（用户 `list_plugins` 时能看见"这个插件要读写我的工程"），
 * 以及挡住"通过宿主 API 的顺手越权"。挡不住恶意代码——这一点写在代码里比写在文档里重要。
 */

import type { Permission } from "./manifest";
import { PERMISSIONS } from "./manifest";

/** 权限的中文说明（`list_plugins` 要展示给人看，光给 `project:write` 看不懂） */
const PERMISSION_DESC: Record<Permission, string> = {
  "project:read": "读工程数据",
  "project:write": "改工程数据（能删幕、改文案、动主题）",
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

/** 权限清单是否合法（manifest 解析时已过滤，这里给测试与诊断用） */
export function invalidPermissions(list: unknown[]): string[] {
  return list.filter((p) => typeof p !== "string" || !(PERMISSIONS as readonly string[]).includes(p)) as string[];
}
