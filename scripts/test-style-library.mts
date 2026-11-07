/**
 * 风格库的契约测试。
 *
 * 为什么要有：这套东西的数据来自一个**仓库外**的库（用户自己维护的 341 条 md + jpg），
 * 解析规则稍一漂移就是"面板少了几十条"或"点进去空着"，而这类问题在截图里看不出来
 * （少 8 条仍然是一屏卡片）。所以把「解析规则」和「安全边界」钉成断言。
 *
 * 覆盖：
 *   1. 索引条目数与静帧数（对照磁盘，不是写死 341 让测试变成橡皮章）
 *   2. 两种文件名：`A1_字雨.md` 与 `M14_.md`（源库里有 8 条只有编号）
 *   3. 目录穿越必须被拒（id 来自 HTTP 参数）
 *   4. 勾选：未知编号要被剔除并回告，不能悄悄留一个读不到提示词的 id
 *   5. 人工覆盖改气质后，索引视图立刻变（覆盖与缓存的交互最容易出错）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildIndex,
  getIndex,
  itemById,
  listBuiltinStyles,
  listLibrary,
  picksSummary,
  readBuiltinStyle,
  readPicks,
  readPrompt,
  stillAbsOf,
  writeOverride,
  writePicks,
} from "../server/styleLibrary.service";
import { listSkills, readSkill, resolveSkillName } from "../server/skills.service";
import { DATA_ROOT } from "../server/paths";
import { STYLE_USES } from "../shared/style-library";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIB = path.join(ROOT, "server", "skills", "style-library");
const OVERRIDES = path.join(DATA_ROOT, "style-overrides.json");
const PICKS = path.join(DATA_ROOT, "style-picks.json");

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

const mdCount = (() => {
  let n = 0;
  for (const u of STYLE_USES) {
    try {
      n += fs.readdirSync(path.join(LIB, u.dir)).filter((f) => f.endsWith(".md")).length;
    } catch {
      /* 目录还没建 */
    }
  }
  return n;
})();

const webpCount = (() => {
  let n = 0;
  for (const u of STYLE_USES) {
    try {
      n += fs.readdirSync(path.join(LIB, u.dir)).filter((f) => f.endsWith(".webp")).length;
    } catch {
      /* 目录还没建 */
    }
  }
  return n;
})();

const idx = buildIndex(true);

console.log("风格库索引");
check("条目数 = 磁盘上的 md 数", () => {
  assert.equal(idx.total, mdCount, `索引 ${idx.total} 条，磁盘 ${mdCount} 个 md`);
});
check("有静帧数 = 磁盘上的 webp 数", () => {
  assert.equal(idx.withStill, webpCount, `索引 ${idx.withStill} 条有图，磁盘 ${webpCount} 个 webp`);
});
check("编号唯一", () => {
  const ids = idx.items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, "出现重复编号，勾选与 picks 都按 id 索引，重复会串");
});
check("编号不带下划线（M14_.md → M14）", () => {
  const bad = idx.items.filter((i) => i.id.includes("_"));
  assert.equal(bad.length, 0, `这些编号还带下划线：${bad.map((b) => b.id).join("、")}`);
});
check("空条目的名字不硬编（M14 只有编号）", () => {
  const it = itemById("M14");
  if (!it) return; // 库里没有就跳过：这是用户可删的内容，不是代码契约
  assert.equal(it.promptChars, 0, "M14 应该是空正文");
  assert.ok(it.name.length > 0, "名字不能是空字符串，否则卡片上是一片空白");
});

console.log("分类与检索");
check("6 个用途都有条目", () => {
  for (const u of STYLE_USES) {
    const n = idx.items.filter((i) => i.use === u.id).length;
    assert.ok(n > 0, `用途「${u.label}」一条都没有：文件夹名改成 ${u.dir} 了吗`);
  }
});
check("按用途过滤只回该用途", () => {
  const r = listLibrary({ use: "technique" });
  assert.ok(r.items.length > 0, "technique 空");
  assert.ok(r.items.every((i) => i.use === "technique"), "混进了别的用途");
});
check("只看有静帧：每条都真有图", () => {
  const r = listLibrary({ withStill: true });
  assert.ok(r.items.length > 0, "一条有图的都没有");
  assert.ok(r.items.every((i) => i.still), "筛选说有图但 still 是空");
});
check("搜索命中名称", () => {
  const target = idx.items.find((i) => i.name && i.name !== "未命名");
  if (!target) return;
  const r = listLibrary({ q: target.name.slice(0, 2) });
  assert.ok(r.items.some((i) => i.id === target.id), `搜「${target.name.slice(0, 2)}」没命中 ${target.id}`);
});

