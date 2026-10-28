import fs from "node:fs";
import path from "node:path";
import { OUT_DIR, listProjectIds, readProject } from "./store";

/**
 * 渲染产物目录（v0.99 起按工程分目录，和素材一个思路）。
 *
 *   out/projects/<工程id>/videos/<名字>_<时间>_<画幅>__<工程id>.mp4
 *   out/projects/<工程id>/stills/<画幅>-<帧>.png
 *   out/projects/<工程id>/subtitles/<工程名>_<时间>.srt
 *
 * 为什么不是 out/videos 一坨：项目一多，成片和几百张关键帧混在一个目录里，
 * 既看不出归属，也没法"删工程就连产物一起删"——只能靠解析文件名猜。
 * 分目录之后，归属由目录决定，文件名只负责给人看。
 *
 * 删除只用 unlinkSync（本机 fs.rmSync 会静默失败，见 store.removeTree）。
 */
export const OUT_PROJECTS_REL = "projects";
export const OUT_PROJECTS_DIR = path.join(OUT_DIR, "projects");

export type OutputKind = "video" | "still" | "subtitle";

const KIND_DIR: Record<OutputKind, string> = {
  video: "videos",
  still: "stills",
  subtitle: "subtitles",
};
const DIR_KIND: Record<string, OutputKind> = {
  videos: "video",
  stills: "still",
  subtitles: "subtitle",
};

/** 旧版扁平目录：v0.99 之后不再写入，只在清理时一并收掉 */
const LEGACY_DIRS = ["videos", "stills", "subtitles"] as const;

const assertProjectId = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error("非法的工程 id");
};

/** 某个工程的产物根目录 */
export function projectOutDir(projectId: string): string {
  assertProjectId(projectId);
  return path.join(OUT_PROJECTS_DIR, projectId);
}

/** 某工程某类产物的目录（不创建） */
export const outDirOf = (projectId: string, kind: OutputKind): string =>
  path.join(projectOutDir(projectId), KIND_DIR[kind]);

