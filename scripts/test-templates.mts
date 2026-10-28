/**
 * 自定义模板纯函数单测（不碰磁盘、不起服务）。
 *
 *   npm test
 *
 * 覆盖：工程 → 快照、快照 → 新工程、模板卡片摘要、素材引用收集。
 */
import assert from "node:assert/strict";
import { createSeedProject } from "../shared/ops";
import {
  assetNameOf,
  collectAssetRefs,
  instantiateTemplate,
  snapshotProject,
  summarizeCustomTemplate,
  type CustomTemplate,
} from "../shared/customTemplate";
import type { Project } from "../shared/schema";

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
    const detail = err instanceof Error ? err.message : String(err);
    for (const line of detail.split("\n")) console.error(`    ${line}`);
  }
};

const makeProject = (): Project => {
  const p = createSeedProject("tpl_src");
  p.name = "源工程";
  p.fps = 25;
  p.scenes[0].elements = [
    {
      id: "el_a",
      kind: "image",
      name: "图 A",
      x: 30,
      y: 40,
      size: 20,
      rotate: 0,
      scale: 1,
      opacity: 1,
      z: 0,
      fill: "#fff",
      viewBox: "0 0 24 24",
      stroke: false,
      strokeWidth: 2,
      weight: 700,
      src: "/assets/pic-a.png",
      libraryId: "asset:as_1",
    },
  ];
  p.scenes[0].transforms = { title: { x: 3, y: -2, rotate: 5, scale: 1.2, z: 2 } };
  p.audio = { src: "/assets/music.wav", volume: 0.6, fadeIn: 1, fadeOut: 2 };
  return p;
};

const tplOf = (project: Project, over: Partial<CustomTemplate> = {}): CustomTemplate => ({
  id: "tpl_test",
  name: "测试模板",
  description: "来自测试",
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: snapshotProject(project),
  ...over,
});

/* ────────────────────────── snapshotProject ────────────────────────── */

test("快照保留 fps / 画幅 / 主题 / 场景 / 音频，丢掉实例身份", () => {
  const p = makeProject();
  const snap = snapshotProject(p);
  assert.equal(snap.fps, 25);
  assert.deepEqual(snap.formats, p.formats);
  assert.deepEqual(snap.theme, p.theme);
  assert.equal(snap.scenes.length, p.scenes.length);
  assert.deepEqual(snap.audio, p.audio);
  // 快照里不应该有工程级字段
  assert.equal("id" in snap, false);
  assert.equal("rev" in snap, false);
  assert.equal("updatedAt" in snap, false);
  assert.equal("name" in snap, false);
});

test("快照是深拷贝：改快照不影响源工程，反之亦然", () => {
  const p = makeProject();
  const snap = snapshotProject(p);
  snap.scenes[0].name = "改了快照";
  snap.formats[0].label = "改了画幅";
  assert.notEqual(p.scenes[0].name, "改了快照");
  assert.notEqual(p.formats[0].label, "改了画幅");
  p.scenes[1].name = "改了源工程";
  assert.notEqual(snap.scenes[1].name, "改了源工程");
});

test("快照保留自由元素与 transforms（整片快照的意义）", () => {
  const p = makeProject();
  const snap = snapshotProject(p);
  assert.equal(snap.scenes[0].elements?.[0].src, "/assets/pic-a.png");
  assert.deepEqual(snap.scenes[0].transforms?.title, { x: 3, y: -2, rotate: 5, scale: 1.2, z: 2 });
});

/* ────────────────────────── instantiateTemplate ────────────────────────── */

test("实例化：新 id、rev=1、名称可覆盖，场景 id 全部换新且唯一", () => {
  const tpl = tplOf(makeProject());
  const a = instantiateTemplate(tpl, { id: "p_new", name: "新名字" });
  assert.equal(a.id, "p_new");
  assert.equal(a.rev, 1);
  assert.equal(a.name, "新名字");
  assert.equal(a.fps, 25);
  assert.equal(a.scenes.length, tpl.payload.scenes.length);

  const ids = a.scenes.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  const oldIds = new Set(tpl.payload.scenes.map((s) => s.id));
  assert.equal(ids.some((id) => oldIds.has(id)), false);
});

