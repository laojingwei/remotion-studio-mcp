/**
 * 测试前置：确保运行期目录存在。
 *
 * 为什么需要：`data/`、`out/`、`public/` 都被 .gitignore 忽略（它们是运行期产物，
 * 不该入库）。本机开发时这些目录早就在了，所以一直没暴露——但 **CI 是全新 clone**，
 * 里面一个都没有。test-loudness / test-beats 会往 `public/assets` 写临时 wav，
 * 目录不存在就直接 ENOENT，整个测试链在第三个脚本就断了。
 *
 * 只建目录，不删不改任何东西；已存在时是 no-op（包括 data 是指向别处的链接时）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs = [
  path.join(ROOT, "data"),
  path.join(ROOT, "data", "projects"),
  path.join(ROOT, "out"),
  path.join(ROOT, "public"),
  path.join(ROOT, "public", "assets"),
];

for (const dir of dirs) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(`[ensure-dirs] 建不出 ${dir}：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

console.log(`[ensure-dirs] 运行期目录就绪（${dirs.length} 个）`);
