/**
 * op reducer 单测（纯函数，不需要浏览器、不需要起服务）。
 *
 *   npm test
 *
 * 覆盖 shared/ops.ts 的每个分支 + 几条曾经踩过的坑：
 *  - set_transform 全零要清理干净，不能留垃圾数据
 *  - 默认 id 绝不能是 demo（否则「新建项目」会覆盖示例工程）
 *  - rev 只 +1，且不修改传入的旧对象（纯函数）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyOps, createSeedProject, type Op } from "../shared/ops";
import { getMeta, MIN_SCENE_FRAMES, SCENE_METAS } from "../shared/sceneMetas";
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
    // 单独取出来格式化：esbuild 对模板字符串里直接嵌 instanceof 三元有解析 bug
    const detail = err instanceof Error ? err.message : String(err);
    for (const line of detail.split("\n")) console.error(`    ${line}`);
  }
};

const seed = (): Project => createSeedProject("t_unit");
const one = (p: Project, op: Op) => applyOps(p, [op]);
const scene0 = (p: Project) => p.scenes[0];

/* ────────────────────────── add_scene ────────────────────────── */

test("add_scene：追加到末尾，默认转场 + 合法时长", () => {
  const p = seed();
  const before = p.scenes.length;
  const { project, createdSceneIds } = one(p, { op: "add_scene", type: "quote" });
  assert.equal(project.scenes.length, before + 1);
  assert.equal(createdSceneIds.length, 1);
  const added = project.scenes[project.scenes.length - 1];
  assert.equal(added.id, createdSceneIds[0]);
  assert.equal(added.type, "quote");
  assert.deepEqual(added.transitionIn, { type: "fade", durationInFrames: 12 });
  assert.ok(added.durationInFrames > 0);
});

test("add_scene：afterSceneId 插在指定场景之后", () => {
  const p = seed();
  const anchor = p.scenes[1].id;
  const { project } = one(p, { op: "add_scene", type: "steps", afterSceneId: anchor });
  assert.equal(project.scenes[2].type, "steps");
  assert.equal(project.scenes[1].id, anchor);
});

test("add_scene：afterSceneId 不存在时抛错", () => {
  assert.throws(() => one(seed(), { op: "add_scene", type: "quote", afterSceneId: "nope" }), /找不到场景/);
});

test("add_scene：未知类型抛错", () => {
  assert.throws(() => one(seed(), { op: "add_scene", type: "does-not-exist" }), /未知场景类型/);
});

test("add_scene：时长被钳制在场景允许区间内", () => {
  const p = seed();
  const tiny = one(p, { op: "add_scene", type: "title", durationInFrames: 1 }).project;
  const addedTiny = tiny.scenes[tiny.scenes.length - 1];
  const huge = one(p, { op: "add_scene", type: "title", durationInFrames: 99999 }).project;
  const addedHuge = huge.scenes[huge.scenes.length - 1];
  assert.ok(addedTiny.durationInFrames >= 2);
  assert.ok(addedHuge.durationInFrames <= 99999);
  assert.ok(addedHuge.durationInFrames >= addedTiny.durationInFrames);
});

/* ────────────────────────── 场景操作 ────────────────────────── */

test("duplicate_scene：复制插在原场景之后，深拷贝互不影响", () => {
  const p = seed();
  const src = scene0(p);
  const { project, createdSceneIds } = one(p, { op: "duplicate_scene", sceneId: src.id });
  assert.equal(project.scenes[1].id, createdSceneIds[0]);
  assert.equal(project.scenes[1].name, `${src.name} 副本`);
  assert.notEqual(project.scenes[1].props, src.props);
});

test("update_scene：props 合并、名称与时长可改", () => {
  const p = seed();
  const s = scene0(p);
  const { project } = one(p, {
    op: "update_scene",
    sceneId: s.id,
    patch: { name: "改过的名字", durationInFrames: 60, props: { title: "新标题" } },
  });
  const next = project.scenes[0];
  assert.equal(next.name, "改过的名字");
  assert.equal(next.durationInFrames, 60);
  assert.equal(next.props.title, "新标题");
  // 未指定的 props 保留（normalizeProps 会补默认值）
  assert.ok(Object.keys(next.props).length > 1);
});

test("update_scene：transitionIn 传 null 表示移除", () => {
  const p = seed();
  const s = scene0(p);
  const { project } = one(p, { op: "update_scene", sceneId: s.id, patch: { transitionIn: null } });
  assert.equal(project.scenes[0].transitionIn, undefined);
});

/* ────────────────────────── 换版式 set_scene_type ────────────────────────── */

test("set_scene_type：换版式，同名 key 迁移、独有的丢弃、缺的补默认值", () => {
  const p = seed();
  const s = scene0(p);
  const { project, summary } = applyOps(p, [
    { op: "set_scene_type", sceneId: s.id, type: "bigtext", props: { text: "迁移测试文本" } },
  ]);
  const sc = project.scenes[0];
  assert.equal(sc.type, "bigtext");
  assert.equal(sc.props.text, "迁移测试文本");
  // 丢弃的字段必须说出来，不能静默
  assert.ok(summary.some((x) => x.includes("丢弃")), JSON.stringify(summary));

  // 再换一次：text 是 bigtext 和 quote 的同名 key，应该迁移过去
  const r2 = applyOps(project, [{ op: "set_scene_type", sceneId: s.id, type: "quote" }]);
  assert.equal(r2.project.scenes[0].props.text, "迁移测试文本", "同名 key 必须迁移");
  // quote 不认识 bigtext 的 sub，要明确报出来
  assert.ok(
    r2.summary.some((x) => x.includes("sub") && x.includes("丢弃")),
    JSON.stringify(r2.summary),
  );
  // quote 缺 author，用默认值补
  assert.ok(
    r2.summary.some((x) => x.includes("author") && x.includes("默认值")),
    JSON.stringify(r2.summary),
  );
  assert.ok(r2.project.scenes[0].props.author !== undefined, "缺的必填字段必须有值");
});

