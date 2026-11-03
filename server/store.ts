import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";
import type { Project } from "../shared/schema";
import { createSeedProject } from "../shared/ops";
import { migrateOverlaysToScenes, projectSchema } from "../shared/schema";
import { TRANSITION_TYPES } from "../shared/transitions";

export const DATA_DIR = path.join(PROJECT_ROOT, "data", "projects");
export const OUT_DIR = path.join(PROJECT_ROOT, "out");
export const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");

/**
 * 悬空链接自愈：data / out / public 有可能是指向外部工作区（如 D:\Remotion workspace）的符号链接。
 *
 * 为什么需要这段：`mkdirSync(recursive)` 只会在**真实路径**上逐级补建目录。当链接的目标被删掉后，
 * 路径解析在链接这一级就断了 —— Node 既不会去建链接的目标目录，也不会绕过链接在本项目里建，
 * 只抛一个 `ENOENT: mkdir ...\data\projects`，看不出真正原因（链接坏了），服务直接起不来。
 *
 * 处理策略（用户确认过的语义）：链接**有效**就按原设计用外部目录，不打扰；链接**悬空**就移除链接本身
 * （绝不碰目标），回到本项目内新建真实目录，并打一行日志说明改到哪儿去了。
 */
function healDanglingLink(target: string): void {
  const rel = path.relative(PROJECT_ROOT, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
  let cur = PROJECT_ROOT;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return; // 这一级还不存在：交给下面的 mkdir 建
    }
    if (!st.isSymbolicLink()) continue;
    try {
      fs.statSync(cur); // 跟随链接能拿到真实 stat = 链接有效
      return;
    } catch {
      let linkTarget = "?";
      try {
        linkTarget = fs.readlinkSync(cur);
      } catch {
        /* 读不到就写 ? */
      }
      try {
        // 先按符号链接删（unlink）；Windows 上目录联接要用 rmdir 才删得掉
        fs.unlinkSync(cur);
      } catch {
        fs.rmdirSync(cur);
      }
      console.warn(
        `[store] ${cur} 原是指向 ${linkTarget} 的链接，但目标目录不存在 —— 已移除链接，改在项目内新建目录` +
          `（如仍想放到外部工作区，把该目录建好再手工重建链接即可）`,
      );
      return;
    }
  }
}

const ensureDirs = () => {
  for (const dir of [DATA_DIR, OUT_DIR, PUBLIC_DIR, path.join(PUBLIC_DIR, "assets")]) {
    healDanglingLink(dir);
    fs.mkdirSync(dir, { recursive: true });
  }
};

const fileOf = (id: string) => path.join(DATA_DIR, id, "project.json");

/**
 * `out/projects/` 下有、`data/projects/` 里没有的工程 id。
 *
 * 复盘问题 18：同一台机器上两套实例/两套数据目录并存时，agent 的清单里会突然少了刚做完的工程
 * （它其实在另一份数据里），或者冒出几个从没创建过的高 rev 工程。
 * 启动时与 list_projects 都拿它做对账，宁可多说一句，也别让人以为工程被删了。
 */
export function orphanOutputProjects(): string[] {
  ensureDirs();
  const outProjects = path.join(OUT_DIR, "projects");
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(outProjects, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const known = new Set(listProjectIds());
  return dirs.filter((id) => !known.has(id));
}

export function listProjectIds(): string[] {
  ensureDirs();
  return fs
    .readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(DATA_DIR, d.name, "project.json")))
    .map((d) => d.name);
}

/**
 * 读工程。
 *
 * **容错**：一个工程里有非法字段（历史上出现过 `subtitleStyle.bold: true`）时，
 * 原来直接 `projectSchema.parse` 抛错 → 列表/健康检查/其它工程全部 500，
 * 一个坏工程能把整个服务拖死。现在：
 *  1. 先试正常解析；
 *  2. 失败时做**定向自愈**（只修已知的几种历史脏值：字幕字重布尔、transforms["undefined"]），
 *     修好就写回并继续；
 *  3. 自愈也失败才抛错，错误里说清楚是哪个工程、哪个字段。
 */
export function readProject(id: string): Project {
  ensureDirs();
  const raw = fs.readFileSync(fileOf(id), "utf8");
  const data = JSON.parse(raw) as Record<string, unknown>;
  const first = projectSchema.safeParse(data);
  if (first.success) {
    if (migrateOverlaysToScenes(first.data)) {
      fs.writeFileSync(fileOf(id), JSON.stringify(first.data, null, 2), "utf8");
    }
    return first.data;
  }
  // 定向自愈：只改确定是历史脏值的字段，别的不动
  if (repairKnownDirtyValues(data)) {
    const retry = projectSchema.safeParse(data);
    if (retry.success) {
      fs.writeFileSync(fileOf(id), JSON.stringify(retry.data, null, 2), "utf8");
      migrateOverlaysToScenes(retry.data);
      return retry.data;
    }
  }
  const detail = first.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(根)"}：${i.message}`)
    .join("；");
  throw new Error(`工程 ${id} 的数据不合法：${detail}`);
}

