import fs from "node:fs";
import path from "node:path";
import {
  assetNameOf,
  assetUrlOf,
  collectAssetRefs,
  isSafeAssetRel,
} from "../shared/customTemplate";
import type { Project } from "../shared/schema";
import { library } from "./library.service";
import { listProjectIds, PUBLIC_DIR, readProject } from "./store";

/**
 * 素材文件布局（v0.98 起分层，不再是 public/assets 一坨）：
 *
 *   public/assets/library/<文件>            跨工程复用的「我的素材」——删工程不动它
 *   public/assets/projects/<工程id>/<文件>   只属于这个工程——删工程时连带清掉
 *   public/assets/<文件>                   旧版扁平文件（保留兼容，可用 organize 一次性归位）
 *
 * 为什么要分层：项目一多，根目录几百个随机文件名，既分不清归属也没法安全清理。
 * 分层后"删工程 → 删它的目录"就是一条确定规则，而不是靠猜哪些文件没人用。
 *
 * 删除只用 unlinkSync（本机 fs.rmSync 会静默失败，见 store.removeTree）。
 */
const ASSET_DIR = path.join(PUBLIC_DIR, "assets");
export const LIBRARY_REL = "library";
/** 没有归属工程的临时素材（语音试听、连接预检）：随时可被「清理未引用」收掉 */
export const PREVIEW_REL = "_preview";
export const PREVIEW_DIR = path.join(ASSET_DIR, PREVIEW_REL);
export const PROJECTS_REL = "projects";
export const LIBRARY_DIR = path.join(ASSET_DIR, LIBRARY_REL);
export const PROJECTS_DIR = path.join(ASSET_DIR, PROJECTS_REL);

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"]);
const AUDIO_EXT = new Set([".wav", ".mp3", ".ogg", ".m4a", ".aac", ".flac", ".opus"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv"]);

export type AssetKind = "image" | "video" | "audio" | "file";

export const assetKindOfFile = (name: string): AssetKind => {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "file";
};

/* ─────────────────────────── 路径 ─────────────────────────── */

/** 工程素材目录（id 来自路由/工具参数，先挡穿越） */
export function projectAssetDir(projectId: string): string {
  if (!/^[\w-]+$/.test(projectId)) throw new Error("非法的工程 id");
  return path.join(PROJECTS_DIR, projectId);
}

/** 工程内文件名 → 相对 assets/ 的路径 */
export const projectAssetRel = (projectId: string, file: string): string =>
  `${PROJECTS_REL}/${projectId}/${file}`;

/** 相对 assets/ 的路径 → 绝对路径（再过一遍安全校验） */
export function absAssetPath(rel: string): string {
  if (!isSafeAssetRel(rel)) throw new Error(`非法的素材路径：${rel}`);
  return path.join(ASSET_DIR, ...rel.split("/"));
}

/** 相对路径（posix 分隔），用于和 project.json 里的 URL 对齐 */
const relOf = (abs: string): string => path.relative(ASSET_DIR, abs).split(path.sep).join("/");

/** 递归列出 assets/ 下所有文件（绝对路径） */
function walkAssetFiles(dir = ASSET_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkAssetFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/* ─────────────────────────── 引用集合 ─────────────────────────── */

/**
 * 当前被工程或素材库引用的素材（相对 assets/ 的路径集合）。
 *
 * 判定只看两个地方：任何工程的 project.json、素材库索引（原图 + 缩略图）。
 * 用**相对路径**而不是文件名 —— 分层之后不同目录下可以有同名文件，
 * 只比文件名会把别人的文件当成自己的（或者反过来删错）。
 */
export function referencedAssetFiles(): Set<string> {
  const used = new Set<string>();
  for (const id of listProjectIds()) {
    try {
      for (const src of collectAssetRefs(readProject(id))) {
        const rel = assetNameOf(src);
        if (rel) used.add(rel);
      }
    } catch {
      // 单个工程文件坏了不影响整体清理，宁可少删
    }
  }
  for (const item of library.list()) {
    const rel = assetNameOf(item.url);
    if (rel) used.add(rel);
    const thumb = item.thumbUrl ? assetNameOf(item.thumbUrl) : null;
    if (thumb) used.add(thumb);
  }
  return used;
}

/* ─────────────────────────── 清理 ─────────────────────────── */

export type AssetCleanupResult = {
  scanned: number;
  removed: number;
  freedBytes: number;
  dryRun: boolean;
  /** 顺手收掉的空目录（相对 assets/） */
  removedDirs: string[];
};

/** 删掉目录树里的空目录（自底向上；assets 根本身不删） */
function pruneEmptyDirs(dir: string, removed: string[] = []): string[] {
  if (!fs.existsSync(dir)) return removed;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name), removed);
  }
  if (
    fs.readdirSync(dir).length === 0 &&
    path.resolve(dir) !== path.resolve(ASSET_DIR)
  ) {
    try {
      fs.rmdirSync(dir);
      removed.push(relOf(dir));
    } catch {
      /* 删不掉就留着 */
    }
  }
  return removed;
}

