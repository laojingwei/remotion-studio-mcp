/**
 * 并发写语义回归：硬冲突（MCP/脚本）与软冲突（编辑器）。
 *
 *   npx tsx scripts/test-conflict.mts
 *
 * 两种调用方要的是不同语义：
 *  - agent / 脚本传 expectedRev 且不带 softRev：对不上就整批拒绝（409），让它重读文档再改；
 *  - 编辑器带 expectedRev + softRev：照常合并（ops 是语义化的），但回执里必须说清楚
 *    "这笔基于旧版本"，否则用户会以为自己的修改被 agent 静默吃掉。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { projects } from "../server/project.service";
import { createSeedProject, type Op } from "../shared/ops";
import { DATA_DIR, writeProject } from "../server/store";

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

const id = `probe_conflict_${Date.now().toString(36)}`;
try {
  writeProject(createSeedProject(id));
  const base = projects.get(id);
  const rename = (name: string): Op => ({ op: "update_project", patch: { name } } as Op);

  test("硬冲突：expectedRev 对不上直接 409，且不落库", () => {
    const err = (() => {
      try {
        projects.apply(id, [rename("硬冲突")], { expectedRev: base.rev - 1 });
        return null;
      } catch (e) {
        return e as Error & { status?: number };
      }
    })();
    assert.ok(err, "应当抛错");
    assert.match(err!.message, /版本冲突/);
    assert.equal(err!.status, 409);
    assert.equal(projects.get(id).name, base.name, "被拒绝的批不该改动内容");
  });

  test("软冲突：照常合并，并在回执首行说明基于旧版本", () => {
    const r = projects.apply(id, [rename("软冲突已合并")], {
      expectedRev: base.rev - 1,
      softRevCheck: true,
    });
    assert.deepEqual(r.revMismatch, { expected: base.rev - 1, actual: base.rev });
    assert.match(r.summary[0] ?? "", /并发修改/);
    assert.equal(r.project.name, "软冲突已合并", "内容仍应写入");
  });

  test("rev 正确时没有 revMismatch（不会误报）", () => {
    const cur = projects.get(id);
    const r = projects.apply(id, [rename("正常改名")], {
      expectedRev: cur.rev,
      softRevCheck: true,
    });
    assert.equal(r.revMismatch, undefined);
    assert.equal(r.project.name, "正常改名");
  });

  test("软冲突不影响 rev 递增（仍然 +1）", () => {
    const cur = projects.get(id);
    const r = projects.apply(id, [rename("再次合并")], {
      expectedRev: cur.rev - 5,
      softRevCheck: true,
    });
    assert.equal(r.project.rev, cur.rev + 1);
  });
} finally {
  try {
    fs.rmSync(path.join(DATA_DIR, id), { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log("");
if (failures.length) {
  console.error(`\x1b[31m${failures.length} 个用例失败\x1b[0m（通过 ${passed} 个）`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\x1b[32m并发写语义：全部通过\x1b[0m（${passed} 个用例）`);