test("set_scene_type：换版式后旁白元素与场景 id 都不丢", () => {
  const p = seed();
  const s = scene0(p);
  const { project, summary } = applyOps(p, [
    { op: "add_element", sceneId: s.id, element: { id: "el_keep", kind: "audio", src: "/assets/x.wav" } },
    { op: "set_scene_type", sceneId: s.id, type: "quote" },
  ]);
  const sc = project.scenes[0];
  assert.equal(sc.id, s.id, "场景 id 不能变");
  assert.deepEqual(sc.elements?.map((e) => e.id), ["el_keep"], "旁白元素必须保留");
  assert.ok(!summary.some((x) => x.includes("丢弃") && x.includes("el_keep")));
});

test("set_scene_type：显式 props 覆盖迁移结果", () => {
  const p = seed();
  const s = scene0(p);
  const { project } = applyOps(p, [
    { op: "set_scene_type", sceneId: s.id, type: "quote", props: { text: "覆盖后的文本" } },
  ]);
  assert.equal(project.scenes[0].props.text, "覆盖后的文本");
});

test("set_scene_type：未知类型抛错", () => {
  const p = seed();
  const s = scene0(p);
  assert.throws(
    () => one(p, { op: "set_scene_type", sceneId: s.id, type: "no-such-type" }),
    /未知场景类型/,
  );
});

test("set_scene_type：换成同一类型只做 props 覆盖，不报丢弃", () => {
  const p = seed();
  const s = scene0(p);
  const { project, summary } = applyOps(p, [
    { op: "set_scene_type", sceneId: s.id, type: s.type, props: { title: "只改这个" } },
  ]);
  assert.equal(project.scenes[0].props.title, "只改这个");
  assert.ok(!summary.some((x) => x.includes("丢弃")), JSON.stringify(summary));
});

test("set_scene_timing：时长被钳制且取整", () => {
  const p = seed();
  const s = scene0(p);
  const min = getMeta("title")!.duration.min;
  const { project } = one(p, { op: "set_scene_timing", sceneId: s.id, durationInFrames: 30.7 });
  assert.equal(project.scenes[0].durationInFrames, Math.max(min, 31));
  const zero = one(p, { op: "set_scene_timing", sceneId: s.id, durationInFrames: 0 }).project;
  assert.ok(zero.scenes[0].durationInFrames >= 1);
});

test("set_scene_timing：能缩到时间轴手柄的下限，不再回弹", () => {
  // 回归：以前每个版式自带 min（30/45/60），时间轴手柄却能拖到 15 帧，
  // 拖短了松手就被 clamp 回去 —— 用户看到的就是"缩到某个长度自己弹回来"。
  const p = seed();
  const s = scene0(p);
  const { project } = one(p, { op: "set_scene_timing", sceneId: s.id, durationInFrames: 20 });
  assert.equal(project.scenes[0].durationInFrames, 20);
  // 所有版式的下限都必须是同一个值（手柄和 ops 共用），否则一定会再分叉
  const mins = new Set(SCENE_METAS.map((m) => m.duration.min));
  assert.deepEqual([...mins], [MIN_SCENE_FRAMES]);
});

test("reorder_scenes：按给定顺序重排，未列出的追加在尾部", () => {
  const p = seed();
  const ids = p.scenes.map((s) => s.id);
  const { project } = one(p, { op: "reorder_scenes", sceneIds: [ids[2], ids[0]] });
  assert.equal(project.scenes.length, ids.length);
  assert.equal(project.scenes[0].id, ids[2]);
  assert.equal(project.scenes[1].id, ids[0]);
  assert.deepEqual(
    project.scenes.slice(2).map((s) => s.id).sort(),
    ids.filter((id) => id !== ids[0] && id !== ids[2]).sort(),
  );
});

test("reorder_scenes：未知 id 抛错", () => {
  assert.throws(() => one(seed(), { op: "reorder_scenes", sceneIds: ["nope"] }), /找不到场景/);
});

test("remove_scene：移除后场景数减少", () => {
  const p = seed();
  const before = p.scenes.length;
  const { project } = one(p, { op: "remove_scene", sceneId: p.scenes[0].id });
  assert.equal(project.scenes.length, before - 1);
});

/* ────────────────────────── set_transform ────────────────────────── */

test("set_transform：局部字段合并到已有变换", () => {
  const p = seed();
  const s = scene0(p);
  const first = one(p, { op: "set_transform", sceneId: s.id, target: "title.text", transform: { x: 5 } })
    .project;
  const second = one(first, {
    op: "set_transform",
    sceneId: s.id,
    target: "title.text",
    transform: { y: 3 },
  }).project;
  const t = second.scenes[0].transforms?.["title.text"];
  assert.ok(t);
  assert.equal(t.x, 5);
  assert.equal(t.y, 3);
  assert.equal(t.scale, 1);
});

test("set_transform：全零视为复位，不留下 transforms 垃圾", () => {
  const p = seed();
  const s = scene0(p);
  const moved = one(p, { op: "set_transform", sceneId: s.id, target: "title.text", transform: { x: 0.001 } })
    .project;
  assert.equal(moved.scenes[0].transforms, undefined);
});