/** 清理 public/assets 里所有没被引用的文件（含分层目录；已删工程的目录一并收掉） */
export function cleanupUnusedAssets(opts: { dryRun?: boolean; onlyRels?: string[] } = {}): AssetCleanupResult {
  const dryRun = !!opts.dryRun;
  if (!fs.existsSync(ASSET_DIR)) {
    return { scanned: 0, removed: 0, freedBytes: 0, dryRun, removedDirs: [] };
  }

  const used = referencedAssetFiles();
  const files = opts.onlyRels
    ? opts.onlyRels.map((rel) => absAssetPath(rel)).filter((f) => fs.existsSync(f))
    : walkAssetFiles();
  let removed = 0;
  let freedBytes = 0;

  for (const full of files) {
    const rel = relOf(full);
    // 隐藏文件（.gitkeep / 系统缩略图）一律不碰
    if (rel.split("/").some((seg) => seg.startsWith("."))) continue;
    if (used.has(rel)) continue;
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    if (!dryRun) {
      try {
        fs.unlinkSync(full);
      } catch {
        continue; // 被占用就跳过，下次还会扫到
      }
    }
    removed++;
    freedBytes += size;
  }

  const removedDirs = dryRun ? [] : pruneEmptyDirs(ASSET_DIR);
  return { scanned: files.length, removed, freedBytes, dryRun, removedDirs };
}

/**
 * 删库条目之后回收文件：库里已无该条目，但**工程里可能还引用着**，
 * 所以先重新算一遍引用集合，还在用就不删。
 */
export function reclaimAssetFiles(urls: (string | undefined)[]): number {
  const used = referencedAssetFiles();
  let removed = 0;
  for (const url of urls) {
    if (!url) continue;
    const rel = assetNameOf(url);
    if (!rel || used.has(rel)) continue;
    const full = absAssetPath(rel);
    if (!fs.existsSync(full)) continue;
    try {
      fs.unlinkSync(full);
      removed++;
    } catch {
      /* 被占用就留着 */
    }
  }
  pruneEmptyDirs(ASSET_DIR);
  return removed;
}

/* ─────────────────────────── 工程素材目录 ─────────────────────────── */

export type ProjectAssetEntry = {
  /** 目录内的文件名 */
  name: string;
  /** 可直接写进工程 / 面板缩略图用的站内地址 */
  url: string;
  /** 相对 assets/ 的路径 */
  rel: string;
  kind: AssetKind;
  bytes: number;
  /** mtime（毫秒） */
  at: number;
  /** 是否仍被本工程 project.json 引用（删之前提示用） */
  referenced: boolean;
};

/** 列出某个工程目录里的素材（不递归：工程目录是平的） */
export function listProjectAssets(projectId: string): ProjectAssetEntry[] {
  const dir = projectAssetDir(projectId);
  if (!fs.existsSync(dir)) return [];
  let referenced = new Set<string>();
  try {
    referenced = new Set(
      collectAssetRefs(readProject(projectId))
        .map((src) => assetNameOf(src))
        .filter((x): x is string => !!x),
    );
  } catch {
    // 工程读不出来也能列文件，只是 referenced 全 false
  }
  const out: ProjectAssetEntry[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(dir, entry.name));
    } catch {
      continue;
    }
    const rel = projectAssetRel(projectId, entry.name);
    out.push({
      name: entry.name,
      url: assetUrlOf(rel),
      rel,
      kind: assetKindOfFile(entry.name),
      bytes: st.size,
      at: Math.round(st.mtimeMs),
      referenced: referenced.has(rel),
    });
  }
  // 新的在前：刚上传的立刻能看到
  return out.sort((a, b) => b.at - a.at);
}

