/**
 * 钩子总线：让插件在宿主流程里插一脚。
 *
 * ## 这一层解决什么
 *
 * 前几批插件只能「加东西」：多一篇指南、多一种风格、多一个场景。
 * 但很多真正有价值的能力是「看一眼再说话」——比如画质守门员：
 * 它不改任何数据，只是在自检时指出"这里字号太小了"。
 *
 * 所以钩子的语义统一是 **只读入参 → 返回文本意见**：
 *
 *   audit:rules    自检时补充检查项
 *   ops:review     每次写入后复盘这一批操作
 *   brief:derive   设计锁推导时补充规则说明
 *
 * ## 三个刻意的约束
 *
 * **1. 同步。**
 * `applyOps` 与 `auditBriefAgainstProject` 都是同步函数，钩子必须跟着同步，
 * 否则就得把整条写入路径改成异步——那是为了插件把宿主翻一遍，代价不成比例。
 * 代价是插件不能发网络请求、不能读大文件。这正好也是我们想要的形态：
 * 需要 IO 的事应该在插件自己的工具里做，而不是卡在用户每次保存工程的时候。
 *
 * **2. 不发能力。**
 * 插件拿到的是数据（brief / project / ops），返回的是字符串。宿主不把
 * fs、fetch、子进程交给它。所以钩子插件**不需要声明任何权限**——
 * 这一批的权限执法（project:write / render / exec）留给真正需要能力的工具类插件。
 *
 * **3. 但代码就是代码。**
 * `plugin.ts` 是被 `import()` 执行的**任意代码**，顶层就能 `fs.rmSync`。
 * 钩子 API 的"只读"约束是**约定**，不是沙箱。装一个代码插件 = 在这台机器上
 * 装一个程序，这一点在 plugins/README.md 里明写了，不能让"声明式权限"
 * 给人一种被隔离的错觉。
 *
 * ## 为什么不缓存模块，以及为什么用 esbuild 打包
 *
 * 最直觉的做法是 `import(url + "?v=" + mtime)`——Node 的 ESM 缓存按 URL 区分，
 * 换个 query 就该是全新求值。实测**只在项目根目录内成立**：
 *
 *   项目内 .ts   → 由 tsx 转译，query 生效，改了立刻是新的
 *   项目外 .ts   → 走 Node 原生类型剥离，模块缓存按**文件路径**去重、忽略 query
 *
 * 项目外的正是用户级插件目录（`~/.remotion-studio/plugins/`）。现象是
 * 「改了插件没反应，重启才好」——和上一批 `presetsCache` 那个坑同源，
 * 而且更难查（重启后又能复现一次"好像好了"）。
 *
 * 所以改成：用 esbuild 把入口连同相对依赖打成一个 `.mjs`，文件名带内容指纹，
 * 落到临时目录再 import。路径变了就是新模块，跟运行时是什么无关；
 * 顺带还能支持 TS 与 `import "./helper"`。
 * 只在文件变了才打包（几十毫秒），没变时只是一个 stat。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { activePlugins, type DiscoveredPlugin } from "./discovery";

/* ─────────────────────────── 钩子定义 ─────────────────────────── */

export const HOOK_KINDS = ["audit:rules", "ops:review", "brief:derive", "text:transform"] as const;
export type HookKind = (typeof HOOK_KINDS)[number];

/** 钩子的中文说明（`list_plugins` 与文档共用） */
export const HOOK_LABEL: Record<HookKind, string> = {
  "audit:rules": "自检补充检查项",
  "ops:review": "写入后复盘",
  "brief:derive": "设计锁补充规则",
  "text:transform": "文本处理（字幕/稿件）",
};