test("set_transform：transform 传 null 删除该条并清空空字典", () => {
  const p = seed();
  const s = scene0(p);
  const moved = one(p, { op: "set_transform", sceneId: s.id, target: "title.text", transform: { x: 9 } })
    .project;
  assert.equal(moved.scenes[0].transforms?.["title.text"].x, 9);
  const reset = one(moved, { op: "set_transform", sceneId: s.id, target: "title.text", transform: null })
    .project;
  assert.equal(reset.scenes[0].transforms, undefined);
});

/* ────────────────────────── 自由元素 ────────────────────────── */

test("add_element：补全 id/名称/schema 默认值", () => {
  const p = seed();
  const s = scene0(p);
  const { project } = one(p, {
    op: "add_element",
    sceneId: s.id,
    element: { kind: "text", text: "你好", fill: "#fff" },
  });
  const el = project.scenes[0].elements?.[0];
  assert.ok(el);
  assert.match(el!.id, /^el_/);
  // 文字元素没起名就用文案当图层名（时间轴上不再全叫「元素」）
  assert.equal(el!.name, "你好");
  assert.equal(el!.x, 50);
  assert.equal(el!.y, 50);
  assert.equal(el!.size, 10);
  assert.equal(el!.z, 0);
  assert.equal(el!.opacity, 1);
  // 显式给名字时以名字为准
  const named = one(p, {
    op: "add_element",
    sceneId: s.id,
    element: { kind: "text", text: "你好", name: "标题贴纸" },
  }).project;
  assert.equal(named.scenes[0].elements?.[0].name, "标题贴纸");
});

test("add_element：字段名拼错直接报错并给建议（N-C：以前静默丢弃）", () => {
  const p = seed();
  const s = scene0(p);
  assert.throws(
    () =>
      one(p, {
        op: "add_element",
        sceneId: s.id,
        element: { kind: "text", text: "白名单探针", opacty: 0.5 } as never,
      }),
    /element里有不认识的字段：opacty（是不是想写 opacity？）/,
  );
});

test("add_element：video 元素带默认静音 / 循环 / 起始帧", () => {
  const p = seed();
  const s = scene0(p);
  const { project } = one(p, {
    op: "add_element",
    sceneId: s.id,
    element: { kind: "video", src: "/assets/v.mp4", aspect: 1.7778 },
  });
  const el = project.scenes[0].elements![0];
  assert.equal(el.kind, "video");
  assert.equal(el.muted, true);
  assert.equal(el.loop, true);
  assert.equal(el.startFrom, 0);
  assert.equal(el.aspect, 1.7778);
});

test("add_element：非法 z（负数）被 schema 拒绝", () => {
  const p = seed();
  const s = scene0(p);
  assert.throws(
    () =>
      one(p, {
        op: "add_element",
        sceneId: s.id,
        element: { kind: "svg", svg: "<path d='M0 0h1v1z'/>", z: -3 },
      }),
    /z/i,
  );
});

test("update_element：patch 合并且保留其他字段", () => {
  const p = seed();
  const s = scene0(p);
  const withEl = one(p, {
    op: "add_element",
    sceneId: s.id,
    element: { kind: "text", text: "原文", fill: "#abc" },
  }).project;
  const el = withEl.scenes[0].elements![0];
  const { project } = one(withEl, {
    op: "update_element",
    sceneId: s.id,
    elementId: el.id,
    patch: { x: 70, text: "改过" },
  });
  const next = project.scenes[0].elements![0];
  assert.equal(next.x, 70);
  assert.equal(next.text, "改过");
  assert.equal(next.fill, "#abc");
  assert.equal(next.kind, "text");
});

test("update_element：opacity 越界被 schema 拒绝", () => {
  const p = seed();
  const s = scene0(p);
  const withEl = one(p, {
    op: "add_element",
    sceneId: s.id,
    element: { kind: "text", text: "x" },
  }).project;
  const el = withEl.scenes[0].elements![0];
  assert.throws(
    () =>
      one(withEl, {
        op: "update_element",
        sceneId: s.id,
        elementId: el.id,
        patch: { opacity: 3 },
      }),
    /opacity/i,
  );
});

test("remove_element：删掉最后一个元素后 elements 字段整个移除", () => {
  const p = seed();
  const s = scene0(p);
  const withEl = one(p, { op: "add_element", sceneId: s.id, element: { kind: "text", text: "x" } }).project;
  const el = withEl.scenes[0].elements![0];
  const { project } = one(withEl, { op: "remove_element", sceneId: s.id, elementId: el.id });
  assert.equal(project.scenes[0].elements, undefined);
});

test("remove_element：不存在的元素抛错", () => {
  const p = seed();
  assert.throws(
    () => one(p, { op: "remove_element", sceneId: scene0(p).id, elementId: "nope" }),
    /找不到元素/,
  );
});

/* ────────────────────────── 元素默认值（按类型给）────────────────────────── */

test("元素静音默认值按类型给：音频默认有声、视频默认静音", () => {
  const p = seed();
  const s = scene0(p);
  const audio = one(p, {
    op: "add_element",
    sceneId: s.id,
    element: { kind: "audio", src: "/assets/x.wav", audioVolume: 1 },
  }).project.scenes[0].elements![0];
  // 曾经一律 default(true)：音频不显式传 muted:false 就被静音成 0，
  // 渲染出来连音轨都不生成，而且零报错。这条必须钉死。
  assert.equal(audio.muted, false, "音频默认必须有声");

  const video = one(p, {
    op: "add_element",
    sceneId: s.id,
    element: { kind: "video", src: "/assets/x.mp4" },
  }).project.scenes[0].elements![0];
  assert.equal(video.muted, true, "视频默认静音（避免和背景音乐打架）");
});

