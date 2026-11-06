/**
 * 插件安装器：把「clone 一个仓库 / npm 一个包」变成「装完就能用」。
 *
 * ## 为什么这里要执行命令
 *
 * 插件是一个完整工程时，必然有 `npm install` 和（通常）`npm run build` 两步。
 * 之前的设计把这两步留给用户，理由是"不能在扫一下目录时静默执行任意代码"。
 * 那个理由仍然成立——**但约束的是"静默"**。用户在编辑器里明确点了「安装」，
 * 并且明确知道来源是一个外部工程，这时的 install/build 是他授权过的动作，
 * 和 postinstall 的风险是同一档，没有新增暴露面。
 *
 * 所以边界改成了：
 *
 *   - 扫描插件目录时**绝不**执行任何东西（保持原状）
 *   - 只有 `POST /api/plugins/install` 这条显式路径才会起子进程
 *   - 子进程一律 `spawn(命令, 参数数组)`，**不走 shell**，参数全部来自白名单/校验
 *   - 每个 job 的完整输出都写进 `data/plugin-installs/<id>.log`，出错能查
 *
 * ## 为什么不直接 `shell: true` 了事
 *
 * Windows 上 `npm` 是 `npm.cmd`，`spawn` 不带 shell 会 EINVAL。绕法是**直接跑
 * `node <npm-cli.js>`**——npm 本身就是个 JS 程序，用当前 node 执行它，跨平台一致，
 * 而且参数不会被 cmd.exe 再解释一遍（插件路径里有 `&`、空格也不会出事）。
 *
 * ## 串行
 *
 * 同一时间只跑一个安装任务。npm 会在全局 cache 上抢锁，两个 `npm install` 并发
 * 时常有一个莫名失败；而"装插件"从来不是需要并行的事。
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DATA_ROOT } from "../paths";
import { PROJECT_PLUGIN_DIR, scanPlugins, setPluginEnabled, type PluginScope } from "./discovery";
import { declaresCodeEntry, isBrokenPackage, readPackageJson, resolvePluginEntry, type PackageJson } from "./entry";
import { resetHookCache } from "./hooks";
import { resetPluginToolCache } from "./plugin-tools";

/* ─────────────────────────── 类型 ─────────────────────────── */

export type InstallSourceKind = "git" | "npm" | "local";

export type StepStatus = "pending" | "running" | "done" | "skip" | "error";

export type InstallStep = {
  key: string;
  label: string;
  status: StepStatus;
  /** 一句话结果（"跳过了，因为没有依赖"这种） */
  detail?: string;
};

export type LogLine = { t: number; stream: "out" | "err" | "sys"; text: string };

export type InstallJobStatus = "queued" | "running" | "done" | "error" | "canceled";

export type InstallJob = {
  id: string;
  source: string;
  kind: InstallSourceKind;
  /** 猜测的目标目录名（下载前就能显示给用户） */
  targetName: string;
  /** 装到哪个插件根（2026-11-06 起只有一个：<repo>/plugins/） */
  scopeRoot: string;
  /** install = 下载并安装；repair = 原地重建 */
  mode: "install" | "repair";
  /** npm 源（默认国内镜像）。git / 本地来源用不到，但日志里仍然显示 */
  registry: string;
  /** 用户明确要求"别管它像不像插件，装" */
  force: boolean;
  /** 失败的结构化原因（目前只有 NOT_A_PLUGIN），前端据此给"仍然安装"按钮 */
  code?: string;
  status: InstallJobStatus;
  steps: InstallStep[];
  logs: LogLine[];
  /** 日志超过上限被丢掉的条数（前端提示"只显示最近 N 行"） */
  droppedLogs: number;
  dir?: string;
  pluginId?: string;
  error?: string;
  /** 失败时该做什么（结构化建议，不是一句"失败了"） */
  hint?: string;
  startedAt: number;
  endedAt?: number;
};

/* ─────────────────────────── 常量与路径 ─────────────────────────── */

/** 安装日志目录：跟 data/ 一起走，换盘也不丢 */
export const INSTALL_LOG_DIR = path.join(DATA_ROOT, "plugin-installs");
/**
 * 暂存目录名（放在插件根目录下，以 `.` 开头 → 扫描时跳过）。
 *
 * 不放在系统临时目录：跨盘 rename 会退化成 copy，一个带 node_modules 的插件
 * 要几十秒；而放在同一个插件根下就只是一个原子的改名。
 */
export const STAGING_DIR_NAME = ".staging";
/** 卸载不删文件，挪到这里——用户后悔了还能捡回来 */
export const PLUGIN_TRASH_DIR = path.join(DATA_ROOT, ".plugin-trash");

/* ─────────────────────────── npm 源 ─────────────────────────── */

/**
 * 默认用国内镜像。
 *
 * 这个项目的使用者几乎都在国内，`registry.npmjs.org` 经常几十秒才超时，
 * 而插件安装动辄要拉几十个包——默认连接到官方源基本等于默认失败。
 * 官方源仍然保留成一个选项，需要时一行就能切。
 */
export const DEFAULT_REGISTRY = "https://registry.npmmirror.com";

export const REGISTRY_PRESETS = [
  { id: "npmmirror", label: "国内镜像 npmmirror（推荐）", url: "https://registry.npmmirror.com" },
  { id: "npm", label: "npm 官方源", url: "https://registry.npmjs.org" },
  { id: "tencent", label: "腾讯云镜像", url: "https://mirrors.cloud.tencent.com/npm/" },
] as const;

/** 插件安装相关的设置（目前只有 registry），跟 data/ 一起走 */
const SETTINGS_FILE = path.join(DATA_ROOT, "plugin-settings.json");

type PluginSettings = { registry?: string };

function readSettings(): PluginSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as PluginSettings;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** 当前 npm 源（没设置过就是国内镜像） */
export function getRegistry(): string {
  const saved = readSettings().registry;
  return normalizeRegistry(saved) ?? DEFAULT_REGISTRY;
}

export function setRegistry(url: string): string {
  const next = normalizeRegistry(url);
  if (!next) throw new Error(`不是一个合法的 npm 源地址：${url}（需要 http(s):// 开头的 URL）`);
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), registry: next }, null, 2), "utf8");
  return next;
}

/** 只接受 http(s)，且去掉末尾斜杠（npm 会自己补） */
export function normalizeRegistry(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const s = url.trim().replace(/\/+$/, "");
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return s;
  } catch {
    return null;
  }
}

/** UI 里最多留多少行（再多浏览器也刷不动） */
const MAX_LOG_LINES = 800;
/** 内存里最多留多少个历史任务 */
const MAX_JOBS = 20;

const TIMEOUT = {
  clone: 5 * 60_000,
  npm: 10 * 60_000,
  build: 8 * 60_000,
  misc: 60_000,
};

/* ─────────────────────────── 来源识别 ─────────────────────────── */

const GIT_URL = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i;
/** npm 包名规则（scoped 可带版本/范围） */
const NPM_SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~><=*|\s-]+)?$/i;
/** GitHub 简写 owner/repo */
const GH_SHORT = /^[\w.-]+\/[\w.-]+$/;