console.log("安全边界");
check("目录穿越被拒", () => {
  for (const bad of ["../../../package.json", "..%2f..%2fpackage", "A1/../../../x"]) {
    assert.equal(stillAbsOf(bad), null, `${bad} 应该被拒`);
  }
});
check("取提示词只回正文，带 风格提示词 节", () => {
  const it = idx.items.find((i) => i.promptChars > 0);
  if (!it) return;
  const p = readPrompt(it.id);
  assert.ok(p && p.length > 0, `${it.id} 读不到提示词`);
  assert.ok(!p!.startsWith("## "), "不该带标题行");
});

console.log("勾选与覆盖");
const backupPicks = fs.existsSync(PICKS) ? fs.readFileSync(PICKS, "utf8") : null;
const backupOv = fs.existsSync(OVERRIDES) ? fs.readFileSync(OVERRIDES, "utf8") : null;

check("勾选剔除未知编号并回告", () => {
  const { picks, dropped } = writePicks({ ids: ["A1", "___nope___"], note: "单测" });
  assert.deepEqual(dropped, ["___nope___"], "未知编号没有被剔除（agent 会照着读一个不存在的条目）");
  assert.deepEqual(picks.ids, ["A1"]);
  assert.equal(readPicks()?.note, "单测", "备注没写进去");
});

check("内置勾选与参考勾选分开存，未知 slug 被剔除", () => {
  const slug = listBuiltinStyles()[0]?.slug;
  if (!slug) return;
  const { picks, dropped } = writePicks({ ids: ["A1"], builtinSlugs: [slug, "___no-such___"] });
  assert.deepEqual(dropped, ["___no-such___"], "未知内置 slug 没被剔除，agent 会拿它去 apply_style 报错");
  assert.deepEqual(picks.ids, ["A1"], "参考编号被内置勾选污染");
  assert.deepEqual(picks.builtinSlugs, [slug], "内置 slug 没写进去");
  const sum = picksSummary();
  assert.ok(sum.includes("直接套"), "摘要没告诉 agent 内置能直接套（它会去翻译一份现成预设）");
  assert.ok(sum.includes("要翻译"), "摘要没告诉 agent 参考要翻译（它会直接 apply_style 一个编号）");
});

check("内置详情带规则正文与配色预设", () => {
  const b = listBuiltinStyles().find((x) => x.hasPreset);
  if (!b) return;
  const d = readBuiltinStyle(b.slug);
  assert.ok(d, "读不到内置详情，抽屉会整块空白");
  assert.ok((d!.rules ?? "").length > 0, "规则正文是空的，用户看不到「这风格到底是什么」");
  assert.ok(d!.preset && Object.keys(d!.preset.palette).length > 0, "预设没有配色，色板会空着");
});

check("未知内置 slug 返回 null（不是抛错也不是空对象）", () => {
  assert.equal(readBuiltinStyle("___nope___"), null);
});

check("老 picks 文件没有 builtinSlugs 也能读", () => {
  fs.writeFileSync(PICKS, JSON.stringify({ at: new Date().toISOString(), ids: ["A1"] }));
  const p = readPicks();
  assert.deepEqual(p?.builtinSlugs, [], "老文件读到 undefined 会让下游每个调用点都写 ?? []");
});

check("只勾内置、不勾参考时 picksSummary 不报「还没挑」", () => {
  const slug = listBuiltinStyles()[0]?.slug;
  if (!slug) return;
  writePicks({ ids: [], builtinSlugs: [slug] });
  assert.ok(!picksSummary().includes("还没"), "只选了内置却被当成没选，agent 会重新问一遍");
});