/* ────────────────────────── 素材起点 startFrom（音频/视频通用）────────────────────────── */

test("add_element：音频可以带 startFrom（从文件中间开始播）", () => {
  const p = seed();
  const s = scene0(p);
  const audio = one(p, {
    op: "add_element",
    sceneId: s.id,
    element: { kind: "audio", src: "/assets/x.wav", startFrom: 45 },
  }).project.scenes[0].elements![0];
  // 音频以前没有 startFrom，只能从文件第 0 秒开始播，
  // 想去掉旁白开头的空白就只能整段重剪。
  assert.equal(audio.startFrom, 45, "音频的 startFrom 必须落盘");
  assert.equal(audio.kind, "audio");
});

test("add_element：startFrom 默认为 0，且负数被 schema 拒绝", () => {
  const p = seed();
  const s = scene0(p);
  const audio = one(p, {
    op: "add_element",
    sceneId: s.id,
    element: { kind: "audio", src: "/assets/x.wav" },
  }).project.scenes[0].elements![0];
  assert.equal(audio.startFrom, 0);

  assert.throws(
    () =>
      one(p, {
        op: "add_element",
        sceneId: s.id,
        element: { kind: "audio", src: "/assets/x.wav", startFrom: -1 },
      }),
    /startFrom/i,
  );
});

test("update_element：可以改 startFrom（裁掉素材开头）", () => {
  const p = seed();
  const s = scene0(p);
  // 一次传两个 op：第二个要作用在第一个产出的工程上
  const { project } = applyOps(p, [
    {
      op: "add_element",
      sceneId: s.id,
      element: { id: "el_sf_test", kind: "audio", src: "/assets/x.wav" },
    },
    {
      op: "update_element",
      sceneId: s.id,
      elementId: "el_sf_test",
      patch: { startFrom: 30 },
    },
  ]);
  const after = project.scenes[0].elements![0];
  assert.equal(after.startFrom, 30);
  // 改 startFrom 不该动到窗口位置和时长
  assert.equal(after.from, 0);
});

/* ────────────────────────── 元素时长截断要说出来 ────────────────────────── */

test("update_element：时长超幕长被截断时，summary 必须说明实际生效值", () => {
  const p = seed();
  const s = scene0(p);
  const sceneDur = s.durationInFrames;
  const { project, summary } = applyOps(p, [
    {
      op: "add_element",
      sceneId: s.id,
      element: { id: "el_trim", kind: "audio", src: "/assets/x.wav" },
    },
    {
      op: "update_element",
      sceneId: s.id,
      elementId: "el_trim",
      patch: { durationInFrames: sceneDur + 500 },
    },
  ]);
  const el = project.scenes[0].elements![0];
  // 截断本身是必要的（元素不能超出场景结尾）
  assert.equal(el.durationInFrames, sceneDur, "时长应被截到场景长度");
  // 但必须说出来：否则接口报「成功」，回读才发现没生效
  const warn = summary.find((x) => x.includes("截断"));
  assert.ok(warn, `summary 里必须有截断提示，实际: ${JSON.stringify(summary)}`);
  assert.match(warn!, /被截断/);
  assert.match(warn!, new RegExp(String(sceneDur + 500))); // 原请求值
  assert.match(warn!, new RegExp(String(sceneDur))); // 实际生效值
});

test("update_element：时长在幕长内时不产生截断提示", () => {
  const p = seed();
  const s = scene0(p);
  const sceneDur = s.durationInFrames;
  const { summary } = applyOps(p, [
    {
      op: "add_element",
      sceneId: s.id,
      element: { id: "el_ok", kind: "audio", src: "/assets/x.wav" },
    },
    {
      op: "update_element",
      sceneId: s.id,
      elementId: "el_ok",
      patch: { durationInFrames: 30 },
    },
  ]);
  assert.ok(!summary.some((x) => x.includes("截断")), `不该有截断提示: ${JSON.stringify(summary)}`);
});

test("元素显式 muted 不被默认值顶掉（音频可手动静音）", () => {
  const p = seed();
  const s = scene0(p);
  const audio = one(p, {
    op: "add_element",
    sceneId: s.id,
    element: { kind: "audio", src: "/assets/x.wav", muted: true },
  }).project.scenes[0].elements![0];
  assert.equal(audio.muted, true);
});

/* ────────────────────────── 主题 / 音频 / 画幅 / 工程 ────────────────────────── */

test("set_theme：只覆盖给出的字段", () => {
  const p = seed();
  const { project } = one(p, { op: "set_theme", palette: { primary: "#123456" }, radius: 3 });
  assert.equal(project.theme.palette.primary, "#123456");
  assert.equal(project.theme.palette.background, p.theme.palette.background);
  assert.equal(project.theme.radius, 3);
});

test("set_audio：音量夹到 0-5（>1 是放大，不是非法值）", () => {
  const p = seed();
  const loud = one(p, { op: "set_audio", audio: { src: "/a.wav", volume: 9, fadeIn: -3, fadeOut: 0 } })
    .project;
  assert.equal(loud.audio?.volume, 5);
  assert.equal(loud.audio?.fadeIn, 0);
  // 放大到 3 倍要原样保留：救小音量素材全靠它
  const boosted = one(p, { op: "set_audio", audio: { src: "/a.wav", volume: 3, fadeIn: 0, fadeOut: 0 } }).project;
  assert.equal(boosted.audio?.volume, 3);
  const cleared = one(loud, { op: "set_audio", audio: null }).project;
  assert.equal(cleared.audio, undefined);
});