/**
 * 只修已知的历史脏值，返回是否改过任何东西。
 * 目前三类：
 *  - `scene.subtitleStyle.bold` 是布尔（曾把"字重"当布尔写）→ true:700 / false:400
 *  - `scene.transforms` 里有 `"undefined"` 键（旧版 set_transform 参数名写错的产物）→ 删掉
 *  - `transitionIn/Out.type` 是不存在的转场 → 优先大小写归一（"GLITCH" → "glitch"，
 *    2026-11 转场扩容后 glitch 本身合法了），真不存在的映射观感或退回 blur，
 *    否则这个工程每次打开都报「数据不合法」，直接打不开
 */
export function repairKnownDirtyValues(project: Record<string, unknown>): boolean {
  let changed = false;
  const scenes = Array.isArray(project.scenes) ? (project.scenes as Record<string, unknown>[]) : [];
  for (const sc of scenes) {
    const style = sc.subtitleStyle as Record<string, unknown> | undefined;
    if (style && typeof style.bold === "boolean") {
      style.bold = style.bold ? 700 : 400;
      changed = true;
    }
    const transforms = sc.transforms as Record<string, unknown> | undefined;
    if (transforms && "undefined" in transforms) {
      delete transforms.undefined;
      changed = true;
      if (!Object.keys(transforms).length) delete sc.transforms;
    }
    for (const key of ["transitionIn", "transitionOut"] as const) {
      const tr = sc[key] as Record<string, unknown> | undefined;
      if (!tr || typeof tr !== "object") continue;
      const type = String(tr.type ?? "");
      // 先试大小写归一：glitch 在 2026-11 转场扩容后成了合法类型，历史数据里
      // 写成 "GLITCH"/"Glitch" 的应该保留原意，而不是被当成脏值重置成 blur
      const lower = type.toLowerCase();
      if (TRANSITION_TYPES.includes(type as (typeof TRANSITION_TYPES)[number])) continue;
      if (TRANSITION_TYPES.includes(lower as (typeof TRANSITION_TYPES)[number])) {
        tr.type = lower;
        changed = true;
        continue;
      }
      // 真不存在的才映射：有对应观感的过去，没有就退回 blur（合法集合里最接近"故障/毛刺"）
      const map: Record<string, string> = { noise: "blur", fadein: "fade" };
      tr.type = map[lower] ?? "blur";
      if (typeof tr.durationInFrames !== "number" || tr.durationInFrames < 0) tr.durationInFrames = 8;
      changed = true;
    }
  }
  return changed;
}

export function writeProject(project: Project): void {
  ensureDirs();
  fs.mkdirSync(path.dirname(fileOf(project.id)), { recursive: true });
  fs.writeFileSync(fileOf(project.id), JSON.stringify(project, null, 2), "utf8");
  // 每次落盘顺手存一份 rev 快照，历史面板才能"回滚到某一版"。
  // 快照失败不能影响主写入，所以内部自己 try/catch。
  saveSnapshot(project);
}

/* ────────────────────────────── rev 快照（历史回滚） ────────────────────────────── */

const SNAPSHOT_KEEP = 50;

const historyDirOf = (id: string) => path.join(DATA_DIR, id, "history");

/** 快照保留策略抽成纯函数，方便单测：按 rev 升序，保留最后 keep 个 */
export function pickSnapshotRevs(revs: number[], keep: number): number[] {
  const sorted = [...new Set(revs)].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (sorted.length <= keep) return sorted;
  return sorted.slice(sorted.length - keep);
}

/** 固定槽位文件名：rev 对 keep 取模，第 50 份之后自然盖掉最老的那一份 */
const slotFileOf = (id: string, rev: number) =>
  path.join(historyDirOf(id), `s${rev % SNAPSHOT_KEEP}.json`);

export function listSnapshots(id: string): number[] {
  const dir = historyDirOf(id);
  if (!fs.existsSync(dir)) return [];
  const out: number[] = [];
  for (const f of fs.readdirSync(dir)) {
    // 旧格式：直接以 rev 命名
    const legacy = /^(\d+)\.json$/.exec(f);
    if (legacy) {
      out.push(Number(legacy[1]));
      continue;
    }
    // 新格式：s<slot>.json，rev 写在内容里
    if (!/^s\d+\.json$/.test(f)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { rev?: number };
      if (typeof data.rev === "number") out.push(data.rev);
    } catch {
      /* 坏快照跳过：不能因为一份损坏的历史让整个列表 500 */
    }
  }
  return out;
}

