/**
 * 提示词库服务：153 篇整片配方的索引、检索与取全文。
 *
 * 库在哪：`server/skills/prompt-library/<体裁文件夹>/PMxxx_<名称>.md`（+ 同名 `.webp`）。
 * 和风格库一样放在 skills 目录的子目录里 —— `skills.service.ts` 的 `skillSources()`
 * 只扫顶层，子目录天然不进技能列表，"库放 skills 里"和"技能列表别被几百篇撑爆"同时成立。
 *
 * 索引落在 `data/prompt-library.json`（`/data` 已 gitignore，换机器自动重建）。
 *
 * 与风格库服务的三处**刻意不同**，都是这一批的实际情况决定的：
 *
 * 1. **没有"气质"词表**。风格库要给 341 条画风猜「克制/科技/复古」，因为用户按形容词挑画风；
 *    提示词库挑的是体裁（要宣传片还是解说片），体裁已经写在文件夹上，不需要再猜一层。
 * 2. **槽位与正文不进列表**。风格库列表里带 promptChars 便于排序，但提示词库一条正文
 *    平均 700 字，153 条一次发出去接近 100KB；列表只给卡片要的字段，详情按 id 单独取。
 * 3. **id 直接就是 PM 编号**（风格库是 A1/L10 这种，要处理"只有编号没有名字"的历史包袱）。
 *    编号由构建脚本定死（配方 PM 跟 slug 排序位，技法 TK 跟声明顺序），
 *    服务端只做 `^(PM|TK)\d{3}$` 校验 + 目录穿越防御。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT as PROJECT_ROOT } from "./root";
import { DATA_ROOT } from "./paths";
import {
  PROMPT_FIDELITIES,
  PROMPT_GENRES,
  promptGenreByLabel,
  type PromptDetail,
  type PromptFidelity,
  type PromptGenre,
  type PromptItem,
  type PromptLibraryIndex,
  type PromptPick,
  type PromptQuery,
  type PromptSlot,
} from "../shared/prompt-library";

export const LIB_REL = "server/skills/prompt-library";
export const LIB_ROOT = path.join(PROJECT_ROOT, LIB_REL);

const INDEX_FILE = path.join(DATA_ROOT, "prompt-library.json");

type Cache = { key: string; index: PromptLibraryIndex };
let cache: Cache | null = null;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** `- 关键词：a、b、c` → ["a","b","c"]；没有该行返回 [] */
function listOf(text: string, label: string): string[] {
  const v = bulletOf(text, label);
  return (v ?? "")
    .split(/[、,，]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** `- 长什么样：…` → 值；没有返回 undefined */
function bulletOf(text: string, label: string): string | undefined {
  const line = text.split("\n").find((l) => l.startsWith(`- ${label}：`));
  if (!line) return undefined;
  const v = line.slice(`- ${label}：`.length).trim();
  return v || undefined;
}

/**
 * 取某个 `## 标题` 到文件尾（提示词库的正文只有一节，槽位刻意排在它前面）。
 *
 * 不能复用"取到下一个 ## 为止"的写法：构建期的版式约定是「槽位在前、提示词在后」，
 * 正文就是文件尾之前的所有内容；按 ## 截断反而会在将来加附录时把正文截掉。
 */
function sectionToEnd(text: string, title: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## ") && l.slice(3).trim().startsWith(title));
  if (start < 0) return "";
  return lines.slice(start + 1).join("\n").trim();
}

/** 槽位行：`- 产品：AIsa —— 名字 + 链接` → {label,value,hint} */
function slotsOf(text: string): PromptSlot[] {
  const body = sectionToEnd(text, "槽位");
  if (!body) return [];
  const out: PromptSlot[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const rest = line.slice(2);
    const sep = rest.indexOf("：");
    if (sep < 0) continue;
    const label = rest.slice(0, sep).trim();
    const tail = rest.slice(sep + 1).trim();
    const dash = tail.indexOf(" —— ");
    const value = (dash >= 0 ? tail.slice(0, dash) : tail).trim();
    const hint = dash >= 0 ? tail.slice(dash + 4).trim() : undefined;
    if (label) out.push({ label, value, hint });
  }
  return out;
}

/** `@0xfemyn · https://x.com/… · prompt-motion.com/customize/<slug>` */
/**
 * 画风耦合度。值由构建器写进 md（`- 画风耦合：…`），这里只做反查。
 *
 * 缺这一行时按「部分」保守处理：判成"自由"会让用户随手换风格、结果毁片；
 * 判成"绑定"只是让他少换一次。宁可少给自由，不给错自由。
 */
const FIDELITY_BY_LABEL = new Map(PROMPT_FIDELITIES.map((f) => [f.label, f.id]));
function parseFidelity(text: string): PromptFidelity {
  return FIDELITY_BY_LABEL.get(bulletOf(text, "画风耦合") ?? "") ?? "partial";
}

function sourceOf(text: string): { creator: string; url: string; page: string } {
  const raw = bulletOf(text, "出处") ?? "";
  const parts = raw.split("·").map((s) => s.trim()).filter(Boolean);
  return {
    // 没有 @作者时退回第一段：技法条目的出处是「原技法 A1」，没有作者也没有链接，
    // 但抽屉里得有几行字可读，否则「出处」下面是一片空白
    creator: parts.find((p) => p.startsWith("@")) ?? parts[0] ?? "",
    url: parts.find((p) => /^https?:\/\//.test(p)) ?? "",
    page: parts.find((p) => p.includes("prompt-motion.com/customize/")) ?? "",
  };
}

function parseItem(text: string, dir: string, file: string): PromptItem | null {
  const titleLine = text.split("\n").find((l) => l.startsWith("# ")) ?? "";
  const tm = /^#\s+((?:PM|TK)\d{3})\s+(.+)$/.exec(titleLine);
  if (!tm) return null;
  const [, id, name] = tm;
  const genreLabel = bulletOf(text, "类型") ?? "";
  const genre = promptGenreByLabel(genreLabel)?.id;
  if (!genre) return null;
  const src = sourceOf(text);
  return {
    id,
    name: name.trim(),
    genre,
    dir,
    summary: bulletOf(text, "长什么样") ?? "",
    fit: bulletOf(text, "适合") ?? "",
    tags: listOf(text, "关键词"),
    duration: bulletOf(text, "时长") ?? "",
    creator: src.creator,
    url: src.url,
    page: src.page,
    dup: bulletOf(text, "同稿"),
    fidelity: parseFidelity(text),
    still: null,
    file: `${dir}/${file}`,
    promptChars: sectionToEnd(text, "提示词").length,
    mdSha: sha1(text),
  };
}

function prevIndex(): Map<string, PromptItem> {
  const disk = readJson<PromptLibraryIndex | null>(INDEX_FILE, null);
  if (!disk || disk.sourceRoot !== LIB_REL || !Array.isArray(disk.items)) return new Map();
  return new Map(disk.items.map((i) => [i.id, i]));
}

/** 重建索引。增量：md 的 sha1 没变就复用上次解析结果，只更新缩略图状态 */
export function buildIndex(force = false): PromptLibraryIndex {
  const prev = force ? new Map<string, PromptItem>() : prevIndex();
  const items: PromptItem[] = [];

  for (const g of PROMPT_GENRES) {
    const dir = path.join(LIB_ROOT, g.dir);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => /^(?:PM|TK)\d{3}_.+\.md$/i.test(f));
    } catch {
      continue; // 文件夹还没建（某体裁一条都没有也不该报错）
    }
    for (const f of files) {
      const abs = path.join(dir, f);
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const sha = sha1(text);
      const base = f.replace(/\.md$/i, "");
      const id = base.slice(0, 5);
      const stillRel = `${g.dir}/${base}.webp`;
      const hasStill = fs.existsSync(path.join(LIB_ROOT, g.dir, `${base}.webp`));
      const cached = prev.get(id);
      if (cached && cached.mdSha === sha && !force) {
        items.push({ ...cached, dir: g.dir, still: hasStill ? stillRel : null });
        continue;
      }
      const item = parseItem(text, g.dir, f);
      if (!item) continue; // 文件头不合约定（手改坏了）——跳过而不是让整个索引挂掉
      items.push({ ...item, still: hasStill ? stillRel : null });
    }
  }

  // 编号自然序就是字典序（PM002 < PM010 < PM153），不需要额外的比较器
  items.sort((a, b) => a.id.localeCompare(b.id));

  const index: PromptLibraryIndex = {
    version: 1,
    builtAt: new Date().toISOString(),
    sourceRoot: LIB_REL,
    total: items.length,
    withStill: items.filter((i) => i.still).length,
    items,
  };
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf8");
  cache = { key: cacheKey(), index };
  return index;
}

/**
 * 库目录的指纹：增删文件时 mtime 会变，据此判断要不要重扫。
 *
 * 还得带上 webp 数量：Windows/NTFS 对「子文件增删导致目录 mtime 变化」的更新有延迟，
 * 实测一次性补 26 张技法缩略图之后，服务仍从旧索引里报 `withStill: 153`。
 */
function cacheKey(): string {
  const parts: string[] = [];
  for (const g of PROMPT_GENRES) {
    try {
      const dir = path.join(LIB_ROOT, g.dir);
      const st = fs.statSync(dir);
      const nStill = fs.readdirSync(dir).filter((f) => f.endsWith(".webp")).length;
      parts.push(`${g.dir}:${Math.round(st.mtimeMs)}:${nStill}`);
    } catch {
      parts.push(`${g.dir}:-`);
    }
  }
  return parts.join("|");
}

/** 磁盘上有多少张缩略图。用来判断旧索引里的 still 字段是不是已经过期 */
function countStills(): number {
  let n = 0;
  for (const g of PROMPT_GENRES) {
    try {
      n += fs.readdirSync(path.join(LIB_ROOT, g.dir)).filter((f) => f.endsWith(".webp")).length;
    } catch {
      /* 目录不存在 = 0 张 */
    }
  }
  return n;
}

export function getIndex(): PromptLibraryIndex {
  const key = cacheKey();
  if (cache && cache.key === key) return cache.index;
  const disk = readJson<PromptLibraryIndex | null>(INDEX_FILE, null);
  if (disk && disk.sourceRoot === LIB_REL) {
    // 磁盘索引能用就先用，但目录动过就重建（避免"加了 md 面板不显示"）
    const diskKey = cacheKey();
    cache = { key: diskKey, index: disk };
    // md 数变了要重建；**缩略图数变了也要重建**——只比 md 数量的话，
    // 补完图面板还会一直显示「这一条还没有缩略图」（实测）。
    if (disk.items.length !== countFiles() || (disk.withStill ?? 0) !== countStills()) return buildIndex();
    return disk;
  }
  return buildIndex();
}

function countFiles(): number {
  let n = 0;
  for (const g of PROMPT_GENRES) {
    try {
      n += fs.readdirSync(path.join(LIB_ROOT, g.dir)).filter((f) => /^(?:PM|TK)\d{3}_.+\.md$/i.test(f)).length;
    } catch {
      /* 目录不存在 = 0 条 */
    }
  }
  return n;
}

export function isLibraryEmpty(): boolean {
  return countFiles() === 0;
}

export function listPrompts(q: PromptQuery = {}): {
  items: PromptItem[];
  total: number;
  withStill: number;
} {
  const { items } = getIndex();
  const genre = q.genre && q.genre !== "all" ? q.genre : null;
  const kw = q.q?.trim().toLowerCase();
  const filtered = items.filter((i) => {
    if (genre && i.genre !== genre) return false;
    if (q.withStill && !i.still) return false;
    if (!kw) return true;
    const hay = `${i.id} ${i.name} ${i.summary} ${i.fit} ${i.tags.join(" ")} ${i.creator} ${i.duration}`;
    return hay.toLowerCase().includes(kw);
  });
  return {
    items: filtered,
    total: items.length,
    withStill: items.filter((i) => i.still).length,
  };
}

/** id 来自 HTTP 参数，必须先卡死格式再拼路径 */
function safeId(id: string): boolean {
  return /^(?:PM|TK)\d{3}$/.test(id);
}

export function itemById(id: string): PromptItem | null {
  if (!safeId(id)) return null;
  return getIndex().items.find((i) => i.id === id) ?? null;
}

export function readDetail(id: string): PromptDetail | null {
  const item = itemById(id);
  if (!item) return null;
  const abs = path.join(LIB_ROOT, item.file);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  return { item, slots: slotsOf(text), prompt: sectionToEnd(text, "提示词") };
}

export function readPrompt(id: string): string | null {
  return readDetail(id)?.prompt ?? null;
}

/** 缩略图的绝对路径（webp 在库目录里，不在 public，所以由接口流出去） */
export function stillAbsOf(id: string): string | null {
  const item = itemById(id);
  if (!item?.still) return null;
  const abs = path.join(LIB_ROOT, item.still);
  return fs.existsSync(abs) ? abs : null;
}

/** 按体裁分组计数：面板顶部的筛选条直接用它，不必前端再算一遍 */
export function genreCounts(): Record<PromptGenre, number> {
  const out = {} as Record<PromptGenre, number>;
  for (const g of PROMPT_GENRES) out[g.id] = 0;
  for (const i of getIndex().items) out[i.genre] += 1;
  return out;
}

const PICK_FILE = path.join(DATA_ROOT, "prompt-pick.json");

/**
 * 采纳状态。**两种"没有"必须分开报**：从没采纳过（面板上没选），和采纳过但那条已从库里消失
 * （换机器 / 库重建 / 条目被删）。混成一句"用户还没采纳"，agent 就会自己从库里挑一条——
 * 那恰好是配方场景里最坏的猜法（选错骨架 = 整片重做）。
 */
export function readPickState(): { pick: PromptPick | null; staleId?: string } {
  const p = readJson<PromptPick | null>(PICK_FILE, null);
  if (!p?.id) return { pick: null };
  if (!itemById(p.id)) return { pick: null, staleId: p.id };
  return { pick: p };
}

export function readPick(): PromptPick | null {
  // 库被重建（换机器、删了那篇）后旧的采纳会指向不存在的编号：
  // 留着会让 agent 去读一个不存在的文件，报错点离真因很远。所以读的时候顺手校验。
  return readPickState().pick;
}

/**
 * 采纳一条配方。**覆盖**而不是累加——一条片子只有一套骨架。
 *
 * 返回 `null` 表示编号在库里不存在：面板上那一条可能刚被删，
 * 静默写进去等于给 agent 留了个假线索。
 */
export function writePick(input: { id: string; note?: string }): PromptPick | null {
  const item = itemById(input.id.trim());
  if (!item) return null;
  const pick: PromptPick = {
    id: item.id,
    name: item.name,
    genre: item.genre,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(PICK_FILE), { recursive: true });
  fs.writeFileSync(PICK_FILE, JSON.stringify(pick, null, 2), "utf8");
  return pick;
}

export function clearPick(): void {
  try {
    fs.unlinkSync(PICK_FILE);
  } catch {
    /* 本来就没有：清空是幂等的 */
  }
}