test("set_audio：只传要改的字段（合并语义），gainCurve 传 null 才清（N-B）", () => {
  const p = seed();
  const curve = { stepMs: 100, values: [1, 2, 3], targetLufs: -23, ratio: 3 };
  const withCurve = one(p, {
    op: "set_audio",
    audio: { src: "/a.wav", volume: 1, fadeIn: 0, fadeOut: 0, gainCurve: curve },
  }).project;
  assert.deepEqual(withCurve.audio?.gainCurve?.values, [1, 2, 3]);
  // 只改音量：曲线必须留着（以前是全量替换，改音量顺手把压缩成果抹掉）
  const louder = one(withCurve, {
    op: "set_audio",
    audio: { src: "/a.wav", volume: 2 },
  }).project;
  assert.equal(louder.audio?.volume, 2);
  assert.deepEqual(louder.audio?.gainCurve?.values, [1, 2, 3]);
  // 显式传 null 才清
  const cleared = one(louder, {
    op: "set_audio",
    audio: { src: "/a.wav", gainCurve: null } as never,
  }).project;
  assert.equal(cleared.audio?.gainCurve, undefined);
  assert.equal(cleared.audio?.volume, 2);
});

test("set_audio：durationInFrames 传 null 才清掉「只播一段」", () => {
  const p = seed();
  const withDur = one(p, {
    op: "set_audio",
    audio: { src: "/a.wav", durationInFrames: 90 },
  }).project;
  assert.equal(withDur.audio?.durationInFrames, 90);
  // 只改音量：时长留着（合并语义）
  const volOnly = one(withDur, { op: "set_audio", audio: { src: "/a.wav", volume: 2 } }).project;
  assert.equal(volOnly.audio?.durationInFrames, 90);
  const cleared = one(volOnly, {
    op: "set_audio",
    audio: { src: "/a.wav", durationInFrames: null } as never,
  }).project;
  assert.equal(cleared.audio?.durationInFrames, undefined);
});

test("set_audio：字段名拼错直接报错，不产生 NaN / null（N-B）", () => {  const p = seed();
  assert.throws(
    () => one(p, { op: "set_audio", audio: { src: "/a.wav", volume2: 2 } as never }),
    /audio里有不认识的字段：volume2（是不是想写 volume？）/,
  );
  // 只传 src：其余字段要落到安全默认值，不能是 undefined → JSON null
  const { project } = one(p, { op: "set_audio", audio: { src: "/a.wav" } as never });
  assert.equal(project.audio?.volume, 1);
  assert.equal(project.audio?.fadeIn, 0);
  assert.equal(project.audio?.fadeOut, 0);
});

test("update_scene：patch 顶层写 props 字段也能生效（N-A 的常见写法）", () => {
  const p = seed();
  const s = scene0(p);
  const { project, summary } = one(p, {
    op: "update_scene",
    sceneId: s.id,
    patch: { title: "复验标题" } as never,
  });
  assert.equal((project.scenes[0].props as Record<string, unknown>).title, "复验标题");
  assert.ok(summary.some((x) => x.includes("按 props 处理")));
});

test("update_scene：完全不认识的 patch 字段直接报错（以前静默无效）", () => {
  const p = seed();
  const s = scene0(p);
  assert.throws(
    () =>
      one(p, {
        op: "update_scene",
        sceneId: s.id,
        patch: { titel: "写错的字段" } as never,
      }),
    /patch里有不认识的字段：titel（是不是想写 title？）/,
  );
});

test("applyOps：写不进数据的 op 必须在 summary 里 ⚠ 报出来", () => {
  const p = seed();
  const s = scene0(p);
  // 把 title 改成当前值：数据前后完全一致 → 幂等重试的合法情况，但必须说出来
  const cur = (p.scenes[0].props as Record<string, unknown>).title as string;
  const { summary } = one(p, {
    op: "update_scene",
    sceneId: s.id,
    patch: { props: { title: cur } },
  });
  assert.ok(summary.some((x) => x.includes("没有产生任何数据变更")), summary.join(" | "));
});

test("add_audio_track：生成 id 与默认值", () => {
  const p = seed();
  const { project } = one(p, { op: "add_audio_track", clip: { src: "/assets/a.wav" } });
  const track = project.audioTracks?.[0];
  assert.ok(track);
  assert.match(track!.id, /^au_/);
  assert.equal(track!.name, "音效");
  assert.equal(track!.from, 0);
  assert.equal(track!.volume, 1);
  assert.equal(track!.fadeIn, 0);
});

test("add_audio_track：可指定起点 / 音量 / 名称", () => {
  const p = seed();
  const { project } = one(p, {
    op: "add_audio_track",
    clip: { src: "/assets/a.wav", name: "转场音", from: 30, volume: 0.5, fadeIn: 0.3 },
  });
  const track = project.audioTracks![0];
  assert.equal(track.name, "转场音");
  assert.equal(track.from, 30);
  assert.equal(track.volume, 0.5);
  assert.equal(track.fadeIn, 0.3);
});

test("update_audio_track：合并且越界音量被 schema 拒绝（上限 5）", () => {
  const p = seed();
  const withTrack = one(p, { op: "add_audio_track", clip: { src: "/assets/a.wav" } }).project;
  const id = withTrack.audioTracks![0].id;
  const updated = one(withTrack, {
    op: "update_audio_track",
    trackId: id,
    patch: { volume: 0.4, from: 30 },
  }).project;
  assert.equal(updated.audioTracks![0].volume, 0.4);
  assert.equal(updated.audioTracks![0].from, 30);
  // 2 倍是允许的（放大），超过 5 才拒绝
  const boosted = one(withTrack, { op: "update_audio_track", trackId: id, patch: { volume: 2 } }).project;
  assert.equal(boosted.audioTracks![0].volume, 2);
  assert.throws(() => one(withTrack, { op: "update_audio_track", trackId: id, patch: { volume: 9 } }));
});

