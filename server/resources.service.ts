import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { Context } from "hono";
import { mimeOf, parseRange } from "./static.service";
import { readUiPrefs, writeUiPrefs } from "./store";

/**
 * 本地资源库：用户把自己的素材文件夹（每类一个）登记进来，agent 和编辑器
 * 直接**引用**里面的文件 —— 文件留在原地，一个字节都不复制。
 *
 * 为什么不复制进 public/assets（「导入素材库」）：
 *   素材动辄几个 GB，复制一份纯浪费；而且 cleanup_unused_assets 那套「无主文件」
 *   判定永远不该碰用户自己的目录。代价是渲染时素材走本机 HTTP 拉取（见下面的
 *   /resources/ 流出路由），server 常驻所以不构成额外依赖。
 *
 * 引用形式：`/resources/<类别>/<相对路径>`（编辑器预览同源直接用），
 * 或完整 `http://127.0.0.1:<port>/resources/...`（渲染 / 写进工程字段用这个，
 * 因为 Remotion 渲染的 bundle 在另一个 origin，相对路径会指错地方）。
 *
 * 三条安全线：
 *   1. 一切读取都先 resolve，再确认仍落在该类别配置的根目录内（防 .. 越界）；
 *      真正流出文件内容前再用 realpath 复核一次，符号链接/junction 指到根外也拦
 *   2. config / browse / search / thumb / pick 这类「能枚举磁盘内容、能改根目录」的管理接口
 *      按**连接来源**只对 127.0.0.1 / ::1 开放（见 index.ts 的 isLocalRequest）——
 *      LAN 模式下同网段机器既枚举不了，也改不了配置；文件流出仍开放（LAN 下编辑器预览需要），
 *      但攻击者必须知道精确路径，而精确路径只能从本机管理面拿到
 *   3. 未配置的类别一律「还没配置」，不回退到全盘
 */

export type ResourceCategoryId = "image" | "bgm" | "sfx" | "video" | "fx" | "other";

export type ResourceCategoryDef = {
  id: ResourceCategoryId;
  label: string;
  exts: string[];
};

export const RESOURCE_CATEGORIES: ResourceCategoryDef[] = [
  {
    id: "image",
    label: "图片",
    exts: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".bmp", ".hdr"],
  },
  { id: "bgm", label: "BGM", exts: [".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus"] },
  { id: "sfx", label: "音效", exts: [".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus"] },
  { id: "video", label: "视频", exts: [".mp4", ".mov", ".webm", ".mkv", ".m4v"] },
  /** lottie json + 序列帧；播放/渲染支持取决于场景侧，这里只管找得到、给得出地址 */
  { id: "fx", label: "特效", exts: [".json", ".lottie", ".zip"] },
  { id: "other", label: "其它", exts: [] },
];

const KEY_PREFIX = "rms:res:";

export const resourceCategoryOf = (id: string) =>
  RESOURCE_CATEGORIES.find((c) => c.id === id);

const extAllowed = (cat: ResourceCategoryDef, file: string): boolean => {
  if (!cat.exts.length) return true; // other：不限扩展名
  const ext = path.extname(file).toLowerCase();
  return cat.exts.includes(ext);
};

/** 每类配置的根目录（来自 ui-prefs 的 rms:res:<id> 键） */
export function readResourceDirs(): Record<string, string> {
  const prefs = readUiPrefs();
  const out: Record<string, string> = {};
  for (const cat of RESOURCE_CATEGORIES) {
    const v = prefs[KEY_PREFIX + cat.id];
    if (v) out[cat.id] = v;
  }
  return out;
}

export function resourceDirOf(catId: string): string | null {
  const v = readUiPrefs()[KEY_PREFIX + catId];
  return v || null;
}

