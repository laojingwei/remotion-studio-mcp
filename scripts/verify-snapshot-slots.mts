/**
 * 快照槽位轮转的验证（这是"保存超时"事故的根治点）。
 *
 * 事故：原来每写一份快照就删掉最老的一份，而宿主注入的 safe-delete 拦截器
 * 按"每轮删文件数"设阈值——连续编辑几十笔后，每次保存都撞阈值，**整个 Node 进程被卡住**，
 * 界面表现就是属性改不动、所有请求排队到 `signal timed out`。
 *
 * 现在改成固定 50 个槽位覆盖：只写不删。这里验：
 * 1. 连续写 60 份之后，目录里的文件数**不超过 50**（槽位确实在复用）；
 * 2. 最近 50 个 rev 都还能读到，更老的读不到（被覆盖，符合"只留 50 份"的承诺）；
 * 3. 槽位里存的 rev 与请求的 rev 不一致时**不能返回错版本**（否则回滚会跳到别的版本）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { projects } from "../server/project.service";
import { createSeedProject } from "../shared/ops";
import type { Op } from "../shared/ops";
import { listSnapshots, readSnapshot } from "../server/store";

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

const id = "p_snap_slot";
const seed = { ...createSeedProject(id), name: "槽位测试" };
projects.replace(seed);
const rename = (name: string): Op[] =>
  [{ op: "update_scene", sceneId: seed.scenes[0].id, patch: { name } } as unknown as Op];

try {
  console.log("[快照槽位]");

  /** 连写 60 个 rev（rev 从 2 开始往上走） */
  for (let i = 0; i < 60; i++) projects.apply(id, rename(`v${i}`));

  const rev = projects.get(id).rev;
  const snaps = listSnapshots(id).sort((a, b) => a - b);
  const dir = path.join(process.cwd(), "data", id, "history");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];

  ok("目录文件数不超过 50（槽位在复用，没有无限增长）", () =>
    assert.ok(files.length <= 50, `实得 ${files.length} 个文件`),
  );
  ok("最近 50 个 rev 都能列出来", () =>
    assert.ok(snaps.length >= 50 && snaps.includes(rev), `共 ${snaps.length} 个，最新 ${rev}`),
  );
  ok("最老的 rev 已被覆盖（只留 50 份的承诺）", () =>
    assert.ok(!snaps.includes(1), JSON.stringify(snaps.slice(0, 3))),
  );

  ok("readSnapshot 能读到最新一份，且内容与 rev 对得上", () => {
    const p = readSnapshot(id, rev);
    assert.ok(p, `rev ${rev} 应该读得到`);
    assert.equal(p!.rev, rev);
  });

  ok("被覆盖的 rev 读回来不会是别的版本", () => {
    const old = readSnapshot(id, 1);
    assert.equal(old, null, "rev 1 已被覆盖，必须返回 null，绝不能返回槽位里别的 rev");
  });
} finally {
  try {
    projects.remove(id);
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