test("update_audio_track：gainCurve 传 null = 清除，不传 = 保持", () => {
  const p = seed();
  const withTrack = one(p, { op: "add_audio_track", clip: { src: "/assets/a.wav" } }).project;
  const id = withTrack.audioTracks![0].id;
  const curve = { stepMs: 100, values: [0.5, 1.5], targetLufs: -18 };
  const applied = one(withTrack, { op: "update_audio_track", trackId: id, patch: { gainCurve: curve } }).project;
  assert.deepEqual(applied.audioTracks![0].gainCurve?.values, [0.5, 1.5]);
  // 只改音量：曲线要留着（压缩成果不该被音量操作抹掉）
  const kept = one(applied, { op: "update_audio_track", trackId: id, patch: { volume: 0.8 } }).project;
  assert.ok(kept.audioTracks![0].gainCurve, "只改音量时曲线应保留");
  const cleared = one(kept, { op: "update_audio_track", trackId: id, patch: { gainCurve: null } }).project;
  assert.equal(cleared.audioTracks![0].gainCurve, undefined);
});

test("update_audio_track / remove_audio_track：未知 id 抛错", () => {
  const p = seed();
  assert.throws(() => one(p, { op: "update_audio_track", trackId: "nope", patch: { volume: 0.5 } }));
  assert.throws(() => one(p, { op: "remove_audio_track", trackId: "nope" }));
});

test("remove_audio_track：删到空时字段整个移除", () => {
  const p = seed();
  const withTrack = one(p, { op: "add_audio_track", clip: { src: "/assets/a.wav" } }).project;
  const id = withTrack.audioTracks![0].id;
  const removed = one(withTrack, { op: "remove_audio_track", trackId: id }).project;
  assert.equal(removed.audioTracks, undefined);
});

test("restore：撤销 / 回滚能恢复音效轨", () => {
  const p = seed();
  const withTrack = one(p, { op: "add_audio_track", clip: { src: "/assets/a.wav" } }).project;
  const snapshot = {
    scenes: withTrack.scenes,
    theme: withTrack.theme,
    name: withTrack.name,
    audio: withTrack.audio,
    audioTracks: withTrack.audioTracks,
  };
  const cleared = one(withTrack, {
    op: "remove_audio_track",
    trackId: withTrack.audioTracks![0].id,
  }).project;
  assert.equal(cleared.audioTracks, undefined);
  const restored = one(cleared, { op: "restore", project: snapshot }).project;
  assert.equal(restored.audioTracks?.length, 1);
});

test("set_formats：去重、取整，并拒绝空数组", () => {
  const p = seed();
  const { project } = one(p, {
    op: "set_formats",
    formats: [
      { key: "portrait", label: "竖屏", width: 1080.4, height: 1920 },
      { key: "portrait", label: "重复", width: 1, height: 1 },
      { key: "square", label: "方形", width: 1080, height: 1080 },
    ],
  });
  assert.equal(project.formats.length, 2);
  assert.equal(project.formats[0].width, 1080);
  assert.throws(() => one(p, { op: "set_formats", formats: [] }), /至少保留一种画幅/);
});

test("update_project：fps 取整且至少 1", () => {
  const { project } = one(seed(), { op: "update_project", patch: { name: "改名", fps: 24.6 } });
  assert.equal(project.name, "改名");
  assert.equal(project.fps, 25);
  const low = one(seed(), { op: "update_project", patch: { fps: 0 } }).project;
  assert.equal(low.fps, 1);
});

test("restore：回滚内容但 rev 继续前进", () => {
  const p = seed();
  const snapshot = { scenes: p.scenes, theme: p.theme, name: p.name, audio: p.audio };
  const changed = one(p, { op: "update_project", patch: { name: "被改掉" } }).project;
  const { project } = one(changed, { op: "restore", project: snapshot, label: "撤销改名" });
  assert.equal(project.name, p.name);
  assert.equal(project.rev, changed.rev + 1);
});

/* ────────────────────────── 通用性质 ────────────────────────── */

test("rev 每次 +1，updatedAt 更新时间", () => {
  const p = seed();
  const { project } = one(p, { op: "update_project", patch: { name: "x" } });
  assert.equal(project.rev, p.rev + 1);
  assert.ok(typeof project.updatedAt === "string");
});

test("纯函数：不修改传入的 project", () => {
  const p = seed();
  const before = JSON.stringify(p);
  applyOps(p, [{ op: "remove_scene", sceneId: p.scenes[0].id }]);
  assert.equal(JSON.stringify(p), before);
});

test("未知 op 抛错（穷尽性兜底）", () => {
  assert.throws(
    () => applyOps(seed(), [{ op: "nope" } as unknown as Op]),
    /不支持的操作/,
  );
});

test("createSeedProject：不传 id 不会生成 demo，且两次不同", () => {
  const a = createSeedProject();
  const b = createSeedProject();
  assert.notEqual(a.id, "demo");
  assert.notEqual(b.id, "demo");
  assert.notEqual(a.id, b.id);
  assert.ok(a.scenes.length > 0);
});

test("createSeedProject：显式传 id 才使用该 id", () => {
  assert.equal(createSeedProject("demo").id, "demo");
});

/* ────────────────────────── 静默丢弃警告（踩坑清单第 2 轮 §1.1） ────────────────────────── */