test("实例化：不传名称用模板名，且两次实例化互相独立", () => {
  const tpl = tplOf(makeProject());
  const a = instantiateTemplate(tpl);
  const b = instantiateTemplate(tpl);
  assert.equal(a.name, "测试模板");
  assert.notEqual(a.id, b.id);
  a.scenes[0].name = "只改 a";
  assert.notEqual(b.scenes[0].name, "只改 a");
  a.theme.palette.primary = "#000000";
  assert.notEqual(b.theme.palette.primary, "#000000");
});

test("实例化：场景内容（props / transforms / elements / 音频）原样带过来", () => {
  const src = makeProject();
  const tpl = tplOf(src);
  const p = instantiateTemplate(tpl);
  assert.deepEqual(p.scenes[0].transforms, src.scenes[0].transforms);
  assert.equal(p.scenes[0].elements?.[0].src, "/assets/pic-a.png");
  assert.deepEqual(p.audio, src.audio);
  assert.equal(p.formats.length, src.formats.length);
  for (let i = 0; i < p.scenes.length; i++) {
    assert.equal(p.scenes[i].type, src.scenes[i].type);
    assert.equal(p.scenes[i].durationInFrames, src.scenes[i].durationInFrames);
    assert.deepEqual(p.scenes[i].props, src.scenes[i].props);
  }
});

test("实例化：模板没有音频时工程也没有 audio 字段", () => {
  const p = makeProject();
  delete p.audio;
  const inst = instantiateTemplate(tplOf(p));
  assert.equal(inst.audio, undefined);
});

/* ────────────────────────── 摘要与素材 ────────────────────────── */

test("卡片摘要：场景数 / 总时长 / 类型清单 / kind=custom", () => {
  const p = makeProject();
  const card = summarizeCustomTemplate(tplOf(p));
  assert.equal(card.key, "tpl_test");
  assert.equal(card.name, "测试模板");
  assert.equal(card.kind, "custom");
  assert.equal(card.sceneCount, p.scenes.length);
  assert.equal(
    card.durationInFrames,
    p.scenes.reduce((sum, s) => sum + s.durationInFrames, 0),
  );
  assert.deepEqual(card.sceneTypes, p.scenes.map((s) => s.type));
  assert.deepEqual(card.tags, ["我的模板"]);
});

test("collectAssetRefs：收集元素 / 场景 props / 音频里的本地素材并去重", () => {
  const p = makeProject();
  p.scenes[1].props = { ...p.scenes[1].props, src: "/assets/cover.png" };
  p.scenes[2].elements = [
    {
      id: "el_b",
      kind: "image",
      name: "B",
      x: 10,
      y: 10,
      size: 10,
      rotate: 0,
      scale: 1,
      opacity: 1,
      z: 0,
      fill: "#fff",
      viewBox: "0 0 24 24",
      stroke: false,
      strokeWidth: 2,
      weight: 700,
      src: "/assets/pic-a.png",
    },
  ];
  const refs = collectAssetRefs(p).sort();
  assert.deepEqual(refs, ["/assets/cover.png", "/assets/music.wav", "/assets/pic-a.png"]);
});

test("collectAssetRefs：忽略外链、data URI 和路径穿越", () => {
  const p = makeProject();
  p.scenes[0].elements![0].src = "https://example.com/a.png";
  p.audio = { src: "data:audio/wav;base64,xxx", volume: 1, fadeIn: 0, fadeOut: 0 };
  assert.deepEqual(collectAssetRefs(p), []);

  const evil = makeProject();
  delete evil.audio;
  evil.scenes[0].elements![0].src = "/assets/../secret.txt";
  assert.deepEqual(collectAssetRefs(evil), []);
});

test("assetNameOf：合法名取出，非法返回 null", () => {
  assert.equal(assetNameOf("/assets/a-b_c.png"), "a-b_c.png");
  assert.equal(assetNameOf("/assets/../x.png"), null);
  assert.equal(assetNameOf("https://x/a.png"), null);
  assert.equal(assetNameOf("/assets/"), null);
});

/* ────────────────────────── 汇总 ────────────────────────── */

console.log("");
if (failures.length) {
  console.error(`${failures.length} 个用例失败（通过 ${passed} 个）`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过：${passed} 个用例`);
