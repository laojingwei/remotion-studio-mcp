/**
 * 提示词库的契约测试（`npm run test:prompt-library`）。
 *
 * 为什么要有：这批数据不是手写的单点，而是"构建脚本产 md → 服务端解析 md → 面板取接口"
 * 三段流水线。任何一段的格式约定漂了，症状都是同一句"面板少了几十条"，
 * 而截图根本看不出来（少 10 条也还是一屏卡片）。所以把解析规则与安全边界钉成断言。
 *
 * 和 test-styles.mts 的分工：那边测的是"77 个内置风格预设 + 样张配方"，
 * 这边测的是"153 篇整片配方 + 26 条单技法 + 槽位 + 缩略图"——两套断言，不要互相冒充。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildIndex,
  genreCounts,
  getIndex,
  itemById,
  listPrompts,
  readDetail,
  readPrompt,
  stillAbsOf,
} from "../server/promptLibrary.service";
import { PROMPT_GENRES } from "../shared/prompt-library";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIB = path.join(ROOT, "server", "skills", "prompt-library");

function mdFiles(): string[] {
  const out: string[] = [];
  for (const g of PROMPT_GENRES) {
    const dir = path.join(LIB, g.dir);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (/^(?:PM|TK)\d{3}_.+\.md$/.test(f)) out.push(path.join(dir, f));
  }
  return out;
}

function webpFiles(): string[] {
  const out: string[] = [];
  for (const g of PROMPT_GENRES) {
    const dir = path.join(LIB, g.dir);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (/^(?:PM|TK)\d{3}_.+\.webp$/.test(f)) out.push(path.join(dir, f));
  }
  return out;
}

const MDS = mdFiles();
const WEBPS = webpFiles();
assert.ok(MDS.length > 0, "库里一篇 md 都没有");

// ── 1. 索引必须对上磁盘，而不是对上某个写死的数字 ──
const idx = buildIndex(true);
assert.equal(idx.total, MDS.length, `索引 ${idx.total} 条，磁盘 ${MDS.length} 篇`);
assert.equal(
  idx.withStill,
  WEBPS.length,
  `索引里有缩略图 ${idx.withStill} 条，磁盘 ${WEBPS.length} 张——多半是 webp 命名没跟 md 对齐`,
);

// ── 2. 编号格式与唯一性 ──
const ids = idx.items.map((i) => i.id);
assert.equal(new Set(ids).size, ids.length, "编号有重复");
for (const id of ids) assert.match(id, /^(?:PM|TK)\d{3}$/, `编号格式不对：${id}`);
/**
 * 编号 = slug 在 207 条源条目里的排序位，**故意会跳号**：
 * 同稿合并的 53 条和明确排除的 1 条都占着位子却没有 md（比如 PM008 就是被排除的那条）。
 * 这是设计而不是缺陷——反过来把 153 条重排成连号，等于让"编号"随种子条数漂移，
 * 用户记住的 PM012 明天就变成了另一条。
 * 所以这里只要求：严格递增、不重复、编号不超过源条目总数。
 */
// 只查 PM 段：TK 是另一套号段（从 1 起连号），上面 6b 单独验
const nums = ids.filter((i) => i.startsWith("PM")).map((i) => Number(i.slice(2)));
for (let i = 1; i < nums.length; i++) {
  assert.ok(nums[i] > nums[i - 1], `PM 编号没有严格递增：PM${nums[i - 1]} → PM${nums[i]}`);
}
assert.ok(nums[0] >= 1 && nums[nums.length - 1] <= 207, `编号超出源条目范围：PM${nums[0]} … PM${nums[nums.length - 1]}`);

// ── 3. 卡片字段：摘要/适合/关键词/体裁都不能空 ──
for (const it of idx.items) {
  assert.ok(it.name && it.name.length > 1, `${it.id} 没有名称`);
  assert.ok(it.summary.length >= 10, `${it.id} 摘要太短：${it.summary}`);
  assert.ok(it.fit.length >= 8, `${it.id} 没有「适合」`);
  assert.ok(it.tags.length >= 3, `${it.id} 关键词少于 3 个`);
  assert.ok(
    PROMPT_GENRES.some((g) => g.id === it.genre),
    `${it.id} 的体裁「${it.genre}」不在定义里`,
  );
  // 体裁必须与所在文件夹一致：文件夹是索引的分类依据，贴错标签会让筛选少一条
  const g = PROMPT_GENRES.find((x) => x.id === it.genre)!;
  assert.ok(it.file.startsWith(`${g.dir}/`), `${it.id} 在 ${it.file}，却标成「${g.label}」`);
}