/**
 * 删工程时清它的素材目录。
 *
 * **不能整目录 rm**：同一个文件可能被别的工程（duplicate / 模板套用）或素材库还引用着，
 * 所以逐个文件对着引用集合判一遍，被引用的一律留下，最后把空目录收掉。
 * 调用时机必须在工程数据删除**之后** —— 那时它自己已经不在引用集合里了。
 */
export function removeProjectAssets(projectId: string): {
  removed: number;
  kept: number;
  freedBytes: number;
} {
  const dir = projectAssetDir(projectId);
  if (!fs.existsSync(dir)) return { removed: 0, kept: 0, freedBytes: 0 };
  const used = referencedAssetFiles();
  let removed = 0;
  let kept = 0;
  let freedBytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    const rel = projectAssetRel(projectId, entry.name);
    if (used.has(rel)) {
      kept++;
      continue;
    }
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    try {
      fs.unlinkSync(full);
      removed++;
      freedBytes += size;
    } catch {
      kept++;
    }
  }
  pruneEmptyDirs(dir);
  return { removed, kept, freedBytes };
}

/** 上传接口用：写进工程目录，返回可直接写进工程的 URL */
export function writeProjectAsset(projectId: string, fileName: string, buffer: Buffer): string {
  if (!isSafeAssetRel(fileName)) throw new Error(`非法的素材文件名：${fileName}`);
  const dir = projectAssetDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), buffer);
  return assetUrlOf(projectAssetRel(projectId, fileName));
}

