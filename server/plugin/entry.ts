import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 插件入口解析：一个插件可以是**一个工程**，也可以是一个**单文件脚本**。
 *
 * ## 为什么要分这两种
 *
 * 最早的约定是「`plugins/<名>/plugin.ts` 一个文件」。它够简单，但撑不起真实生态：
 * 别人写的插件是一个 npm 包或 git 仓库，有自己的 `package.json`、`node_modules`、
 * 构建脚本、测试、甚至原生依赖（sharp / better-sqlite3）。对这样的东西，
 * 宿主既不该、也不能把它当单文件来 esbuild 打包——原生模块打不进去，
 * 而 `postinstall` 里编出来的东西更不可能。
 *
 * 所以现在按目录里有没有 `package.json` 分流：
 *
 * ```
 * 有 package.json 且入口是已构建的 JS   → module 模式：Node 直接 import（不打包）
 * 有 package.json 但入口不存在/未构建   → unbuilt：明确告诉用户该跑什么命令
 * 没有 package.json                     → script 模式：老的单文件，esbuild 打包
 * ```
 *
 * ## module 模式为什么不用打包
 *
 * 实测（`node` 22，项目目录外）：`import(url + "?v=" + mtime)` 能重新求值，
 * 而相对的 `import "./chunk.js"` 与 `import "some-dep"` 都能按 Node 的常规算法解析——
 * 也就是说**插件自己的 `node_modules` 天然可用**，不需要宿主介入。
 *
 * 对比一下：老的 script 模式是把入口和相对依赖打成一个 .mjs 落到临时目录，
 * 那个产物周围没有 node_modules，所以第三方依赖必须内联。两种模式各有各的适用面。
 *
 * ## 一个必须写清的限制
 *
 * module 模式下**宿主不负责安装依赖**。`npm install` 会联网、会跑 `postinstall`
 * 脚本（= 在用户机器上执行任意代码）。这种事不能在一次普通的「扫一下插件目录」里
 * 顺手发生，所以这里只做**诊断**：告诉用户在他自己的插件目录里跑什么命令。
 */

/** 老的单文件入口候选（继续支持，很多轻量插件这样写就很合适） */
export const SCRIPT_ENTRIES = ["plugin.ts", "plugin.mts", "plugin.mjs", "plugin.js", "index.ts", "index.mjs"];

const JS_EXT = new Set([".mjs", ".js", ".cjs"]);
/** script 模式的源码扩展名：单文件插件被鼓励拆 helper（.ts），这些都要进指纹 */
const SCRIPT_SRC_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]);
const TS_EXT = new Set([".ts", ".mts", ".cts"]);

/** 打包产物落这里。放系统临时目录：不该混进用户的 plugins/ 或 data/ */
export const CACHE_DIR = path.join(os.tmpdir(), "remotion-studio-plugin-cache");

/* ─────────────────────────── package.json ─────────────────────────── */

export type PackageJson = {
  name?: string;
  version?: string;
  description?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  /** 本项目的插件元信息（可选）。没写就按目录结构与入口导出推断 */
  remotionStudio?: unknown;
  [k: string]: unknown;
};

export function readPackageJson(dir: string): PackageJson | null {
  const file = path.join(dir, "package.json");
  /*
   * 「没有 package.json」和「有但坏了」必须分开：
   * 前者是正常的单文件插件，后者要让用户去修。
   * 用 existsSync 而不是靠 statSync 抛异常来判断 —— 抛异常分不清这两件事，
   * 会把每一个单文件插件都误报成"package.json 解析失败"。
   */
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as PackageJson) : { __broken: true };
  } catch {
    return { __broken: true };
  }
}

/** package.json 存在但解析不了 */
export const isBrokenPackage = (pkg: PackageJson | null): boolean => Boolean(pkg && pkg.__broken);

/**
 * 从 `exports` 里取出根入口。
 *
 * 要处理三种写法，都是真实存在于 npm 生态里的：
 *   "exports": "./dist/index.mjs"                        ← 直接字符串
 *   "exports": { ".": "./dist/index.mjs" }               ← 标准
 *   "exports": { "import": "./x.mjs", "require": "…" }   ← 省略 "." 的常见写法
 */
function pickExportTarget(exportsField: unknown): string | null {
  if (typeof exportsField === "string") return exportsField;
  if (!exportsField || typeof exportsField !== "object") return null;

  const obj = exportsField as Record<string, unknown>;
  const keys = Object.keys(obj);
  const hasSubpaths = keys.some((k) => k === "." || k.startsWith("./"));
  const root = hasSubpaths ? obj["."] : obj;
  if (root === undefined) return null;
  if (typeof root === "string") return root;

  if (root && typeof root === "object") {
    const cond = root as Record<string, unknown>;
    // 顺序有意义：ESM 优先（我们一律用 import()），再退到 CJS
    for (const k of ["import", "module", "node", "default", "require"]) {
      const v = cond[k];
      if (typeof v === "string") return v;
      if (v && typeof v === "object") {
        for (const kk of ["import", "node", "default", "require"]) {
          const vv = (v as Record<string, unknown>)[kk];
          if (typeof vv === "string") return vv;
        }
      }
    }
  }
  return null;
}