/**
 * 判断一个字符串是 git 仓库、npm 包，还是本地目录。
 *
 * 顺序有讲究：先看协议前缀（最不会误判），再看"本地是否真的存在"，
 * 然后才轮 npm 正则。反过来会把本地一个叫 `foo` 的目录当成 npm 包 `foo` 去下载。
 */
export function detectSourceKind(raw: string): InstallSourceKind | null {
  const s = raw.trim();
  if (!s) return null;
  if (GIT_URL.test(s)) return "git";

  const asPath = s.startsWith("~/") ? path.join(process.env.HOME || process.env.USERPROFILE || "", s.slice(2)) : s;
  try {
    if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) return "local";
  } catch {
    /* 路径不合法就当它不是路径 */
  }

  if (s.startsWith(".") || /^[a-zA-Z]:[\\/]/.test(s) || path.isAbsolute(s)) return "local";
  if (/^npm:/i.test(s)) return "npm";
  if (NPM_SPEC.test(s)) return "npm";
  if (GH_SHORT.test(s)) return "git";
  return null;
}

/** `github.com/a/b` / `a/b` → 补成完整 URL；已经是 URL 就原样返回 */
export function normalizeGitUrl(raw: string): string {
  const s = raw.trim();
  if (GIT_URL.test(s)) return s;
  return `https://github.com/${s.replace(/\.git$/, "")}.git`;
}

/** 拆 npm spec：`@scope/pkg@1.2` → { name:"@scope/pkg", version:"1.2" } */
export function splitNpmSpec(raw: string): { name: string; version: string } {
  const s = raw.trim().replace(/^npm:/i, "");
  if (s.startsWith("@")) {
    const slash = s.indexOf("/");
    if (slash < 0) return { name: s, version: "" };
    const at = s.indexOf("@", slash);
    return at > 0 ? { name: s.slice(0, at), version: s.slice(at + 1) } : { name: s, version: "" };
  }
  const at = s.indexOf("@");
  return at > 0 ? { name: s.slice(0, at), version: s.slice(at + 1) } : { name: s, version: "" };
}

/** 目录名消毒：去掉路径分隔符与 ..，保留中文（git 仓库名可能是中文） */
export function safeDirName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/^\.+/, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    // 首尾的点和横线一起去掉：以 . 开头的目录会被扫描跳过，以 - 开头在命令行里很别扭
    .replace(/^[-.]+|[-.]+$/g, "")
    .trim();
  return cleaned.slice(0, 60) || `plugin-${Date.now().toString(36)}`;
}

/** 猜一个目录名（下载前给用户看） */
export function guessTargetName(kind: InstallSourceKind, source: string): string {
  if (kind === "npm") {
    const { name } = splitNpmSpec(source);
    const parts = name.split("/");
    return safeDirName(parts[parts.length - 1] || name);
  }
  if (kind === "git") {
    const base = normalizeGitUrl(source)
      .replace(/\.git$/, "")
      .replace(/[?#].*$/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .pop();
    return safeDirName(base || "plugin");
  }
  /*
   * 本地目录优先用 package.json 的 name 当目录名。
   *
   * 用户常常指向 `D:/项目/src` 或 `D:/项目`，目录名对宿主来说毫无意义（"src"），
   * 而包名才是插件的真名。没有 package.json 才退回目录名。
   */
  const abs = path.resolve(source.replace(/^~(?=[\\/])/, process.env.HOME || process.env.USERPROFILE || "~"));
  const pkg = readPackageJson(abs);
  const pkgName = typeof pkg?.name === "string" ? pkg.name.split("/").pop() : "";
  if (pkgName) return safeDirName(pkgName);
  return safeDirName(path.basename(source.replace(/[\\/]+$/, "")) || "plugin");
}

/* ─────────────────────────── 残留清理 ─────────────────────────── */

/**
 * 清掉上次崩溃/断电留下的暂存目录。
 *
 * 不清的话它们会一直躺在 plugins/.staging/ 里：扫描虽然跳过（`.` 开头），
 * 但每个失败几百 MB 的 node_modules 会悄悄吃掉磁盘。
 */
export function cleanupPluginStaging(): string[] {
  const cleaned: string[] = [];
  for (const root of [PROJECT_PLUGIN_DIR]) {
    const dir = path.join(root, STAGING_DIR_NAME);
    if (!fs.existsSync(dir)) continue;
    try {
      for (const name of fs.readdirSync(dir)) {
        try {
          fs.rmSync(path.join(dir, name), { recursive: true, force: true });
          cleaned.push(name);
        } catch {
          /* 被占用就下次再清 */
        }
      }
    } catch {
      /* 目录读不了就算了 */
    }
  }
  return cleaned;
}

/* ─────────────────────────── 命令执行 ─────────────────────────── */

/** npm 的真实身份：优先用当前 node 跑 npm-cli.js（跨平台、无 shell） */
function npmInvocation(): { cmd: string; prefix: string[]; shell: boolean } {
  const cand = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(cand)) return { cmd: process.execPath, prefix: [cand], shell: false };
  // 兜底：PATH 里的 npm。Windows 上 .cmd 必须借 shell
  return { cmd: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [], shell: process.platform === "win32" };
}

const children = new Map<string, ChildProcess>();

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } catch {
      child.kill();
    }
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      /* 已经退出了 */
    }
  }
}

type RunOpts = { cwd: string; job: InstallJob; timeout: number; step?: InstallStep };

/**
 * 跑一条命令，输出实时进 job.logs。
 *
 * 只 reject 一次（成功/失败/超时/取消四选一），避免"超时后又收到 exit"重复结算。
 */