/** 把工程里所有 /assets/… 引用按映射改写（导入包 / 套模板时换到新工程目录） */
export function remapAssetUrlsInProject<T>(value: T, mapUrl: (url: string) => string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const rel = assetNameOf(v);
      return rel ? mapUrl(v) : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/* ─────────────────────────── 一次性整理（老文件归位） ─────────────────────────── */

export type OrganizeMove = {
  /** 相对 assets/ 的旧路径（旧版都在根下，没有斜杠） */
  from: string;
  /** 相对 assets/ 的新路径 */
  to: string;
  bytes: number;
  reason: string;
};

export type OrganizeRewrite = {
  projectId: string;
  name: string;
  /** 改写的引用条数 */
  changed: number;
  /** 改写后的工程（调用方负责写盘 + 更新缓存；dryRun 时不要写） */
  project: Project;
};

export type OrganizeResult = {
  dryRun: boolean;
  moves: OrganizeMove[];
  rewrites: OrganizeRewrite[];
  libraryUpdated: { id: string; name: string; changed: number }[];
  skipped: { rel: string; reason: string }[];
  /** dryRun 时不收目录（什么都没搬） */
  freedDirs: string[];
  /** 素材库里指向"文件已不存在"的条目数（这些条目点开就是空图，建议删掉） */
  libraryMissing: number;
};

/**
 * 把旧版散在 `assets/` 根下的文件归位：
 *  - 只被一个工程引用 → 搬进那个工程的目录
 *  - 被多个工程引用 → 搬进 library/（共享）
 *  - 只被素材库引用 → 搬进 library/
 *  - 谁都不引用 → 不动（交给 cleanupUnusedAssets）
 *
 * 搬完同步改写 project.json / 素材库索引里的 URL（否则工程立刻裂图）。
 * `dryRun=true` 只出方案，不动任何文件 —— 这一步**必须**先看。
 */
export function organizeAssets(opts: { dryRun?: boolean; onlyRels?: string[] } = {}): OrganizeResult {
  const dryRun = !!opts.dryRun;
  const result: OrganizeResult = {
    dryRun,
    moves: [],
    rewrites: [],
    libraryUpdated: [],
    skipped: [],
    freedDirs: [],
    libraryMissing: 0,
  };

  const projects = new Map<string, Project>();
  /** rel → 引用它的工程 id */
  const ownersOf = new Map<string, string[]>();
  for (const id of listProjectIds()) {
    try {
      const project = readProject(id);
      projects.set(id, project);
      for (const src of collectAssetRefs(project)) {
        const rel = assetNameOf(src);
        if (!rel) continue;
        const list = ownersOf.get(rel) ?? [];
        if (!list.includes(id)) list.push(id);
        ownersOf.set(rel, list);
      }
    } catch {
      result.skipped.push({ rel: `(工程 ${id})`, reason: "工程文件读不出来，跳过" });
    }
  }
  const libraryByRel = new Map<string, { id: string; name: string }[]>();
  for (const item of library.list()) {
    const rel = assetNameOf(item.url);
    if (rel && !fs.existsSync(absAssetPath(rel))) result.libraryMissing++;
    if (!rel) continue;
    const list = libraryByRel.get(rel) ?? [];
    list.push({ id: item.id, name: item.name });
    libraryByRel.set(rel, list);
  }

  const rootFiles = fs.existsSync(ASSET_DIR)
    ? fs
        .readdirSync(ASSET_DIR, { withFileTypes: true })
        .filter((d) => d.isFile() && !d.name.startsWith("."))
        .map((d) => d.name)
        .filter((name) => !opts.onlyRels || opts.onlyRels.includes(name))
    : [];

  /** 目标已存在的路径：不覆盖，报出来 */
  const taken = new Set(walkAssetFiles().map(relOf));

  for (const fileName of rootFiles) {
    const owners = ownersOf.get(fileName) ?? [];
    const lib = libraryByRel.get(fileName) ?? [];
    let to: string;
    let reason: string;
    if (owners.length === 1) {
      to = projectAssetRel(owners[0], fileName);
      reason = `只被工程「${projects.get(owners[0])?.name ?? owners[0]}」引用`;
    } else if (owners.length > 1) {
      to = `${LIBRARY_REL}/${fileName}`;
      reason = `被 ${owners.length} 个工程共用 → 放共享库`;
    } else if (lib.length) {
      to = `${LIBRARY_REL}/${fileName}`;
      reason = `只被素材库引用（${lib.map((x) => x.name).join("、")}）`;
    } else {
      result.skipped.push({ rel: fileName, reason: "没有任何工程/素材库引用（留给 cleanupUnusedAssets）" });
      continue;
    }

    if (taken.has(to)) {
      result.skipped.push({ rel: fileName, reason: `目标已存在：${to}（不覆盖）` });
      continue;
    }
    const full = path.join(ASSET_DIR, fileName);
    let bytes = 0;
    try {
      bytes = fs.statSync(full).size;
    } catch {
      result.skipped.push({ rel: fileName, reason: "读不到文件大小" });
      continue;
    }

    result.moves.push({ from: fileName, to, bytes, reason });
    taken.add(to);

    if (!dryRun) {
      const dst = absAssetPath(to);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      try {
        fs.renameSync(full, dst);
      } catch {
        fs.copyFileSync(full, dst);
        fs.unlinkSync(full);
      }
    }
  }

  const urlMap = new Map<string, string>();
  for (const mv of result.moves) urlMap.set(assetUrlOf(mv.from), assetUrlOf(mv.to));
  if (!urlMap.size) return result;

  const mapUrl = (url: string) => urlMap.get(url) ?? url;

  for (const [id, project] of projects) {
    const next = remapAssetUrlsInProject(project, mapUrl);
    const changed = countUrlHits(project, urlMap);
    if (!changed) continue;
    next.rev = project.rev + 1;
    next.updatedAt = new Date().toISOString();
    result.rewrites.push({ projectId: id, name: next.name, changed, project: next });
  }

  for (const item of library.list()) {
    const url = mapUrl(item.url);
    const thumbUrl = item.thumbUrl ? mapUrl(item.thumbUrl) : item.thumbUrl;
    const changed = (url !== item.url ? 1 : 0) + (thumbUrl !== item.thumbUrl ? 1 : 0);
    if (!changed) continue;
    result.libraryUpdated.push({ id: item.id, name: item.name, changed });
    if (!dryRun) library.setUrl(item.id, { url, thumbUrl });
  }

  if (!dryRun) result.freedDirs = pruneEmptyDirs(ASSET_DIR);
  return result;
}

/** 统计一份工程里命中了多少个待改写 URL（只用于回执数字） */
function countUrlHits(value: unknown, urlMap: Map<string, string>): number {
  let n = 0;
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (urlMap.has(v)) n++;
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v && typeof v === "object") {
      for (const val of Object.values(v as Record<string, unknown>)) walk(val);
    }
  };
  walk(value);
  return n;
}