test("update_element：patch 塞 anim 被丢弃时必须 ⚠ 报出来", () => {
  const p = seed();
  const r = one(p, { op: "add_element", sceneId: scene0(p).id, element: { kind: "text", text: "x" } });
  const elId = (scene0(r.project) as unknown as { elements: { id: string }[] }).elements[0].id;
  const r2 = one(r.project, {
    op: "update_element",
    sceneId: scene0(p).id,
    elementId: elId,
    patch: { opacity: 0.5, anim: [{ at: [0, 20] }] },
  } as unknown as Op);
  const warned = r2.summary.some((s) => s.includes("anim") && s.includes("丢弃"));
  assert.ok(warned, `summary 应包含丢弃警告，实际：${JSON.stringify(r2.summary)}`);
  // 数据里确实没有 anim（zod strip 生效）
  const el = (scene0(r2.project) as unknown as { elements: Record<string, unknown>[] }).elements[0];
  assert.ok(!("anim" in el), "anim 不应出现在叠加层元素上");
  assert.equal(el.opacity, 0.5, "已知字段正常生效");
});

test("update_freeform_element：patch 塞未知字段直接报错（不静默）", () => {
  const p = seed();
  const r = one(p, {
    op: "add_scene",
    type: "freeform",
    props: { elements: [{ id: "f0", type: "text", text: "基" }] },
  } as unknown as Op);
  const sc = r.project.scenes[r.project.scenes.length - 1];
  assert.throws(
    () =>
      one(r.project, {
        op: "update_freeform_element",
        sceneId: sc.id,
        elementId: "f0",
        patch: { text: "改", notAField: 1 },
      } as unknown as Op),
    /notAField/,
  );
  // 已知字段单独改仍正常
  const r2 = one(r.project, {
    op: "update_freeform_element",
    sceneId: sc.id,
    elementId: "f0",
    patch: { text: "改" },
  } as unknown as Op);
  const el = (r2.project.scenes[r2.project.scenes.length - 1].props as { elements: Record<string, unknown>[] })
    .elements[0];
  assert.equal(el.text, "改");
});

/* ────────────────────────── add/remove_freeform_element ────────────────────────── */

const withFree = () => {
  const p = seed();
  const r = one(p, {
    op: "add_scene",
    type: "freeform",
    props: { elements: [{ id: "f0", type: "text", text: "基" }] },
  } as unknown as Op);
  return { project: r.project, sc: r.project.scenes[r.project.scenes.length - 1] };
};

test("add_freeform_element：非 freeform 场景报错并指路", () => {
  const { project, sc } = withFree();
  const normal = project.scenes.find((s) => s.id !== sc.id)!;
  assert.throws(
    () => one(project, { op: "add_freeform_element", sceneId: normal.id, element: { type: "text" } } as unknown as Op),
    /set_scene_type|add_element/,
  );
});

test("add_freeform_element：成功追加并自动编 id", () => {
  const { project, sc } = withFree();
  const r = one(project, {
    op: "add_freeform_element",
    sceneId: sc.id,
    element: { type: "svg", svg: "<svg/>", viewBox: "0 0 920 420" },
  } as unknown as Op);
  const els = (r.project.scenes[r.project.scenes.length - 1].props as { elements: { id: string }[] }).elements;
  assert.equal(els.length, 2);
  assert.equal(els[1].id, "f1", "自动 id 应接着现有编号");
  assert.ok(r.summary.some((s) => s.includes("f1")));
});

test("add_freeform_element：未知字段直接报错（不静默）", () => {
  const { project, sc } = withFree();
  assert.throws(
    () =>
      one(project, {
        op: "add_freeform_element",
        sceneId: sc.id,
        element: { type: "text", bogusField: 1 },
      } as unknown as Op),
    /bogusField|不合法|无法识别|无效|Invalid|expected/i,
  );
});

test("add_freeform_element：上限 40 报错", () => {
  const { project, sc } = withFree();
  const els = Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, type: "text" as const, text: `t${i}` }));
  const r = one(project, {
    op: "update_scene",
    sceneId: sc.id,
    patch: { props: { elements: els } },
  } as unknown as Op);
  assert.throws(
    () =>
      one(r.project, {
        op: "add_freeform_element",
        sceneId: sc.id,
        element: { type: "text", text: "第 41 个" },
      } as unknown as Op),
    /上限/,
  );
});

test("remove_freeform_element：按 id 删，报剩余数", () => {
  const { project, sc } = withFree();
  const r = one(project, {
    op: "add_freeform_element",
    sceneId: sc.id,
    element: { id: "f9", type: "text", text: "删我" },
  } as unknown as Op);
  const r2 = one(r.project, { op: "remove_freeform_element", sceneId: sc.id, elementId: "f9" } as unknown as Op);
  const els = (r2.project.scenes[r2.project.scenes.length - 1].props as { elements: { id: string }[] }).elements;
  assert.equal(els.length, 1);
  assert.ok(r2.summary.some((s) => s.includes("剩余 1")));
});

test("remove_freeform_element：只剩最后一个时报错", () => {
  const { project, sc } = withFree();
  assert.throws(
    () => one(project, { op: "remove_freeform_element", sceneId: sc.id, elementId: "f0" } as unknown as Op),
    /最后一个|set_scene_type/,
  );
});

test("回归：add_element 仍写 scene.elements（死代码清理未破坏行为）", () => {
  const p = seed();
  const r = one(p, { op: "add_element", sceneId: scene0(p).id, element: { kind: "text", text: "x" } });
  const s0 = scene0(r.project) as unknown as { elements?: unknown[] };
  assert.equal(s0.elements?.length, 1);
  assert.equal((r.project as unknown as { overlays?: unknown[] }).overlays, undefined);
});

