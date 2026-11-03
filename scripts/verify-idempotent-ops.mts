/**
 * 写请求幂等（opId）的验证。
 *
 * 为什么必须有：客户端把写超时当"没成功"重发，但超时也可能意味着
 * **服务端已经写成功了、只是响应没回来**。没有去重，重发会把 `add_element`
 * 执行两遍——用户看到"拖了一个物体，冒出两个"，而且撤销一次只撤掉一个。
 *
 * 这里验四条：
 * 1. 同 opId 第二次调用不再执行（rev 不变、内容不变）；
 * 2. 新 opId 正常执行（rev +1）；
 * 3. 不带 opId 的老客户端行为完全不变（每次都执行）；
 * 4. 同 opId 但**跨工程**不会互相命中（key 里带 projectId）。
 */
import assert from "node:assert/strict";
import { projects } from "../server/project.service";
import { createSeedProject } from "../shared/ops";
import type { Op } from "../shared/ops";

let pass = 0;
let fail = 0;
const ok = (name: string, fn: () => void) => {
  try {
    fn();
    pass++;
    console.log("  ✓", name);
  } catch (e) {
    fail++;
    console.log("  ✗", name, "\n    ", (e as Error).message);
  }
};

const idA = "p_idem_a";
const idB = "p_idem_b";
const seedA = { ...createSeedProject(idA), name: "幂等测试 A" };
const seedB = { ...createSeedProject(idB), name: "幂等测试 B" };
projects.replace(seedA);
projects.replace(seedB);

const rename = (p: typeof seedA, name: string): Op[] =>
  [{ op: "update_scene", sceneId: p.scenes[0].id, patch: { name } } as unknown as Op];

try {
  console.log("[ops 幂等]");

  ok("同一 opId 第二次不再执行（rev 与内容都不变）", () => {
    const ops = rename(seedA, "改一次");
    const first = projects.apply(idA, ops, { opId: "c1:1" });
    assert.equal(first.project.scenes[0].name, "改一次");
    const rev = first.project.rev;
    const second = projects.apply(idA, ops, { opId: "c1:1" });
    assert.equal(second.project.rev, rev, `第二次不该再写库（rev ${rev} → ${second.project.rev}）`);
    assert.equal(second.project.scenes[0].name, "改一次");
  });

  ok("新 opId 正常执行（rev +1）", () => {
    const before = projects.get(idA).rev;
    const res = projects.apply(idA, rename(seedA, "改两次"), { opId: "c1:2" });
    assert.equal(res.project.rev, before + 1);
    assert.equal(res.project.scenes[0].name, "改两次");
  });

  ok("不带 opId 的老客户端行为不变（每次都执行）", () => {
    const before = projects.get(idA).rev;
    const r1 = projects.apply(idA, rename(seedA, "无 id 1"));
    const r2 = projects.apply(idA, rename(seedA, "无 id 2"));
    assert.equal(r1.project.rev, before + 1);
    assert.equal(r2.project.rev, before + 2, "没有 opId 就不该被去重");
  });

  ok("同 opId 跨工程不会串（key 带 projectId）", () => {
    const rB = projects.apply(idB, rename(seedB, "B 的改动"), { opId: "c1:1" });
    assert.equal(rB.project.scenes[0].name, "B 的改动", "B 工程应真的执行，不能命中 A 的缓存");
    assert.equal(projects.get(idA).scenes[0].name, "无 id 2", "A 工程不受影响");
  });
} finally {
  for (const id of [idA, idB]) {
    try {
      projects.remove(id);
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
