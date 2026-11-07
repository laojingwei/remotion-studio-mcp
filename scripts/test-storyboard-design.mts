/**
 * 分镜「设计体检」的契约测试。
 *
 * 为什么要有：`storyboardDesignNotes` 是"逐句贴卡"的唯一早期拦截点。它失效不会报错，
 * 只会安静地什么都不说——而"什么都没说"看起来和"这版分镜很好"一模一样。
 * 所以把三种触发条件和"不误报"钉成断言。
 *
 * 覆盖：
 *   1. 一幕都没标 relation → 必须提示
 *   2. plain + 未标 过半 → 必须提示
 *   3. note/change 里的空词 → 按词聚合提示（同一个词三幕只说一次）
 *   4. 干净分镜 → 只出通用自检一条（不能一条都不出，也不能刷屏）
 *   5. relation 是枚举：乱写要被 schema 挡住
 *   6. storyboardToText 要把关系标签渲染出来（否则用户看不出这幕承担了什么）
 */
import assert from "node:assert/strict";
import { SHOT_RELATIONS, storyboardDesignNotes, storyboardToText, type Shot } from "../server/storyboard.service";

let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  [ok] ${name}`);
  } catch (err) {
    failed++;
    console.log(`  [fail] ${name}\n        ${err instanceof Error ? err.message : String(err)}`);
  }
};

const mk = (n: number, relation?: Shot["relation"], note?: string): Shot[] =>
  Array.from({ length: n }, () => ({ type: "bigtext", relation, note }));

console.log("设计体检触发条件");
check("一幕都没标 relation → 提示逐句贴卡", () => {
  const { lines } = storyboardDesignNotes(mk(3));
  assert.ok(
    lines.some((l) => l.includes("没有一幕标了 relation")),
    "没提示 = 逐句贴卡不会被拦住",
  );
});

check("plain + 未标 过半 → 提示过半是换页", () => {
  const shots: Shot[] = [{ type: "a", relation: "cause" }, ...mk(3, "plain")];
  const { lines, relationCount, plainCount } = storyboardDesignNotes(shots);
  assert.equal(relationCount, 1);
  assert.equal(plainCount, 3);
  assert.ok(lines.some((l) => l.includes("承担关系的只有 1/4")), "没提示过半");
});

check("空词按词聚合，同一个词三幕只报一次", () => {
  const { lines } = storyboardDesignNotes(mk(3, "cause", "这里要丝滑一点，做得大气"));
  const hit = lines.find((l) => l.includes("无法执行")) ?? "";
  assert.ok(hit.includes("丝滑"), "漏了空词");
  assert.equal(hit.split("丝滑").length - 1, 1, "同一个词被重复列了三次，会被当噪音跳过");
  assert.ok(hit.includes("第 1/2/3 幕"), "没告诉在哪几幕");
});

check("干净分镜只出通用自检一条（不刷屏也不沉默）", () => {
  const { lines } = storyboardDesignNotes([
    { type: "compare", relation: "contrast", note: "两状态同一单位，左灰右亮，0.6 秒错开" },
    { type: "linechart", relation: "accumulate", note: "0→12 万，2 秒" },
  ]);
  assert.equal(lines.length, 1, `应只有 1 条，实际 ${lines.length} 条`);
  assert.ok(lines[0].includes("自检两条"));
});

check("2 幕以下不刷提示（单幕片没有关系可言）", () => {
  assert.deepEqual(storyboardDesignNotes(mk(1)).lines, []);
});

console.log("字段与渲染");
check("relation 是枚举，乱写要被挡住", () => {
  assert.ok(SHOT_RELATIONS.includes("cause"), "枚举里没有 cause");
  assert.ok(!(SHOT_RELATIONS as readonly string[]).includes("因果"), "枚举混进了中文，agent 会两种都试");
  assert.equal(SHOT_RELATIONS.length, 8, "七类关系 + plain = 8");
});

check("分镜表要把关系标签渲染出来", () => {
  const txt = storyboardToText({
    shots: [
      { type: "title" },
      { type: "compare", relation: "contrast", sync: "切在第二拍" },
      { type: "linechart", relation: "accumulate" },
    ],
  });
  assert.ok(txt.includes("〔否定对比〕"), "用户看不出这一幕承担了什么");
  assert.ok(txt.includes("同步：切在第二拍"), "sync 没渲染，三问③白填");
});

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