function run(cmd: string, args: string[], opts: RunOpts): Promise<void> {
  const { cwd, job, timeout, step } = opts;
  if (job.status === "canceled") return Promise.reject(new Error("已取消"));

  pushLog(job, "sys", `$ ${prettyCommand(cmd, args)}`);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    // spawn 自己抛异常时 done() 会在 setTimeout 赋值之前被调用 —— 所以这里必须先声明
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      children.delete(job.id);
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: {
          ...process.env,
          /*
           * npm 源走环境变量而不是命令行参数：`npm run build` 里的脚本可能自己
           * 再调 npm / npx（比如 "build": "npx tsc"），只有 env 能一路传下去。
           * 已经在用户 shell 里设了 registry 的，以这里的为准——不然"设置里明明是
           * 国内镜像，装的时候却在连官方源"这种问题根本查不出来。
           */
          npm_config_registry: job.registry || DEFAULT_REGISTRY,
          // 让 npm / git 在无人值守时不要卡在交互提示上
          npm_config_yes: "true",
          npm_config_audit: "false",
          npm_config_fund: "false",
          npm_config_update_notifier: "false",
          CI: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "echo",
        },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      done(new Error(`启动命令失败：${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    children.set(job.id, child);

    timer = setTimeout(() => {
      killTree(child);
      done(new Error(`命令超时（${Math.round(timeout / 1000)}s）：${path.basename(cmd)} ${args[0] ?? ""}`));
    }, timeout);

    pipeLines(child.stdout, (line) => pushLog(job, "out", line));
    pipeLines(child.stderr, (line) => pushLog(job, "err", line));

    child.on("error", (err) => done(new Error(`命令执行失败：${err.message}`)));
    child.on("close", (code) => {
      if (job.status === "canceled") return done(new Error("已取消"));
      if (code === 0) {
        if (step) step.status = "done";
        done();
      } else {
        done(new Error(`命令退出码 ${code}：${path.basename(cmd)} ${args.slice(0, 2).join(" ")}`));
      }
    });
  });
}

/** 按行切流。npm 的输出经常一行写完不换行，所以 close 时把残余也吐出来 */
function pipeLines(stream: NodeJS.ReadableStream | null, onLine: (s: string) => void): void {
  if (!stream) return;
  let buf = "";
  stream.on("data", (chunk: Buffer | string) => {
    buf += chunk.toString();
    // 进度条用 \r 刷新，不切开的话整个安装过程只会看到一行越来越长
    const parts = buf.split(/\r\n|\n|\r/);
    buf = parts.pop() ?? "";
    for (const p of parts) if (p.trim()) onLine(p);
  });
  stream.on("end", () => {
    if (buf.trim()) onLine(buf);
    buf = "";
  });
}

/**
 * 去掉 ANSI 颜色码。
 *
 * vite / tsc / esbuild 在管道里也会吐 `\u001b[32m✓\u001b[39m`，原样塞进前端就是一堆
 * `[32m` 这样的垃圾字符——用户看到的第一反应是"报错了吧"。
 */
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

/**
 * 跑一条命令并把 stdout 收回来（用于 `git ls-tree` / `git show` 这类要读结果的）。
 *
 * stderr 仍然进日志；stdout 不进——它是程序要解析的数据，不是给人看的进度。
 */
function runCapture(cmd: string, args: string[], opts: RunOpts, maxBytes = 4 * 1024 * 1024): Promise<{ stdout: string }> {
  const { cwd, job, timeout } = opts;
  if (job.status === "canceled") return Promise.reject(new Error("已取消"));

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (err?: Error, stdout = "") => {
      if (settled) return;
      settled = true;
      children.delete(job.id);
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve({ stdout });
    };

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: {
          ...process.env,
          npm_config_registry: job.registry || DEFAULT_REGISTRY,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "echo",
        },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      done(new Error(`启动命令失败：${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    children.set(job.id, child);

    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      if (out.length < maxBytes) out += c.toString();
    });
    pipeLines(child.stderr, (line) => pushLog(job, "err", line));

    timer = setTimeout(() => {
      killTree(child);
      done(new Error(`命令超时：${path.basename(cmd)} ${args[0] ?? ""}`));
    }, timeout);

    child.on("error", (err) => done(new Error(`命令执行失败：${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) done(undefined, out);
      else done(new Error(`命令退出码 ${code}：${path.basename(cmd)} ${args.slice(0, 2).join(" ")}`));
    });
  });
}

function pushLog(job: InstallJob, stream: LogLine["stream"], text: string): void {
  job.logs.push({ t: Date.now(), stream, text: stripAnsi(text).slice(0, 2000) });
  if (job.logs.length > MAX_LOG_LINES) {
    job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
    job.droppedLogs += 1;
  }
}

/* ─────────────────────────── 预检：先判断，再决定要不要下载 ─────────────────────────── */

/**
 * 「这看起来不是插件」——专门用一个错误类型，前端据此给"仍然安装"的机会。
 *
 * 预检只能看**声明**，看不到代码：一个把钩子全写在 dist 里、又没写任何清单的插件，
 * 会被误判。所以它是"停下来问一句"，不是"永久拒绝"。
 */
export class NotAPluginError extends Error {
  readonly code = "NOT_A_PLUGIN";
  constructor(
    readonly reason: string,
    readonly source: string,
  ) {
    super(
      `${reason}\n\n已经在下载/安装之前停下：没有装依赖、没有做构建、没有留下文件。\n` +
        `如果确认就是要装它（比如作者没写声明），点「仍然安装」。`,
    );
    this.name = "NotAPluginError";
  }
}

type Verdict = { ok: boolean; reason?: string; detail?: string };

/** 仓库根目录里有这些，就算插件 */
export function treeLooksLikePlugin(paths: string[], pkg: PackageJson | null): boolean {
  if (pkg && !isBrokenPackage(pkg) && pkg.remotionStudio && typeof pkg.remotionStudio === "object") return true;
  if (declaresCodeEntry(pkg)) return true;
  // 只看**根层**的名字：skills/a.md 算 skills 目录，src/skills.ts 不算
  return paths.some((p) => PLUGIN_MARKERS.includes(p.split("/")[0]));
}

/**
 * npm 包的预检：只看 registry 上的清单，**不下载 tarball**。
 *
 * 用 `/<name>/latest` 这个端点（单版本文档）而不是整个 packument：几 KB 就够判断，
 * 大包的 packument 能有几 MB。
 */
async function probeNpm(job: InstallJob): Promise<Verdict> {
  const spec = job.source.replace(/^npm:/i, "");
  const { name, version } = splitNpmSpec(spec);
  const base = (job.registry || DEFAULT_REGISTRY).replace(/\/+$/, "");
  // 版本是范围（^2 / >=1）时拿不到单版本文档，退回 latest：判断"是不是插件"用 latest 足够
  const tag = version && !/[\s^~<>|*]/.test(version) ? version : "latest";
  const url = `${base}/${name.replace("/", "%2F")}/${tag}`;

  let manifest: Record<string, unknown> | null = null;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: true, detail: `读不到包信息（HTTP ${res.status}），跳过预检` };
    manifest = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: true, detail: "读不到包信息（网络或私有源），跳过预检" };
  }

  const why = manifestRejectsPlugin(manifest, name);
  return why ? { ok: false, reason: why } : { ok: true, detail: `registry 清单里有插件标志（${name}@${tag}）` };
}

/** 清单里有没有插件标志；没有就返回一句给人看的话 */
export function manifestRejectsPlugin(m: Record<string, unknown>, name: string): string | null {
  const obj = m as {
    remotionStudio?: unknown;
    main?: unknown;
    module?: unknown;
    exports?: unknown;
    keywords?: unknown;
    files?: unknown;
  };
  if (obj.remotionStudio && typeof obj.remotionStudio === "object") return null;
  if (obj.main || obj.module || obj.exports) return null;
  const kw = Array.isArray(obj.keywords) ? obj.keywords.join(" ").toLowerCase() : "";
  if (kw.includes("remotion-studio") || kw.includes("remotion-plugin")) return null;
  const files = Array.isArray(obj.files) ? obj.files.map((f) => String(f).replace(/^\.\//, "").replace(/\/$/, "")) : [];
  if (files.some((f) => PLUGIN_MARKERS.includes(f))) return null;

  return (
    `包「${name}」的 package.json 里没有任何插件标志：没有 remotionStudio 字段、没有 main / exports 入口，` +
    `keywords 里没有 remotion-studio，files 里也没有 skills / styles / scenes 这类目录。`
  );
}

/**
 * git 仓库的预检：**只取目录树，不取文件内容**。
 *
 * `--filter=blob:none --no-checkout` 让 git 只下 commit + tree 对象，
 * 再用 `ls-tree` 列出文件路径、`show HEAD:package.json` 只拉这一个 blob。
 * 一个几百 MB 的仓库，判断"是不是插件"只需要几十 KB。
 */
async function probeGit(job: InstallJob, jobDir: string, work: string): Promise<Verdict> {
  const url = normalizeGitUrl(job.source);
  await run(
    "git",
    ["clone", "--depth", "1", "--single-branch", "--filter=blob:none", "--no-checkout", url, work],
    { cwd: jobDir, job, timeout: TIMEOUT.clone },
  );

  const tree = await runCapture("git", ["-C", work, "ls-tree", "-r", "--name-only", "HEAD"], {
    cwd: jobDir,
    job,
    timeout: TIMEOUT.misc,
  });
  const paths = tree.stdout.split(/\r?\n/).filter(Boolean);

  let pkg: PackageJson | null = null;
  if (paths.includes("package.json")) {
    try {
      const shown = await runCapture("git", ["-C", work, "show", "HEAD:package.json"], {
        cwd: jobDir,
        job,
        timeout: TIMEOUT.misc,
      });
      pkg = JSON.parse(shown.stdout) as PackageJson;
    } catch {
      pkg = null;
    }
  }

  if (treeLooksLikePlugin(paths, pkg)) {
    return { ok: true, detail: `仓库里找到了插件标志（${paths.length} 个文件，只取了目录树）` };
  }
  return {
    ok: false,
    reason:
      `仓库「${job.targetName}」里没有插件标志：根目录没有 manifest.json / skills / styles / plugin.ts，` +
      `package.json 里也没有 remotionStudio 字段或 main / exports 入口。`,
  };
}

/** 本地目录的预检：不用下载，直接看 */
function probeLocal(job: InstallJob): Verdict {
  const src = job.source.replace(/^~(?=[\\/])/, process.env.HOME || process.env.USERPROFILE || "~");
  const abs = path.resolve(src);
  const pkg = readPackageJson(abs);
  let has = false;
  try {
    has = looksLikePlugin(abs, pkg);
  } catch {
    has = false;
  }
  return has
    ? { ok: true, detail: "目录里有插件标志" }
    : { ok: false, reason: `目录「${abs}」里没有插件标志：没有 manifest.json / skills / styles / plugin.ts，package.json 里也没有 remotionStudio 或 main/exports。` };
}

/* ─────────────────────────── 任务表 ─────────────────────────── */

const jobs = new Map<string, InstallJob>();
/** 串行队列：npm 会抢全局 cache 锁，并发反而更慢更容易失败 */
type QueuedJob = { id: string; mode: "install" | "repair" };
let running = false;
const queue: QueuedJob[] = [];

const newId = () => `plg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function getJob(id: string): InstallJob | undefined {
  return jobs.get(id);
}

export function listJobs(): InstallJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

function trimJobs(): void {
  const all = listJobs();
  for (const j of all.slice(MAX_JOBS)) {
    if (j.status === "running" || j.status === "queued") continue;
    jobs.delete(j.id);
  }
}

/** 取消：只对排队中/运行中有效。运行中的会杀掉子进程树 */
export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || (job.status !== "running" && job.status !== "queued")) return false;
  job.status = "canceled";
  job.endedAt = Date.now();
  pushLog(job, "sys", "用户取消");
  const child = children.get(id);
  if (child) killTree(child);
  return true;
}

/* ─────────────────────────── 安装主流程 ─────────────────────────── */

export type InstallInput = {
  /** git URL / npm spec / 本地目录 */
  source: string;
  /** 覆盖目录名（可选） */
  name?: string;
  /** 本次安装用的 npm 源；不传就用设置里那个（默认国内镜像） */
  registry?: string;
  /**
   * 跳过"这是不是一个插件"的预检。
   *
   * 预检只能看**声明的痕迹**（remotionStudio 字段、main/exports、关键词、根目录里的
   * skills/ 之类），看不到代码本身。所以它有可能误判——比如一个只在 dist 里导出钩子、
   * 又没写任何清单的插件。用户确认"我知道我在装什么"之后，就不该再拦着他。
   */
  force?: boolean;
};

export function startInstall(input: InstallInput): InstallJob {
  const raw = String(input.source ?? "").trim();
  if (!raw) throw new Error("插件来源不能为空：填 git 地址、npm 包名，或一个本地目录");

  const kind = detectSourceKind(raw);
  if (!kind) {
    throw new Error(
      `认不出这个来源：「${raw}」。支持三种写法：\n` +
        `  · git 地址：https://github.com/用户/仓库 或 用户/仓库\n` +
        `  · npm 包名：@scope/名字 或 名字@版本\n` +
        `  · 本地目录：D:/path/to/plugin`,
    );
  }

  const targetName = input.name ? safeDirName(input.name) : guessTargetName(kind, raw);
  const root = PROJECT_PLUGIN_DIR;
  const dir = path.join(root, targetName);

  if (fs.existsSync(dir)) {
    throw new Error(
      `目标目录已存在：${dir}\n` +
        `先卸载同名插件，或者换一个名字安装（安装时指定 name）。直接覆盖会丢掉你原来的插件。`,
    );
  }

  const registry = normalizeRegistry(input.registry) ?? getRegistry();
  const job: InstallJob = {
    id: newId(),
    source: raw,
    kind,
    targetName,
    scopeRoot: root,
    mode: "install",
    registry,
    force: !!input.force,
    status: "queued",
    steps: [
      { key: "resolve", label: "识别来源", status: "pending" },
      { key: "probe", label: "检查是不是插件", status: "pending" },
      { key: "fetch", label: kind === "git" ? "克隆仓库" : kind === "npm" ? "下载 npm 包" : "复制目录", status: "pending" },
      { key: "deps", label: "安装依赖", status: "pending" },
      { key: "build", label: "执行构建", status: "pending" },
      { key: "place", label: `放到 plugins/${targetName}`, status: "pending" },
      { key: "verify", label: "确认宿主能识别", status: "pending" },
    ],
    logs: [],
    droppedLogs: 0,
    startedAt: Date.now(),
  };

  jobs.set(job.id, job);
  trimJobs();

  if (running) {
    job.status = "queued";
    pushLog(job, "sys", "前面还有任务在跑，排队中…");
    queue.push({ id: job.id, mode: "install" });
  } else {
    void launch(job);
  }

  return job;
}

async function launch(job: InstallJob): Promise<void> {
  running = true;
  // 断言成联合类型：否则 TS 会把 job.status 收窄成字面量 "running"，
  // 后面 catch/finally 里的 `!== "canceled" / !== "done"` 全被判成"永远为真"
  job.status = "running" as InstallJobStatus;
  try {
    await execute(job);
  } catch (err) {
    if (job.status !== "canceled") {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      job.code = (err as { code?: string })?.code;
    }
  } finally {
    job.endedAt = Date.now();
    const step = job.steps.find((s) => s.status === "running");
    if (step && job.status !== "done") step.status = "error";
    flushLogFile(job);
    running = false;
    dispatchNext();
  }
}

/** 从队列里取下一个（install 与 repair 走不同的执行体） */
function dispatchNext(): void {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  const j = jobs.get(next.id);
  if (!j || j.status !== "queued") {
    dispatchNext();
    return;
  }
  if (next.mode === "repair") void launchRepair(j);
  else void launch(j);
}

async function execute(job: InstallJob): Promise<void> {
  const destRoot = job.scopeRoot || PROJECT_PLUGIN_DIR;
  const dest = path.join(destRoot, job.targetName);
  /*
   * 暂存区放在**目标插件目录下**，而不是系统临时目录。
   *
   * 两个理由：① 同一个文件系统，最后一步 `rename` 是瞬时的（跨盘 copy 一个带
   * node_modules 的插件要好几十秒）；② 目录名以 `.` 开头，扫描时会被跳过，
   * 所以整个过程插件对宿主**完全不可见** —— 不会出现"装到一半，宿主已经把它
   * 当成插件去加载、然后报一堆找不到入口的错"。
   */
  const jobDir = path.join(destRoot, STAGING_DIR_NAME, job.id);
  const work = path.join(jobDir, "pkg");

  fs.mkdirSync(destRoot, { recursive: true });
  fs.mkdirSync(jobDir, { recursive: true });

  const step = (key: string) => job.steps.find((s) => s.key === key)!;
  const begin = (key: string) => {
    const s = step(key);
    s.status = "running";
    return s;
  };

  try {
    /* 1. 识别 */
    const s1 = begin("resolve");
    s1.detail = `${kindLabel(job.kind)} → ${dest}`;
    s1.status = "done";
    pushLog(job, "sys", `来源类型：${kindLabel(job.kind)}`);

    /* 2. 预检：先判断"是不是插件"，再决定要不要把东西拉下来 */
    const sp = begin("probe");
    if (job.force) {
      sp.status = "skip";
      sp.detail = "按你的要求跳过检查";
      pushLog(job, "sys", "跳过预检（force）");
    } else {
      const verdict =
        job.kind === "npm" ? await probeNpm(job) : job.kind === "git" ? await probeGit(job, jobDir, work) : probeLocal(job);
      if (!verdict.ok) {
        sp.status = "error";
        sp.detail = verdict.reason;
        throw new NotAPluginError(verdict.reason ?? "看起来不是插件", job.source);
      }
      sp.status = "done";
      sp.detail = verdict.detail;
      pushLog(job, "sys", `预检通过：${verdict.detail ?? "有插件标志"}`);
    }

    /* 3. 取回（到暂存区，此时对宿主不可见） */
    const s2 = begin("fetch");
    if (job.kind === "git") {
      if (fs.existsSync(path.join(work, ".git"))) {
        // 预检时已经克隆好（--no-checkout，只有目录树），现在把文件取下来即可
        pushLog(job, "sys", "复用预检时的克隆，检出文件");
        await run("git", ["-C", work, "checkout", "-f", "HEAD"], { cwd: jobDir, job, timeout: TIMEOUT.clone });
        s2.detail = "已检出（预检时只取了目录树，省掉一次下载）";
      } else {
        const url = normalizeGitUrl(job.source);
        pushLog(job, "sys", `克隆 ${url}`);
        await run("git", ["clone", "--depth", "1", "--single-branch", url, work], {
          cwd: jobDir,
          job,
          timeout: TIMEOUT.clone,
        });
        s2.detail = "已克隆（浅克隆，不含历史）";
      }
    } else if (job.kind === "npm") {
      const spec = job.source.replace(/^npm:/i, "");
      const npm = npmInvocation();
      const prefix = path.join(jobDir, "npmroot");
      pushLog(job, "sys", `下载 ${spec}（源 ${job.registry}）`);

      /*
       * 取包优先用 `npm pack`：它只下这个包的 tarball，**不带依赖**。
       *
       * 之前用 `npm install <spec> --prefix …` 取包，npm 会把这个包的整棵依赖树也装进
       * 临时目录——实测装 `remotion-studio-mcp` 时白拉 362 个包，紧接着又要在插件目录
       * 里重装一遍。同一个依赖树下两次，纯浪费。
       *
       * 解压用系统 tar（Win10+ 自带 bsdtar）。没有 tar 就退回老办法，功能不受影响。
       */
      let extracted = false;
      const tar = tarCommand();
      if (tar) {
        try {
          await run(npm.cmd, [...npm.prefix, "pack", spec, "--pack-destination", jobDir, "--silent"], {
            cwd: jobDir,
            job,
            timeout: TIMEOUT.npm,
          });
          const tgz = fs.readdirSync(jobDir).find((f) => f.endsWith(".tgz"));
          if (!tgz) throw new Error("npm pack 没有产出 .tgz");
          fs.mkdirSync(work, { recursive: true });
          await run(tar, ["-xzf", path.join(jobDir, tgz), "-C", work, "--strip-components=1"], {
            cwd: jobDir,
            job,
            timeout: TIMEOUT.misc,
          });
          extracted = true;
        } catch (err) {
          pushLog(job, "sys", `npm pack 方式失败，改用 npm install 取包：${err instanceof Error ? err.message : err}`);
        }
      }

      if (!extracted) {
        await run(
          npm.cmd,
          [...npm.prefix, "install", spec, "--prefix", prefix, "--no-save", "--ignore-scripts", "--include=prod"],
          { cwd: jobDir, job, timeout: TIMEOUT.npm },
        );
        const { name } = splitNpmSpec(spec);
        const pkgDir = path.join(prefix, "node_modules", ...name.split("/"));
        if (!fs.existsSync(pkgDir)) throw new Error(`下载完成但没找到包目录：${pkgDir}`);
        fs.cpSync(pkgDir, work, { recursive: true });
      }
      s2.detail = `已下载 ${splitNpmSpec(spec).name}`;
    } else {
      const src = job.source.replace(/^~(?=[\\/])/, process.env.HOME || process.env.USERPROFILE || "~");
      const abs = path.resolve(src);
      if (!fs.existsSync(abs)) throw new Error(`本地目录不存在：${abs}`);
      pushLog(job, "sys", `复制 ${abs}`);
      fs.cpSync(abs, work, {
        recursive: true,
        filter: (p) => {
          const base = path.basename(p);
          // .git 是仓库内部结构；node_modules 会在暂存区里重新装（复制它慢且可能跨平台失效）
          return base !== ".git" && base !== "node_modules" && base !== STAGING_DIR_NAME;
        },
      });
      s2.detail = "已复制（跳过 .git / node_modules）";
    }
    s2.status = "done";

    const pkg = readPackageJson(work);
    if (pkg && isBrokenPackage(pkg)) throw new Error("插件里的 package.json 解析失败（JSON 语法错误），先修好它");
    const buildScript = typeof pkg?.scripts?.build === "string" ? pkg.scripts.build.trim() : "";

    /*
     * 早停：**在装依赖之前**判断"这是不是一个插件"。
     *
     * 没有这一步，装一个普通 npm 包（甚至把本编辑器自己当插件装）会先把几百个依赖
     * 拉下来、再跑一遍完整构建，最后才说"宿主没把它识别成插件"——用户等了五分钟，
     * 磁盘多出几百 MB，得到的是一句没用的结论。
     */
    if (!job.force && !looksLikePlugin(work, pkg)) {
      throw new Error(
        "这个包里没有任何插件标志：没有 package.json 的 remotionStudio 字段、没有 skills / styles / brief / scenes 等目录、" +
          "没有 plugin.ts，也没有 main / exports 代码入口。\n" +
          "已在这里停下——没有安装依赖、没有构建、没有留下任何文件。检查一下是不是把普通 npm 包当成插件装了。",
      );
    }

    /* 3. 依赖（在暂存区装，失败了目标目录还是干净的） */
    const s3 = begin("deps");
    const deps = pkg
      ? [
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.keys(pkg.optionalDependencies ?? {}),
          ...Object.keys(pkg.devDependencies ?? {}),
        ]
      : [];
    if (!deps.length) {
      s3.status = "skip";
      s3.detail = pkg ? "没有声明依赖" : "没有 package.json（纯内容插件）";
      pushLog(job, "sys", `跳过依赖安装：${s3.detail}`);
    } else {
      const npm = npmInvocation();
      pushLog(
        job,
        "sys",
        `安装 ${deps.length} 个依赖…（${buildScript ? "含 devDependencies，要构建" : "只装运行时依赖"}；源 ${job.registry}）`,
      );
      /*
       * 有 build 脚本才装 devDependencies：构建工具（esbuild / tsc）通常在那里。
       * 没有构建就没有必要把别人整条测试工具链拖下来——实测一个普通 npm 包里
       * devDependencies 能带来 170+ 个包。
       */
      await run(
        npm.cmd,
        [...npm.prefix, "install", buildScript ? "--include=dev" : "--omit=dev", "--no-audit", "--no-fund"],
        { cwd: work, job, timeout: TIMEOUT.npm, step: s3 },
      );
      s3.detail = `已安装 ${deps.length} 个依赖`;
    }

    /* 4. 构建 */
    const s4 = begin("build");
    if (!buildScript) {
      s4.status = "skip";
      s4.detail = "没有 build 脚本（作者可能已经提交了产物，或这是纯内容插件）";
      pushLog(job, "sys", `跳过构建：${s4.detail}`);
    } else {
      const npm = npmInvocation();
      pushLog(job, "sys", `执行构建：${buildScript}`);
      try {
        await run(npm.cmd, [...npm.prefix, "run", "build"], { cwd: work, job, timeout: TIMEOUT.build, step: s4 });
      } catch (err) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}\n` +
            `构建失败最常见的原因：① 这个项目只支持 Linux / macOS（比如要 WSL 编译 wasm），② 它根本不是插件，` +
            `③ 它需要额外的系统工具。完整输出在 data/plugin-installs/${job.id}.log`,
        );
      }
      s4.detail = "构建完成";
    }

    /* 5. 就位：构建好了才让它出现在 plugins/ 里 */
    const s5 = begin("place");
    if (fs.existsSync(dest)) throw new Error(`目标目录已存在：${dest}`);
    fs.renameSync(work, dest);
    job.dir = dest;
    s5.detail = dest;
    s5.status = "done";

    /* 6. 校验 */
    const s6 = begin("verify");
    const after = readPackageJson(dest);
    if (after && !isBrokenPackage(after) && declaresCodeEntry(after)) {
      const entry = resolvePluginEntry(dest);
      if (entry.kind === "unbuilt") {
        s6.status = "error";
        throw new Error(`装好了，但入口仍不可用：${entry.detail}${entry.hint ? `。${entry.hint}` : ""}`);
      }
      s6.detail = entry.detail;
    }

    // 重新扫一遍，确认宿主真的看得见（这一步能抓到"目录放对了但清单坏了"）
    const seen = scanPlugins().find((p) => path.resolve(p.dir) === path.resolve(dest));
    if (!seen) {
      /*
       * 走到这里只有两种可能：用户强制装了（force），或者文件确实不认识。
       * 强制装的情况下**不报错**：他要的就是"放进来"，现在东西在里面了，
       * 界面上也会作为「未识别的目录」出现，随时能删。报错只会让他以为没装上。
       */
      if (job.force) {
        s6.status = "skip";
        s6.detail = "装好了，但宿主识别不了它——已列在「未识别的目录」里，可随时删除";
        pushLog(
          job,
          "sys",
          `⚠ 已按你的要求装到 ${dest}，但它没有任何插件标志，宿主不会加载。它现在出现在插件面板的「未识别的目录」里。`,
        );
        job.status = "done";
        return;
      }
      throw new Error(`文件已就位（${dest}），但宿主没把它识别成插件：目录里既没有清单，也看不出任何贡献项`);
    }
    if (seen.errors.length) {
      throw new Error(`宿主识别到了，但清单有错：${seen.errors.join("；")}`);
    }
    job.pluginId = seen.id;
    /*
     * "装上了"和"这是个插件"是两件事。
     *
     * 一个普通 npm 包（比如 is-number）也有 package.json + main，宿主照样能把它
     * 当成代码插件加载——于是安装流程一路绿灯，用户以为装成功了，实际什么都没多。
     * 这里不做失败（有些插件是纯代码、什么都不声明），只把话说明白。
     */
    if (!looksLikePlugin(dest, after)) {
      pushLog(
        job,
        "sys",
        "⚠ 这个目录里没有任何插件声明（remotionStudio 字段 / skills / styles / plugin.ts …）：装是装好了，" +
          "但它很可能提供不了任何东西 —— 检查一下是不是装错了包。",
      );
    }
    /*
     * 新装的插件必须**默认启用**。
     *
     * data/plugins.json 是黑名单（disabled 列表），而它不会随目录删除一起清空：
     * 用户停用过某个插件 → 卸载 → 重新装，id 还在黑名单里，现象就是
     * "装完了、list_plugins 里也看得见，但就是不生效"。安装是明确的用户意图，
     * 这里直接把 id 从黑名单里摘掉。
     */
    if (!seen.enabled) {
      setPluginEnabled(seen.id, true);
      pushLog(job, "sys", `此前被停用过，已重新启用（${seen.id}）`);
    }
    s6.detail = `已识别为「${seen.name}」（${seen.id}）${seen.provides.length ? `，提供 ${seen.provides.join("、")}` : ""}`;
    s6.status = "done";

    // 清缓存：新插件的钩子/工具要立刻可用，不能等下一次重启
    try {
      resetHookCache();
      resetPluginToolCache();
    } catch {
      /* 缓存清理失败不影响安装结果 */
    }

    pushLog(job, "sys", `✓ 安装完成：${seen.name}`);
    job.status = "done";
  } finally {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
      // 空的 .staging 也顺手收掉，plugins/ 里不该留一个来历不明的空目录
      const parent = path.dirname(jobDir);
      if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
    } catch {
      /* 清不掉就留着，下次启动会统一清 */
    }
  }
}

const kindLabel = (k: InstallSourceKind): string =>
  k === "git" ? "git 仓库" : k === "npm" ? "npm 包" : "本地目录";

/** 日志里别让人看 `node .../npm-cli.js install`，那不是用户敲得出来的东西 */
function prettyCommand(cmd: string, args: string[]): string {
  if (cmd === process.execPath && args[0] && /npm-cli\.js$/i.test(args[0])) {
    return `npm ${args.slice(1).join(" ")}`;
  }
  return `${path.basename(cmd)} ${args.join(" ")}`;
}

/** 系统 tar 在哪（没有就返回 null，调用方退回 npm install） */
function tarCommand(): string | null {
  if (process.platform !== "win32") return "tar";
  const sysRoot = process.env.SystemRoot || "C:////Windows";
  const abs = path.join(sysRoot, "System32", "tar.exe");
  return fs.existsSync(abs) ? abs : null;
}

/** 一个目录里有没有"这是本编辑器插件"的信号 */
const PLUGIN_MARKERS = [
  "manifest.json",
  "skills",
  "styles",
  "brief",
  "scenes",
  "templates",
  "elements",
  "scene3d",
  "tools",
  "hooks",
  "plugin.ts",
  "plugin.mts",
  "plugin.mjs",
  "plugin.js",
  "index.ts",
  "index.mjs",
];

function looksLikePlugin(dir: string, pkg: PackageJson | null): boolean {
  if (pkg && !isBrokenPackage(pkg) && pkg.remotionStudio && typeof pkg.remotionStudio === "object") return true;
  if (declaresCodeEntry(pkg)) return true;
  return PLUGIN_MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
}

/* ─────────────────────────── 日志落盘 ─────────────────────────── */

/** 失败时最有用的东西是完整输出，内存里那份会被截断，所以再写一份到 data/ */
function flushLogFile(job: InstallJob): void {
  try {
    fs.mkdirSync(INSTALL_LOG_DIR, { recursive: true });
    const lines = job.logs.map((l) => `[${new Date(l.t).toISOString()}] ${l.stream === "err" ? "E" : l.stream === "sys" ? "·" : " "} ${l.text}`);
    const head = [
      `# 插件安装 ${job.id}`,
      `# 来源 ${job.source}（${kindLabel(job.kind)}）`,
      `# 结果 ${job.status}${job.error ? `：${job.error}` : ""}`,
      `# 目录 ${job.dir ?? "-"}`,
      "",
    ];
    fs.writeFileSync(path.join(INSTALL_LOG_DIR, `${job.id}.log`), [...head, ...lines].join("\n"), "utf8");
  } catch {
    /* 日志写不进去不该让安装失败 */
  }
}

/* ─────────────────────────── 未识别的目录 ─────────────────────────── */

export type OrphanDir = {
  name: string;
  dir: string;
  pathLabel: string;
  scope: PluginScope;
  /** 为什么没被当成插件（一句话，界面上直接显示） */
  reason: string;
  bytes: number;
  /** 太大/文件太多时只做了估算 */
  sizeTruncated: boolean;
};

/**
 * `plugins/` 里"看起来是装进来的、但不是插件"的目录。
 *
 * 为什么需要这个：`scanPlugins()` 对"既没有清单、也认不出任何贡献项"的目录是**静默跳过**的。
 * 这个设计本身没错（用户可能只是在 plugins/ 下放了个临时文件夹），但它有个恶果：
 * 一次失败的安装、或者装错了包，在界面上**完全不存在** —— 用户既不知道它装没装上，
 * 也没地方删它，只能自己去翻文件系统。
 *
 * 所以这里把"有 package.json / manifest.json / node_modules / plugin.ts"的目录单独列出来：
 * 它们是安装的痕迹，必须可见、可删；纯碎文件（一个 README）仍然不打扰用户。
 */
export function scanOrphanDirs(): OrphanDir[] {
  const known = new Set(scanPlugins().map((p) => path.resolve(p.dir)));
  const out: OrphanDir[] = [];

  for (const root of [{ dir: PROJECT_PLUGIN_DIR, scope: "project" as const }]) {
    if (!fs.existsSync(root.dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const dir = path.join(root.dir, e.name);
      if (known.has(path.resolve(dir))) continue;

      const has = (rel: string) => fs.existsSync(path.join(dir, rel));
      const hasPackage = has("package.json");
      const hasManifest = has("manifest.json");
      const hasModules = has("node_modules");
      const hasEntry = has("plugin.ts") || has("plugin.mts") || has("plugin.js") || has("plugin.mjs");
      // 一点安装痕迹都没有的目录不打扰用户（一个 README、一个临时文件夹都很常见）
      if (!hasPackage && !hasManifest && !hasModules && !hasEntry) continue;

      let reason = "没有任何插件标志（没有 remotionStudio 字段、没有 skills/styles 等目录、没有 plugin.ts）";
      if (hasManifest) reason = "manifest.json 存在但解析不出可用的清单";
      if (hasPackage && hasModules) reason = "装进来了，但没有插件标志——多半是装错了包";

      const { bytes, truncated } = dirSize(dir);
      out.push({
        name: e.name,
        dir,
        pathLabel: root.scope === "project" ? `plugins/${e.name}` : `~/.remotion-studio/plugins/${e.name}`,
        scope: root.scope,
        reason,
        bytes,
        sizeTruncated: truncated,
      });
    }
  }
  return out;
}

/** 有上限的目录体积统计：node_modules 动辄几万个文件，不能让一次列表请求卡住 */
function dirSize(dir: string, budget = 6000): { bytes: number; truncated: boolean } {
  let bytes = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    if (seen >= budget) return { bytes, truncated: true };
    const cur = stack.pop()!;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of list) {
      seen += 1;
      if (seen >= budget) return { bytes, truncated: true };
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          bytes += fs.statSync(p).size;
        } catch {
          /* 统计不到就算了 */
        }
      }
    }
  }
  return { bytes, truncated: false };
}

/* ─────────────────────────── 卸载 ─────────────────────────── */

export type RemoveResult = { dir: string; scope: string; /** 挪到哪（purge 模式没有这个值） */ trash?: string; /** true = 已永久删除，不经过回收站 */ purged?: boolean };

/**
 * 卸载插件。两种模式：
 *
 * - **默认：挪到 data/.plugin-trash/，不删文件。**
 *   插件目录里可能有作者自己积累的数据（生成的预设、本地的 API key），
 *   一键删除是不可逆的；"挪走"既让它立刻消失，又能在用户后悔时捡回来。
 * - **purge: true：彻底删除，不可恢复。** 只在用户于确认框里**显式选择**"永久删除"时
 *   才会走到这里（前端弹窗给了两档，回收站是推荐项）——服务端不再做二次确认，
 *   但目录安全检查一条不少。
 */
export function removePlugin(id: string, opts: { purge?: boolean } = {}): RemoveResult {
  const target = scanPlugins().find((p) => p.id === id);
  if (!target) throw new Error(`没有 id 为「${id}」的插件`);

  const dir = path.resolve(target.dir);
  if (!isInside(dir, PROJECT_PLUGIN_DIR)) {
    throw new Error(`拒绝卸载：${dir} 不在插件目录内（这不是这个服务该动的东西）`);
  }

  const result: RemoveResult = { dir, scope: target.scope };

  if (opts.purge) {
    // 彻底删除。isInside 检查已保证只动 plugins/ 里的目录
    fs.rmSync(dir, { recursive: true, force: true });
    result.purged = true;
  } else {
    result.trash = moveToTrash(dir);
  }

  try {
    resetHookCache();
    resetPluginToolCache();
  } catch {
    /* 同上 */
  }

  return result;
}

/** 挪进回收站（不删除）。跨盘时 rename 会 EXDEV，退化成复制 + 删除 */
function moveToTrash(dir: string): string {
  fs.mkdirSync(PLUGIN_TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trash = path.join(PLUGIN_TRASH_DIR, `${path.basename(dir)}-${stamp}`);
  try {
    fs.renameSync(dir, trash);
  } catch {
    fs.cpSync(dir, trash, { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return trash;
}

/**
 * 删掉一个"未识别的目录"。
 *
 * 和 removePlugin 的区别：不要求它能被识别成插件——恰恰相反，这些是**装错了/装坏了**
 * 的残留，必须能给用户一个"从这里消失"的动作。同样只挪不删。
 */
export function removeOrphanDir(dir: string): { dir: string; trash: string } {
  const abs = path.resolve(dir);
  if (!isInside(abs, PROJECT_PLUGIN_DIR)) {
    throw new Error(`拒绝删除：${abs} 不在插件目录内`);
  }
  // 万一它其实是能识别的插件，也别走这条路径（应该用 removePlugin，会清缓存）
  if (scanPlugins().some((p) => path.resolve(p.dir) === abs)) {
    throw new Error("这个目录已经被识别成插件了，用「卸载」而不是这里删");
  }
  const trash = moveToTrash(abs);
  return { dir: abs, trash };
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/* ─────────────────────────── 修复 / 重建 ─────────────────────────── */

/**
 * 对一个**已经在 plugins/ 里**的插件重跑「装依赖 + 构建」。
 *
 * 用途有两个：作者改了源码要重新构建；或者当初是手动拷进来没构建。
 * 与 startInstall 的区别：不下载、不移动目录，直接在原地跑。
 */
export function startRepair(id: string): InstallJob {
  const target = scanPlugins().find((p) => p.id === id);
  if (!target) throw new Error(`没有 id 为「${id}」的插件`);

  const dir = path.resolve(target.dir);
  const pkg = readPackageJson(dir);
  if (!pkg || isBrokenPackage(pkg)) {
    throw new Error("这个插件没有可用的 package.json，没有可构建的东西（纯内容插件不需要构建）");
  }
  if (!pkg.scripts?.build && !Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) {
    throw new Error("这个插件的 package.json 里既没有依赖也没有 build 脚本，没什么可重建的");
  }

  const job: InstallJob = {
    id: newId(),
    source: dir,
    kind: "local",
    targetName: path.basename(dir),
    scopeRoot: path.dirname(dir),
    mode: "repair",
    registry: getRegistry(),
    force: true,
    status: "queued",
    steps: [
      { key: "resolve", label: "定位插件", status: "done", detail: dir },
      { key: "probe", label: "检查是不是插件", status: "skip", detail: "已经在 plugins/ 里，跳过" },
      { key: "fetch", label: "下载", status: "skip", detail: "已在 plugins/ 里，跳过" },
      { key: "deps", label: "安装依赖", status: "pending" },
      { key: "build", label: "执行构建", status: "pending" },
      { key: "place", label: "就位", status: "skip", detail: "原地重建" },
      { key: "verify", label: "确认宿主能识别", status: "pending" },
    ],
    logs: [],
    droppedLogs: 0,
    dir,
    startedAt: Date.now(),
  };

  jobs.set(job.id, job);
  trimJobs();
  if (running) {
    pushLog(job, "sys", "前面还有任务在跑，排队中…");
    queue.push({ id: job.id, mode: "repair" });
  } else {
    void launchRepair(job);
  }
  return job;
}

async function launchRepair(job: InstallJob): Promise<void> {
  running = true;
  job.status = "running" as InstallJobStatus;
  const dir = job.dir!;
  try {
    const pkg = readPackageJson(dir);
    if (!pkg || isBrokenPackage(pkg)) throw new Error("package.json 不可用");

    const s4 = job.steps.find((s) => s.key === "deps")!;
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    if (!deps.length) {
      s4.status = "skip";
      s4.detail = "没有声明依赖";
    } else {
      s4.status = "running";
      const npm = npmInvocation();
      await run(npm.cmd, [...npm.prefix, "install", "--include=dev", "--no-audit", "--no-fund"], {
        cwd: dir,
        job,
        timeout: TIMEOUT.npm,
        step: s4,
      });
      s4.detail = `已安装 ${deps.length} 个依赖`;
    }

    const s5 = job.steps.find((s) => s.key === "build")!;
    const buildScript = typeof pkg.scripts?.build === "string" ? pkg.scripts.build.trim() : "";
    if (!buildScript) {
      s5.status = "skip";
      s5.detail = "没有 build 脚本";
    } else {
      s5.status = "running";
      const npm = npmInvocation();
      await run(npm.cmd, [...npm.prefix, "run", "build"], { cwd: dir, job, timeout: TIMEOUT.build, step: s5 });
      s5.detail = "构建完成";
    }

    const s6 = job.steps.find((s) => s.key === "verify")!;
    s6.status = "running";
    const entry = resolvePluginEntry(dir);
    if (entry.kind === "unbuilt") throw new Error(`重建后入口仍不可用：${entry.detail}${entry.hint ? `。${entry.hint}` : ""}`);
    s6.status = "done";
    s6.detail = entry.detail;
    job.status = "done";
    try {
      resetHookCache();
      resetPluginToolCache();
    } catch {
      /* 忽略 */
    }
    pushLog(job, "sys", "✓ 重建完成");
  } catch (err) {
    job.status = job.status === "canceled" ? "canceled" : "error";
    job.error = err instanceof Error ? err.message : String(err);
    const s = job.steps.find((x) => x.status === "running");
    if (s) s.status = "error";
  } finally {
    job.endedAt = Date.now();
    flushLogFile(job);
    running = false;
    dispatchNext();
  }
}
