import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./root";

/**
 * 工作空间：把 `data/`、`public/`、`out/` 三块"会长大的"目录搬到用户指定的磁盘。
 *
 * 为什么用**链接**而不是"配置里改路径"：
 *  - 这三条路径在 render / bundle / 静态路由 / 历史快照里到处硬引用，改成动态路径要动几十处，
 *    而且改完还要重启服务（内存里的常量不会变）。
 *  - 搬完在原位置留一个目录链接（Windows junction，不需要管理员权限），代码一行不用改、
 *    服务也不用重启，用户看到的还是 `data/`、`out/`，只是真实字节落在别的盘。
 *
 * 迁移动作是**两阶段**的，避免搬到一半把数据弄丢：
 *  1. 全部复制到目标目录，逐个核对"文件数 + 总字节数"；
 *  2. 核对全过了才删原目录、建链接。任何一步核对不过 → 原地不动，报错说明差多少。
 *
 * 只用 unlink/rmdir 删（本机 `fs.rmSync(recursive)` 有静默不删的坑，见 store.removeTree）。
 */
export type WorkspaceDirName = "data" | "public" | "out";

const DIRS: WorkspaceDirName[] = ["data", "public", "out"];
const CONFIG_FILE = path.join(ROOT, "workspace.json");

export type DirStatus = {
  name: WorkspaceDirName;
  /** 代码实际使用的路径（仓库内挂载点） */
  path: string;
  /** 真实落盘位置（解析链接后） */
  real: string;
  /** 是否为指向别处的链接（= 已迁走） */
  linked: boolean;
  files: number;
  bytes: number;
  /** 异常说明（链接目标不存在等） */
  problem?: string;
};

export type WorkspaceStatus = {
  /** 工程根目录 */
  root: string;
  /** 自定义工作空间；null = 三块都在工程目录里 */
  workspaceDir: string | null;
  dirs: DirStatus[];
  totalBytes: number;
  /** 工程目录所在盘剩余 */
  rootFree: number;
  /** 工作空间所在盘剩余（未迁移时等于 rootFree） */
  workspaceFree: number;
};

export type RelocatePlanItem = {
  name: WorkspaceDirName;
  from: string;
  to: string;
  files: number;
  bytes: number;
  /** 已经在目标位置，无需搬 */
  skip: boolean;
  skipReason?: string;
};

export type RelocateResult = {
  dryRun: boolean;
  target: string;
  plan: RelocatePlanItem[];
  moved: { name: WorkspaceDirName; files: number; bytes: number }[];
  /** 目标盘剩余（迁移前 / 迁移后估算） */
  targetFreeBefore: number;
  targetFreeAfter: number;
  warnings: string[];
};

type Config = {
  /** 自定义工作空间根目录（null = 默认，就在工程目录里） */
  workspaceDir: string | null;
  updatedAt?: string;
};

export const readConfig = (): Config => {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Partial<Config>;
    return { workspaceDir: typeof raw.workspaceDir === "string" ? raw.workspaceDir : null };
  } catch {
    return { workspaceDir: null };
  }
};

const writeConfig = (cfg: Config) => {
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ ...cfg, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
};

/* ─────────────────────────── 文件系统小工具 ─────────────────────────── */

const isLink = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * 建目录链接的类型。
 * Windows 只有 junction 不需要管理员权限；macOS/Linux 用 "dir"（普通目录符号链接），
 * 传 "junction" 在 POSIX 上会直接抛 EINVAL —— 这是「迁移工作空间」在 mac 上失败的原因。
 */
const LINK_TYPE: "junction" | "dir" = process.platform === "win32" ? "junction" : "dir";

