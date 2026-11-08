/**
 * 提示词库校验器（`npm run check:prompt-library`）。
 *
 * 它回答的不是"我觉得写得对不对"，而是三个可复现的问题：
 * 1. **格式能被现有索引读出来吗**：`sectionOf` / `bulletOf` 是从
 *    `server/styleLibrary.service.ts:100` / `:115` 逐字搬过来的同一套逻辑。为了证明
 *    这份拷贝没有走样，先拿已有的 `02-手法/A1_字雨.md` 做金样本自检——它读错的话，
 *    后面所有结论都不算。
 * 2. **每条都能回到源站吗**：`- 出处：` 里的 slug 必须能在 `source.json` 找到，
 *    且作者、原贴一致。207 条靠人工核对不现实，这条挡的是"改错行、贴错作者"。
 * 3. **编号稳定吗**：PM 编号必须等于 slug 在 source.json 排序里的位置——编号漂移
 *    会让用户记住的编号失效，且这种错不会显形。
 *
 * 用法：`npx tsx scripts/check-prompt-library.mts`
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../server/root";
import { PROMPT_FIDELITIES, PROMPT_GENRES } from "../shared/prompt-library";

const LIB_ROOT = path.join(ROOT, "server", "skills", "prompt-library");
const SOURCE_FILE = path.join(ROOT, "data", "prompt-motion", "source.json");
const MANIFEST = path.join(ROOT, "data", "prompt-motion", "manifest.json");
/**
 * 金样本：一份**旧库**风格的 md，用来证明上面两个解析函数没走样。
 *
 * 以前直接指向 `server/skills/style-library/02-手法/A1_字雨.md`——但那个目录已经被删了，
 * 指向一个不存在的文件，自检会静默降级成"跳过"。所以复制一份进 fixtures：
 * 自检要的可复现性，不该依赖一个随时会被删的目录。
 */
const GOLDEN = path.join(ROOT, "scripts", "fixtures", "golden-style-sample.md");

/** 体裁标签与顺序都读共享定义，别在这里再抄一遍（加第 8 类时抄漏过一次就懂了） */
const GENRE_LABELS = PROMPT_GENRES.map((g) => g.label);

/** 画风耦合必须是这三值之一：面板靠它决定"换风格会不会毁片"，写错会静默失效 */
const FIDELITY_LABELS = PROMPT_FIDELITIES.map((f) => f.label);

// ── 以下两个函数逐字来自 server/styleLibrary.service.ts（:100 / :115），不要改写 ──
function sectionOf(text: string, title: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## ") && l.slice(3).trim().startsWith(title));
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

function bulletOf(text: string, label: string): string | undefined {
  const line = text.split("\n").find((l) => l.startsWith(`- ${label}：`));
  if (!line) return undefined;
  const v = line.slice(`- ${label}：`.length).trim();
  return v || undefined;
}

/** 新库的提示词节：从 `## 提示词` 取到文件尾（与 promptSectionOf 的口径一致） */
function promptSectionOf(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## ") && l.slice(3).trim().startsWith("提示词"));
  if (start < 0) return "";
  return lines.slice(start + 1).join("\n").trim();
}

function listOf(v: string | undefined): string[] {
  return (v ?? "")
    .split(/[、,，]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs));
    else if (e.name.endsWith(".md")) out.push(abs);
  }
  return out;
}

const errors: string[] = [];
const warnings: string[] = [];

// ── 0. 金样本自检：证明这套解析函数确实读得懂旧库 ──
if (!fs.existsSync(GOLDEN)) {
  warnings.push(`金样本不存在，跳过自检：${path.relative(ROOT, GOLDEN)}`);
} else {
  const g = fs.readFileSync(GOLDEN, "utf8");
  const gSummary = bulletOf(g, "长什么样");
  if (!gSummary || !gSummary.includes("雨")) errors.push("自检失败：sectionOf/bulletOf 读不出旧库的「长什么样」");
  if (listOf(bulletOf(g, "关键词")).length !== 3) errors.push("自检失败：读不出旧库的 3 个关键词");
  if (!sectionOf(g, "风格提示词").includes("Canvas 2D")) errors.push("自检失败：读不出旧库的风格提示词正文");
}

