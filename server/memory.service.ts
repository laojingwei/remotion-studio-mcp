import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";

/**
 * agent 记忆：坑（pitfall）/ 偏好（preference）/ 配方（recipe），按类分文件存。
 *
 * 为什么按类分：片子越做越多，混在一个文件里会越来越长，检索也越来越不准。
 * 作用域：全局（跨工程）+ 工程级（只对当前片子有用）。
 */
export const MEMORY_ROOT = path.join(PROJECT_ROOT, "data", "memory");

export type MemoryKind = "pitfall" | "preference" | "recipe";
export type MemoryScope = "global" | "project";

export type MemoryItem = {
  id: string;
  kind: MemoryKind;
  text: string;
  tags: string[];
  at: string;
};

const FILES: Record<MemoryKind, string> = {
  pitfall: "pitfalls.json",
  preference: "preferences.json",
  recipe: "recipes.json",
};

const KINDS = Object.keys(FILES) as MemoryKind[];

function dirFor(scope: MemoryScope, projectId?: string): string {
  if (scope === "project") {
    if (!projectId) throw new Error("scope=project 时必须传 projectId");
    return path.join(MEMORY_ROOT, "projects", projectId);
  }
  return path.join(MEMORY_ROOT, "global");
}

function fileFor(scope: MemoryScope, kind: MemoryKind, projectId?: string): string {
  return path.join(dirFor(scope, projectId), FILES[kind]);
}

function readKind(file: string): MemoryItem[] {
  if (!fs.existsSync(file)) return [];
  // 解析失败抛错，避免把空数组写回去覆盖记忆
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { items?: MemoryItem[] };
  return Array.isArray(raw.items) ? raw.items : [];
}

function writeKind(file: string, items: MemoryItem[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function newId(): string {
  return `m_${Math.random().toString(36).slice(2, 10)}`;
}

export function remember(input: {
  kind: MemoryKind;
  text: string;
  tags?: string[];
  scope?: MemoryScope;
  projectId?: string;
}): MemoryItem {
  const text = String(input.text ?? "").trim();
  if (!text) throw new Error("记忆内容不能为空");
  const scope = input.scope ?? (input.kind === "recipe" ? "global" : "global");
  const file = fileFor(scope, input.kind, input.projectId);
  const items = readKind(file);
  const item: MemoryItem = {
    id: newId(),
    kind: input.kind,
    text,
    tags: (input.tags ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 8),
    at: new Date().toISOString(),
  };
  // 完全相同的文本不重复记
  if (items.some((x) => x.text === text)) {
    return items.find((x) => x.text === text)!;
  }
  items.unshift(item);
  writeKind(file, items);
  return item;
}

export function recall(input: {
  kind?: MemoryKind;
  query?: string;
  tags?: string[];
  scope?: MemoryScope;
  projectId?: string;
  limit?: number;
}): MemoryItem[] {
  const scope = input.scope ?? "global";
  const kinds = input.kind ? [input.kind] : KINDS;
  const q = (input.query ?? "").trim().toLowerCase();
  const tags = (input.tags ?? []).map((t) => t.toLowerCase());
  const out: MemoryItem[] = [];
  for (const kind of kinds) {
    const file = fileFor(scope, kind, input.projectId);
    const items = readKind(file);
    for (const it of items) {
      const text = it.text.toLowerCase();
      const hay = `${text} ${it.tags.join(" ").toLowerCase()}`;
      const okQuery = !q || text.includes(q) || it.tags.some((t) => t.toLowerCase().includes(q));
      const okTags = !tags.length || tags.every((t) => hay.includes(t));
      if (okQuery && okTags) out.push(it);
    }
  }
  out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return out.slice(0, Math.max(1, Math.min(50, input.limit ?? 20)));
}

/** 工程级记忆也查（recall 时合并全局 + 工程） */
export function recallAll(input: {
  kind?: MemoryKind;
  query?: string;
  tags?: string[];
  projectId?: string;
  limit?: number;
}): MemoryItem[] {
  const limit = Math.max(1, Math.min(50, input.limit ?? 20));
  const base = recall({ ...input, scope: "global", limit });
  if (!input.projectId) return base;
  try {
    const local = recall({ ...input, scope: "project", projectId: input.projectId, limit });
    const merged = [...local, ...base];
    merged.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
    return merged.slice(0, limit);
  } catch {
    return base;
  }
}