/** 配置/更换某类的目录：必须是已存在的目录，否则直接抛错（回执里给可照改的信息） */
export function setResourceDir(catId: string, dir: string): string {
  const cat = resourceCategoryOf(catId);
  if (!cat) {
    throw new Error(`没有「${catId}」这个资源类别。可用：${RESOURCE_CATEGORIES.map((c) => c.id).join("、")}`);
  }
  const abs = path.resolve(dir.trim());
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`目录不存在：${abs}（先确认盘符和路径；如果它是「素材\图片」下层的文件夹，别漏掉中间层）`);
  }
  if (!st.isDirectory()) {
    throw new Error(`${abs} 不是目录（是要一个文件夹，不是文件）`);
  }
  // stat 能过、readdir 未必（外接盘休眠/第三方文件系统驱动都有先例）。
  // 配置时就实测一次，把「保存成功但一列就炸」挡在门口：
  try {
    fs.readdirSync(abs);
  } catch (err) {
    throw new Error(
      `${abs} 能看到但列不出内容：${err instanceof Error ? err.message : String(err)}` +
        `（移动硬盘可能在休眠，或文件系统驱动不兼容 —— 重新插拔后再试）`,
    );
  }
  const prefs = readUiPrefs();
  prefs[KEY_PREFIX + catId] = abs;
  writeUiPrefs(prefs);
  return abs;
}

/** 清除某类的目录配置（配错了/不想用了）。没配过也当成功，幂等 */
export function clearResourceDir(catId: string): void {
  const cat = resourceCategoryOf(catId);
  if (!cat) {
    throw new Error(`没有「${catId}」这个资源类别。可用：${RESOURCE_CATEGORIES.map((c) => c.id).join("、")}`);
  }
  const prefs = readUiPrefs();
  delete prefs[KEY_PREFIX + catId];
  writeUiPrefs(prefs);
}

/** 资源目录里会遇到、但 static.service 的 MIME 表没有的扩展名（缺了会被 Chromium 拒播） */
const RES_MIME: Record<string, string> = {
  ".hdr": "image/vnd.radiance",
  ".exr": "image/x-exr",
  ".flac": "audio/flac",
  ".opus": "audio/opus",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".lottie": "application/json",
};

const resMimeOf = (file: string): string => RES_MIME[path.extname(file).toLowerCase()] ?? mimeOf(file);

/** rel（/ 分隔、已 decode）→ 绝对路径；`..` 越界返回 null。
 * 符号链接指向根目录外的情况这里看不出来（`path.resolve` 不解析链接），
 * 由 serveResourceFile 在真正读内容前用 realpath 复核。 */
function safeJoin(root: string, rel: string): string | null {
  const rootAbs = path.resolve(root);
  const full = path.resolve(rootAbs, ...rel.split("/").filter((p) => p && p !== "."));
  const relToRoot = path.relative(rootAbs, full);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) return null;
  return full;
}

export type ResourceEntry = {
  name: string;
  dir: boolean;
  size?: number;
  mtime?: number;
  /** 站内引用（完整 URL），dir 没有 */
  url?: string;
};

export function browseCategory(catId: string, sub = ""): {
  root: string;
  path: string;
  parent: string | null;
  entries: ResourceEntry[];
  /** 当前这一层就是序列帧文件夹时给出识别结果（fx 类），前端据此显示摘要而不是空白网格 */
  sequence?: DetectedSequence;
  /** 序列帧文件夹的前几帧 URL，给面板预览用（只给 8 张，别把几百张原图一起拉出来） */
  preview?: string[];
} {
  const cat = resourceCategoryOf(catId);
  if (!cat) throw new Error(`没有「${catId}」这个资源类别`);
  const root = resourceDirOf(catId);
  if (!root) throw new Error(`「${cat.label}」还没配置本地目录——先在资源库面板里给它指定一个文件夹`);

  const abs = safeJoin(root, sub);
  if (!abs) throw new Error(`路径越界：${sub} 不在「${cat.label}」的目录内`);

  let list: fs.Dirent[];
  try {
    list = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // 根目录读不了和子目录读不了，给的建议完全不同：
    throw new Error(
      !sub
        ? `配置的目录读不了（${detail}）。可能被移动/改名，或移动硬盘休眠了 —— 点「浏览…」重新选一次即可`
        : `读不了 ${abs}（${detail}）。这个子目录可能刚被移动或删了 —— 点「← 上一级」刷新一下`,
    );
  }

  const entries: ResourceEntry[] = [];
  for (const ent of list) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(abs, ent.name);
    if (ent.isDirectory()) {
      entries.push({ name: ent.name, dir: true });
      continue;
    }
    if (!ent.isFile() || !extAllowed(cat, ent.name)) continue;
    let size = 0;
    let mtime = 0;
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      // 拿不到 stat（被占用等）就列出来但别带元数据
    }
    entries.push({
      name: ent.name,
      dir: false,
      size,
      mtime,
      url: resourceUrl(catId, sub ? `${sub}/${ent.name}` : ent.name),
    });
  }
  entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, "zh")));

  const parent = sub ? (sub.includes("/") ? sub.slice(0, sub.lastIndexOf("/")) : "") : null;

  /**
   * fx 类目录里的单帧 PNG 不在 exts 白名单内（整夹才是结果），所以按普通规则列出来
   * 会是「0 项」——用户点开自己的特效库以为读不出东西。这里复用同一次 readdir 的条目
   * 就地识别，返回摘要 + 少量预览帧（不额外读盘，也不在前端铺几百张原图）。
   */
  const sequence = cat.id === "fx" ? (detectSequenceFromEntries(list) ?? undefined) : undefined;
  const preview = sequence
    ? list
        .filter((e) => e.isFile() && SEQ_IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
        .slice(0, 8)
        .map((e) => resourceUrl(catId, sub ? `${sub}/${e.name}` : e.name))
    : undefined;
  return { root, path: sub, parent, entries, ...(sequence ? { sequence, preview } : {}) };
}

