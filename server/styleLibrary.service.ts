/**
 * 风格库服务：341 条外部风格提示词的索引、检索与勾选。
 *
 * 库在哪：`server/skills/style-library/<用途文件夹>/<编号>_<名称>.md`（+ 同名 `.webp`）。
 * 为什么在 skills 目录下却不在技能列表里：`server/skills.service.ts` 的 `skillSources()`
 * 用 `readdirSync` **只扫顶层**、只收 `.md`。子目录天然被跳过 —— 于是"库放 skills 里"
 * 和"技能列表别被 341 篇撑爆"这两件冲突的事同时成立。改动 skills.service 前先看这条。
 *
 * 索引落在 `data/style-library.json`（`data/` 已被 .gitignore 忽略，换机器自动重建）。
 * 为什么要有索引而不是每次现扫：面板一次要发 341 条给前端，扫描 + 解析 341 个 md
 * 大约 200ms，滚动筛选会反复触发。索引让筛选变成纯内存过滤。
 *
 * 增量：每个条目记 md 的 sha1，`buildIndex()` 只重解析 sha 变了的文件。用户补一张静帧
 * 只改目录 mtime，不重解析正文。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT as PROJECT_ROOT } from "./root";
import { DATA_ROOT } from "./paths";
import { listStyles, presetOf, readStyle } from "./styles.service";
import {
  STYLE_MOODS,
  STYLE_USES,
  type BuiltinStyleDetail,
  type BuiltinStyleItem,
  type StyleItem,
  type StyleLibraryIndex,
  type StyleMood,
  type StylePicks,
  type StyleQuery,
  type StyleUse,
} from "../shared/style-library";

/** 库根（相对工程根）。索引里也记这个值，换目录能一眼看出索引是不是旧的 */
export const LIB_REL = "server/skills/style-library";
export const LIB_ROOT = path.join(PROJECT_ROOT, LIB_REL);

const INDEX_FILE = path.join(DATA_ROOT, "style-library.json");
const OVERRIDES_FILE = path.join(DATA_ROOT, "style-overrides.json");
const PICKS_FILE = path.join(DATA_ROOT, "style-picks.json");

/** 内置风格的静帧约定：`server/styles/stills/<slug>.webp`（由 probe_style 出图后落盘） */
const BUILTIN_STILL_DIR = path.join(PROJECT_ROOT, "server", "styles", "stills");

/**
 * 气质初判词表。
 *
 * 为什么用词表而不是让模型判：341 条要一次判完，模型调用既慢又不稳定（同一句两次给不同
 * 标签），而且用户看不出"为什么这条被标成压抑"。词表可解释、可改、可复现。
 * 命中即记，一条最多 3 个。
 */
const MOOD_HINTS: Record<StyleMood, string[]> = {
  克制: ["克制", "安静", "极简", "留白", "冷静", "理性", "素净", "低饱和"],
  活泼: ["活泼", "俏皮", "弹跳", "轻快", "可爱", "热闹", "欢快", "童趣"],
  高级: ["高级", "质感", "杂志", "编辑", "精致", "考究", "低调"],
  温暖: ["温暖", "手绘", "纸质", "木纹", "暖色", "怀旧", "温柔", "亲切"],
  // "代码" 不能进词表：整个库都是"用代码（Canvas 2D）画一段…"，加进去 341 条全被判成科技
  科技: ["科技", "赛博", "霓虹", "数据", "未来", "hud", "屏幕", "终端", "算法"],
  复古: ["复古", "年代", "胶片", "印刷", "像素", "80", "90", "怀旧", "老式", "做旧"],
  东方: ["水墨", "工笔", "剪纸", "皮影", "敦煌", "中国", "书法", "东方", "国潮", "印章", "国风"],
  荒诞: ["荒诞", "超现实", "扭曲", "梦境", "离奇", "实验"],
  压抑: ["压抑", "压迫", "黑暗", "沉重", "困境", "压力", "阴郁", "窒息"],
  浪漫: ["浪漫", "光斑", "星空", "温柔", "诗意", "梦幻", "柔光"],
};