// ── 1. 源数据与清单 ──
if (!fs.existsSync(SOURCE_FILE)) {
  console.error(`缺少 source.json，先跑 scripts/extract-prompt-motion.mts`);
  process.exit(1);
}
const source = JSON.parse(fs.readFileSync(SOURCE_FILE, "utf8")) as {
  items: { slug: string; title: string; creator: string; tweetUrl: string; slots: unknown[] }[];
};
const bySlug = new Map(source.items.map((i) => [i.slug, i]));
const order = source.items.map((i) => i.slug).sort();

const files = walk(LIB_ROOT);
if (!files.length) {
  console.error("提示词库里没有 md，先跑 scripts/build-prompt-library.mts");
  process.exit(1);
}

const manifest = fs.existsSync(MANIFEST)
  ? (JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as {
      count: number;
      items: { id: string; slug: string; file: string }[];
    })
  : null;
if (manifest && manifest.count !== files.length)
  errors.push(`manifest 记 ${manifest.count} 条，磁盘上有 ${files.length} 个 md`);
const manifestByFile = new Map((manifest?.items ?? []).map((i) => [i.file.replace(/\\/g, "/"), i]));

const seenIds = new Set<string>();
const seenSlugs = new Set<string>();
const seenTech = new Set<string>();
const techIds: string[] = [];
let filledSlots = 0;

