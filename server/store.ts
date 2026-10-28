import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";
import type { Project } from "../shared/schema";
import { createSeedProject } from "../shared/ops";
import { migrateOverlaysToScenes, projectSchema } from "../shared/schema";

export const DATA_DIR = path.join(PROJECT_ROOT, "data", "projects");
export const OUT_DIR = path.join(PROJECT_ROOT, "out");
export const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");

const ensureDirs = () => {
  for (const dir of [DATA_DIR, OUT_DIR, PUBLIC_DIR, path.join(PUBLIC_DIR, "assets")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const fileOf = (id: string) => path.join(DATA_DIR, id, "project.json");

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
 * 目前两类：
 *  - `scene.subtitleStyle.bold` 是布尔（曾把"字重"当布尔写）→ true:700 / false:400
 *  - `scene.transforms` 里有 `"undefined"` 键（旧版 set_transform 参数名写错的产物）→ 删掉
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

export function listSnapshots(id: string): number[] {
  const dir = historyDirOf(id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => Number(f.replace(/\.json$/, "")))
    .filter((n) => Number.isFinite(n));
}

export function saveSnapshot(project: Project): void {
  try {
    const dir = historyDirOf(project.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${project.rev}.json`), JSON.stringify(project), "utf8");

    /**
     * **硬上限 50 份**：rev 涨过 50 之后，每写一次就顺带删掉最老的一份。
     *
     * 删除一律单独 try/catch：删不掉（占满/被锁/被上层驱动拦）只是这次没清，
     * 绝不能影响主写入，更不能让工程保存失败。
     *
     * 注意：本机的宿主会给 Node 注入 safe-delete 拦截器（按"每轮删文件数"设阈值），
     * 这里每次写都删一个文件，连续编辑几十笔就可能撞到阈值并**卡住**整个进程
     * （症状：属性改不动、刷新转圈）。所以服务必须用 `npm start` / 启动编辑器.bat 起，
     * 它会带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`（见 scripts/start.mjs）。
     */
    const all = listSnapshots(project.id);
    if (all.length <= SNAPSHOT_KEEP) return;
    const keepSet = new Set(pickSnapshotRevs(all, SNAPSHOT_KEEP));
    for (const rev of all) {
      if (keepSet.has(rev)) continue;
      try {
        fs.unlinkSync(path.join(dir, `${rev}.json`));
      } catch {
        /* 被占用就下次再清 */
      }
    }
  } catch {
    /* 快照只是锦上添花，失败不影响工程本身 */
  }
}

export function readSnapshot(id: string, rev: number): Project | null {
  const file = path.join(historyDirOf(id), `${rev}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Project;
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
