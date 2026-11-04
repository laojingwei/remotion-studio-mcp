/**
 * `list_projects` 回执文案的单测。
 *
 * 这段文字里有三套数字必须同时对上：列出来的行数、头部的「共 N 个」、末尾的「已归档 M 个」。
 * 之前 includeArchived:true 时头部只算在用的（「共 6 个在用工程」却列了 22 行），
 * 靠肉眼 review 是看不出来的——所以把它当数据来测。
 */
import assert from "node:assert/strict";
import { formatProjectList, type ProjectRow } from "../server/projects-text";

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}：${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ✗ ${name}`);
  }
}

const rows: ProjectRow[] = [
  { id: "p_a", name: "在做的片子", rev: 12, scenes: 5 },
  { id: "p_b", name: "旧测试 A", rev: 3, scenes: 2, archivedAt: "2026-11-01T10:00:00.000Z" },
  { id: "p_c", name: "旧测试 B", rev: 1, scenes: 1, archivedAt: "2026-11-02T10:00:00.000Z" },
];

const lines = (s: string) => s.split(String.fromCharCode(10));

test("默认：只列在用的，头部数字 = 列出条数", () => {
  const out = formatProjectList({ projects: rows, currentId: "p_a" });
  assert.match(out, /共 1 个在用工程/);
  assert.ok(out.includes("★ 在做的片子"));
  // 默认不列归档项的行本身（末尾的「已归档 N 个」会点名几个，那是提示不是列表）
  assert.ok(!out.includes("（id=p_b"), out);
  // 归档的没列出来，所以必须说明有几个、怎么拿回来
  assert.match(out, /已归档 2 个（不在上面，文件都还在）/);
  assert.match(out, /includeArchived:true/);
});

test("includeArchived：头部是总数并说清拆分，且不再说「不在上面」", () => {
  const out = formatProjectList({ projects: rows, currentId: "p_a", includeArchived: true });
  assert.match(out, /共 3 个工程（1 个在用 \+ 2 个已归档/);
  assert.ok(out.includes("旧测试 A"));
  assert.ok(out.includes("旧测试 B"));
  // 「不在上面」在列出归档项时就是假话，必须换掉
  assert.ok(!/不在上面/.test(out), out);
  assert.match(out, /上面带「已归档」的 2 个/);
});

test("列出的行数 == 头部声明的总数（防「数字对不上」复现）", () => {
  const out = formatProjectList({ projects: rows, includeArchived: true });
  const listed = lines(out).filter((l) => /^\s*[★ ]\s.*（id=p_/.test(l)).length;
  assert.equal(listed, 3);
  assert.match(out, /共 3 个工程/);
});

test("已归档的行带日期，日期只到天（不把 ISO 一长串糊上去）", () => {
  const out = formatProjectList({ projects: rows, includeArchived: true });
  assert.ok(out.includes("· 已归档 2026-11-01"));
  assert.ok(!out.includes("T10:00:00"));
});

test("全归档：不说「没有工程」，而是说「0 个在用」并给出恢复办法", () => {
  const allArchived = rows.map((r) => ({ ...r, archivedAt: r.archivedAt ?? "2026-11-03T00:00:00.000Z" }));
  const out = formatProjectList({ projects: allArchived, currentId: "p_a" });
  assert.match(out, /在用的工程是 0 个/);
  assert.ok(!/还没有任何工程/.test(out));
  assert.match(out, /archive_project/);
  // 全归档时列表要列出来，否则用户一个工程名都看不到
  assert.ok(out.includes("在做的片子"));
});

test("当前工程被归档：默认要提醒，展开时不再提醒（列出来就在眼前）", () => {
  const archivedCurrent: ProjectRow[] = [
    { id: "p_a", name: "在做的片子", rev: 12, scenes: 5, archivedAt: "2026-11-01T10:00:00.000Z" },
    { id: "p_b", name: "别的", rev: 3, scenes: 2 },
  ];
  const hidden = formatProjectList({ projects: archivedCurrent, currentId: "p_a" });
  assert.match(hidden, /当前默认工程 p_a 已归档/);
  const expanded = formatProjectList({ projects: archivedCurrent, currentId: "p_a", includeArchived: true });
  assert.ok(!/已归档：不在上面的/.test(expanded), expanded);
  assert.ok(expanded.includes("★ 在做的片子"));
});

test("对账与数据目录：有才出现，没有就不占版面", () => {
  const plain = formatProjectList({ projects: rows, currentId: "p_a" });
  assert.ok(!plain.includes("数据目录"), plain);
  assert.ok(!plain.includes("对账提醒"), plain);

  const withOrphans = formatProjectList({
    projects: rows,
    currentId: "p_a",
    dataDir: "D:/dsh/proj/data/projects",
    serverUrl: "http://127.0.0.1:4380",
    orphanIds: ["p_zombie1", "p_zombie2"],
  });
  assert.match(withOrphans, /数据目录：D:\/dsh\/proj\/data\/projects/);
  assert.match(withOrphans, /本次连的是 http:\/\/127\.0\.0\.1:4380/);
  assert.match(withOrphans, /out\/ 里有 2 个工程不在当前数据目录/);
});

test("单行格式稳定：★ 占位符不破坏对齐（未选中的行前也是 2 个字符）", () => {
  const out = formatProjectList({ projects: rows, currentId: "p_a" });
  const row = lines(out).find((l) => l.includes("（id=p_a"));
  assert.ok(row);
  assert.match(row as string, /^★ 在做的片子（id=p_a，5 场景，rev=12）$/);
});

console.log(`\n${failures.length ? "FAILED" : "全部通过"}：${passed} 个用例`);
if (failures.length) {
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