for (const abs of files.sort()) {
  const rel = path.relative(LIB_ROOT, abs).replace(/\\/g, "/");
  const text = fs.readFileSync(abs, "utf8");
  const h1 = /^# ((?:PM|TK)\d{3}) (.+)$/m.exec(text);
  if (!h1) {
    errors.push(`${rel}：首行不是「# PMxxx 名称」或「# TKxxx 名称」`);
    continue;
  }
  const [, id, name] = h1;
  const isTech = id.startsWith("TK");
  if (isTech) techIds.push(id);
  if (seenIds.has(id)) errors.push(`${rel}：编号 ${id} 重复`);
  seenIds.add(id);

  // 类型必须与所在文件夹一致（文件夹是索引的用途轴，错了面板就归类错）
  const folder = rel.split("/")[0];
  const genreLabel = bulletOf(text, "类型");
  if (!genreLabel || !GENRE_LABELS.includes(genreLabel)) errors.push(`${rel}：类型「${genreLabel}」不在约定里`);
  if (genreLabel && !folder.startsWith(String(GENRE_LABELS.indexOf(genreLabel) + 1).padStart(2, "0")))
    errors.push(`${rel}：类型「${genreLabel}」与文件夹「${folder}」不一致`);

  const look = bulletOf(text, "长什么样");
  if (!look) errors.push(`${rel}：缺「长什么样」（面板卡片摘要就靠它）`);
  else if (look.length > 90) errors.push(`${rel}：长什么样 ${look.length} 字，超过 90`);

  if (!bulletOf(text, "适合")) errors.push(`${rel}：缺「适合」`);
  const fid = bulletOf(text, "画风耦合");
  if (!fid) errors.push(`${rel}：缺「画风耦合」（面板靠它提示换风格的风险）`);
  else if (!FIDELITY_LABELS.includes(fid)) errors.push(`${rel}：画风耦合「${fid}」不在约定里`);
  if (listOf(bulletOf(text, "关键词")).length < 3) errors.push(`${rel}：关键词少于 3 个`);
  if (!bulletOf(text, "时长")) warnings.push(`${rel}：没有时长行（源片可能没填 length 槽位）`);

  // 出处：配方回链源站；技法回链原代码样片条目。两者都靠这一行才能追溯来源
  const src = bulletOf(text, "出处") ?? "";
  if (isTech) {
    const techM = /样片 ([A-G]\d{1,2})/.exec(src);
    if (!techM) errors.push(`${rel}：技法出处行没有原条目 id（例「原「技法」代码样片 A1」）`);
    else {
      if (seenTech.has(techM[1])) errors.push(`${rel}：原条目 ${techM[1]} 重复`);
      seenTech.add(techM[1]);
    }
  } else {
    const slugM = /customize\/([a-z0-9-]+)$/.exec(src);
    if (!slugM) errors.push(`${rel}：出处行没有源页链接`);
    else {
      const slug = slugM[1];
      if (seenSlugs.has(slug)) errors.push(`${rel}：slug ${slug} 重复`);
      seenSlugs.add(slug);
      const item = bySlug.get(slug);
      if (!item) errors.push(`${rel}：slug ${slug} 在 source.json 里不存在`);
      else {
        if (item.creator && !src.includes(`@${item.creator}`)) errors.push(`${rel}：出处里的作者与源站不一致`);
        if (item.tweetUrl && !src.includes(item.tweetUrl)) errors.push(`${rel}：出处里的原贴链接与源站不一致`);
        if (item.slots.length) filledSlots++;
        // 编号 = slug 在排序里的位置
        const expect = `PM${String(order.indexOf(slug) + 1).padStart(3, "0")}`;
        if (id !== expect) errors.push(`${rel}：编号 ${id} 应为 ${expect}（编号必须跟着 slug 走，否则会漂移）`);
      }
    }
  }

  // 正文
  const prompt = promptSectionOf(text);
  if (!prompt) errors.push(`${rel}：没有「## 提示词」正文`);
  else {
    if (/^##\s/m.test(prompt)) errors.push(`${rel}：正文里出现二级标题，索引会把后半段截断`);
    if (prompt.length < 400) errors.push(`${rel}：正文 ${prompt.length} 字，偏短（要 ≥400）`);
    if (prompt.length > 1800) errors.push(`${rel}：正文 ${prompt.length} 字，偏长（要 ≤1800）`);
    if ((prompt.match(/\*\*[^*]+\*\*/g) ?? []).length < 3) errors.push(`${rel}：正文小标题少于 3 个`);
  }

  const mItem = manifestByFile.get(rel);
  if (manifest && !mItem) warnings.push(`${rel}：不在 manifest 里（重新 build 一次）`);
  if (mItem && mItem.id !== id) errors.push(`${rel}：manifest 里的编号 ${mItem.id} 与文件 ${id} 不一致`);
}

if (!manifest) warnings.push("没有 manifest（只校验了 md 本体）");

// TK 编号从 TK001 起严格连号：技法是按种子声明顺序编号的，跳号说明有文件被删或改名
if (techIds.length) {
  const sorted = [...techIds].sort();
  for (let i = 0; i < sorted.length; i++) {
    const expect = `TK${String(i + 1).padStart(3, "0")}`;
    if (sorted[i] !== expect) {
      errors.push(`技法编号不连续：第 ${i + 1} 个是 ${sorted[i]}，应为 ${expect}`);
      break;
    }
  }
}

// ── 报告 ──
const byGenre = new Map<string, number>();
for (const abs of files) {
  const folder = path.relative(LIB_ROOT, abs).replace(/\\/g, "/").split("/")[0];
  byGenre.set(folder, (byGenre.get(folder) ?? 0) + 1);
}
console.log(`md ${files.length} 个｜源条目 ${source.items.length}｜有槽位的 ${filledSlots}`);
console.log("分布：" + [...byGenre.entries()].sort().map(([k, v]) => `${k} ${v}`).join("｜"));
if (warnings.length) {
  console.log(`\n⚠ ${warnings.length} 条提醒：`);
  for (const w of warnings.slice(0, 20)) console.log("  " + w);
  if (warnings.length > 20) console.log(`  …还有 ${warnings.length - 20} 条`);
}
if (errors.length) {
  console.log(`\n✗ ${errors.length} 处错误：`);
  for (const e of errors) console.log("  " + e);
  process.exit(1);
}
console.log("\n✓ 全部通过：格式可被现有索引解析、条目可回链源站、编号与 slug 一致");
