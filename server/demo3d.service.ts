import fs from "node:fs";
import path from "node:path";
import { ROOT as PROJECT_ROOT } from "./root";
import { DATA_DIR, PUBLIC_DIR, writeProject } from "./store";
import type { Project } from "../shared/schema";

/**
 * 3D 示例工程（demo3d）。
 *
 * 和 demo 的区别：3D 场景离不开贴图，光写一份 project.json 是黑球。所以这里把
 * 「工程 + 素材」当成一套种子放在 scripts/seeds/demo3d/：安装时一起铺到
 * data/projects/demo3d 和 public/assets/projects/demo3d。
 *
 * 为什么不把贴图塞进 project.json 的 base64：十张图 ~2.3MB，base64 后膨胀 1/3，
 * 每次读工程都要解析这个字符串，编辑器打开会明显变卡。
 */
export const DEMO3D_ID = "demo3d";

const SEED_DIR = path.join(PROJECT_ROOT, "scripts", "seeds", "demo3d");
const SEED_PROJECT = path.join(SEED_DIR, "project.json");
const SEED_ASSETS = path.join(SEED_DIR, "assets");
const TARGET_ASSETS = path.join(PUBLIC_DIR, "assets", "projects", DEMO3D_ID);

export const isDemo3D = (id: string): boolean => id === DEMO3D_ID;

export function hasDemo3D(): boolean {
  return fs.existsSync(path.join(DATA_DIR, DEMO3D_ID, "project.json"));
}

/** 种子是否随包一起装上了（开发目录里一定有；用户只装了产物时可能没有） */
export function hasDemo3DSeed(): boolean {
  return fs.existsSync(SEED_PROJECT) && fs.existsSync(SEED_ASSETS);
}

function copyAssets(): number {
  fs.mkdirSync(TARGET_ASSETS, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(SEED_ASSETS)) {
    const src = path.join(SEED_ASSETS, name);
    if (!fs.statSync(src).isFile()) continue;
    fs.copyFileSync(src, path.join(TARGET_ASSETS, name));
    n += 1;
  }
  return n;
}

export function readDemo3DSeed(): Project {
  return JSON.parse(fs.readFileSync(SEED_PROJECT, "utf8")) as Project;
}

/** 把示例工程铺到磁盘（覆盖已有内容），返回装好的工程 */
export function installDemo3D(): Project {
  const project = readDemo3DSeed();
  const assets = copyAssets();
  writeProject(project);
  console.log(`[demo3d] 已安装示例工程（${assets} 个素材）`);
  return project;
}

/**
 * 启动时确保示例存在。
 *
 * 只补缺的那一半：工程在、素材没了就只拷素材；素材在、工程没了就只写工程。
 * 不能用 installDemo3D 无脑覆盖——用户改过的示例会被每次启动抹掉，
 * 要恢复原始内容必须走「重置」。
 */
export function ensureDemo3D(): void {
  if (!hasDemo3DSeed()) return;
  try {
    if (!fs.existsSync(TARGET_ASSETS)) copyAssets();
    if (!hasDemo3D()) {
      writeProject(readDemo3DSeed());
      console.log("[demo3d] 已安装示例工程");
    }
  } catch (err) {
    console.error("[demo3d] 安装示例工程失败（不影响其他工程）：", err);
  }
}
