import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * bundle 产物目录的管理。
 *
 * 为什么要单独一个文件：这里只有路径计算和目录清单这类纯逻辑，
 * 测试可以直接跑；而 render.service.ts 一 import 就拖上 @remotion/renderer，
 * 单测会变慢还可能拉起浏览器。
 *
 * 背景：以前 `bundle()` 不传 outDir，产物落在 os.tmpdir() 的随机目录里，
 * 每次「源码变更 → 重新打包」都会**新增**一份（bundle 会把 public/ 整个拷进去，
 * 一份约 100MB），没有任何东西清理它。实测这台机器攒了 104 份、9.7GB。
 * 现在固定打到项目内的 .remotion-bundle，旧的 Temp 目录在服务启动时清掉。
 */

/** 项目内的固定 bundle 输出目录名（相对项目根，.gitignore 里有对应条目） */
export const BUNDLE_OUT_DIR_NAME = ".remotion-bundle";

export const bundleOutDir = (projectRoot: string) => path.join(projectRoot, BUNDLE_OUT_DIR_NAME);

/**
 * Remotion 旧版临时 bundle 的目录名前缀。
 *
 * 只匹配这个前缀：tmpdir 里还有别的东西（系统临时文件、其它工具的缓存），
 * 一概不碰。这个前缀是 Remotion bundler 写死的，改名即失效——所以每次
 * 升级依赖后值得肉眼确认一遍这个常量还对不对。
 */
export const LEGACY_BUNDLE_PREFIX = "remotion-webpack-bundle-";

export type LegacyBundle = { dir: string; ageMs: number };

/**
 * 列出 Temp 里的旧 bundle 目录。
 *
 * 三重保险，确保它只能删到「我们自己产生的缓存」：
 *  1. 只在 os.tmpdir() 的**第一层**找（不递归）；
 *  2. 目录名必须以 LEGACY_BUNDLE_PREFIX 开头；
 *  3. 更新时间必须早于 minAgeMs（默认 30 分钟）——
 *     目录刚创建可能是另一个正在跑的实例正在用它，动了会让别人的渲染当场 404。
 */
export function listLegacyBundles(
  tmpDir: string = os.tmpdir(),
  now = Date.now(),
  minAgeMs = 30 * 60 * 1000,
): LegacyBundle[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: LegacyBundle[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(LEGACY_BUNDLE_PREFIX)) continue;
    const dir = path.join(tmpDir, e.name);
    try {
      const ageMs = now - fs.statSync(dir).mtimeMs;
      if (ageMs < minAgeMs) continue;
      out.push({ dir, ageMs });
    } catch {
      /* 刚被删，忽略 */
    }
  }
  return out;
}

export type CleanupResult = { removed: number; kept: number; freedDirs: string[] };

/**
 * 清掉 Temp 里遗留的旧 bundle 目录。
 *
 * 幂等：没有旧目录就是 no-op。删除失败（比如某份正被某个僵尸进程占着）
 * 不抛错、只计数跳过——清理是锦上添花，不该让服务起不来。
 */
export function cleanupLegacyBundles(
  tmpDir: string = os.tmpdir(),
  log: (msg: string) => void = () => {},
): CleanupResult {
  const old = listLegacyBundles(tmpDir);
  const result: CleanupResult = { removed: 0, kept: 0, freedDirs: [] };
  for (const { dir } of old) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      result.removed++;
      result.freedDirs.push(dir);
    } catch {
      result.kept++;
    }
  }
  if (result.removed > 0) {
    log(`清理了 Temp 里 ${result.removed} 个遗留的旧版打包目录（${LEGACY_BUNDLE_PREFIX}*）`);
  }
  if (result.kept > 0) {
    log(`${result.kept} 个旧目录删不掉（可能被占用），下次启动再试`);
  }
  return result;
}
