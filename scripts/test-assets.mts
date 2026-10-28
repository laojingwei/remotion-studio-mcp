/**
 * 素材分层目录的单测（不需要起服务）。
 *
 * 覆盖 v0.98 的分层布局：
 *   assets/library/           跨工程复用，删工程不动
 *   assets/projects/<id>/     工程私有，删工程连带清（但被别的工程/素材库引用时必须留下）
 *
 * 会往 public/assets 和 data/projects 写临时文件/临时工程，跑完全部删掉。
 * 临时名字统一带 `__testas_` 前缀，失败也只会留下自己的东西。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  assetNameOf,
  collectAssetRefs,
  isSafeAssetRel,
} from "../shared/customTemplate";
import { createSeedProject, applyOps } from "../shared/ops";
import {
  LIBRARY_REL,
  PROJECTS_REL,
  cleanupUnusedAssets,
  listProjectAssets,
  organizeAssets,
  projectAssetDir,
  referencedAssetFiles,
  removeProjectAssets,
  writeProjectAsset,
} from "../server/assets.service";
import { library } from "../server/library.service";
import { ROOT } from "../server/root";
import { deleteProjectDir, PUBLIC_DIR, readProject, removeTree, writeProject } from "../server/store";

const ASSETS = path.join(PUBLIC_DIR, "assets");
const RID = Math.random().toString(36).slice(2, 7);
const P1 = `p_testas_${RID}a`;
const P2 = `p_testas_${RID}b`;
const LEGACY = `__testas_legacy_${RID}.png`;
const LIB_FILE = `__testas_lib_${RID}.png`;

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  [ok] ${name}`);
};

const write = (rel: string, text = "x") => {
  const full = path.join(ASSETS, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
};
const exists = (rel: string) => fs.existsSync(path.join(ASSETS, ...rel.split("/")));

/** 造一个只引用某个素材的临时工程 */
function tempProject(id: string, name: string, assetUrl: string) {
  const seed = createSeedProject(id);
  seed.name = name;
  const { project } = applyOps(seed, [
    { op: "add_element", sceneId: seed.scenes[0].id, element: { kind: "image", src: assetUrl } },
  ]);
  writeProject(project);
  return project;
}

function cleanup() {
  for (const id of [P1, P2]) {
    try {
      deleteProjectDir(id);
    } catch {
      /* 没建起来也无所谓 */
    }
    // 本机 fs.rmSync(recursive) 会"静默成功却不删"（MEMORY 里的坑），所以用 removeTree + rmdir
    try {
      const dir = projectAssetDir(id);
      if (fs.existsSync(dir)) {
        removeTree(dir);
        fs.rmdirSync(dir);
      }
    } catch {
      /* 忽略 */
    }
  }
  for (const rel of [LEGACY, LIB_FILE]) {
    const full = path.join(ASSETS, rel);
    if (fs.existsSync(full)) fs.rmSync(full, { force: true });
  }
  for (const item of library.list()) {
    if (item.name.startsWith("__testas_")) library.remove(item.id);
  }
}

