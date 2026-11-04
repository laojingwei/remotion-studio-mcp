/**
 * 工程归档：把工程从**默认列表**里收起来，但一个字节都不删。
 *
 * 为什么需要它：`data/projects/` 下很快会积一堆测试工程（自检建的、模板试建的、
 * 「随手点一下」建的）。它们和真作品混在一起，agent 每次 `list_projects` 都要
 * 把二十来个名字读一遍才找到该改的那个，用户的切换面板也要翻半天。
 *
 * 三个方案里选了这个：
 *  · 直接删 —— 不可逆。用户分不清「测试垃圾」和「上周想留着的那版」。
 *  · 在 project.json 里加字段 —— 归档是**列表元数据**，塞进文档会改 rev、
 *    进历史、让协作者以为内容变了；而且坏工程读不出来时正好是归档最该生效的时候。
 *  · 独立的 data/archive.json（本实现）—— 不动工程文件，读坏了也不影响工程本身。
 *
 * 归档不改变任何能力：仍能打开、渲染、导出、被 agent 显式指定 id 修改，
 * 只是不再出现在默认列表、不再参与「当前工程」的自愈挑选。
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "./paths";
import { writeJsonAtomic } from "./store";

export type ArchiveEntry = { at: string; note?: string };
export type ArchiveMap = Record<string, ArchiveEntry>;

export const ARCHIVE_FILE = path.join(DATA_ROOT, "archive.json");

/**
 * 容错解析：这个文件坏了**不能**让工程列表 500。
 * 它是纯辅助数据，读不出来就当「一个都没归档」（最坏结果是列表变长，不是数据丢失）。
 */
export function parseArchive(raw: string | null | undefined): ArchiveMap {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: ArchiveMap = {};
  for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
    if (!id) continue;
    if (typeof v === "string") {
      // 兼容早期只写时间戳字符串的形态
      if (v.trim()) out[id] = { at: v };
      continue;
    }
    if (!v || typeof v !== "object") continue;
    const at = (v as ArchiveEntry).at;
    if (typeof at !== "string" || !at.trim()) continue;
    const note = (v as ArchiveEntry).note;
    out[id] = typeof note === "string" && note.trim() ? { at, note } : { at };
  }
  return out;
}

export function readArchive(): ArchiveMap {
  try {
    return parseArchive(fs.readFileSync(ARCHIVE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeArchive(map: ArchiveMap): void {
  fs.mkdirSync(path.dirname(ARCHIVE_FILE), { recursive: true });
  writeJsonAtomic(ARCHIVE_FILE, map);
}

export function isArchived(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(readArchive(), id);
}

export function archivedAt(id: string): string | null {
  return readArchive()[id]?.at ?? null;
}

export function archivedCount(): number {
  return Object.keys(readArchive()).length;
}

/** 标记 / 取消标记。返回当前归档项（取消后为 null） */
export function setArchived(id: string, on: boolean, note?: string): ArchiveEntry | null {
  const map = readArchive();
  if (!on) {
    if (!map[id]) return null;
    delete map[id];
    writeArchive(map);
    return null;
  }
  const entry: ArchiveEntry = { at: new Date().toISOString() };
  if (note?.trim()) entry.note = note.trim();
  map[id] = entry;
  writeArchive(map);
  return entry;
}

/** 工程被真删掉时清掉归档标记，别留下指向不存在工程的孤儿项 */
export function forgetArchived(id: string): boolean {
  const map = readArchive();
  if (!map[id]) return false;
  delete map[id];
  writeArchive(map);
  return true;
}

/** 清掉指向「已经不存在的工程」的归档项，返回清掉的数量（导入/手动删目录后的对账） */
export function pruneArchived(existingIds: Iterable<string>): number {
  const map = readArchive();
  const alive = new Set(existingIds);
  let removed = 0;
  for (const id of Object.keys(map)) {
    if (!alive.has(id)) {
      delete map[id];
      removed++;
    }
  }
  if (removed) writeArchive(map);
  return removed;
}