export type HookContext = {
  "audit:rules": {
    /** 需求契约（只读，已深冻结） */
    brief: Record<string, unknown>;
    /** 工程快照（只读，已深冻结） */
    project: Record<string, unknown>;
    /** 设计锁；没定形态时为 null */
    lock: Record<string, unknown> | null;
  };
  "ops:review": {
    /** 写入前的工程（只读，已深冻结） */
    before: Record<string, unknown>;
    /** 写入后的工程（只读，已深冻结） */
    after: Record<string, unknown>;
    /** 这一批 op 原文（只读，已深冻结） */
    ops: Record<string, unknown>[];
  };
  "brief:derive": {
    brief: Record<string, unknown>;
    /** 宿主刚推导出的设计锁（只读，已深冻结） */
    lock: Record<string, unknown>;
  };
  "text:transform": {
    /** 当前文本（可能已被前一个插件处理过） */
    text: string;
    /** 这段文本是什么：字幕 / 稿件 / 需求契约 */
    kind: TextKind;
    projectId: string | null;
    sceneId: string | null;
  };
};

/** 文本处理的作用对象（决定插件该不该动手：术语表对字幕和稿件都适用，但对 brief 未必） */
export type TextKind = "subtitle" | "script" | "brief";

/** 插件返回值：全部可选，都是给人/给 agent 看的文字 */
export type HookVerdict = {
  /** 必须修（会让自检不通过）；不要滥用，它挡的是交付 */
  blocking: string[];
  warnings: string[];
  /** 通过项，写"你要求的都在"这类确认 */
  passed: string[];
  /** 追加到设计锁的规则说明（只影响展示，不参与 lockViolations 判定） */
  lockRules: string[];
};

const EMPTY: HookVerdict = { blocking: [], warnings: [], passed: [], lockRules: [] };

/* ─────────────────────────── 加载状态 ─────────────────────────── */

type LoadedHook = { pluginId: string; kind: HookKind; fn: (ctx: unknown) => unknown };

export type HookError = { pluginId: string; message: string };

export type HookStatus = {
  /** 已注册的钩子函数条数 */
  count: number;
  /** 提供钩子的插件 id */
  plugins: string[];
  /** 加载或运行时的错误（`list_plugins` 会展示） */
  errors: HookError[];
  /** 是否至少有一个钩子（消费点据此跳过整段逻辑） */
  active: boolean;
};

let loaded: LoadedHook[] = [];
let errors: HookError[] = [];
let fingerprint = "";
let loading: Promise<HookStatus> | null = null;
/** 运行期失败计数：连续失败的钩子会被摘掉，否则坏插件会污染每一次写入 */
const failures = new Map<LoadedHook, number>();
const MAX_FAILURES = 3;
const SLOW_MS = 30;

/** 插件入口候选（按顺序取第一个存在的） */
const ENTRY_FILES = ["plugin.ts", "plugin.mts", "plugin.mjs", "plugin.js", "index.ts", "index.mjs"];

/** 打包产物落在这里。放系统临时目录：不该混进用户的 plugins/ 或 data/ */
const CACHE_DIR = path.join(os.tmpdir(), "remotion-studio-plugin-cache");

/** 插件入口文件（`plugin.ts` / `index.mjs` …）。工具插件复用同一个入口，所以导出 */
export function pluginEntryFile(dir: string): string | null {
  for (const name of ENTRY_FILES) {
    const f = path.join(dir, name);
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* 不存在就试下一个 */
    }
  }
  return null;
}

/** 目录里有没有"待启用的示例入口"（`plugin.ts.example` 这类） */
function hasExampleEntry(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => /\.(ts|mts|mjs|js|cjs)\.example$/.test(f));
  } catch {
    return false;
  }
}