/* ───────────── 目录选择器（「浏览…」按钮的后端） ───────────── */

/**
 * 浏览器拿不到本机绝对路径：`<input webkitdirectory>` 只给相对路径，
 * `showDirectoryPicker()` 给的句柄也不带完整路径，而 server 侧列目录必须有绝对路径。
 * 所以「浏览」由 server 代劳：从这里开始逐级列出子目录，用户走到目标文件夹后
 * 点「使用此目录」，把路径写进该类的配置。
 *
 * 只列**目录**不列文件 —— 这是选文件夹，翻文件是 browse/search 的事。
 * 与 browse/search 同一条安全线：只在 loopback Host 下开放（见 index.ts 路由）。
 */

/** Windows 枚举存在的盘符；非 Windows 回退到根 `/` */
function listDrives(): string[] {
  if (process.platform !== "win32") return ["/"];
  const drives: string[] = [];
  for (let i = 65; i <= 90; i++) {
    const drive = `${String.fromCharCode(i)}:\\`;
    try {
      fs.accessSync(drive, fs.constants.X_OK);
      drives.push(drive);
    } catch {
      // 空光驱/不存在的盘符跳过（accessSync 在 Windows 上对无介质光驱也可能不抛，无妨）
    }
  }
  return drives;
}

/** Windows 自带的系统目录，进不去也没意义，列出来纯添乱 */
const PICK_SKIP = new Set(["system volume information", "$recycle.bin", "windows", "program files", "program files (x86)", "programdata", "appdata"]);

export type PickEntry = { name: string; dir: true; path: string };