function main() {
  try {
    /* ── 1. 路径安全：允许子目录，但每一段都要干净 ── */
    test("isSafeAssetRel：接受分层路径，挡住穿越与隐藏文件", () => {
      assert.equal(isSafeAssetRel("projects/p_x/a.png"), true);
      assert.equal(isSafeAssetRel("library/a.mp3"), true);
      assert.equal(isSafeAssetRel("../x.png"), false);
      assert.equal(isSafeAssetRel("projects/../../x.png"), false);
      assert.equal(isSafeAssetRel("projects//a.png"), false);
      assert.equal(isSafeAssetRel("projects/.hidden"), false);
      assert.equal(isSafeAssetRel(""), false);
    });

    test("assetNameOf：/assets/projects/p_x/a.png → 相对路径", () => {
      assert.equal(assetNameOf("/assets/projects/p_x/a.png"), "projects/p_x/a.png");
      assert.equal(assetNameOf("/assets/../etc/passwd"), null);
      assert.equal(assetNameOf("https://x.com/a.png"), null);
    });

    /* ── 2. collectAssetRefs 补齐了两处漏收集 ── */
    test("collectAssetRefs：带上音效轨与自由画布元素的素材", () => {
      const project = createSeedProject(`p_refs_${RID}`);
      project.audioTracks = [
        {
          id: "au_1",
          name: "音效",
          src: "/assets/library/sfx.wav",
          from: 0,
          volume: 1,
          fadeIn: 0,
          fadeOut: 0,
        },
      ];
      project.scenes[1].props = {
        ...project.scenes[1].props,
        elements: [{ id: "f0", type: "image", x: 50, y: 50, src: "/assets/projects/px/c.png" }],
      } as never;
      const refs = collectAssetRefs(project);
      assert.ok(refs.includes("/assets/library/sfx.wav"), "音效轨 src 要收集");
      assert.ok(refs.includes("/assets/projects/px/c.png"), "自由画布元素 src 要收集");
    });

    /* ── 3. 工程目录读写 ── */
    test("writeProjectAsset：写进 projects/<id>/ 并返回站内地址", () => {
      const url = writeProjectAsset(P1, `${RID}-a.png`, Buffer.from("png"));
      assert.equal(url, `/assets/${PROJECTS_REL}/${P1}/${RID}-a.png`);
      assert.ok(exists(`${PROJECTS_REL}/${P1}/${RID}-a.png`));
    });

    test("listProjectAssets：列文件、标出是否被引用", () => {
      tempProject(P1, "临时工程A", `/assets/${PROJECTS_REL}/${P1}/${RID}-a.png`);
      const items = listProjectAssets(P1);
      assert.equal(items.length, 1);
      assert.equal(items[0].kind, "image");
      assert.equal(items[0].referenced, true);
    });

    /* ── 4. 删工程：删自己的，留别人的 ── */
    test("removeProjectAssets：被别的工程引用的文件必须留下", () => {
      tempProject(P2, "临时工程B", `/assets/${PROJECTS_REL}/${P1}/${RID}-a.png`);
      // 真实顺序：先删工程数据，再清它的素材目录
      deleteProjectDir(P1);
      const r = removeProjectAssets(P1);
      assert.equal(r.removed, 0, "被 B 引用，一个都不该删");
      assert.equal(r.kept, 1);
      assert.ok(exists(`${PROJECTS_REL}/${P1}/${RID}-a.png`));
      assert.ok(referencedAssetFiles().has(`${PROJECTS_REL}/${P1}/${RID}-a.png`));
    });

    test("removeProjectAssets：没人用了就删干净，并收掉空目录", () => {
      deleteProjectDir(P2);
      const r = removeProjectAssets(P1);
      assert.equal(r.removed, 1);
      assert.equal(exists(`${PROJECTS_REL}/${P1}/${RID}-a.png`), false);
      assert.equal(fs.existsSync(projectAssetDir(P1)), false, "空目录要收掉");
    });

    /* ── 5. 素材库进 library/ ── */
    test("library.add：文件落在 assets/library/，删条目会回收", () => {
      const item = library.add({ buffer: Buffer.from("lib"), filename: LIB_FILE, name: `__testas_${RID}` });
      assert.ok(item.url.startsWith(`/assets/${LIBRARY_REL}/`), item.url);
      assert.ok(exists(item.url.replace("/assets/", "")), "文件要真的落在 library/ 下");
      const removed = library.remove(item.id);
      assert.equal(removed.id, item.id);
    });

    /* ── 6. cleanup：没有引用的文件（含已删工程目录里的）会被清掉 ── */
    test("cleanupUnusedAssets：dryRun 不动手，实跑才删", () => {
      const orphan = `${PROJECTS_REL}/p_gone_${RID}/orphan.png`;
      write(orphan);
      const dry = cleanupUnusedAssets({ dryRun: true, onlyRels: [orphan] });
      assert.equal(dry.removed, 1, "要报出这个孤儿文件");
      assert.ok(exists(orphan), "dryRun 不能真删");
      // 只动自己造的文件：真实素材目录里可能有用户还想要的东西
      const real = cleanupUnusedAssets({ onlyRels: [orphan] });
      assert.equal(real.removed, 1);
      assert.equal(exists(orphan), false);
      assert.equal(fs.existsSync(path.join(ASSETS, PROJECTS_REL, `p_gone_${RID}`)), false);
    });

    /* ── 7. 整理老文件：按归属搬进工程目录 / library ── */
    test("organizeAssets：只被一个工程引用的老文件搬进该工程目录并改 URL", () => {
      write(LEGACY, "legacy-png");
      const p = tempProject(P1, "临时工程A", `/assets/${LEGACY}`);

      const dry = organizeAssets({ dryRun: true, onlyRels: [LEGACY] });
      const move = dry.moves.find((m) => m.from === LEGACY);
      assert.ok(move, "dryRun 要给出方案");
      assert.equal(move!.to, `${PROJECTS_REL}/${P1}/${LEGACY}`);
      assert.ok(exists(LEGACY), "dryRun 不能真搬");
      assert.ok(
        JSON.stringify(readProject(P1)).includes(`/assets/${LEGACY}`),
        "dryRun 不改 URL",
      );

      const real = organizeAssets({ dryRun: false, onlyRels: [LEGACY] });
      assert.ok(real.moves.some((m) => m.from === LEGACY));
      for (const r of real.rewrites) writeProject(r.project);
      assert.equal(exists(LEGACY), false, "老文件应已搬走");
      assert.ok(exists(`${PROJECTS_REL}/${P1}/${LEGACY}`));
      assert.ok(
        JSON.stringify(readProject(P1)).includes(`/assets/${PROJECTS_REL}/${P1}/${LEGACY}`),
        "工程里的 URL 要改成新位置",
      );
      assert.ok(p.id === P1);
    });

    test("organizeAssets：被多个工程共用的老文件搬进 library", () => {
      write(LEGACY, "shared-png");
      tempProject(P1, "临时工程A", `/assets/${LEGACY}`);
      tempProject(P2, "临时工程B", `/assets/${LEGACY}`);
      const dry = organizeAssets({ dryRun: true, onlyRels: [LEGACY] });
      const move = dry.moves.find((m) => m.from === LEGACY);
      assert.ok(move);
      assert.equal(move!.to, `${LIBRARY_REL}/${LEGACY}`);
      // 收尾：把这次造的东西清掉，免得影响后面的断言
      cleanup();
    });
  } finally {
    cleanup();
  }

  console.log(`\n素材目录测试：${passed} 例通过`);
}

main();
