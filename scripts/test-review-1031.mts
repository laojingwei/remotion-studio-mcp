/**
 * 2026-10-31 复盘整改的回归测试（纯函数 + 参数校验，不需要浏览器）。
 *
 * 覆盖四件事，每一件都对应一次真实事故：
 *  1. 嵌套字段写错名不再"假成功"（segments.dur 那次试了四次）；
 *  2. 退役字段给出明确替代名（mustInclude / delivery）；
 *  3. 自由画布的文本与字号能被审计看见（8 幕 95 个元素全在 props 里，审计却一条没读到）；
 *  4. 画幅可以只写 key（"portrait" 不再报 Expected object）。
 */
import assert from "node:assert/strict";
import { TOOLS, validateToolArgs } from "../server/mcp-tools";
import { sceneAuditElements } from "../shared/sceneElements";
import { freeElSchema } from "../shared/freeform";
import { legacyFieldNotice, stepMissingDetail } from "../server/brief.service";

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

const tool = (name: string) => {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`没有工具 ${name}`);
  return t;
};

console.log("[param-guard] 嵌套字段名写错要拒绝并指路");
test("segments[].dur 报错，并建议 startSec/endSec", () => {
  assert.throws(
    () => validateToolArgs(tool("save_brief"), { segments: [{ dur: 0, end: 3, content: "钩子" }] }),
    (e: Error) => /segments\[0\]\.dur/.test(e.message) && /startSec/.test(e.message),
  );
});
test("正确写法（startSec/endSec）能过", () => {
  const ok = validateToolArgs(tool("save_brief"), {
    segments: [{ startSec: 0, endSec: 3, content: "钩子" }],
  });
  assert.ok(Array.isArray(ok.segments));
});

console.log("\n[param-guard] 退役字段要给出替代名");
test("mustInclude → 提示改用 mustInfo", () => {
  assert.throws(
    () => validateToolArgs(tool("save_brief"), { mustInclude: ["370"] }),
    /已退役.*mustInfo/,
  );
});
test("delivery → 提示改用 deliverables", () => {
  assert.throws(
    () => validateToolArgs(tool("save_brief"), { delivery: "竖屏" }),
    /已退役.*deliverables/,
  );
});

console.log("\n[param-guard] elementId 收数字要指向 index");
test("elementId: 13 报「按下标请用 index」", () => {
  assert.throws(
    () => validateToolArgs(tool("update_freeform_element"), { sceneId: "s", elementId: 13, patch: {} }),
    /index/,
  );
});

console.log("\n[param-guard] 画幅简写");
test("formats 收 \"portrait\" 字符串", () => {
  const ok = validateToolArgs(tool("set_formats"), { formats: "portrait" });
  assert.equal(ok.formats, "portrait");
});
test("formats 收 [\"portrait\",\"square\"]", () => {
  const ok = validateToolArgs(tool("set_formats"), { formats: ["portrait", "square"] });
  assert.deepEqual(ok.formats, ["portrait", "square"]);
});

console.log("\n[audit-visibility] 自由画布元素要能被审计看见");
test("props.elements 的文本进审计视图", () => {
  const scene = {
    type: "freeform",
    props: { elements: [{ type: "text", text: "370 元" }] },
    elements: [{ id: "el1", kind: "text", text: "字幕里的话" }],
  };
  const els = sceneAuditElements(scene);
  const texts = els.map((e) => e.text);
  assert.ok(texts.includes("370 元"), "props 里的文本丢了");
  assert.ok(texts.includes("字幕里的话"), "叠加层文本丢了");
});
test("freeform 的 text 映射成 kind=text，字号取 size", () => {
  const els = sceneAuditElements({
    type: "freeform",
    props: { elements: [{ type: "text", text: "巨字", size: 19 }] },
  });
  assert.equal(els[0].kind, "text");
  assert.equal(els[0].size, 19);
});
test("fx / shape 不会被当成文字元素", () => {
  const els = sceneAuditElements({
    type: "freeform",
    props: { elements: [{ type: "fx" }, { type: "shape", shape: "rect" }] },
  });
  assert.equal(els.filter((e) => e.kind === "text").length, 0);
});

console.log("\n[freeform] width/height 可单独给，存量行为不变");
test("只给 size 时 schema 仍能过（存量元素不变）", () => {
  const r = freeElSchema.safeParse({ type: "shape", shape: "rect", size: 30 });
  assert.ok(r.success);
});
test("width/height 被接受", () => {
  const r = freeElSchema.safeParse({ type: "shape", shape: "rect", size: 76, width: 76, height: 20 });
  assert.ok(r.success);
});

console.log("\n[brief] 缺项要指名，老字段退役要说明");
test("空 brief 的第 5 步缺 mustInfo（带 key）", () => {
  const miss = stepMissingDetail(5, {} as never);
  assert.equal(miss[0]?.key, "mustInfo");
});
test("空数组也算没填", () => {
  const miss = stepMissingDetail(5, { mustInfo: [] } as never);
  assert.equal(miss.length, 1);
});
test("只有老字段的 brief 给出退役提示", () => {
  const notice = legacyFieldNotice({ mustInclude: ["370"], delivery: "竖屏" } as never);
  assert.ok(notice && /已退役/.test(notice) && /第 5 步/.test(notice) && /第 8 步/.test(notice));
});
test("新字段齐全时不打扰", () => {
  const notice = legacyFieldNotice({
    mustInfo: [{ text: "370" }],
    deliverables: [{ type: "主片", spec: "1080×1920" }],
  } as never);
  assert.equal(notice, null);
});

console.log(`\n${failures.length ? "FAILED" : "全部通过"}：${passed} 个用例`);
if (failures.length) {
  console.error(`失败：${failures.join("、")}`);
  process.exit(1);
}