export function pickDir(abs = ""): { path: string; parent: string | null; entries: PickEntry[] } {
  if (!abs.trim()) {
    return {
      path: "",
      parent: null,
      entries: listDrives().map((d) => ({ name: d, dir: true, path: d })),
    };
  }
  const full = path.resolve(abs.trim());
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch {
    throw new Error(`目录不存在：${full}`);
  }
  if (!st.isDirectory()) throw new Error(`${full} 不是目录（要一个文件夹）`);

  let list: fs.Dirent[];
  try {
    list = fs.readdirSync(full, { withFileTypes: true });
  } catch (err) {
    throw new Error(`读不了 ${full}：${err instanceof Error ? err.message : String(err)}`);
  }
  const entries: PickEntry[] = [];
  for (const ent of list) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    if (PICK_SKIP.has(ent.name.toLowerCase())) continue;
    entries.push({ name: ent.name, dir: true, path: path.join(full, ent.name) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  const parent = path.dirname(full);
  /**
   * parent 为 null 只有「盘符列表」这一层用；盘符根目录（如 D:\）的 dirname 是它自己，
   * 但用户还得能退回盘符列表换别的盘 —— 所以这里回 ""（盘符层的地址）而不是 null。
   */
  return { path: full, parent: parent === full ? "" : parent, entries };
}

/**
 * 逐段编码：中文/空格/#/?/% 直接拼进 URL 会截断或 404。
 * 但 `{frame}` 是序列帧模式串的占位符，必须原样留给渲染端替换，不能被编码成 %7Bframe%7D。
 */
const encodeSegment = (s: string): string =>
  s.split("{frame}").map((p) => encodeURIComponent(p)).join("{frame}");

/** 站内相对引用（/resources/<类>/<相对路径>） */
export const resourceRelUrl = (catId: string, rel: string): string =>
  `/resources/${catId}/${rel.split(/[\\/]/).filter((p) => p && p !== ".").map(encodeSegment).join("/")}`;

/** 完整引用（写进工程字段 / 渲染用这个）：本机 origin + 站内相对引用 */
export const resourceUrl = (catId: string, rel: string): string =>
  `http://127.0.0.1:${process.env.PORT ?? "4380"}${resourceRelUrl(catId, rel)}`;

export type ResourceHit = {
  name: string;
  /** 相对该类根目录的路径（/ 分隔） */
  rel: string;
  /** 绝对路径（让 agent 知道文件真实在哪，也方便用户去找） */
  abs: string;
  size: number;
  mtime: number;
  /** 站内引用 URL：普通文件直达；kind=sequence 时指向文件夹（逐帧用下面的 pattern） */
  url: string;
  /** 序列帧文件夹专用 */
  kind?: "sequence";
  frames?: number;
  firstFrame?: string;
  lastFrame?: string;
  /** 可直接粘进 imageSeqSrc / material.map.src 的模式串 URL（含 {frame}，已编码） */
  pattern?: string;
  seqFrom?: number;
  seqTo?: number;
  frameDigits?: number;
  /** 编号是否连续；false = 中间跳号，不能按「首帧 + N」盲拼 */
  continuous?: boolean;
};

/* ───────────── 序列帧识别（特效类） ───────────── */

/**
 * 序列帧是「几百张编号图片躺在一个文件夹里」，单帧没有意义、数量还会挤爆搜索结果。
 * 所以 fx 类搜索时把**整个文件夹**作为一个结果返回。
 *
 * 识别规则（宁缺毋滥，别把普通照片文件夹误伤）：
 *   文件夹里 ≥8 张图片，且按「前缀+编号」分组后，**最大的一组 ≥8 张**。
 *   `explosion_0001.png … explosion_0120.png` 是序列帧；
 *   `xww 0 草地湖水1 (0.10MB).png` 这种名字各异的普通图组不会命中（结尾不是编号）。
 *
 * 返回帧数 + 首末帧文件名（agent 拿这个就能拼出全部逐帧 URL）；不像序列帧返回 null。
 */
const SEQ_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".tga", ".exr", ".bmp", ".webp"]);
const SEQ_MIN_FRAMES = 8;

/**
 * 在**已经读到手的目录条目**里做序列帧识别（不重新读盘）。
 * 规则：某「前缀+编号」组的图片 ≥8 张即认定；返回可直接用的模式串与参数。
 *
 * 保留文件名的原始大小写（分组 key 才小写）：Windows 大盘不敏感看不出差别，
 * 但在大小写敏感的文件系统上，把 `Explosion_0001.png` 回执成 `explosion_…` 会 404。
 * 同时返回 continuous：编号跳号时不能让 agent 按「首帧 + N」盲拼出并不存在的帧。
 */
export type DetectedSequence = {
  /** 帧文件名模式串（不含目录）：前缀 + {frame} + 扩展名 */
  pattern: string;
  frames: number;
  seqFrom: number;
  seqTo: number;
  frameDigits: number;
  continuous: boolean;
  firstFrame: string;
  lastFrame: string;
};

export function detectSequenceFromEntries(list: fs.Dirent[]): DetectedSequence | null {
  const groups = new Map<
    string,
    { count: number; min: number; max: number; pad: number; ext: string; rawPrefix: string }
  >();
  let files = 0;
  for (const e of list) {
    if (!e.isFile()) continue;
    files++;
    const ext = path.extname(e.name).toLowerCase();
    if (!SEQ_IMAGE_EXTS.has(ext)) continue;
    const stem = e.name.slice(0, e.name.length - ext.length);
    const m = /^(.*?)(\d{2,})$/.exec(stem); // 结尾至少 2 位连续数字才算编号
    if (!m) continue;
    const key = m[1].toLowerCase();
    const num = parseInt(m[2], 10);
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.min = Math.min(g.min, num);
      g.max = Math.max(g.max, num);
      g.pad = Math.max(g.pad, m[2].length);
    } else {
      groups.set(key, { count: 1, min: num, max: num, pad: m[2].length, ext, rawPrefix: m[1] });
    }
  }
  if (files < SEQ_MIN_FRAMES) return null;
  let best: { count: number; min: number; max: number; pad: number; ext: string; rawPrefix: string } | null = null;
  for (const g of groups.values()) {
    if (g.count < SEQ_MIN_FRAMES) continue;
    if (!best || g.count > best.count) best = g;
  }
  if (!best) return null;
  const fmt = (n: number) => best!.rawPrefix + String(n).padStart(best!.pad, "0") + best!.ext;
  return {
    pattern: `${best.rawPrefix}{frame}${best.ext}`,
    frames: best.count,
    seqFrom: best.min,
    seqTo: best.max,
    frameDigits: best.pad,
    continuous: best.count === best.max - best.min + 1,
    firstFrame: fmt(best.min),
    lastFrame: fmt(best.max),
  };
}