/** 目录里的文件数与总字节（不跟随链接；本身就是链接时先解析） */
export function dirStats(dir: string): { files: number; bytes: number } {
  if (!fs.existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files++;
        } catch {
          /* 读不到就跳过 */
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** 目标盘剩余空间（拿不到就返回 -1） */
export function freeSpace(dir: string): number {
  try {
    let probe = path.resolve(dir);
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return -1;
      probe = parent;
    }
    const st = fs.statfsSync(probe);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return -1;
  }
}

const statOf = (p: string): DirStatus => {
  const linked = isLink(p);
  const exists = fs.existsSync(p);
  const real = exists ? fs.realpathSync(p) : p;
  const { files, bytes } = exists ? dirStats(p) : { files: 0, bytes: 0 };
  const status: DirStatus = { name: "data", path: p, real, linked, files, bytes };
  if (linked && !exists) status.problem = "链接指向的目录不存在（目标盘被拔掉或目录被删）";
  return status;
};

/* ─────────────────────────── 状态 ─────────────────────────── */

export function getWorkspaceStatus(): WorkspaceStatus {
  const cfg = readConfig();
  const dirs = DIRS.map((name) => {
    const s = statOf(path.join(ROOT, name));
    s.name = name;
    return s;
  });
  const totalBytes = dirs.reduce((a, d) => a + d.bytes, 0);
  const rootFree = freeSpace(ROOT);
  const wsDir = cfg.workspaceDir;
  return {
    root: ROOT,
    workspaceDir: wsDir,
    dirs,
    totalBytes,
    rootFree,
    workspaceFree: wsDir ? freeSpace(wsDir) : rootFree,
  };
}

/* ─────────────────────────── 迁移 ─────────────────────────── */

/** 递归复制并计数（源→目的；目的必须不存在或为空） */
function copyTree(from: string, to: string, out = { files: 0, bytes: 0 }) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst, out);
    else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
      out.files++;
      out.bytes += fs.statSync(src).size;
    }
  }
  return out;
}

/** 递归删目录（unlink + rmdir，删完由调用方复查） */
function removeTree(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeTree(full);
      fs.rmdirSync(full);
    } else {
      fs.unlinkSync(full);
    }
  }
}

const isSubPath = (child: string, parent: string) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

const dirIsEmpty = (dir: string) => {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
};

/**
 * 把 data/public/out 迁到 `targetDir`（或迁回工程目录）。
 *
 * `dryRun` 只出方案：搬多少文件、占多少空间、目标盘够不够 —— **先看方案再动手**。
 */
