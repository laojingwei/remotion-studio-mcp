/**
 * 项目切换面板的「搜索 + 排序」——纯函数，不碰 React。
 *
 * 为什么要单独抽出来：这段逻辑有三处容易出错，而且都是**看不出报错**的那种：
 *  1. 时间字段可能是空串（坏工程 `projectFileTimes` 返回 ""），`Date.parse("")` 是 NaN，
 *     直接比较 NaN 会让 `sort` 的顺序变得随机（每次打开面板顺序都不一样）。
 *  2. 时间相同（批量导入、同一秒建的一批）时必须用名称兜底，否则列表顺序抖。
 *  3. 中文名要按拼音排（`localeCompare(..., "zh-Hans-CN")`），按 UTF-16 码位排是乱序。
 * 这三条都能被单测锁住，所以逻辑不写在组件里。
 */
import type { ProjectSummary } from "./apiClient";

/** 排序字段：创建时间 / 最后修改时间 / 名称（面板上三个图标按钮） */
export type ProjSortKey = "created" | "updated" | "name";
export type ProjSort = { key: ProjSortKey; dir: "asc" | "desc" };

/** 默认按「最后修改」倒序：找工程时最常见的诉求是「我刚才改的那个」 */
export const PROJ_SORT_DEFAULT: ProjSort = { key: "updated", dir: "desc" };

const SORT_KEYS: ProjSortKey[] = ["created", "updated", "name"];

/**
 * 把 localStorage 里的字符串解析成排序设置。
 * 传 null / 坏 JSON / 不认识的字段一律回默认值——面板不该因为一条偏好读坏了就打不开。
 */
export function readProjSort(raw: string | null): ProjSort {
  if (!raw) return PROJ_SORT_DEFAULT;
  try {
    const v = JSON.parse(raw) as Partial<ProjSort> | null;
    if (!v || typeof v !== "object") return PROJ_SORT_DEFAULT;
    if (!SORT_KEYS.includes(v.key as ProjSortKey)) return PROJ_SORT_DEFAULT;
    if (v.dir !== "asc" && v.dir !== "desc") return PROJ_SORT_DEFAULT;
    return { key: v.key as ProjSortKey, dir: v.dir };
  } catch {
    return PROJ_SORT_DEFAULT;
  }
}

/** 点击同一个按钮 = 切升降序；换字段 = 用该字段的自然方向（名称升序、时间倒序） */
export function nextSort(cur: ProjSort, key: ProjSortKey): ProjSort {
  if (cur.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "name" ? "asc" : "desc" };
}

/**
 * 搜索词拆词：空格分隔，**全部命中**才算匹配。
 * 这样「秀场 精华」能命中「秀场直播01·平台生态与变现逻辑（精华版）」，
 * 而单个关键词又不用记全名。
 */
export function parseQuery(raw: string): string[] {
  return raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(p: ProjectSummary, tokens: string[]): boolean {
  if (!tokens.length) return true;
  // id 也参与匹配：报错信息里给的是 id，直接粘进来就能找到那个工程
  const hay = `${p.name} ${p.id}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/** 空串 / 非法值当 0：坏工程会沉到倒序列表最底下，而不是插在中间 */
function timeValue(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** 列表右侧显示哪个时间，跟当前排序字段保持一致（不然按"修改"排却显示创建时间，看着像乱序） */
export function timeOf(p: ProjectSummary, key: ProjSortKey): string | undefined {
  return key === "updated" ? p.updatedAt : p.createdAt;
}

const byName = (a: ProjectSummary, b: ProjectSummary) => a.name.localeCompare(b.name, "zh-Hans-CN");

export function sortProjects(list: ProjectSummary[], sort: ProjSort): ProjectSummary[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    if (sort.key === "name") return dir * byName(a, b);
    const av = timeValue(timeOf(a, sort.key));
    const bv = timeValue(timeOf(b, sort.key));
    if (av !== bv) return dir * (av - bv);
    return byName(a, b);
  });
}

/** 面板列表的唯一入口：先筛后排，返回新数组（不改入参） */
export function filterProjects(
  list: ProjectSummary[],
  rawQuery: string,
  sort: ProjSort,
): ProjectSummary[] {
  const tokens = parseQuery(rawQuery);
  return sortProjects(list.filter((p) => matches(p, tokens)), sort);
}