/**
 * 落一份 rev 快照。
 *
 * **固定 50 个槽位轮转覆盖，永远不删文件** —— 这条是被真实事故逼出来的：
 * 原来是"写一份、删掉最老的一份"，而本机宿主会给 Node 注入 safe-delete 拦截器
 * （按每轮删文件数设阈值）。连续编辑几十笔之后，每次保存都撞阈值，
 * **整个 Node 进程被卡住**：界面表现为属性改不动、所有请求排队到超时
 * （红色提示 "signal timed out"），刷新也没用，只能重启服务。
 *
 * 覆盖同一个文件名只做 write，不触发任何删除策略，所以这条路彻底没有了。
 * 代价是 `listSnapshots` 要读文件内容才知道 rev（50 个小 JSON，历史面板打开时才算）。
 */
export function saveSnapshot(project: Project): void {
  try {
    const dir = historyDirOf(project.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(slotFileOf(project.id, project.rev), JSON.stringify(project), "utf8");
  } catch {
    /* 快照只是锦上添花，失败不影响工程本身 */
  }
}

export function readSnapshot(id: string, rev: number): Project | null {
  // 新槽位：内容里的 rev 必须是同一个——槽位可能已被更新的 rev 覆盖
  const slot = slotFileOf(id, rev);
  if (fs.existsSync(slot)) {
    try {
      const p = JSON.parse(fs.readFileSync(slot, "utf8")) as Project;
      if (p.rev === rev) return p;
    } catch {
      /* 落到旧格式 */
    }
  }
  const legacy = path.join(historyDirOf(id), `${rev}.json`);
  if (!fs.existsSync(legacy)) return null;
  try {
    return JSON.parse(fs.readFileSync(legacy, "utf8")) as Project;
  } catch {
    return null;
  }
}

/** 递归删除目录内容（不用 fs.rmSync：某些 Windows/上层过滤驱动环境下它会静默返回却不删） */
export const removeTree = (dir: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeTree(child);
      fs.rmdirSync(child);
    } else {
      fs.unlinkSync(child);
    }
  }
};

/** 删除整个工程目录（project.json + 该工程的产物） */
export function deleteProjectDir(id: string): void {
  // id 来自路由参数，先挡住路径穿越
  if (!/^[\w-]+$/.test(id)) throw new Error("非法的工程 id");
  const dir = path.join(DATA_DIR, id);
  if (!fs.existsSync(dir)) return;
  removeTree(dir);
  fs.rmdirSync(dir);
}

export function ensureSeed(): void {
  ensureDirs();
  const ids = listProjectIds();
  if (ids.length === 0) {
    const seed = createSeedProject("demo");
    writeProject(seed);
    console.log(`[store] 初始化示例工程 data/projects/${seed.id}/project.json`);
  }
}

/**
 * 工程的创建 / 最后修改时间。
 *
 * Project 文档里没有 createdAt（不为一个展示字段改 schema 和 rev），
 * 这里直接读文件时间：createdAt 取 birthtime（Windows/NTFS 可靠，拿不到退回 mtime），
 * updatedAt 取 mtime。
 */
export function projectFileTimes(id: string): { createdAt: string; updatedAt: string } {
  try {
    const st = fs.statSync(fileOf(id));
    const created = st.birthtimeMs > 0 ? st.birthtime : st.mtime;
    return { createdAt: created.toISOString(), updatedAt: st.mtime.toISOString() };
  } catch {
    return { createdAt: "", updatedAt: "" };
  }
}

/**
 * 上一次打开、或被 agent 编辑过的工程。
 *
 * 存在 data/last-project.json，跟工程数据放一起——它描述的是"这台机器上最近在用哪个工程"，
 * 属于本地状态，不该进工程文档（否则每次切换工程都会 push 一个新 rev）。
 */
const LAST_PROJECT_FILE = path.join(PROJECT_ROOT, "data", "last-project.json");

export function readLastProjectId(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(LAST_PROJECT_FILE, "utf8")) as { id?: unknown };
    return typeof raw.id === "string" ? raw.id : null;
  } catch {
    return null;
  }
}

export function writeLastProjectId(id: string): void {
  try {
    fs.mkdirSync(path.dirname(LAST_PROJECT_FILE), { recursive: true });
    fs.writeFileSync(
      LAST_PROJECT_FILE,
      JSON.stringify({ id, at: new Date().toISOString() }, null, 2),
      "utf8",
    );
  } catch {
    /* 记录失败不影响主流程 */
  }
}

/**
 * UI 偏好（面板宽度 / 折叠 / 时间轴高度 / 显示开关）。
 *
 * 直接存 localStorage 的镜像（字符串 map），前端读回时原样写回 localStorage，
 * 所以像 `rms:outlines` 那种用 "1"/"0" 字符串判断的地方完全不用改。
 */
const UI_PREFS_FILE = path.join(PROJECT_ROOT, "data", "ui-prefs.json");

export function readUiPrefs(): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(UI_PREFS_FILE, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") clean[key] = value;
    }
    return clean;
  } catch {
    return {};
  }
}

export function writeUiPrefs(prefs: Readonly<Record<string, string>>): void {
  try {
    fs.mkdirSync(path.dirname(UI_PREFS_FILE), { recursive: true });
    fs.writeFileSync(UI_PREFS_FILE, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error(`[store] 写入 UI 偏好失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