export type StyleOverride = { moods?: StyleMood[]; use?: StyleUse };

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** 编号自然序：A1 < A2 < A10（按字典序会排成 A1, A10, A2） */
function idKey(id: string): [string, number] {
  const m = /^([A-Za-z]+)(\d+)/.exec(id);
  return m ? [m[1].toUpperCase(), Number(m[2])] : [id.toUpperCase(), 0];
}

function compareId(a: string, b: string): number {
  const [pa, na] = idKey(a);
  const [pb, nb] = idKey(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  return na - nb;
}

/** 从 md 正文里取某个 `## 标题` 下的内容（不含标题行） */
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

/** `- 关键词：a、b、c` → ["a","b","c"]；没有该行返回 [] */
function bulletOf(text: string, label: string): string | undefined {
  const line = text.split("\n").find((l) => l.startsWith(`- ${label}：`));
  if (!line) return undefined;
  const v = line.slice(`- ${label}：`.length).trim();
  return v || undefined;
}

function listOf(text: string, label: string): string[] {
  return (bulletOf(text, label) ?? "")
    .split(/[、,，/／]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 气质初判：拿名称 + 摘要 + 适合 + 关键词 + **提示词正文前 400 字**一起匹配。
 *
 * 为什么要带正文：341 条里只有 124 条写了「关键词」、193 条写了「适合」——只用头字段
 * 会有 219 条判不出气质（实测）。正文是唯一齐的文本（341/341），代价是可能带进噪音，
 * 所以截断到 400 字，并且面板允许人工改（写进 data/style-overrides.json）。
 */
function moodsOf(item: {
  name: string;
  summary?: string;
  fit?: string;
  tags: string[];
  prompt?: string;
}): StyleMood[] {
  const hay = `${item.name} ${item.summary ?? ""} ${item.fit ?? ""} ${item.tags.join(" ")} ${
    item.prompt?.slice(0, 400) ?? ""
  }`.toLowerCase();
  const hit: StyleMood[] = [];
  for (const mood of STYLE_MOODS) {
    if (MOOD_HINTS[mood].some((w) => hay.includes(w.toLowerCase()))) hit.push(mood);
    if (hit.length >= 3) break;
  }
  return hit;
}

export function readOverrides(): Record<string, StyleOverride> {
  return readJson<Record<string, StyleOverride>>(OVERRIDES_FILE, {});
}

export function writeOverride(id: string, patch: StyleOverride): Record<string, StyleOverride> {
  const all = readOverrides();
  const next: StyleOverride = { ...(all[id] ?? {}) };
  if (patch.moods) next.moods = patch.moods;
  if (patch.use) next.use = patch.use;
  if (!next.moods?.length && !next.use) delete all[id];
  else all[id] = next;
  writeJson(OVERRIDES_FILE, all);
  cache = null; // 覆盖改了，索引视图要跟着变
  return all;
}

/** 目录 mtime（含一级子目录），用来判断索引是否过期 */
function libMtime(): number {
  let max = 0;
  const touch = (p: string) => {
    try {
      const s = fs.statSync(p);
      if (s.mtimeMs > max) max = s.mtimeMs;
    } catch {
      /* 目录不存在时忽略 */
    }
  };
  touch(LIB_ROOT);
  for (const u of STYLE_USES) {
    const dir = path.join(LIB_ROOT, u.dir);
    touch(dir);
    try {
      for (const f of fs.readdirSync(dir)) touch(path.join(dir, f));
    } catch {
      /* 该用途目录还没建（首次导入前） */
    }
  }
  return max;
}

/**
 * 缓存键：库文件 mtime + 索引文件 mtime。
 *
 * 为什么要把索引文件也算进来：`npm run style:build` 是在**另一个进程**里重建索引的，
 * 只比库 mtime 的话，正在跑的服务永远认为自己的内存缓存还是最新的——用户在面板里
 * 补了图、改了气质，看到的还是旧数据，只能重启服务。加上索引文件 mtime 就自愈了。
 */
function cacheKey(): string {
  let idxM = 0;
  try {
    idxM = fs.statSync(INDEX_FILE).mtimeMs;
  } catch {
    /* 索引还没建过 */
  }
  return `${libMtime()}|${idxM}`;
}

type Cache = { key: string; index: StyleLibraryIndex };
let cache: Cache | null = null;

/**
 * 重建索引。`force` 为真时忽略 md sha 缓存。
 *
 * 只扫描 `STYLE_USES` 里列出的 6 个文件夹 —— 不递归任意子目录。理由：库会有人往里
 * 塞草稿、`.git`、导出目录，全量递归会把垃圾也变成"风格"，而 agent 分不出哪个是垃圾。
 */
/**
 * 把人工覆盖贴到条目上。
 *
 * 单独一个函数是因为有两条路径要用：①`buildIndex()` 从 md 现解析完 ②`getIndex()`
 * 直接读磁盘索引。只在 ① 里应用的话，用户在面板里改完气质、`cache = null` 之后
 * 会从磁盘读回没覆盖的版本 —— 表现就是"改了没生效"，而且刷新一下又好了，极难查。
 */
function applyOverrides(items: StyleItem[]): void {
  const overrides = readOverrides();
  for (const it of items) {
    const ov = overrides[it.id];
    if (!ov) continue;
    if (ov.moods?.length) it.moods = ov.moods;
    if (ov.use) {
      const def = STYLE_USES.find((u) => u.id === ov.use);
      if (def) {
        it.use = def.id;
        it.dir = def.dir;
      }
    }
  }
}

export function buildIndex(force = false): StyleLibraryIndex {
  const prev = new Map<string, StyleItem>();
  const old = readJson<StyleLibraryIndex | null>(INDEX_FILE, null);
  if (old && !force) for (const it of old.items ?? []) prev.set(it.id, it);

  const items: StyleItem[] = [];
  for (const u of STYLE_USES) {
    const dir = path.join(LIB_ROOT, u.dir);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
    } catch {
      continue; // 目录还没建
    }
    for (const f of files) {
      const base = f.replace(/\.md$/i, "");
      /**
       * 文件名两种：`A1_字雨.md` 和 `M14_.md`（源库里 8 条只有编号、名字还空着）。
       * 编号取「字母数字前缀」，剩下的才算名字；用非贪婪会在 A1_字雨 上切成 A + 1_字雨。
       */
      const fm = /^([A-Za-z0-9]+)_+(.*)$/.exec(base);
      const id = (fm ? fm[1] : base).trim();
      const fileLabel = (fm?.[2] ?? "").trim();
      if (!id) continue;
      const abs = path.join(dir, f);
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const sha = sha1(text);
      const cached = prev.get(id);
      const stillRel = `${u.dir}/${base}.webp`;
      const hasStill = fs.existsSync(path.join(LIB_ROOT, u.dir, `${base}.webp`));

      // 正文没变就复用上次的解析结果，只更新静帧状态（用户补图很频繁）
      if (cached && cached.mdSha === sha && !force) {
        items.push({ ...cached, use: u.id, dir: u.dir, still: hasStill ? stillRel : null });
        continue;
      }

      const titleLine = text.split("\n").find((l) => l.startsWith("# ")) ?? "";
      const tm = /^#\s+(\S+)\s*(.*)$/.exec(titleLine);
      const catLine = bulletOf(text, "分类") ?? "";
      const [series, ...subParts] = catLine.split("·").map((s) => s.trim());
      const sub = subParts.join(" · ") || undefined;
      // 名字三级兜底：标题 → 文件名 → 子类名。空条目不硬编一个假名字，标成「未命名」让用户去补
      const name = (tm?.[2] ?? "").trim() || fileLabel || "未命名";
      const summary = bulletOf(text, "长什么样");
      const fit = bulletOf(text, "适合");
      const tags = listOf(text, "关键词");
      const prompt = sectionOf(text, "风格提示词");

      const baseItem: Omit<StyleItem, "moods" | "use" | "dir"> = {
        id,
        name,
        series: (series ?? "").split(" ")[0] || u.dir,
        sub,
        summary,
        fit,
        tags,
        still: hasStill ? stillRel : null,
        file: `${u.dir}/${f}`,
        promptChars: prompt.length,
        mdSha: sha,
      };
      items.push({
        ...baseItem,
        use: u.id,
        dir: u.dir,
        moods: moodsOf({ ...baseItem, prompt }),
      });
    }
  }

  applyOverrides(items);

  items.sort((a, b) => {
    const ua = STYLE_USES.findIndex((u) => u.id === a.use);
    const ub = STYLE_USES.findIndex((u) => u.id === b.use);
    if (ua !== ub) return ua - ub;
    return compareId(a.id, b.id);
  });

  const index: StyleLibraryIndex = {
    version: 1,
    builtAt: new Date().toISOString(),
    sourceRoot: LIB_REL,
    total: items.length,
    withStill: items.filter((i) => i.still).length,
    items,
  };
  writeJson(INDEX_FILE, index);
  cache = { key: cacheKey(), index };
  return index;
}

/** 取索引（内存 → 磁盘 → 重建） */
export function getIndex(): StyleLibraryIndex {
  const key = cacheKey();
  if (cache && cache.key === key) return cache.index;
  // 内存没有：先看磁盘上的索引是不是用这份库建的
  const disk = readJson<StyleLibraryIndex | null>(INDEX_FILE, null);
  if (disk?.items?.length && disk.sourceRoot === LIB_REL) {
    applyOverrides(disk.items);
    cache = { key, index: disk };
    return disk;
  }
  return buildIndex();
}

/** 库里一条都没有时（首次安装没导入）返回 true，面板据此提示"先跑导入" */
export function isLibraryEmpty(): boolean {
  return getIndex().total === 0;
}

export function listLibrary(q: StyleQuery = {}): { items: StyleItem[]; total: number; withStill: number } {
  const idx = getIndex();
  const text = (q.q ?? "").trim().toLowerCase();
  const use = q.use && q.use !== "all" ? q.use : null;
  const mood = q.mood && q.mood !== "all" ? q.mood : null;

  let items = idx.items;
  if (use) items = items.filter((i) => i.use === use);
  if (mood) items = items.filter((i) => i.moods.includes(mood));
  if (q.withStill) items = items.filter((i) => !!i.still);
  if (text) {
    items = items.filter((i) =>
      [i.id, i.name, i.summary, i.fit, i.series, ...i.tags]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(text),
    );
  }
  const limit = Math.min(Math.max(q.limit ?? 400, 1), 400);
  return { items: items.slice(0, limit), total: idx.total, withStill: idx.withStill };
}

export function itemById(id: string): StyleItem | null {
  return getIndex().items.find((i) => i.id === id) ?? null;
}

/** 该条的 `## 风格提示词` 全文；面板抽屉里显示、agent 读原文都用这个 */
export function readPrompt(id: string): string | null {
  const it = itemById(id);
  if (!it) return null;
  try {
    return sectionOf(fs.readFileSync(path.join(LIB_ROOT, it.file), "utf8"), "风格提示词");
  } catch {
    return null;
  }
}

/**
 * 静帧绝对路径。**必须**校验落在库根内：id 来自 HTTP 参数，直接拼路径等于开了目录穿越。
 */
export function stillAbsOf(id: string): string | null {
  const it = itemById(id);
  if (!it?.still) return null;
  const abs = path.resolve(LIB_ROOT, it.still);
  const root = path.resolve(LIB_ROOT);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return fs.existsSync(abs) ? abs : null;
}

/** 内置 43 个风格（面板下半区）。有 `server/styles/stills/<slug>.webp` 才带图 */
export function listBuiltinStyles(): BuiltinStyleItem[] {
  return listStyles().map((s) => {
    const rel = `stills/${s.slug}.webp`;
    const has = fs.existsSync(path.join(BUILTIN_STILL_DIR, `${s.slug}.webp`));
    return { slug: s.slug, name: s.name, hasPreset: s.hasPreset, still: has ? rel : null };
  });
}

export function builtinStillAbsOf(slug: string): string | null {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const abs = path.join(BUILTIN_STILL_DIR, `${slug}.webp`);
  return fs.existsSync(abs) ? abs : null;
}

/**
 * 内置风格的详情（面板右抽屉用）。
 *
 * 为什么不在前端直接展示：内置风格的价值全在 **规则正文 + 结构化预设** 里，
 * 面板下面那张缩略图只体现配色和版式，看不出"本质 / 最俗的版本 / 坑"。
 * 用户要判断"这个风格适不适合我的片子"，得让他看见规则本身。
 */
export function readBuiltinStyle(slug: string): BuiltinStyleDetail | null {
  const info = listStyles().find((s) => s.slug === slug);
  if (!info) return null;
  return {
    slug: info.slug,
    name: info.name,
    hasPreset: info.hasPreset,
    preset: presetOf(slug),
    rules: readStyle(slug),
  };
}

/* ── 勾选 ─────────────────────────────────────────────────────────── */

export function readPicks(): StylePicks | null {
  const p = readJson<StylePicks | null>(PICKS_FILE, null);
  if (!p || !Array.isArray(p.ids)) return null;
  // 老文件里没有 builtinSlugs：补成空数组，省得每个调用点都写 ?? []
  if (!Array.isArray(p.builtinSlugs)) p.builtinSlugs = [];
  return p;
}

/**
 * 写勾选。
 *
 * 会顺手把 `ids` 里不存在于库的编号剔掉并回告 —— 用户删了某条风格后，旧的 picks 里
 * 还留着那个编号时，agent 会照着读一份不存在的提示词，报错点离真正原因很远。
 * 内置 slug 同理：风格被删掉后留着 slug，apply_style 会报"风格不存在"。
 */
export function writePicks(input: {
  ids: string[];
  builtinSlugs?: string[];
  note?: string;
  projectId?: string;
}): {
  picks: StylePicks;
  dropped: string[];
} {
  const all = new Set(getIndex().items.map((i) => i.id));
  const ids = [...new Set(input.ids.map((s) => s.trim()).filter(Boolean))];
  const dropped = ids.filter((id) => !all.has(id));

  const builtinAll = new Set(listBuiltinStyles().map((b) => b.slug));
  const slugs = [...new Set((input.builtinSlugs ?? []).map((s) => s.trim()).filter(Boolean))];
  const droppedSlugs = slugs.filter((s) => !builtinAll.has(s));

  const picks: StylePicks = {
    at: new Date().toISOString(),
    ids: ids.filter((id) => all.has(id)),
    builtinSlugs: slugs.filter((s) => builtinAll.has(s)),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
  writeJson(PICKS_FILE, picks);
  return { picks, dropped: [...dropped, ...droppedSlugs] };
}

/**
 * agent 侧排版用：把勾选渲染成几行文字，省得它自己拼。
 *
 * 两个分组必须分开写、且各自带一句「下一步做什么」—— 这是整个勾选链路上最容易出错的地方：
 * 参考风格被直接 apply_style 会静默套不上，内置风格被"翻译"则等于白扔一份现成预设。
 */
export function picksSummary(): string {
  const p = readPicks();
  const ids = p?.ids ?? [];
  const slugs = p?.builtinSlugs ?? [];
  if (!ids.length && !slugs.length) return "用户还没在编辑器里挑风格。";

  const out: string[] = [];
  out.push(`用户挑了风格（${p!.at.slice(0, 16).replace("T", " ")}）：`);

  if (slugs.length) {
    const all = listBuiltinStyles();
    out.push("", `【内置 ${slugs.length} 个 · 能直接套用】`);
    for (const slug of slugs) {
      const b = all.find((x) => x.slug === slug);
      out.push(`· ${slug} ${b?.name ?? ""}${b && !b.hasPreset ? "（只有规则没有预设，要手动套）" : ""}`);
    }
    out.push("→ 这些直接 `apply_style(slug)` 就能落 palette/font/radius，**不要翻译**。多个候选就让用户挑，别一次全套。");
  }

  if (ids.length) {
    out.push("", `【参考 ${ids.length} 条 · 要翻译】`);
    for (const id of ids) {
      const it = itemById(id);
      if (!it) out.push(`· ${id}（库里已找不到这一条）`);
      else out.push(`· ${it.id} ${it.name}${it.summary ? ` —— ${it.summary}` : ""}${it.still ? "（有静帧）" : "（无静帧）"}`);
    }
    out.push(
      "→ 这些是**参考风格**，不能 apply_style。顺序：get_guide(\"style-translate\") 学怎么翻（六槽位 + 三条降级路径）→ get_style_library_prompt(id) 读原文 → 翻成本片的主题/版式/氛围 → probe_style 出我们引擎的样张给用户确认。",
    );
  }

  if (p?.note) out.push("", `备注：${p.note}`);
  return out.join("\n");
}