// ── 4. 详情：正文可取、够长、不含二级标题（含了会被当成新章节切走）──
const sample = readDetail(ids[0])!;
assert.ok(sample, "取不到第一条详情");
assert.ok(sample.prompt.length >= 400, `正文只有 ${sample.prompt.length} 字`);
assert.ok(!/^##\s/m.test(sample.prompt), "正文里出现了二级标题");
assert.ok(sample.slots.length >= 1, "槽位没解析出来");
for (const s of sample.slots) {
  assert.ok(s.label && s.label.length <= 6, `槽位标签可疑：${s.label}`);
  assert.ok(s.value.length > 0, `槽位「${s.label}」没有值`);
}
assert.equal(readPrompt(ids[0]), sample.prompt, "readPrompt 与 readDetail 的正文不一致");

// ── 5. 同稿合并必须留痕（源站有 49 人提交同一段，不能悄悄只剩一条）──
assert.ok(
  idx.items.some((i) => i.dup),
  "没有任何一条带「同稿」——49 人同稿那组应该留下合并说明",
);

// ── 6. 检索与筛选 ──
const reels = listPrompts({ genre: "reel" });
assert.ok(reels.items.every((i) => i.genre === "reel"), "按体裁筛选混进了别的体裁");
const counts = genreCounts();
assert.equal(
  Object.values(counts).reduce((a, b) => a + b, 0),
  idx.total,
  "分体裁计数之和与总数不等",
);
const kw = listPrompts({ q: "贯穿物" });
assert.ok(kw.items.length >= 1, "关键词搜不到东西");

// ── 6b. 单技法（TK 段）：和配方同一个库、不同的号段，必须各自成立 ──
const techs = idx.items.filter((i) => i.id.startsWith("TK"));
assert.equal(techs.length, 26, `单技法应为 26 条，实际 ${techs.length}`);
assert.ok(
  techs.every((t) => t.genre === "technique"),
  "有 TK 条目的体裁不是 technique（构建器写错了）",
);
const techIds = techs.map((t) => t.id).sort();
for (let i = 0; i < techIds.length; i++) {
  assert.equal(techIds[i], `TK${String(i + 1).padStart(3, "0")}`, "技法编号没有从 TK001 连续排");
}
assert.equal(counts.technique, 26, "genreCounts 里的单技法计数不对");
// 技法没有槽位（它是一招，不是一整片），有槽位说明写成了配方
const techDetail = readDetail("TK001");
assert.ok(techDetail, "TK001 取不到详情");
assert.equal(techDetail!.slots.length, 0, "技法不该有槽位");
assert.ok(readPrompt("TK001")!.length >= 400, "TK001 正文太短");
// 技法的出处必须是原代码样片 id，而不是源站 slug
assert.match(
  techDetail!.item.creator,
  /样片 [A-G]\d{1,2}/,
  "技法出处没带上原条目 id（抽屉里的「出处」会是空的）",
);
assert.equal(techDetail!.item.page, "", "技法不该有源站源页链接");

// ── 6b-2. 缩略图：26 条技法没有源站视频可抽帧，由 build-technique-stills 逐条画出来 ──
// 少一张面板上就是一个空占位，而索引构建不会报错（它只认 md），所以要显式挡住。
const noStill = idx.items.filter((i) => !i.still);
assert.equal(
  noStill.length,
  0,
  `还有 ${noStill.length} 条没有缩略图：${noStill.slice(0, 8).map((i) => i.id).join("、")}。` +
    `配方跑 npm run prompt:stills，技法跑 npm run prompt:technique-stills`,
);
assert.equal(idx.withStill, idx.total, "索引里的 withStill 与 total 不一致（该重建索引了）");
// 有 still 的还得真有文件，不能是索引里留了个悬空路径
for (const it of idx.items) {
  if (!it.still) continue;
  assert.ok(stillAbsOf(it.id), `${it.id} 的索引指向了不存在的缩略图：${it.still}`);
}

// ── 6c. 画风耦合：面板靠它提示"换风格会不会毁片"，必须条条有、且值合法 ──
for (const it of idx.items) {
  assert.ok(
    ["free", "partial", "bound"].includes(it.fidelity),
    `${it.id} 的画风耦合「${it.fidelity}」不合法`,
  );
}
const fidCount = { free: 0, partial: 0, bound: 0 };
for (const it of idx.items) fidCount[it.fidelity]++;
assert.ok(fidCount.free >= 15, `画风自由的只有 ${fidCount.free} 条，判定规则可能收得太紧`);
assert.ok(fidCount.bound >= 30, `绑媒介的只有 ${fidCount.bound} 条，判定规则可能失效`);
// 技法无一例外绑在媒介上：字雨换一种风格就不是字雨了
assert.ok(
  techs.every((t) => t.fidelity === "bound"),
  "有技法没被标成「绑在媒介上」",
);
// 自由的那批必须真的没有画风词——抽查两条，正文里不该出现媒介或配色字样
for (const it of idx.items.filter((x) => x.fidelity === "free").slice(0, 2)) {
  const body = readPrompt(it.id) ?? "";
  for (const w of ["手绘", "水墨", "像素", "剪纸", "配色", "字体"]) {
    assert.ok(!body.includes(w), `${it.id} 标了「画风自由」但正文里出现「${w}」`);
  }
}

// ── 7. 安全边界：id 来自 HTTP 参数，必须挡目录穿越 ──
for (const bad of ["../manifest", "PM../x", "pm002", "PM02", "PM0022", "PM002/../../x"]) {
  assert.equal(itemById(bad), null, `非法 id 没被拒：${bad}`);
  assert.equal(stillAbsOf(bad), null, `非法 id 取缩略图没被拒：${bad}`);
}

// ── 8. 缩略图路径必须落在库目录内 ──
const withStill = idx.items.find((i) => i.still);
assert.ok(withStill, "一条缩略图都没有，先跑 prompt:stills");
const abs = stillAbsOf(withStill!.id)!;
assert.ok(abs.startsWith(LIB), `缩略图路径跑到库外了：${abs}`);
assert.ok(fs.existsSync(abs), "索引说有缩略图，文件却不在");

// ── 9. 重复构建必须稳定（增量缓存最怕第二次少一半）──
const again = buildIndex(true);
assert.equal(again.total, idx.total, "两次重建的条数不一致");
assert.deepEqual(
  again.items.map((i) => i.id),
  idx.items.map((i) => i.id),
  "两次重建的顺序不一致",
);

console.log(`✓ 提示词库契约通过：${idx.total} 条｜有图 ${idx.withStill} 条｜体裁 ${Object.keys(counts).length} 类`);
console.log(
  "  分布：" +
    PROMPT_GENRES.map((g) => `${g.label} ${counts[g.id] ?? 0}`).join("｜"),
);
