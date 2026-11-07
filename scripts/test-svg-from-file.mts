/**
 * svgSrcFile（大 SVG 文件引用）解引用链路测试。
 *
 *   npm test
 *
 * 背景：手绘白片的 SVG 路径 6k–21k 字符，内联进工具调用易错、Read 单行 >2000
 * 截断。svgSrcFile 让 agent 写文件、服务端读——这里钉住解引用的形状与四道闸
 * （绝对路径/扩展名/体积/冲突），最后走真实 Project.apply 漏斗验证落盘产物。
 *
 * 注意：STUDIO_DATA_ROOT 必须在 project.service（→ paths.ts）模块加载**之前**
 * 设置，所以漏斗依赖用动态 import，环境变量在最顶部先落。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freeElSchema } from "../shared/freeform";
import { elementSchema } from "../shared/schema";
import { resolveElementFromFile } from "../server/element-from-file";
import type { Op } from "../shared/ops";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svg-from-file-"));
const dataRoot = path.join(dir, "data");
process.env.STUDIO_DATA_ROOT = dataRoot;

// 动态 import：保证 env 先于 paths.ts 的模块加载
const { projects } = await import("../server/project.service");
const { createSeedProject } = await import("../shared/ops");

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

const writeSvg = (name: string, content: string): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
};
const SVG = '<path d="M0 0 L10 10" stroke="#333"/>';

test("注入 + 剥键：svgSrcFile 解析成 svg，路径键不残留", () => {
  const file = writeSvg("s1.svg", SVG);
  const ops = [
    { op: "add_freeform_element", sceneId: "s", element: { type: "svg", svgSrcFile: file, viewBox: "0 0 24 24" } },
  ] as unknown as Op[];
  const notes = resolveElementFromFile(ops);
  const el = (ops[0] as { element: Record<string, unknown> }).element;
  assert.equal(el.svg, SVG, "svg 没被注入");
  assert.ok(!("svgSrcFile" in el), "svgSrcFile 残留在元素上（会随 project.json 落盘）");
  assert.match(notes[0], /s1\.svg/, "回执确认行没报文件名");
  assert.match(notes[0], /字符/, "回执确认行没报大小");
});

test("add_scene 的 props.elements 形状也能解（deep-visit 不分 op 类型）", () => {
  const file = writeSvg("s2.svg", SVG);
  const ops = [
    {
      op: "add_scene",
      type: "freeform",
      props: { elements: [{ type: "svg", svgSrcFile: file }, { type: "text", text: "hi" }] },
    },
  ] as unknown as Op[];
  resolveElementFromFile(ops);
  const els = (ops[0] as { props: { elements: Record<string, unknown>[] } }).props.elements;
  assert.equal(els[0].svg, SVG);
  assert.ok(!("svgSrcFile" in els[0]));
  assert.ok(!("svg" in els[1]), "解引用串味了：没引用文件的元素被塞了 svg");
});

test("update_freeform_element / update_element 的 patch 两条通道都通", () => {
  const f1 = writeSvg("p1.svg", SVG);
  const f2 = writeSvg("p2.svg", SVG);
  const ops = [
    { op: "update_freeform_element", sceneId: "s", index: 0, patch: { svgSrcFile: f1 } },
    { op: "update_element", sceneId: "s", elementId: "e1", patch: { svgSrcFile: f2 } },
  ] as unknown as Op[];
  resolveElementFromFile(ops);
  assert.equal((ops[0] as { patch: Record<string, unknown> }).patch.svg, SVG);
  assert.equal((ops[1] as { patch: Record<string, unknown> }).patch.svg, SVG);
});

test("XML 声明 / DOCTYPE 被剥掉，内容 trim", () => {
  const file = writeSvg("doc.svg", `<?xml version="1.0"?>\n<!DOCTYPE svg>\n  ${SVG}  \n`);
  const ops = [{ op: "add_freeform_element", sceneId: "s", element: { type: "svg", svgSrcFile: file } }] as unknown as Op[];
  resolveElementFromFile(ops);
  const el = (ops[0] as { element: Record<string, unknown> }).element;
  assert.equal(el.svg, SVG);
});

test("四道闸：相对路径 / 不存在 / 超体积 / svg 冲突，各自报错", () => {
  const big = path.join(dir, "big.svg");
  fs.writeFileSync(big, "x".repeat(201 * 1024), "utf8");
  const okFile = writeSvg("ok.svg", SVG);
  const cases: [Op[], RegExp][] = [
    [{ op: "add_freeform_element", sceneId: "s", element: { type: "svg", svgSrcFile: "tmp/rel.svg" } } as unknown as Op, /绝对路径/],
    [{ op: "add_freeform_element", sceneId: "s", element: { type: "svg", svgSrcFile: path.join(dir, "nope.svg") } } as unknown as Op, /不存在/],
    [{ op: "add_freeform_element", sceneId: "s", element: { type: "svg", svgSrcFile: big } } as unknown as Op, /200KB/],
    [{ op: "add_freeform_element", sceneId: "s", element: { type: "svg", svg: SVG, svgSrcFile: okFile } } as unknown as Op, /二选一/],
  ];
  for (const [op, pattern] of cases) {
    assert.throws(() => resolveElementFromFile([op]), pattern, `期望报错匹配 ${pattern}`);
  }
});

test("两个 schema 都认识 svgSrcFile：freeElSchema（strict）不拒、elementSchema 不静默丢", () => {
  // freeform 通道是 strict()：字段没进 schema 会直接报错——这里必须能通过
  const free = freeElSchema.safeParse({ type: "svg", svgSrcFile: "D:/x.svg", x: 1, y: 1 });
  assert.ok(free.success, `freeElSchema 拒了 svgSrcFile：${free.success ? "" : free.error!.issues[0].message}`);
  // 叠加层通道是默认剥离行为：字段没进 schema 会被静默丢——解析后键必须还在
  const overlay = elementSchema.parse({ id: "e", name: "e", kind: "svg", svgSrcFile: "D:/x.svg" });
  assert.equal(overlay.svgSrcFile, "D:/x.svg", "elementSchema 把 svgSrcFile 静默丢了（元素会变空 svg 且零报错）");
});

test("端到端：走真实 Project.apply 漏斗，落盘工程里 svg 已注入、无 svgSrcFile 残留", () => {
  const seed = createSeedProject();
  projects.replace(seed);
  const file = writeSvg("e2e.svg", SVG);
  const res = projects.apply(seed.id, [
    {
      op: "add_scene",
      type: "freeform",
      name: "手绘第 1 幕",
      props: { elements: [{ type: "svg", svgSrcFile: file, viewBox: "0 0 24 24" }] },
    },
  ] as unknown as Op[], { actor: "test" });
  assert.ok(
    res.summary.some((l) => l.includes("e2e.svg")),
    `回执 summary 没带注入确认：${res.summary.join(" | ")}`,
  );
  // 直接读盘（绕过内存缓存），验证的就是 agent/编辑器将来打开会看到的东西。
  // 工程落 dataRoot/projects/<id>/（PROJECTS_ROOT），不是 dataRoot 根下
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataRoot, "projects", seed.id, "project.json"), "utf8")) as {
    scenes: { props?: { elements?: Record<string, unknown>[] } }[];
  };
  const ff = onDisk.scenes.find((s) => s.props?.elements?.length);
  assert.ok(ff, "freeform 场景没落盘");
  const el = ff.props!.elements![0];
  assert.equal(el.svg, SVG, "落盘元素没有 svg 内容");
  assert.ok(!("svgSrcFile" in el), "svgSrcFile 残留在落盘数据里");
});

try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}

console.log(`\n${failures.length ? `✗ ${failures.length} 项失败：${failures.join("、")}` : "全部通过"}（${passed} 过 / ${failures.length} 败）`);
if (failures.length) process.exit(1);