export function relocateWorkspace(
  targetDir: string,
  opts: { dryRun?: boolean } = {},
): RelocateResult {
  const dryRun = !!opts.dryRun;
  const raw = String(targetDir ?? "").trim();
  if (!raw) throw new Error("要给一个目标目录，比如 D:/remotion-workspace");
  if (!path.isAbsolute(raw)) throw new Error(`目标目录要给绝对路径：${raw}`);
  const target = path.resolve(raw);

  // 目标不能是工程目录本身（那是"搬回原位"，走 reset），也不能在工程目录里面
  // （否则 data 里套 data，越搬越大）
  if (isSubPath(target, ROOT)) {
    throw new Error(`目标目录不能放在工程目录里面：${target}`);
  }
  if (target === path.resolve(ROOT)) {
    throw new Error("目标就是工程目录，请用「搬回工程目录」");
  }

  const warnings: string[] = [];
  const plan: RelocatePlanItem[] = [];

  if (!fs.existsSync(target)) {
    if (!dryRun) fs.mkdirSync(target, { recursive: true });
    warnings.push(`目标目录不存在，${dryRun ? "实际执行时会自动创建" : "已自动创建"}：${target}`);
  } else if (!fs.statSync(target).isDirectory()) {
    throw new Error(`目标不是目录：${target}`);
  }

  // 可写探测（dryRun 也探，免得"看着能搬，点了才报错"）。
  // dryRun 不建目录，所以在"目录还不存在"时探它的父目录——否则会误报不可写。
  const probeBase = fs.existsSync(target) ? target : path.dirname(target);
  try {
    const probe = path.join(probeBase, `.write-test-${Date.now()}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
  } catch {
    throw new Error(
      probeBase === target ? `目标目录不可写：${target}` : `目标目录的上级不可写：${probeBase}`,
    );
  }

  for (const name of DIRS) {
    const from = path.join(ROOT, name);
    const to = path.join(target, name);
    const exists = fs.existsSync(from);
    const linked = isLink(from);
    const real = exists ? fs.realpathSync(from) : from;
    const { files, bytes } = exists ? dirStats(from) : { files: 0, bytes: 0 };

    if (linked && path.resolve(real) === path.resolve(to)) {
      plan.push({ name, from, to, files, bytes, skip: true, skipReason: "已经指向目标目录" });
      continue;
    }
    if (fs.existsSync(to) && !dirIsEmpty(to)) {
      throw new Error(
        `目标目录里已经有 ${name}/ 且不是空的（${to}）。换个目录，或先把它清空/改名再迁移。`,
      );
    }
    plan.push({ name, from, to, files, bytes, skip: false });
  }

  const need = plan.filter((p) => !p.skip).reduce((a, p) => a + p.bytes, 0);
  const targetFreeBefore = freeSpace(target);
  const result: RelocateResult = {
    dryRun,
    target,
    plan,
    moved: [],
    targetFreeBefore,
    targetFreeAfter: targetFreeBefore < 0 ? -1 : targetFreeBefore - need,
    warnings,
  };
  if (targetFreeBefore >= 0 && need > 0 && targetFreeBefore < need * 1.05) {
    throw new Error(
      `目标盘空间不够：需要约 ${(need / 1024 ** 3).toFixed(2)} GB（含 5% 余量），` +
        `只剩 ${(targetFreeBefore / 1024 ** 3).toFixed(2)} GB`,
    );
  }
  if (!plan.some((p) => !p.skip)) {
    if (!dryRun) writeConfig({ workspaceDir: target });
    return result;
  }
  if (dryRun) return result;

  /* 阶段一：全部复制 + 逐个核对（这一步失败只需清掉目标里的副本，源目录完好） */
  const staged: RelocatePlanItem[] = [];
  for (const item of plan) {
    if (item.skip) continue;
    const copied = copyTree(item.from, item.to);
    if (copied.files !== item.files || copied.bytes !== item.bytes) {
      throw new Error(
        `复制 ${item.name}/ 核对不上：源 ${item.files} 个 / ${item.bytes} 字节，` +
          `目标 ${copied.files} 个 / ${copied.bytes} 字节。已停止，源目录没有动。`,
      );
    }
    staged.push(item);
  }

  /* 阶段二：删原目录 → 在原位置建链接 */
  for (const item of staged) {
    if (isLink(item.from)) {
      fs.unlinkSync(item.from);
    } else {
      removeTree(item.from);
      fs.rmdirSync(item.from);
    }
    fs.symlinkSync(item.to, item.from, LINK_TYPE);
    if (!fs.existsSync(item.from)) {
      throw new Error(`建链接失败：${item.from} → ${item.to}（数据已复制到目标，可用它恢复）`);
    }
    result.moved.push({ name: item.name, files: item.files, bytes: item.bytes });
  }

  writeConfig({ workspaceDir: target });
  return result;
}

/** 把三块搬回工程目录（链接去掉、文件复制回来） */
export function resetWorkspace(opts: { dryRun?: boolean } = {}): RelocateResult {
  const dryRun = !!opts.dryRun;
  const plan: RelocatePlanItem[] = [];
  for (const name of DIRS) {
    const from = path.join(ROOT, name);
    const linked = isLink(from);
    if (!linked) continue;
    const real = fs.realpathSync(from);
    const { files, bytes } = dirStats(from);
    plan.push({ name, from: real, to: from, files, bytes, skip: false });
  }
  const result: RelocateResult = {
    dryRun,
    target: ROOT,
    plan,
    moved: [],
    targetFreeBefore: freeSpace(ROOT),
    targetFreeAfter: freeSpace(ROOT),
    warnings: [],
  };
  if (!plan.length || dryRun) return result;

  // 复制回工程目录（此时 from 是链接，to 位置是链接本身，先复制到临时位置再换）
  const staged: { item: RelocatePlanItem; tmp: string }[] = [];
  for (const item of plan) {
    const tmp = `${item.to}.restore-${Date.now().toString(36)}`;
    const copied = copyTree(item.from, tmp);
    if (copied.files !== item.files || copied.bytes !== item.bytes) {
      throw new Error(`复制回 ${item.name}/ 核对不上，已停止（链接未动）。`);
    }
    staged.push({ item, tmp });
  }
  for (const { item, tmp } of staged) {
    fs.unlinkSync(item.to); // 去掉链接
    fs.renameSync(tmp, item.to);
    result.moved.push({ name: item.name, files: item.files, bytes: item.bytes });
  }
  writeConfig({ workspaceDir: null });
  return result;
}

/**
 * 启动自愈：链接被删/断开时重建。
 * 目标盘不在（拔了移动硬盘）→ 不重建，返回要提醒用户的事项。
 */
export function repairWorkspace(): string[] {
  const warnings: string[] = [];
  const cfg = readConfig();
  if (!cfg.workspaceDir) return warnings;
  if (!fs.existsSync(cfg.workspaceDir)) {
    warnings.push(
      `工作空间目录不存在：${cfg.workspaceDir}（data/public/out 可能已断开，插回磁盘或重新指定）`,
    );
    return warnings;
  }
  for (const name of DIRS) {
    const mount = path.join(ROOT, name);
    const to = path.join(cfg.workspaceDir!, name);
    if (!fs.existsSync(to)) continue;
    const exists = fs.existsSync(mount);
    const linked = isLink(mount);
    if (exists && !linked) continue; // 已经是实体目录，不动它
    if (linked) {
      if (path.resolve(fs.realpathSync(mount)) === path.resolve(to)) continue;
      fs.unlinkSync(mount);
    }
    try {
      fs.symlinkSync(to, mount, LINK_TYPE);
      warnings.push(`已重建链接：${name}/ → ${to}`);
    } catch (err) {
      warnings.push(`重建链接失败：${name}/（${err instanceof Error ? err.message : err}）`);
    }
  }
  return warnings;
}

/* ─────────────────────────── 目录浏览（给「浏览…」按钮用） ─────────────────────────── */

export type DirEntry = { name: string; path: string };
export type DirListing = {
  /** 当前列的是哪个目录；null = 盘符列表 */
  path: string | null;
  parent: string | null;
  entries: DirEntry[];
  /** 当前目录（或该盘）剩余空间 */
  free: number;
};

/** 本机盘符（Windows 才有；其它系统返回空数组，退回"从工程目录开始"） */
function listDrives(): DirEntry[] {
  if (process.platform !== "win32") return [];
  const out: DirEntry[] = [];
  for (let c = 65; c <= 90; c++) {
    const p = `${String.fromCharCode(c)}:\\`;
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) out.push({ name: p, path: p });
    } catch {
      /* 光驱/U盘拔了之类，跳过 */
    }
  }
  return out;
}

/**
 * 列目录（只读）。
 *
 * 界面上的「浏览…」不用系统原生对话框（浏览器拿不到绝对路径，服务端弹窗又得 spawn 外部程序），
 * 而是自己走这个接口一层层点进去 —— 纯 Node、跨平台、还能顺手把每个盘的剩余空间带出来。
 */
export function listDirs(target?: string): DirListing {
  const raw = String(target ?? "").trim();
  if (!raw) {
    const drives = listDrives();
    return {
      path: null,
      parent: null,
      entries: drives.length ? drives : [{ name: "工程目录", path: ROOT }],
      free: drives.length ? freeSpace(drives[0].path) : freeSpace(ROOT),
    };
  }
  const dir = path.resolve(raw);
  if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`不是目录：${dir}`);

  const entries: DirEntry[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    entries.push({ name: entry.name, path: path.join(dir, entry.name) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    entries,
    free: freeSpace(dir),
  };
}
