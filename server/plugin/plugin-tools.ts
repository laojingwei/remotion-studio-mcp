/**
 * 工具插件：让插件往宿主里加一个 MCP 工具。
 *
 * ## 这是四批里唯一"插件能动手"的一层
 *
 * 钩子只能说话（返回字符串），工具能**读工程、改工程**。所以这一层的重点不是"能加工具"，
 * 而是"加的工具能干什么、谁批准"：
 *
 *   插件声明 permissions → 宿主只把声明过的能力交给它 → 没声明就抛 PermissionDenied
 *
 * ## 必须先说清的一件事：权限不是沙箱
 *
 * `plugin.ts` 是被 `import()` 执行的**任意代码**，插件顶层直接 `import fs` 就能绕过这里
 * 所有检查。所以权限声明的真实作用是 **知情同意**：用户 `list_plugins` 时能看见
 * "这个插件要读/写我的工程"，再决定装不装。它能挡住的是**插件通过宿主 API 的越权**
 * （比如只想读却顺手写了一把），挡不住恶意代码。
 *
 * 这条写在文档里比写在代码里重要——不能让"声明式权限"给人一种被隔离的错觉。
 *
 * ## 只读/写两条能力，其余先不开
 *
 * `render` / `net` / `exec` / `assets:*` 在 `PERMISSIONS` 里有定义，但这一版**没有对应 API**。
 * 声明了也用不上，`list_plugins` 会标出来。与其给一个半成品接口，不如先只开最需要的两条。
 */

import type { Permission, PluginManifest } from "./manifest";
import { PermissionDenied } from "./permissions";
import { activePlugins, type DiscoveredPlugin } from "./discovery";
import { entryFingerprint, loadPluginModule, pluginEntryFile } from "./hooks";
import { buildParamShape } from "./tool-params";
import { replacePluginTools, pluginToolEntries, type PluginToolEntry } from "./tool-registry";
import { listProjectIds, readProject } from "../store";
import { projects } from "../project.service";
import type { ToolDef } from "../tools/_shared";

/** 这一版真正接了 API 的权限（其余只有定义，见文件头） */
export const WIRED_PERMISSIONS: Permission[] = ["project:read", "project:write"];

export type PluginToolError = { pluginId: string; message: string };

export type PluginToolStatus = {
  /** 已注册的插件工具数 */
  count: number;
  /** 贡献了工具的插件 */
  plugins: string[];
  errors: PluginToolError[];
  active: boolean;
};

/* ─────────────────────────── 能力 ─────────────────────────── */

/**
 * 交给插件工具的上下文。
 *
 * 只给"函数"，不给"对象"：直接把 `projects` 单例递过去，插件就能调用
 * `projects.delete()` 之类没有经过权限判断的方法——那等于权限表白写。
 */
export type PluginToolCtx = {
  pluginId: string;
  /** 打日志（进服务端 stdout，排查插件行为用） */
  log: (msg: string) => void;
  /** 需要 project:read */
  listProjects: () => string[];
  /** 需要 project:read */
  readProject: (projectId: string) => unknown;
  /** 需要 project:write；返回 rev 与这次写入的摘要 */
  applyOps: (projectId: string, ops: unknown[]) => { rev: number; summary: string[] };
};

function capabilitiesFor(p: DiscoveredPlugin): PluginToolCtx {
  const id = p.id;
  const manifest = p.manifest as PluginManifest | null;
  const perms = manifest?.permissions ?? [];

  const require = (perm: Permission): void => {
    if (!perms.includes(perm)) throw new PermissionDenied(id, perm);
  };

  return {
    pluginId: id,
    log: (msg) => console.log(`[plugin:${id}] ${String(msg).slice(0, 500)}`),
    listProjects: () => {
      require("project:read");
      return listProjectIds();
    },
    readProject: (projectId) => {
      require("project:read");
      if (typeof projectId !== "string" || !/^[\w-]+$/.test(projectId)) {
        throw new Error(`非法的工程 id：${String(projectId)}`);
      }
      return readProject(projectId);
    },
    applyOps: (projectId, ops) => {
      require("project:write");
      if (typeof projectId !== "string" || !/^[\w-]+$/.test(projectId)) {
        throw new Error(`非法的工程 id：${String(projectId)}`);
      }
      if (!Array.isArray(ops) || ops.length === 0) throw new Error("applyOps 需要非空的 ops 数组");
      /*
       * actor 写成 `plugin:<id>`：历史记录里必须看得出这次改动是插件干的。
       * 记成 user 会让"我没动过这个工程"变成无法自证的事。
       */
      const r = projects.apply(projectId, ops as never[], { actor: `plugin:${id}` });
      return { rev: r.project.rev, summary: r.summary };
    },
  };
}