/** 某工程某类产物的目录（确保存在），返回绝对路径 */
export function ensureOutDir(projectId: string, kind: OutputKind): string {
  const dir = outDirOf(projectId, kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ─────────────────────────── 列表 ─────────────────────────── */

export type OutputEntry = {
  /** 相对 out/ 的路径，删除时用它（跨工程不可能只靠文件名区分） */
  path: string;
  /** 目录内文件名 */
  name: string;
  url: string;
  kind: OutputKind;
  size: number;
  mtimeMs: number;
  projectId: string;
  /** 工程还在 → 名字；工程已删 → null（孤儿产物，可一键清） */
  projectName: string | null;
};

/** 列出所有工程目录下的产物，新的在前 */
export function listOutputs(): OutputEntry[] {
  if (!fs.existsSync(OUT_PROJECTS_DIR)) return [];
  const alive = new Set(listProjectIds());
  const out: OutputEntry[] = [];

  for (const entry of fs.readdirSync(OUT_PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const projectId = entry.name;
    let projectName: string | null = null;
    if (alive.has(projectId)) {
      try {
        projectName = readProject(projectId).name;
      } catch {
        projectName = null;
      }
    }
    for (const [dir, kind] of Object.entries(DIR_KIND)) {
      const full = path.join(OUT_PROJECTS_DIR, projectId, dir);
      if (!fs.existsSync(full)) continue;
      for (const f of fs.readdirSync(full, { withFileTypes: true })) {
        if (!f.isFile() || f.name.startsWith(".")) continue;
        let st: fs.Stats;
        try {
          st = fs.statSync(path.join(full, f.name));
        } catch {
          continue;
        }
        const rel = `${OUT_PROJECTS_REL}/${projectId}/${dir}/${f.name}`;
        out.push({
          path: rel,
          name: f.name,
          url: `/out/${rel}`,
          kind,
          size: st.size,
          mtimeMs: Math.round(st.mtimeMs),
          projectId,
          projectName,
        });
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/* ─────────────────────────── 删除 ─────────────────────────── */

/** 相对 out/ 的产物路径是否合法：projects/<id>/(videos|stills|subtitles)/<文件> */
export function parseOutputPath(rel: string): { projectId: string; kind: OutputKind; file: string } | null {
  if (!rel || rel.includes("\\") || rel.includes("//")) return null;
  const parts = rel.split("/");
  if (parts.length !== 4) return null;
  const [root, projectId, dir, file] = parts;
  if (root !== OUT_PROJECTS_REL) return null;
  if (!/^[\w-]+$/.test(projectId)) return null;
  const kind = DIR_KIND[dir];
  if (!kind) return null;
  // 文件名**允许中文**（成片名取自工程名，如 "未命名项目_2026-...mp4"），
  // 但只接受"单段、不以点开头、不含分隔符"——真正的兜底是调用方再 resolve 一次验父目录
  if (!file || file.startsWith(".") || file.includes("\\") || file === ".." || file === ".") {
    return null;
  }
  return { projectId, kind, file };
}

/** 删掉空目录（自底向上，只收本工程的目录） */
function pruneProjectDirs(projectId: string): void {
  const root = projectOutDir(projectId);
  for (const dir of Object.values(KIND_DIR)) {
    const full = path.join(root, dir);
    try {
      if (fs.existsSync(full) && fs.readdirSync(full).length === 0) fs.rmdirSync(full);
    } catch {
      /* 删不掉就留着 */
    }
  }
  try {
    if (fs.existsSync(root) && fs.readdirSync(root).length === 0) fs.rmdirSync(root);
  } catch {
    /* 同上 */
  }
}

/** 按相对路径删除产物（只认 projects/<id>/<类>/<文件>，挡穿越） */
export function deleteOutputs(paths: string[]): {
  deleted: number;
  freedBytes: number;
  missing: number;
} {
  let deleted = 0;
  let freedBytes = 0;
  let missing = 0;
  const touched = new Set<string>();

  for (const raw of paths) {
    const parsed = parseOutputPath(String(raw));
    if (!parsed) {
      missing++;
      continue;
    }
    const dir = outDirOf(parsed.projectId, parsed.kind);
    const full = path.resolve(dir, parsed.file);
    // 双保险：最终路径必须仍在工程产物目录内（文件名允许中文，不能只靠字符集判断）
    if (!full.startsWith(path.resolve(dir) + path.sep)) {
      missing++;
      continue;
    }
    if (!fs.existsSync(full)) {
      missing++;
      continue;
    }
    try {
      const size = fs.statSync(full).size;
      fs.unlinkSync(full);
      deleted++;
      freedBytes += size;
      touched.add(parsed.projectId);
    } catch {
      missing++;
    }
  }
  for (const id of touched) pruneProjectDirs(id);
  return { deleted, freedBytes, missing };
}

export type RemoveProjectOutputsResult = {
  removed: number;
  freedBytes: number;
};

/**
 * 删工程时清它的产物目录（**整目录**，不像素材那样判引用）。
 * 理由：成片/关键帧/字幕只属于它自己，不存在"别的工程还在用"的情况；
 * 而且 user 明确要"删工程就连产物一起删" —— 少一个隐形占空间的目录。
 */
export function removeProjectOutputs(projectId: string): RemoveProjectOutputsResult {
  const root = projectOutDir(projectId);
  if (!fs.existsSync(root)) return { removed: 0, freedBytes: 0 };

  let removed = 0;
  let freedBytes = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        try {
          fs.rmdirSync(full);
        } catch {
          /* 留着 */
        }
        continue;
      }
      try {
        freedBytes += fs.statSync(full).size;
        fs.unlinkSync(full);
        removed++;
      } catch {
        /* 被占用就跳过，下次清理还会扫到 */
      }
    }
  };
  walk(root);
  try {
    fs.rmdirSync(root);
  } catch {
    /* 还有文件没删掉就留着 */
  }
  return { removed, freedBytes };
}

/* ─────────────────────────── 保留策略 ─────────────────────────── */

export type CleanupOptions = {
  /** 只清理这个工程；不传表示所有工程 */
  projectId?: string;
  /** 只处理这些工程（测试用，避免一次扫全部） */
  onlyProjectIds?: string[];
  /** 每个工程保留多少个成片，默认 5 */
  keepVideos?: number;
  /** 关键帧/字幕保留多少天，默认 7；0 表示全部清掉 */
  stillsDays?: number;
  /** 连"工程已不存在"的产物目录一起清，默认 true */
  removeOrphans?: boolean;
  /** 只统计不删除 */
  dryRun?: boolean;
};

export type CleanupResult = {
  scanned: number;
  removedVideos: number;
  removedStills: number;
  removedSubtitles: number;
  removedFiles: number;
  /** 工程已删除、目录被整块收掉的数量（按目录里的文件数算进 removedFiles） */
  removedOrphanDirs: number;
  /** 旧版扁平目录里被收掉的文件数 */
  removedLegacy: number;
  freedBytes: number;
  keptVideos: number;
  dryRun: boolean;
};

export type OutputFile = {
  name: string;
  size: number;
  mtimeMs: number;
  projectId: string | null;
};

/**
 * 产物文件名 → 工程 id（**兜底用**）。
 * 新布局靠目录判断归属，这个只用于处理被拷出来/老版本留下的文件：
 * 新命名 `<名字>_<时间>_<画幅>__<projectId>.mp4` 取 `__` 后面那段；
 * 旧命名 `<projectId>-<taskId>-<画幅>.mp4` 取第一段。
 */
export function projectIdOfOutput(filename: string): string | null {
  const suffix = /__([A-Za-z0-9_]+)\.(?:mp4|gif|webm|png|webp|srt|vtt)$/i.exec(filename);
  if (suffix) return suffix[1];
  const legacy = /^([A-Za-z0-9_]+)-/.exec(filename);
  return legacy ? legacy[1] : null;
}

/** 同一工程内保留 mtime 最新的 keep 个，返回需要删除的 */
export function planVideoRemoval(files: OutputFile[], keepPerProject: number): OutputFile[] {
  const keep = Math.max(1, Math.trunc(keepPerProject));
  const byProject = new Map<string, OutputFile[]>();
  for (const f of files) {
    if (!f.projectId) continue; // 名字不认识就当不是产物，绝不乱删
    const list = byProject.get(f.projectId) ?? [];
    list.push(f);
    byProject.set(f.projectId, list);
  }
  const doomed: OutputFile[] = [];
  for (const list of byProject.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    doomed.push(...list.slice(keep));
  }
  return doomed;
}

const listDir = (dir: string): OutputFile[] => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith("."))
    .map((d) => {
      let st: fs.Stats | null = null;
      try {
        st = fs.statSync(path.join(dir, d.name));
      } catch {
        return null;
      }
      return {
        name: d.name,
        size: st.size,
        mtimeMs: st.mtimeMs,
        projectId: projectIdOfOutput(d.name),
      };
    })
    .filter((x): x is OutputFile => !!x);
};

/** 旧版扁平目录（out/videos 等）——只用来收尾 */
const legacyFiles = (): { dir: string; file: OutputFile }[] => {
  const out: { dir: string; file: OutputFile }[] = [];
  for (const dir of LEGACY_DIRS) {
    const full = path.join(OUT_DIR, dir);
    for (const file of listDir(full)) out.push({ dir: full, file });
  }
  return out;
};

export function cleanupOutputs(opts: CleanupOptions = {}): CleanupResult {
  const keepVideos = Math.min(100, Math.max(1, Math.trunc(opts.keepVideos ?? 5)));
  const stillsDays = Math.min(365, Math.max(0, Math.trunc(opts.stillsDays ?? 7)));
  const dryRun = !!opts.dryRun;
  const removeOrphans = opts.removeOrphans !== false;
  const only = opts.projectId;
  const onlyIds = opts.onlyProjectIds?.length ? new Set(opts.onlyProjectIds) : null;

  const result: CleanupResult = {
    scanned: 0,
    removedVideos: 0,
    removedStills: 0,
    removedSubtitles: 0,
    removedFiles: 0,
    removedOrphanDirs: 0,
    removedLegacy: 0,
    freedBytes: 0,
    keptVideos: 0,
    dryRun,
  };

  const alive = new Set(listProjectIds());
  const cutoff = Date.now() - stillsDays * 24 * 60 * 60 * 1000;
  const projectIds = fs.existsSync(OUT_PROJECTS_DIR)
    ? fs
        .readdirSync(OUT_PROJECTS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name)
    : [];

  for (const projectId of projectIds) {
    if (only && projectId !== only) continue;
    if (onlyIds && !onlyIds.has(projectId)) continue;
    if (!/^[\w-]+$/.test(projectId)) continue;

    // 工程没了：整块收掉（成片是"一次几十分钟渲出来的"，但工程都删了，留着也没人找得到）
    if (!alive.has(projectId)) {
      const dir = projectOutDir(projectId);
      const files = Object.values(KIND_DIR).flatMap((d) => listDir(path.join(dir, d)));
      if (!removeOrphans) continue;
      result.scanned += files.length;
      result.removedOrphanDirs++;
      for (const f of files) result.freedBytes += f.size;
      if (!dryRun) {
        const r = removeProjectOutputs(projectId);
        result.removedFiles += r.removed;
      } else {
        result.removedFiles += files.length;
      }
      continue;
    }

    const videos = listDir(outDirOf(projectId, "video"));
    const stills = listDir(outDirOf(projectId, "still"));
    const subs = listDir(outDirOf(projectId, "subtitle"));
    result.scanned += videos.length + stills.length + subs.length;

    const doomedVideos = planVideoRemoval(videos, keepVideos);
    const doomedStills = stills.filter((f) => f.mtimeMs < cutoff);
    const doomedSubs = subs.filter((f) => f.mtimeMs < cutoff);

    const remove = (kind: OutputKind, files: OutputFile[]) => {
      const dir = outDirOf(projectId, kind);
      for (const f of files) {
        if (dryRun) {
          result.freedBytes += f.size;
          continue;
        }
        try {
          fs.unlinkSync(path.join(dir, f.name));
          result.freedBytes += f.size;
          if (kind === "video") result.removedVideos++;
          else if (kind === "still") result.removedStills++;
          else result.removedSubtitles++;
          result.removedFiles++;
        } catch {
          /* 文件可能被渲染进程占用，跳过即可，下次还会扫到 */
        }
      }
      if (dryRun) {
        if (kind === "video") result.removedVideos += files.length;
        else if (kind === "still") result.removedStills += files.length;
        else result.removedSubtitles += files.length;
        result.removedFiles += files.length;
      }
    };
    remove("video", doomedVideos);
    remove("still", doomedStills);
    remove("subtitle", doomedSubs);

    result.keptVideos += videos.length - doomedVideos.length;
    if (!dryRun) pruneProjectDirs(projectId);
  }

  // 旧版扁平目录：不再写入，残留的一次收掉（不按天/不按数量，整块清）
  if (!only && !onlyIds) {
    const legacy = legacyFiles();
    result.scanned += legacy.length;
    for (const { dir, file } of legacy) {
      if (dryRun) {
        result.removedLegacy++;
        result.removedFiles++;
        result.freedBytes += file.size;
        continue;
      }
      try {
        fs.unlinkSync(path.join(dir, file.name));
        result.removedLegacy++;
        result.removedFiles++;
        result.freedBytes += file.size;
      } catch {
        /* 跳过 */
      }
    }
    if (!dryRun) {
      for (const dir of LEGACY_DIRS) {
        const full = path.join(OUT_DIR, dir);
        try {
          if (fs.existsSync(full) && fs.readdirSync(full).length === 0) fs.rmdirSync(full);
        } catch {
          /* 留着 */
        }
      }
    }
  }

  return result;
}