check("覆盖改气质后立刻生效（不重启、不只改内存）", () => {
  const target = idx.items[0].id;
  const before = itemById(target)!.moods;
  writeOverride(target, { moods: ["克制"] });
  assert.deepEqual(itemById(target)!.moods, ["克制"], "内存视图没跟上");
  // 清掉缓存再从磁盘读，模拟"另一个进程刚写完"
  const again = getIndex();
  assert.deepEqual(again.items.find((i) => i.id === target)!.moods, ["克制"], "磁盘索引的路径没应用覆盖");
  writeOverride(target, { moods: before.length ? before : ["克制"] });
});

console.log("正文取法（245/341 条的提示词节后有同级标题）");
check("V 系列正文完整：text 围栏里的提示词本体没被切掉", () => {
  const v11 = readPrompt("V11") ?? "";
  assert.ok(v11.length > 4000, `V11 正文只有 ${v11.length} 字——sectionOf 按「下一个 ##」截断了，真正的提示词（嵌在「怎么用/提示词」小节里）全丢`);
  assert.ok(v11.includes("Signature features"), "V11 的提示词本体没进正文");
  // 「原片/源码」元信息行是噪音：评审分数诱导 agent 误判质量、demos 路径诱导它找不存在的源码。
  // 只断言这两类行——「怎么用」节正文里的 rubric 提及（含"未随库分发"）是操作指引，保留
  for (const noise of ["AI 评审终评", "demos/"]) {
    assert.ok(!v11.includes(noise), `V11 正文里有噪音「${noise}」——原片/源码元信息行该过滤`);
  }
});