/**
 * package.json 有没有**声明**代码入口（不管产物在不在）。
 *
 * 与 `resolvePluginEntry().kind !== "unbuilt"` 的区别很重要：
 * 后者答"现在能不能跑"，这个答"作者是想做代码插件吗"。
 * 发现阶段要用后者——一个还没 `npm run build` 的插件必须被看见，
 * 然后由加载阶段报出"未构建 + 该跑什么命令"，而不是凭空消失。
 */
export function declaresCodeEntry(pkg: PackageJson | null): boolean {
  if (!pkg || isBrokenPackage(pkg)) return false;
  return (
    (typeof pkg.main === "string" && !!pkg.main.trim()) ||
    (typeof pkg.module === "string" && !!pkg.module.trim()) ||
    (pkg.exports !== undefined && pkg.exports !== null)
  );
}

/* ─────────────────────────── 解析结果 ─────────────────────────── */

/**
 * - `module`  已构建的 JS 入口，Node 直接 import，依赖走插件自己的 node_modules
 * - `script`  TS/单文件源码，由宿主编译（老的 esbuild 路径）
 * - `unbuilt` 认得出是个插件，但现在跑不起来；`hint` 说清该做什么
 */
export type EntryKind = "module" | "script" | "unbuilt";

export type ResolvedEntry = {
  kind: EntryKind;
  /** module / script 时的入口绝对路径 */
  file?: string;
  /** 一句话说明（怎么找到的 / 为什么不能用）。错误信息与 list_plugins 共用 */
  detail: string;
  /** unbuilt 时给用户的具体命令 */
  hint?: string;
  /** 工程模式下的 package.json（manifest 推导要用） */
  pkg?: PackageJson;
};

/** 给用户看的构建提示。不写"请构建"，写"在哪个目录跑哪两条命令" */
function buildHint(pkg: PackageJson | null): string {
  const hasBuild = typeof pkg?.scripts?.build === "string";
  const hasDeps =
    Object.keys(pkg?.dependencies ?? {}).length > 0 || Object.keys(pkg?.devDependencies ?? {}).length > 0;

  if (hasBuild) return "在该插件目录执行：npm install && npm run build（也可以直接装它的发布版，产物通常已经构建好）";
  if (hasDeps) return "在该插件目录执行：npm install（它声明了依赖但没写 build 脚本，产物可能已随包提供）";
  return "在这个插件的 package.json 里补 main / exports 指向构建产物，或把入口写成单文件 plugin.ts";
}

/**
 * 找出这个目录的插件入口。
 *
 * 判定顺序是刻意的：**先看 package.json**。因为一个工程可能同时有 `index.ts`（源码）
 * 和 `package.json`（指向 dist），如果先匹配单文件就会去编译源码，绕过用户自己的构建流程
 * ——那正是现在要修的问题。
 */