/* ────────────────────────── set_transform 目标校验（验证报告 P0-03） ────────────────────────── */

test("set_transform：缺 target 直接报错（不写 transforms[undefined]）", () => {
  const p = seed();
  assert.throws(
    () => one(p, { op: "set_transform", sceneId: scene0(p).id, target: undefined as never, transform: { x: 5 } }),
    /缺少 target/,
  );
});

test("set_transform：未知元素 id 报错并列出可用元素", () => {
  const p = seed();
  assert.throws(
    () => one(p, { op: "set_transform", sceneId: scene0(p).id, target: "not_an_element", transform: { x: 5 } }),
    /没有元素「not_an_element」/,
  );
});

test("set_transform：子元素写法（title.text）仍然合法", () => {
  const p = seed();
  const r = one(p, { op: "set_transform", sceneId: scene0(p).id, target: "title.text", transform: { x: 5 } });
  assert.ok(r.project.scenes[0].transforms?.["title.text"]);
});

test("回归锁：applyOps 的 switch 里不得有重名 case（死代码曾两次潜伏）", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "shared", "ops.ts"), "utf8");
  const names = [...src.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.equal(dup.join(","), "");
});

/* ────────────────────────── 字幕样式与画中画（验证报告 v2 N-02/N-03/N-13） ────────────────────────── */

test("set_subtitle：bold 传布尔归一成数字字重（否则导出包导入失败）", () => {
  const p = seed();
  const s = scene0(p);
  const r = one(p, { op: "set_subtitle", sceneId: s.id, style: { bold: true } as never });
  const style = r.project.scenes[0].subtitleStyle as unknown as { bold: number };
  assert.equal(style.bold, 700);
  assert.equal(typeof style.bold, "number");
});

test("set_subtitle：fontWeight 别名映射到 bold，数字夹到 100–900", () => {
  const p = seed();
  const s = scene0(p);
  const a = one(p, { op: "set_subtitle", sceneId: s.id, style: { fontWeight: 800 } as never });
  assert.equal((a.project.scenes[0].subtitleStyle as never as { bold: number }).bold, 800);
  const b = one(p, { op: "set_subtitle", sceneId: s.id, style: { bold: 5000 } as never });
  assert.equal((b.project.scenes[0].subtitleStyle as never as { bold: number }).bold, 900);
});

test("set_subtitle：样式里不合法类型直接报错（不让脏数据进工程）", () => {
  const p = seed();
  const s = scene0(p);
  assert.throws(
    () => one(p, { op: "set_subtitle", sceneId: s.id, style: { color: 123 } as never }),
    /字幕样式不合法/,
  );
});

test("set_scene_box：缺 box 报错（不再静默恢复全屏）", () => {
  const p = seed();
  const s = scene0(p);
  assert.throws(
    () => one(p, { op: "set_scene_box", sceneId: s.id, box: undefined as never }),
    /缺少 box/,
  );
});

test("set_scene_box：空对象报错，box:null 才是恢复全屏", () => {
  const p = seed();
  const s = scene0(p);
  assert.throws(() => one(p, { op: "set_scene_box", sceneId: s.id, box: {} }), /空对象/);
  const r = one(p, { op: "set_scene_box", sceneId: s.id, box: null });
  assert.equal(r.project.scenes[0].box, undefined);
});

test("set_scene_box：scale 被夹取时写进 summary（不静默）", () => {
  const p = seed();
  const s = scene0(p);
  const r = one(p, { op: "set_scene_box", sceneId: s.id, box: { scale: 2 } });
  assert.equal(r.project.scenes[0].box?.scale, 1);
  assert.ok(r.summary.join("；").includes("已夹到"), r.summary.join("；"));
});

test("场景时长被夹取时 summary 有提示", () => {
  const p = seed();
  const s = scene0(p);
  const r = one(p, { op: "set_scene_timing", sceneId: s.id, durationInFrames: 3 });
  assert.ok(r.summary.join("；").includes("已夹到"), r.summary.join("；"));
});

/* ────────────────────────── op 字段白名单（C1 回归锁） ────────────────────────── */

test("未知字段直接拒绝（不再静默丢弃）", () => {
  const p = seed();
  const s = scene0(p);
  assert.throws(
    () => one(p, { op: "set_scene_timing", sceneId: s.id, durationInFrames: 100, bogusField: 1 } as never),
    /未知字段.*bogusField/,
  );
  // 报错要带「第 N 个操作」定位（批量时的核心诉求）
  assert.throws(
    () =>
      applyOps(p, [
        { op: "set_scene_timing", sceneId: s.id, durationInFrames: 100 },
        { op: "set_scene_timing", sceneId: s.id, durationInFrames: 120 },
        { op: "set_audio", volume2: 2 } as never,
      ]),
    /第 3\/3 个操作（set_audio）.*未知字段.*volume2/,
  );
});

test("set_audio 缺 audio 字段报错而不是崩（C1：曾崩在 op.audio.ducking）", () => {
  assert.throws(() => one(seed(), { op: "set_audio" } as never), /缺少 audio 字段/);
  // audio:null（清除）仍然合法
  const r = one(seed(), { op: "set_audio", audio: null });
  assert.equal(r.project.audio, undefined);
});

/* ────────────────────────── 汇总 ────────────────────────── */

console.log("");
if (failures.length) {
  console.error(`\x1b[31m${failures.length} 个用例失败\x1b[0m（通过 ${passed} 个）`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\x1b[32m全部通过\x1b[0m：${passed} 个用例`);