/** FNV-1a → base36：够短、稳定、不需要引入依赖（和 manifest 里的 id 哈希同一个做法） */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(36)}${(s.length % 1296).toString(36).padStart(2, "0")}`;
}

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "plugin";

type Esbuild = {
  buildSync: (o: Record<string, unknown>) => unknown;
};

/** esbuild 是 vite/tsx 的既有依赖；拿不到就退回直接 import（项目内插件仍可用） */
let esbuildMod: Esbuild | null | undefined;

async function esbuildOf(): Promise<Esbuild | null> {
  if (esbuildMod !== undefined) return esbuildMod;
  try {
    esbuildMod = (await import("esbuild")) as unknown as Esbuild;
  } catch {
    esbuildMod = null;
  }
  return esbuildMod;
}

function esbuildErrText(err: unknown): string {
  const e = err as { errors?: { text?: string; location?: { line?: number; column?: number } }[]; message?: string };
  const first = e?.errors?.[0];
  if (first?.text) {
    const loc = first.location ? `（第 ${first.location.line} 行）` : "";
    return `${first.text}${loc}`;
  }
  return e?.message ?? String(err);
}

/**
 * 加载一个插件入口，返回它的模块。
 *
 * 优先走 esbuild 打包（见文件头注释：query 缓存在项目外不生效）。
 * 打包失败必须报出来——静默退回直接 import 会让语法错误看起来像"插件没装"。
 */
/** 加载插件入口模块（带 esbuild 缓存）。工具插件复用，导出 */
export async function loadPluginModule(file: string, id: string): Promise<{ mod: Record<string, unknown>; artifact: string }> {
  const st = fs.statSync(file);
  const tag = `${Math.round(st.mtimeMs)}-${st.size}`;
  const eb = await esbuildOf();

  if (eb) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const out = path.join(CACHE_DIR, `${safeName(id)}-${shortHash(`${file}|${tag}`)}.mjs`);
    if (!fs.existsSync(out)) {
      try {
        eb.buildSync({
          entryPoints: [file],
          // 打成单文件：临时目录里没有 node_modules，靠 esbuild 把相对依赖与依赖库都内联
          bundle: true,
          format: "esm",
          platform: "node",
          target: "node20",
          outfile: out,
          absWorkingDir: path.dirname(file),
          logLevel: "silent",
          sourcemap: false,
        });
      } catch (err) {
        // 写坏的半成品不留在缓存里，否则改了也一直用坏的那份
        try {
          fs.rmSync(out, { force: true });
        } catch {
          /* 忽略 */
        }
        throw new Error(`编译失败：${esbuildErrText(err)}`);
      }
    }
    return { mod: (await import(pathToFileURL(out).href)) as Record<string, unknown>, artifact: out };
  }

  return {
    mod: (await import(`${pathToFileURL(file).href}?v=${tag}`)) as Record<string, unknown>,
    artifact: file,
  };
}

/** 清掉这一轮不再使用的打包产物（改了插件就会生成新文件，不清理会一直涨） */
function pruneCache(keep: Set<string>): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(CACHE_DIR);
  } catch {
    return;
  }
  for (const n of names) {
    const f = path.join(CACHE_DIR, n);
    if (keep.has(f)) continue;
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 被别的进程占着就下次再删 */
    }
  }
}

/**
 * 指纹 = 所有钩子入口文件的 (路径 + mtime + size) + 启用插件集合。
 *
 * size 必须进指纹：编辑器同一个时间片里连存两次，mtime 可能一样，
 * 只看 mtime 会漏掉后一次修改。
 */
/** 入口指纹：工具插件与钩子共用同一套判定，改了任一处两边一起重载 */
export function entryFingerprint(list: DiscoveredPlugin[]): string {
  const parts: string[] = [];
  for (const p of list) {
    if (!p.provides.includes("hooks")) continue;
    const f = pluginEntryFile(p.dir);
    if (!f) {
      parts.push(`${p.id}@missing`);
      continue;
    }
    try {
      const st = fs.statSync(f);
      parts.push(`${f}@${st.mtimeMs}@${st.size}`);
    } catch {
      parts.push(`${f}@gone`);
    }
  }
  return parts.join("|");
}

/* ─────────────────────────── 返回值收敛 ─────────────────────────── */

/** 单条意见的长度上限：一个插件不该能靠一句话把工具回执刷屏 */
const MAX_ITEM = 300;
const MAX_ITEMS = 20;

function takeStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((x) => (x.length > MAX_ITEM ? `${x.slice(0, MAX_ITEM)}…` : x));
}

/**
 * 把插件返回的任意值收成 `HookVerdict`。
 *
 * 不信任返回结构：插件可能返回 null、字符串、或者数组而不是对象。
 * 这里一律容忍（拿不到就当没说话），因为一个返回值写错的插件
 * 不该让用户的保存请求失败。
 */
function normalize(raw: unknown): HookVerdict {
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  const o = raw as Record<string, unknown>;
  return {
    blocking: takeStrings(o.blocking),
    warnings: takeStrings(o.warnings),
    passed: takeStrings(o.passed),
    lockRules: takeStrings(o.lockRules),
  };
}

/* ─────────────────────────── 加载 ─────────────────────────── */

/**
 * 加载 / 重载插件钩子。
 *
 * 幂等且便宜：插件没变时只做几十个 stat。所有请求入口都可以放心调用
 * （HTTP 中间件、MCP 工具包装、测试），不会每次都重新 import。
 */
export async function ensurePluginHooks(): Promise<HookStatus> {
  if (loading) return loading;
  const list = activePlugins();
  const next = entryFingerprint(list);
  if (next === fingerprint) return hookStatus();

  loading = (async () => {
    const acc: LoadedHook[] = [];
    const errs: HookError[] = [];
    const keep = new Set<string>();

    for (const p of list) {
      if (!p.provides.includes("hooks")) continue;
      const file = pluginEntryFile(p.dir);
      if (!file) {
        /*
         * 带 `.example` 后缀的入口是"示例还没启用"，不是错误。
         * 仓库里自带的示例默认都是这个状态，把它们报成加载失败会让
         * `list_plugins` 一打开就是一片红——真正的错误就没人看了。
         */
        if (!hasExampleEntry(p.dir)) {
          errs.push({ pluginId: p.id, message: `声明了钩子但没找到入口文件（应有一个 ${ENTRY_FILES.join(" / ")}）` });
        }
        continue;
      }
      let mod: Record<string, unknown>;
      try {
        const loadedEntry = await loadPluginModule(file, p.id);
        mod = loadedEntry.mod;
        keep.add(loadedEntry.artifact);
      } catch (err) {
        errs.push({ pluginId: p.id, message: `入口加载失败：${errText(err)}` });
        continue;
      }

      const table = (mod.default ?? mod.hooks ?? mod) as Record<string, unknown>;
      if (!table || typeof table !== "object") {
        errs.push({ pluginId: p.id, message: "入口没有导出对象（应 export default { \"audit:rules\": fn }）" });
        continue;
      }

      let registered = 0;
      for (const kind of HOOK_KINDS) {
        const fn = table[kind];
        if (typeof fn !== "function") continue;
        acc.push({ pluginId: p.id, kind, fn: fn as (ctx: unknown) => unknown });
        registered++;
      }
      if (!registered) {
        errs.push({
          pluginId: p.id,
          message: `入口里没有可识别的钩子（支持：${HOOK_KINDS.join(" / ")}）`,
        });
      }
    }

    loaded = acc;
    errors = errs;
    failures.clear();
    fingerprint = next;
    pruneCache(keep);
    return hookStatus();
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

/**
 * 深拷贝 + 冻结。
 *
 * 只在**确有插件**时才做（见 `runHook` 的调用方），否则每次保存工程都多一次
 * 全量拷贝。拷贝的理由不是性能而是边界：把宿主的活对象交给插件，
 * 插件改一个字段就等于改了下一次写入的基础，而这种错误不会有任何报错。
 */
export function frozenSnapshot<T>(v: T): T {
  return deepFreeze(structuredClone(v)) as T;
}

/* ─────────────────────────── 执行 ─────────────────────────── */

/** 有没有某类钩子（消费点用它在零插件时省掉整段逻辑） */
export function hasHook(kind: HookKind): boolean {
  return loaded.some((h) => h.kind === kind);
}

function hookList(kind: HookKind): LoadedHook[] {
  return loaded.filter((h) => h.kind === kind);
}

/**
 * 记一次钩子运行失败；连续失败到阈值就把它摘掉。
 *
 * 为什么要摘：一个坏插件会在用户每次保存工程时打印一次堆栈，日志很快没法看，
 * 而且它还占着同步路径的时间。摘掉之后 `list_plugins` 里仍能看到原因。
 */
function noteHookFailure(h: LoadedHook, kind: HookKind, err: unknown): void {
  const n = (failures.get(h) ?? 0) + 1;
  failures.set(h, n);
  if (n >= MAX_FAILURES) {
    loaded = loaded.filter((x) => x !== h);
    errors.push({ pluginId: h.pluginId, message: `${kind} 连续失败 ${n} 次，已停用：${errText(err)}` });
  } else {
    errors.push({ pluginId: h.pluginId, message: `${kind} 报错（第 ${n} 次）：${errText(err)}` });
  }
  errors = errors.slice(-20);
}

/**
 * 跑一类钩子，把所有人的意见合起来。
 *
 * **ctx 必须是快照**（`frozenSnapshot` 过的）。这里刻意不替调用方冻结：
 * 冻结宿主的活对象（比如 `project.service` 的缓存文档）会让后续写入莫名其妙地失败，
 * 而且报错点离肇事点很远。所以快照的责任留在调用方，成本也只在该插件存在时才付。
 *
 * 失败隔离：某个插件抛错只记一笔、摘掉它，其余插件照常。连续失败 3 次就永久摘除
 * ——否则一个坏插件会在用户每次保存工程时打印一次堆栈，日志很快没法看。
 */
export function runHook<K extends HookKind>(kind: K, ctx: HookContext[K]): HookVerdict {
  const list = hookList(kind);
  if (!list.length) return { ...EMPTY };

  const out: HookVerdict = { blocking: [], warnings: [], passed: [], lockRules: [] };

  for (const h of list) {
    const started = Date.now();
    try {
      const v = normalize(h.fn(ctx));
      // 归属清楚：插件报的问题必须看得出是插件报的，否则用户会以为是宿主的判断
      out.blocking.push(...v.blocking.map((x) => `[${h.pluginId}] ${x}`));
      out.warnings.push(...v.warnings.map((x) => `[${h.pluginId}] ${x}`));
      out.passed.push(...v.passed.map((x) => `[${h.pluginId}] ${x}`));
      out.lockRules.push(...v.lockRules.map((x) => `[${h.pluginId}] ${x}`));
    } catch (err) {
      noteHookFailure(h, kind, err);
    }
    const cost = Date.now() - started;
    if (cost > SLOW_MS) {
      errors = [
        ...errors.slice(-19),
        { pluginId: h.pluginId, message: `${kind} 耗时 ${cost}ms（应 < ${SLOW_MS}ms）—— 钩子在保存/自检的同步路径上，别做重活` },
      ];
    }
  }

  return out;
}

/* ─────────────────────────── 文本处理链 ─────────────────────────── */

/** 单次处理的文本上限。文本链跑在保存路径上，两万字以上该走批处理而不是每次保存都过一遍 */
const MAX_TEXT = 20000;
/** 输出长度上限：比输入大太多基本是插件写错了（比如把整段替换成一段模板） */
const MAX_GROWTH = 3;

export type TextStep = { pluginId: string; before: number; after: number };

export type TextPipelineResult = {
  text: string;
  changed: boolean;
  /** 每一步实际改动的插件（按执行顺序） */
  steps: TextStep[];
  /** 被跳过的原因（超长、返回空、抛错）——要能回到用户眼前，不能静默 */
  warnings: string[];
};

/**
 * 跑一遍文本处理链（字幕 / 稿件）。
 *
 * 与 `runHook` 的区别：那条是"收集意见"，这条是**流水线**——上一个插件的输出是
 * 下一个的输入，顺序有意义。所以单独一个函数，而不是复用 verdict 合并。
 *
 * 三道保险，每一道都对应一个真实会发生的坏情况：
 *  1. **返回空字符串** → 整条链把用户的字幕清空了。拒收，保留上一版。
 *  2. **输出暴涨** → 插件把一句话替换成一整段模板。拒收。
 *  3. **抛错** → 跳过这一个，其余继续（和 `runHook` 同一套失败计数）。
 *
 * 还有一条**不**在这里做、但必须写进文档：**幂等**。链上的每个插件都得保证
 * 处理两次和处理一次结果一样，否则 agent 反复保存同一句话会把字幕越改越远。
 */
export function runTextPipeline(
  text: string,
  meta: { kind: TextKind; projectId?: string | null; sceneId?: string | null },
): TextPipelineResult {
  const list = hookList("text:transform");
  const base: TextPipelineResult = { text, changed: false, steps: [], warnings: [] };
  if (!list.length) return base;

  if (text.length > MAX_TEXT) {
    return { ...base, warnings: [`文本 ${text.length} 字，超过处理上限 ${MAX_TEXT}，已跳过插件处理（太长会拖慢保存）`] };
  }

  let cur = text;
  const steps: TextStep[] = [];
  const warnings: string[] = [];

  for (const h of list) {
    const started = Date.now();
    let out: unknown;
    try {
      out = h.fn({ text: cur, kind: meta.kind, projectId: meta.projectId ?? null, sceneId: meta.sceneId ?? null });
    } catch (err) {
      noteHookFailure(h, "text:transform", err);
      warnings.push(`插件「${h.pluginId}」处理出错，已跳过：${errText(err)}`);
      continue;
    }

    // 允许直接返回字符串，也允许 { text }
    const next = typeof out === "string" ? out : (out as { text?: unknown } | null)?.text;
    if (typeof next !== "string") {
      if (out !== undefined && out !== null) warnings.push(`插件「${h.pluginId}」没返回文本（要返回 string 或 { text }），已跳过`);
      continue;
    }
    if (next === cur) continue;

    if (!next.trim()) {
      warnings.push(`插件「${h.pluginId}」返回了空文本，已忽略（否则一句话就能把字幕清空）`);
      continue;
    }
    if (next.length > cur.length * MAX_GROWTH + 200) {
      warnings.push(
        `插件「${h.pluginId}」输出长度异常（${cur.length} → ${next.length} 字），已忽略 —— 检查是不是把整段替换成了模板`,
      );
      continue;
    }

    steps.push({ pluginId: h.pluginId, before: cur.length, after: next.length });
    cur = next;

    const cost = Date.now() - started;
    if (cost > SLOW_MS) {
      warnings.push(`插件「${h.pluginId}」处理耗时 ${cost}ms（应 < ${SLOW_MS}ms）—— 它在保存路径上`);
    }
  }

  return { text: cur, changed: cur !== text, steps, warnings };
}

/** 一步处理结果的一句话说明（工具回执用；不写的话用户不知道自己的字被谁改了） */
export function textStepsToNote(r: TextPipelineResult): string {
  if (!r.changed) return "";
  return r.steps.map((s) => `「${s.pluginId}」${s.before}→${s.after} 字`).join("、");
}

/** 当前钩子状态（`list_plugins` 展示 + 测试断言） */
export function hookStatus(): HookStatus {
  return {
    count: loaded.length,
    plugins: [...new Set(loaded.map((h) => h.pluginId))].sort(),
    errors: [...errors],
    active: loaded.length > 0,
  };
}

/** 某个插件挂上了哪几类钩子（`list_plugins` 用它说清"它在哪个环节说话"） */
export function hookKindsOf(pluginId: string): HookKind[] {
  return [...new Set(loaded.filter((h) => h.pluginId === pluginId).map((h) => h.kind))];
}

/** 测试用：清空状态，让下一次 ensure 重新加载 */
export function resetHookCache(): void {
  loaded = [];
  errors = [];
  fingerprint = "";
  failures.clear();
}