export function resolvePluginEntry(dir: string): ResolvedEntry {
  const pkg = readPackageJson(dir);

  if (pkg && isBrokenPackage(pkg)) {
    return { kind: "unbuilt", detail: "package.json 存在但解析失败（JSON 语法错误？）", hint: "修好 package.json 再看" };
  }

  if (pkg) {
    const target =
      pickExportTarget(pkg.exports) ??
      (typeof pkg.module === "string" ? pkg.module : null) ??
      (typeof pkg.main === "string" ? pkg.main : null);

    if (target) {
      const abs = path.resolve(dir, target);
      const rel = target.replace(/^\.\//, "");
      if (!fs.existsSync(abs)) {
        return {
          kind: "unbuilt",
          detail: `package.json 把入口指向 ${rel}，但这个文件不存在`,
          hint: buildHint(pkg),
          pkg,
        };
      }
      const ext = path.extname(abs).toLowerCase();
      if (JS_EXT.has(ext)) {
        return { kind: "module", file: abs, detail: `工程模式：入口 ${rel}（已构建，不打包）`, pkg };
      }
      if (TS_EXT.has(ext)) {
        // 入口直接写源码：仍是"工程"，但没有构建产物，只能宿主编译
        return { kind: "script", file: abs, detail: `入口是 TypeScript 源码 ${rel}，由宿主编译`, pkg };
      }
      return { kind: "unbuilt", detail: `入口 ${rel} 不是 JS/TS（${ext || "无扩展名"}）`, hint: buildHint(pkg), pkg };
    }

    // 没声明入口：顺着常见构建输出名找一遍，找到就当工程模式
    for (const guess of ["dist/index.mjs", "dist/index.js", "dist/main.mjs", "dist/plugin.mjs", "index.mjs"]) {
      const abs = path.join(dir, guess);
      if (fs.existsSync(abs)) {
        return { kind: "module", file: abs, detail: `没有 main/exports，按约定找到 ${guess}`, pkg };
      }
    }
    return {
      kind: "unbuilt",
      detail: "package.json 里没有 main / module / exports，也没有 dist/ 产物",
      hint: buildHint(pkg),
      pkg,
    };
  }

  for (const name of SCRIPT_ENTRIES) {
    const abs = path.join(dir, name);
    try {
      if (fs.statSync(abs).isFile()) {
        return { kind: "script", file: abs, detail: `单文件入口 ${name}` };
      }
    } catch {
      /* 试下一个 */
    }
  }

  return {
    kind: "unbuilt",
    detail: `既没有 package.json，也没有 ${SCRIPT_ENTRIES.slice(0, 3).join(" / ")} 这样的入口文件`,
    hint: "想要工程化插件就放 package.json（写好 main/exports）；想要轻量的就写一个 plugin.ts",
  };
}

/* ─────────────────────────── 指纹 ─────────────────────────── */

/** FNV-1a → base36：够短、稳定、不需要依赖 */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(5, "0").slice(0, 5);
}

export { shortHash };

/**
 * module 模式的缓存标签。
 *
 * 只看入口文件不够：插件改了 `dist/chunk-xxx.js` 而入口没变时，Node 会继续用旧模块。
 * 所以把入口的**同级目录**（一般是 dist）里的 JS 都算进去，递归两层——够覆盖
 * 常见的 chunk 布局，又不会去扫 node_modules（那有几千个文件）。
 *
 * 上限 300 个文件：真超了说明这个目录里混进了别的东西，扫下去只会拖慢每次调用。
 */
function moduleFingerprint(entry: string): string {
  const parts: string[] = [];
  const push = (f: string) => {
    try {
      const st = fs.statSync(f);
      parts.push(`${path.basename(f)}:${Math.round(st.mtimeMs)}:${st.size}`);
    } catch {
      parts.push(`${path.basename(f)}:gone`);
    }
  };

  push(entry);
  const dir = path.dirname(entry);
  const pkgFile = path.join(path.dirname(dir), "package.json");
  if (fs.existsSync(pkgFile)) push(pkgFile);

  const walk = (d: string, depth: number) => {
    if (depth > 2 || parts.length > 300) return;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (parts.length > 300) return;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "src") continue;
        walk(abs, depth + 1);
      } else if (JS_EXT.has(path.extname(e.name).toLowerCase())) {
        push(abs);
      }
    }
  };
  walk(dir, 0);

  return `${Math.round(fs.statSync(entry).mtimeMs)}-${shortHash(parts.join("|"))}`;
}

/**
 * script 模式的缓存标签：入口 + **入口同目录两层内的全部源码文件**。
 *
 * 只看入口文件不够：文档鼓励单文件插件拆 helper（`import "./helper"`），
 * esbuild 会把 helper 一起打进产物——但 helper 改了入口的 mtime/size 不变，
 * 产物文件名不变，`fs.existsSync(out)` 命中旧缓存，改了等于没改。
 * 所以 script 模式也要像 moduleFingerprint 那样扫同目录（含 .ts/.tsx/.json）。
 */
function scriptFingerprint(entry: string): string {
  const parts: string[] = [];
  const push = (f: string) => {
    try {
      const st = fs.statSync(f);
      parts.push(`${path.basename(f)}:${Math.round(st.mtimeMs)}:${st.size}`);
    } catch {
      parts.push(`${path.basename(f)}:gone`);
    }
  };

  push(entry);
  const walk = (d: string, depth: number) => {
    if (depth > 2 || parts.length > 300) return;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (parts.length > 300) return;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "dist") continue;
        walk(abs, depth + 1);
      } else if (SCRIPT_SRC_EXT.has(path.extname(e.name).toLowerCase())) {
        push(abs);
      }
    }
  };
  walk(path.dirname(entry), 0);

  return `${Math.round(fs.statSync(entry).mtimeMs)}-${shortHash(parts.join("|"))}`;
}

/**
 * 统一的入口缓存标签：module 模式扫 dist 两层，script 模式扫同目录源码。
 * hooks.ts / tts-providers.ts 的热更新指纹也用它——三处口径必须一致，
 * 否则"这条链热更新、那条链要重启"会成为最迷惑人的不一致。
 */
