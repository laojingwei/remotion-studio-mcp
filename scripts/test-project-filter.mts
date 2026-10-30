/**
 * 项目面板「搜索 + 排序」单测（纯 Node，不需要起服务 / 浏览器）。
 *
 * 这些逻辑的失败方式都是「看不出报错」：
 *  - 空时间（坏工程的 createdAt 是 ""）→ Date.parse 得到 NaN → 排序随机，每次打开顺序都不一样
 *  - 同一秒建的一批工程 → 时间相同 → 没有名称兜底就会抖
 *  - 中文名按 UTF-16 码位排 = 乱序（必须走 localeCompare 中文排序）
 */
import assert from "node:assert/strict";
import type { ProjectSummary } from "../web/apiClient";
import {
  PROJ_SORT_DEFAULT,
  filterProjects,
  nextSort,
  parseQuery,
  readProjSort,
  sortProjects,
  timeOf,
} from "../web/projectFilter";

let passed = 0;
const failures: string[] = [];
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  [fail] ${name}`);
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
  }
};

const p = (
  id: string,
  name: string,
  createdAt = "",
  updatedAt = "",
): ProjectSummary => ({ id, name, rev: 1, scenes: 3, createdAt, updatedAt });

const names = (list: ProjectSummary[]) => list.map((x) => x.name).join(",");

const A = p("p_aaa111", "一万音浪", "2026-10-29T10:00:00.000Z", "2026-10-30T09:00:00.000Z");
const B = p("p_bbb222", "秀场直播（精华版）", "2026-10-28T04:00:00.000Z", "2026-10-30T11:00:00.000Z");
const C = p("p_ccc333", "项目 3", "2026-10-30T01:00:00.000Z", "2026-10-29T02:00:00.000Z");
const BROKEN = p("p_ddd444", "⚠️ p_ddd444（数据损坏）", "", "");
const ALL = [A, B, C, BROKEN];

console.log("projectFilter");

test("默认排序 = 最后修改倒序", () => {
  assert.deepEqual(PROJ_SORT_DEFAULT, { key: "updated", dir: "desc" });
  assert.equal(names(sortProjects(ALL, PROJ_SORT_DEFAULT)), "秀场直播（精华版）,一万音浪,项目 3,⚠️ p_ddd444（数据损坏）");
});

test("按创建时间正序", () => {
  assert.equal(
    names(sortProjects(ALL, { key: "created", dir: "asc" })),
    "⚠️ p_ddd444（数据损坏）,秀场直播（精华版）,一万音浪,项目 3",
  );
});

test("空时间（坏工程）不会让排序变随机：倒序时沉底、正序时在最前", () => {
  const desc = sortProjects(ALL, { key: "updated", dir: "desc" });
  assert.equal(desc[desc.length - 1].id, "p_ddd444");
  const asc = sortProjects(ALL, { key: "updated", dir: "asc" });
  assert.equal(asc[0].id, "p_ddd444");
});

test("时间相同按名称兜底（顺序稳定，不抖动）", () => {
  const t = "2026-10-30T00:00:00.000Z";
  const same = [p("p_1", "C 工程", t, t), p("p_2", "A 工程", t, t), p("p_3", "B 工程", t, t)];
  assert.equal(names(sortProjects(same, { key: "updated", dir: "desc" })), "A 工程,B 工程,C 工程");
  assert.equal(names(sortProjects([...same].reverse(), { key: "updated", dir: "desc" })), "A 工程,B 工程,C 工程");
});

test("名称排序走中文拼音，不是码位序", () => {
  // 码位序：「一」(U+4E00) < 「秀」(U+79C0) < 「项」(U+9879)
  // 拼音序：项(xiang) < 秀(xiu) < 一(yi)
  const got = sortProjects([A, B, C], { key: "name", dir: "asc" }).map((x) => x.name);
  assert.deepEqual(got, ["项目 3", "秀场直播（精华版）", "一万音浪"]);
});

test("搜索：大小写不敏感，且能按 id 找到（报错信息里给的是 id）", () => {
  assert.equal(filterProjects(ALL, "P_BBB222", PROJ_SORT_DEFAULT).length, 1);
  assert.equal(filterProjects(ALL, "p_bbb222", PROJ_SORT_DEFAULT)[0].id, "p_bbb222");
});

test("搜索：多个关键词必须全部命中", () => {
  assert.equal(names(filterProjects(ALL, "秀场 精华", PROJ_SORT_DEFAULT)), "秀场直播（精华版）");
  assert.equal(filterProjects(ALL, "秀场 一万", PROJ_SORT_DEFAULT).length, 0);
});

test("搜索：空串/纯空格返回全部，且不改入参", () => {
  const before = names(ALL);
  assert.equal(filterProjects(ALL, "", PROJ_SORT_DEFAULT).length, ALL.length);
  assert.equal(filterProjects(ALL, "   ", PROJ_SORT_DEFAULT).length, ALL.length);
  assert.equal(names(ALL), before, "入参被改动了");
  assert.deepEqual(parseQuery("  秀场   精华  "), ["秀场", "精华"]);
});

test("搜索 + 排序组合：先筛后排", () => {
  const got = filterProjects(ALL, "工程", { key: "created", dir: "desc" });
  assert.equal(got.length, 0, `不该有匹配：${names(got)}`);
  const hit = filterProjects(ALL, "音浪 一万", { key: "name", dir: "asc" });
  assert.equal(names(hit), "一万音浪");
});

test("点击同一按钮切升降序，换字段用自然方向", () => {
  assert.deepEqual(nextSort({ key: "updated", dir: "desc" }, "updated"), { key: "updated", dir: "asc" });
  assert.deepEqual(nextSort({ key: "updated", dir: "asc" }, "updated"), { key: "updated", dir: "desc" });
  assert.deepEqual(nextSort({ key: "updated", dir: "asc" }, "name"), { key: "name", dir: "asc" });
  assert.deepEqual(nextSort({ key: "name", dir: "asc" }, "created"), { key: "created", dir: "desc" });
});

test("偏好读坏了不影响面板打开", () => {
  assert.deepEqual(readProjSort(null), PROJ_SORT_DEFAULT);
  assert.deepEqual(readProjSort("{ 坏的"), PROJ_SORT_DEFAULT);
  assert.deepEqual(readProjSort('{"key":"size","dir":"asc"}'), PROJ_SORT_DEFAULT);
  assert.deepEqual(readProjSort('{"key":"name","dir":"sideways"}'), PROJ_SORT_DEFAULT);
  assert.deepEqual(readProjSort('{"key":"created","dir":"asc"}'), { key: "created", dir: "asc" });
});

test("列表显示的时间跟着排序字段走", () => {
  assert.equal(timeOf(A, "updated"), A.updatedAt);
  assert.equal(timeOf(A, "created"), A.createdAt);
  // 按名称排时没有"时间维"，退回创建时间，至少不是空的
  assert.equal(timeOf(A, "name"), A.createdAt);
});

console.log(`\n${failures.length ? "FAILED" : "全部通过"}：${passed} 个用例`);
if (failures.length) {
  console.error(`失败：${failures.join("、")}`);
  process.exit(1);
}
