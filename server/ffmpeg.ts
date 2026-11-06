import fs from "node:fs";
import path from "node:path";
import { ROOT as PROJECT_ROOT } from "./root";

/**
 * ffmpeg 可执行文件在哪。
 *
 * 为什么单独一个模块：TTS 的响度归一要用它，插件文件处理链也要把它交给插件。
 * 放在 `media.service.ts` 会违背那边的设计承诺（"纯 Node，不 spawn 外部进程"），
 * 放在 `tts.service.ts` 则让插件子系统反向依赖 TTS —— 两边都不合适。
 *
 * 查找顺序：`FFMPEG_PATH` 环境变量 > Remotion 自带那份 > PATH。
 * Remotion 装了 `@remotion/compositor-*` 就一定带 ffmpeg，所以绝大多数用户的机器上
 * **一定有**，这也是敢把 `ctx.ffmpeg` 交给插件的前提。
 */
export function ffmpegPath(): string | null {
  const env = (process.env.FFMPEG_PATH ?? "").trim();
  if (env && fs.existsSync(env)) return env;

  if (process.platform === "win32") {
    const bundled = path.join(PROJECT_ROOT, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffmpeg.exe");
    if (fs.existsSync(bundled)) return bundled;
  }
  // Linux/macOS 的 Remotion 包名不同，挨个试（装在哪个平台就只有一个存在）
  for (const pkg of ["compositor-linux-x64-gnu", "compositor-darwin-x64", "compositor-darwin-arm64"]) {
    const p = path.join(PROJECT_ROOT, "node_modules", "@remotion", pkg, "ffmpeg");
    if (fs.existsSync(p)) return p;
  }
  return null;
}