export function entryCacheTag(kind: string, file: string | undefined, fallbackDetail: string): string {
  if (kind === "module" && file) return moduleFingerprint(file);
  if (kind === "script" && file) return scriptFingerprint(file);
  return `${kind}:${fallbackDetail}`;
}

/* ─────────────────────────── 加载 ─────────────────────────── */

type Esbuild = { buildSync: (o: Record<string, unknown>) => unknown };

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

export function esbuildErrText(err: unknown): string {
  const e = err as { errors?: { text?: string; location?: { line?: number; column?: number } }[]; message?: string };
  const first = e?.errors?.[0];
  if (first?.text) {
    const loc = first.location ? `（第 ${first.location.line} 行）` : "";
    return `${first.text}${loc}`;
  }
  return e?.message ?? String(err);
}

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "plugin";

const importUrl = (file: string, tag: string) => `${pathToFileURL(file).href}?v=${tag}`;

/**
 * 加载插件入口模块。
 *
 * 两种模式的行为差别，就是这次改造的全部意义：
 *
 * | | module（工程） | script（单文件） |
 * |---|---|---|
 * | 谁编译 | 插件自己（npm run build） | 宿主 esbuild |
 * | 依赖从哪来 | 插件自己的 node_modules | 打包内联，宿主解析 |
 * | 原生模块 | 能用 | 用不了 |
 * | 热更新 | 入口+dist 指纹变 = 重新 import | 源文件变 = 重新打包 |
 */
export async function loadPluginEntry(
  dir: string,
  id: string,
): Promise<{ mod: Record<string, unknown>; artifact: string; entry: ResolvedEntry }> {
  const entry = resolvePluginEntry(dir);

  if (entry.kind === "unbuilt") {
    throw new Error(entry.hint ? `${entry.detail}。${entry.hint}` : entry.detail);
  }

  // 统一绝对路径：esbuild 的 absWorkingDir 不接受相对路径，
  // 而调用方传进来的可能是相对的（tests / 脚本里很常见）
  const file = path.resolve(entry.file!);

  if (entry.kind === "module") {
    const tag = moduleFingerprint(file);
    return { mod: (await import(importUrl(file, tag))) as Record<string, unknown>, artifact: file, entry };
  }

  /* script 模式：老路径，esbuild 打成单文件 */
  const eb = await esbuildOf();
  if (!eb) {
    // 没有 esbuild 就直接 import 源码（Node 22 能剥类型；跑不了会给出它自己的错）
    const tag = scriptFingerprint(file);
    return { mod: (await import(importUrl(file, tag))) as Record<string, unknown>, artifact: file, entry };
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // 产物名必须用 scriptFingerprint：helper 改了也要换新产物，否则 existsSync 命中旧缓存
  const out = path.join(CACHE_DIR, `${safeName(id)}-${shortHash(`${file}|${scriptFingerprint(file)}`)}.mjs`);
  if (!fs.existsSync(out)) {
    try {
      eb.buildSync({
        entryPoints: [file],
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
      try {
        fs.rmSync(out, { force: true });
      } catch {
        /* 忽略 */
      }
      throw new Error(`编译失败：${esbuildErrText(err)}`);
    }
  }
  return { mod: (await import(pathToFileURL(out).href)) as Record<string, unknown>, artifact: out, entry };
}

/* ─────────────────────────── 诊断 ─────────────────────────── */

/**
 * 工程化插件的常见坑，加载前就能查出来。
 *
 * 最有价值的一条是 `react` / `remotion`：插件如果把它们写进 dependencies 并真的装了，
 * 它自己的 node_modules 里就会有一份**另一版本**的 React。服务端跑不受影响，
 * 但一旦它的组件进渲染端，就是经典的 "Invalid hook call" —— 报错点在宿主代码里，
 * 查半天查不到插件头上。所以在加载前就喊出来。
 */
export function lintPackage(pkg: PackageJson | null): string[] {
  if (!pkg || isBrokenPackage(pkg)) return [];
  const out: string[] = [];

  const shared = ["react", "react-dom", "remotion", "@remotion/cli", "@remotion/renderer"];
  const bad = shared.filter((n) => pkg.dependencies?.[n] || pkg.devDependencies?.[n]);
  if (bad.length) {
    out.push(
      `${bad.join("、")} 不该写进 dependencies —— 它们必须由宿主提供（改成 peerDependencies），` +
        `否则插件会自带一份另一个版本，渲染时会出现 Invalid hook call`,
    );
  }

  if (!pkg.version) out.push("package.json 没有 version —— list_plugins 里显示不出来，也无法区分新旧版本");

  return out;
}