check("L 系列完整方案在提示词节之后，不能只取 128 字", () => {
  const l10 = readPrompt("L10") ?? "";
  assert.ok(l10.length > 8000, `L10 正文只有 ${l10.length} 字——完整方案在「1. Essence…11. Variation space」，全在风格提示词节之后`);
  assert.ok(l10.includes("Essence"), "L10 的方案本体没进正文");
  // 「补充」节是外链附录，不属于提示词
  assert.ok(!/(^|\n)##\s+补充/.test(l10), "「补充」节混进了正文");
});

check("摘要兜底：V 用视觉特征行、L 用 Essence 首段，表格头不许当摘要", () => {
  const items = listLibrary().items;
  const v11 = items.find((i) => i.id === "V11")!;
  assert.ok(v11.summary?.includes("几何"), `V11 摘要没从「视觉特征」提取：${v11.summary}`);
  const l10 = items.find((i) => i.id === "L10")!;
  assert.ok(l10.summary && !l10.summary.startsWith("|"), `L10 摘要抓到了表格头：${l10.summary}`);
  // 只有源库空壳（只有编号没正文）才允许没摘要：有正文必有可提取的一句话
  const empty = items.filter((i) => !i.summary);
  assert.ok(
    empty.every((i) => i.promptChars < 60),
    `有正文却没摘要的条目：${empty.filter((i) => i.promptChars >= 60).map((i) => i.id).join("、")}`,
  );
});

check("正文薄的条目（M10 型）要把补充外链附上——提示词原文只在链接那边", () => {
  const m10 = readPrompt("M10") ?? "";
  assert.ok(m10.includes("prompt-motion.com"), `M10 正文 ${m10.length} 字却没附外链：agent 和用户都没地方找原文`);
  assert.ok(m10.includes("提示词原文要去下面这些链接找"), "没说明「为什么给链接」——读的人不知道这是原文入口");
  // 正文厚的条目不许混入链接块
  const a1 = readPrompt("A1") ?? "";
  assert.ok(!a1.includes("要去下面这些链接找"), "A1 正文完整，不该附链接块");
});

check("库外相对链接已中性化（demos 连源盘都没有，死链不能再进面板）", () => {
  const dir = path.join(ROOT, "server", "skills", "style-library");
  const bad: string[] = [];
  for (const f of fs.readdirSync(dir).flatMap((d) => fs.readdirSync(path.join(dir, d)).map((x) => path.join(dir, d, x))).filter((f) => f.endsWith(".md"))) {
    if (/\]\(\.\.\//.test(fs.readFileSync(f, "utf8"))) bad.push(path.basename(f));
  }
  assert.deepEqual(bad, [], `还有 ${bad.length} 个文件带 ](../ 死链：${bad.slice(0, 3).join("、")}`);
});

console.log("翻译技能（style-translate）可达性");console.log("翻译技能（style-translate）可达性");
check("技能能被扫到（否则 agent 永远找不到这篇）", () => {
  assert.ok(
    listSkills().some((s) => s.name === "style-translate"),
    "server/skills/style-translate.md 没被 skills.service 扫到",
  );
});

check("用户嘴里的词能直连这篇，不掉进\"你可能想读\"", () => {
  for (const q of ["风格库", "参考风格", "画风翻译", "字雨", "翻译"]) {
    assert.equal(resolveSkillName(q).name, "style-translate", `「${q}」没直连到 style-translate`);
  }
  // 反向：宽词不能被这条抢走，否则"质感"类问题会被导到翻译技能
  assert.equal(resolveSkillName("质感").name, "craft", "「质感」被截胡了");
});

check("按节读取只回那一节", () => {
  const sec = readSkill("style-translate", "降级");
  assert.ok(sec.includes("降级路径"), "按节读取没命中「八、翻不过去的怎么办」");
  assert.ok(sec.split("\n")[0].startsWith("## "), "返回内容不是从标题开始的");
  assert.ok(sec.split("\n").filter((l) => l.startsWith("## ")).length === 1, "带出了别的小节");
});

console.log("文字 / 动作两篇的可达性（用户抱怨直连）");
check("text-events 与 motion-rules 能被扫到", () => {
  const names = listSkills().map((s) => s.name);
  for (const n of ["text-events", "motion-rules"]) {
    assert.ok(names.includes(n), `server/skills/${n}.md 没被扫到，agent 永远找不到这篇`);
  }
});

check("用户说的是症状，不是篇名：这些词必须直连", () => {
  for (const q of ["文字太小", "字看不清", "读窗", "断行", "断句", "字号", "打字机"]) {
    assert.equal(resolveSkillName(q).name, "text-events", `「${q}」没直连到 text-events`);
  }
  for (const q of ["转场", "接缝", "错峰", "缓动", "弹簧", "过冲", "太黏", "太拖"]) {
    assert.equal(resolveSkillName(q).name, "motion-rules", `「${q}」没直连到 motion-rules`);
  }
});

check("新路由不许截胡老目的地", () => {
  // 这两条是"排版"与"质感"的宽词路由：被新篇抢走的话，自由画布和整体质感的问题会走错门
  assert.notEqual(resolveSkillName("排版").name, "text-events", "「排版」被文字篇截胡（应指向 freeform）");
  assert.equal(resolveSkillName("自由画布").name, "freeform", "「自由画布」没到 freeform");
  assert.equal(resolveSkillName("质感").name, "craft", "「质感」没到 craft");
});

check("两篇都能按节读（节名是真标题，不是正文里的词）", () => {
  for (const [name, sec, must] of [
    ["text-events", "先算够不够读", "读窗"],
    ["text-events", "手法谱系", "typewriter"],
    ["motion-rules", "错峰", "间隔"],
    ["motion-rules", "接缝", "速度"],
  ] as const) {
    const t = readSkill(name, sec);
    assert.ok(t.includes(must), `${name} 按「${sec}」读不到 ${must}`);
    assert.equal(t.split("\n").filter((l) => l.startsWith("## ")).length, 1, `${name} 按节读取带出了别的小节`);
  }
});

check("全部技能里的 get_guide(\"x\") 引用都真的存在", () => {
  const names = new Set(listSkills().map((s) => s.name));
  const dir = path.join(ROOT, "server", "skills");
  const bad: string[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of text.matchAll(/get_guide\("([^"]+)"\)/g)) {
      // manual.md 里有一句 get_guide("名字") 是占位示例，不是真引用
      if (m[1] === "名字") continue;
      if (!names.has(m[1])) bad.push(`${f}: get_guide("${m[1]}")`);
    }
  }
  assert.deepEqual(bad, [], `技能里引用了不存在的技能：${bad.join("；")}`);
});

// 还原用户数据：测试不该留下"用户勾了 A1"这种假状态
if (backupPicks) fs.writeFileSync(PICKS, backupPicks);
else fs.rmSync(PICKS, { force: true });
if (backupOv) fs.writeFileSync(OVERRIDES, backupOv);
else fs.rmSync(OVERRIDES, { force: true });

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