export function searchCategory(
  catId: string,
  opts: { keyword?: string; ext?: string[]; limit?: number } = {},
): { root: string; total: number; truncated: boolean; hits: ResourceHit[] } {
  const cat = resourceCategoryOf(catId);
  if (!cat) throw new Error(`没有「${catId}」这个资源类别`);
  const root = resourceDirOf(catId);
  if (!root) throw new Error(`「${cat.label}」还没配置本地目录——先在资源库面板里给它指定一个文件夹`);

  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 300);
  const kw = (opts.keyword ?? "").trim().toLowerCase();
  const extFilter = (opts.ext ?? [])
    .map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`))
    .filter(Boolean);

  const hits: ResourceHit[] = [];
  let visited = 0;
  let truncated = false;
  const queue: { abs: string; rel: string }[] = [{ abs: root, rel: "" }];

  /**
   * 广度优先、**不限目录深度**：素材树深到五六层很常见（图片→背景→草地→子类→…），
   * 按层数截断会静默漏掉深处的素材且用户无从察觉。
   * 失控防护不靠层数，靠「总扫描量」：visited 封顶 + 结果条数封顶，最坏情况也就几秒。
   *
   * **每个目录只读一次盘**（readdir 是外接盘上最贵的操作）：
   * 出队时读条目，特效类先就地判断「是不是序列帧文件夹」——
   * 是则整体成一个结果、不再展开子项（几百帧逐个列既无意义又白烧扫描量）；
   * 否则才遍历子项：文件过滤，子目录入队。
   */
  while (queue.length) {
    // 队列里还有没扫的目录 = 结果不全。不能让「hits 恰好等于 limit」悄悄退出后
    // 还回 truncated:false，agent 会以为已经列全了。
    if (hits.length >= limit || visited > 50_000) {
      truncated = queue.length > 0;
      break;
    }
    const { abs, rel } = queue.shift()!;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue; // 无权限/路径超长/被占用的目录跳过
    }

    if (cat.id === "fx") {
      const seq = detectSequenceFromEntries(list);
      const name = path.basename(abs);
      // 序列帧文件夹是「一个结果」，也必须吃 keyword / ext 过滤：
      // 否则搜「碎石」会把全部 298 个序列夹塞满 limit，回执还劝 agent 换关键词（无效）
      const matchesKw = !kw || name.toLowerCase().includes(kw) || rel.toLowerCase().includes(kw);
      // ext 对文件夹按帧的扩展名判定：找 json/lottie 时不该混进一堆 PNG 序列
      const matchesExt = !extFilter.length || extFilter.some((e) => SEQ_IMAGE_EXTS.has(e));
      if (seq && matchesKw && matchesExt) {
        visited++;
        hits.push({
          name,
          rel,
          abs,
          size: 0,
          mtime: 0,
          url: `${resourceUrl(catId, rel)}/`,
          kind: "sequence",
          // 直接给可粘贴的模式串，别让 agent 从首末帧名反推前缀/位数/起点
          pattern: resourceUrl(catId, rel ? `${rel}/${seq.pattern}` : seq.pattern),
          frames: seq.frames,
          firstFrame: seq.firstFrame,
          lastFrame: seq.lastFrame,
          seqFrom: seq.seqFrom,
          seqTo: seq.seqTo,
          frameDigits: seq.frameDigits,
          continuous: seq.continuous,
        });
        continue; // 序列帧内部不再展开
      }
      // 关键词不匹配时不整夹跳过：里面可能还有 json/lottie 命中。
      // fx 白名单不收单帧图片，几百张 PNG 只计 visited、不进结果，也不额外读盘。
    }

    for (const ent of list) {
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      visited++;
      if (ent.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        queue.push({ abs: path.join(abs, ent.name), rel: childRel });
        continue;
      }
      if (!ent.isFile() || !extAllowed(cat, ent.name)) continue;
      if (extFilter.length && !extFilter.includes(path.extname(ent.name).toLowerCase())) continue;
      if (kw && !ent.name.toLowerCase().includes(kw) && !childRel.toLowerCase().includes(kw)) continue;
      let size = 0;
      let mtime = 0;
      try {
        const st = fs.statSync(path.join(abs, ent.name));
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        // 同 browse：stat 不到也返回
      }
      hits.push({
        name: ent.name,
        rel: childRel,
        abs: path.join(abs, ent.name),
        size,
        mtime,
        url: resourceUrl(catId, childRel),
      });
    }
  }
  return { root, total: hits.length, truncated, hits };
}

/** realpath(root) 缓存：序列帧每帧都要复核越界，别每次都做一次磁盘解析 */
const realRootCache = new Map<string, string>();

const realRootOf = (root: string): string => {
  const hit = realRootCache.get(root);
  if (hit) return hit;
  const real = fs.realpathSync(root);
  if (realRootCache.size > 32) realRootCache.clear();
  realRootCache.set(root, real);
  return real;
};

/**
 * 把 `/resources/<类>/<相对路径>` 的文件流出去。
 * 复用 static.service 的 MIME 表和 Range 逻辑（音视频要能拖进度条），
 * 但根目录是**每类动态**的，所以不能直接用 serveFiles 工厂。
 * 缓存给 must-revalidate + ETag：预览每帧都要验证一次，304 便宜，正确性优先。
 */
export function serveResourceFile(c: Context, catId: string, rel: string): Response | Promise<Response> {
  const cat = resourceCategoryOf(catId);
  if (!cat) return c.notFound();
  const root = resourceDirOf(catId);
  if (!root) return c.notFound();

  const full = safeJoin(root, rel);
  if (!full) return c.json({ error: "路径越界" }, 403);

  /**
   * 符号链接 / Windows junction 能把字符串上「在根内」的路径指到根外，
   * safeJoin 的 path.resolve 看不见这一层。真正读内容之前用 realpath 复核一次；
   * root 自己也 realpath（允许配置的根目录本身是链接），并缓存避免每帧重复 syscall。
   */
  try {
    const realRoot = realRootOf(root);
    const realFull = fs.realpathSync(full);
    const inside = path.relative(realRoot, realFull);
    if (inside.startsWith("..") || path.isAbsolute(inside)) return c.json({ error: "路径越界" }, 403);
  } catch {
    return c.notFound();
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    return c.notFound();
  }
  if (!stat.isFile()) return c.notFound();

  const type = resMimeOf(full);
  const size = stat.size;
  const etag = `W/"${size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=0, must-revalidate",
    etag,
    "last-modified": stat.mtime.toUTCString(),
    /**
     * **WebGL 贴图必须有 CORS 头**：three 的 TextureLoader 以 crossOrigin=anonymous
     * 拉图（要把像素读进 WebGL），渲染 bundle 的 origin（localhost:3000 / 渲染端口）
     * 和本机 server（127.0.0.1:4380）不同源——没这个头 2D <img> 能显示、3D 贴图必挂，
     * 且报错只在渲染日志里（CORS blocked），工程数据完全看不出问题。
     * 能枚举目录的接口仍限本机；文件流出要精确路径，开放 CORS 风险可控。
     */
    "access-control-allow-origin": "*",
  };

  const inm = c.req.header("if-none-match");
  if (inm && inm === etag) return c.body(null, 304, headers);

  const span = parseRange(c.req.header("range"), size);
  if (span === "invalid") {
    return c.body(null, 416, { ...headers, "content-range": `bytes */${size}` });
  }
  const start = span ? span.start : 0;
  const end = span ? span.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  headers["content-length"] = String(length);
  if (span) headers["content-range"] = `bytes ${start}-${end}/${size}`;

  if (c.req.method === "HEAD" || size === 0) {
    return c.body(null, span ? 206 : 200, headers);
  }
  const nodeStream = fs.createReadStream(full, { start, end });
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
  return c.body(webStream, span ? 206 : 200, headers);
}