/* ─────────────────────────── 工具定义收敛 ─────────────────────────── */

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;

type RawTool = {
  name?: unknown;
  description?: unknown;
  params?: unknown;
  run?: unknown;
};

/** 内置工具名（用于防撞名）。动态 import 避免静态成环，第二次起是缓存命中 */
async function builtinToolNames(): Promise<Set<string>> {
  try {
    const mod = (await import("../mcp-tools")) as { TOOLS?: { name: string }[] };
    return new Set((mod.TOOLS ?? []).map((t) => t.name));
  } catch {
    return new Set();
  }
}

/* ─────────────────────────── 加载 ─────────────────────────── */

let fingerprint = "";
let errors: PluginToolError[] = [];
let loading: Promise<PluginToolStatus> | null = null;

export function pluginToolStatus(): PluginToolStatus {
  const list = pluginToolEntries();
  return {
    count: list.length,
    plugins: [...new Set(list.map((e) => e.pluginId))].sort(),
    errors: [...errors],
    active: list.length > 0,
  };
}

/** 加载 / 重载插件工具（幂等、便宜：没变时只是 stat） */
export async function ensurePluginTools(): Promise<PluginToolStatus> {
  if (loading) return loading;
  const list = activePlugins();
  const next = entryFingerprint(list);
  if (next === fingerprint) return pluginToolStatus();

  loading = (async () => {
    const acc: PluginToolEntry[] = [];
    const errs: PluginToolError[] = [];
    const builtin = await builtinToolNames();
    const taken = new Set<string>(builtin);

    for (const p of list) {
      if (!p.provides.includes("hooks")) continue;
      const file = pluginEntryFile(p.dir);
      if (!file) continue; // 钩子那边已经报过"缺入口"，这里不重复报

      let mod: Record<string, unknown>;
      try {
        mod = (await loadPluginModule(file, p.id)).mod;
      } catch {
        continue; // 加载失败同样由钩子那边报；同一件事报两遍等于噪音
      }

      const table = (mod.default ?? mod.hooks ?? mod) as Record<string, unknown>;
      const rawTools = (table?.tools ?? mod.tools) as unknown;
      if (!rawTools) continue;
      if (!Array.isArray(rawTools)) {
        errs.push({ pluginId: p.id, message: "tools 必须是数组：[{ name, description, params, run }]" });
        continue;
      }

      const ctx = capabilitiesFor(p);

      for (const raw of rawTools) {
        if (!raw || typeof raw !== "object") {
          errs.push({ pluginId: p.id, message: "tools 里有一项不是对象" });
          continue;
        }
        const t = raw as RawTool;
        const name = String(t.name ?? "").trim();

        if (!TOOL_NAME_RE.test(name)) {
          errs.push({
            pluginId: p.id,
            message: `工具名「${name}」不合法：小写字母开头，3–41 位，只含字母/数字/下划线（建议带插件前缀，如 ${p.id.replace(/-/g, "_")}_xxx）`,
          });
          continue;
        }
        if (taken.has(name)) {
          const why = builtin.has(name) ? "与内置工具重名" : "与别的插件工具重名";
          errs.push({ pluginId: p.id, message: `工具名「${name}」${why} —— 换个名字（加插件前缀最省事）` });
          continue;
        }
        if (typeof t.run !== "function") {
          errs.push({ pluginId: p.id, message: `工具「${name}」缺 run 函数` });
          continue;
        }
        const description = String(t.description ?? "").trim();
        if (!description) {
          errs.push({ pluginId: p.id, message: `工具「${name}」缺 description —— agent 靠它决定要不要调` });
          continue;
        }

        const { shape, issues } = buildParamShape(t.params);
        if (issues.length) {
          errs.push({ pluginId: p.id, message: `工具「${name}」参数声明有问题：${issues.join("；")}` });
          continue;
        }

        const run = t.run as (args: Record<string, unknown>, ctx: PluginToolCtx) => unknown;
        const def: ToolDef = {
          name,
          description,
          shape,
          run: async (args) => {
            const out = await run(args, ctx);
            if (typeof out === "string") return out;
            // 返回对象就序列化：agent 读的是文本，undefined 会变成"工具没输出"这种莫名其妙的空回执
            return out === undefined ? "（插件工具没有返回内容）" : JSON.stringify(out, null, 2);
          },
        };
        acc.push({ pluginId: p.id, def });
        taken.add(name);
      }
    }

    replacePluginTools(acc);
    errors = errs;
    fingerprint = next;
    return pluginToolStatus();
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** 测试用：清空状态，让下一次 ensure 重新加载 */
export function resetPluginToolCache(): void {
  replacePluginTools([]);
  errors = [];
  fingerprint = "";
}
