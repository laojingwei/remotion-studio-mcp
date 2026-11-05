/**
 * 生成 `src/_plugins.generated.ts`（薄壳，逻辑在 server/plugin/gen-entry.ts）。
 *
 *   tsx scripts/gen-plugin-entry.mts          生成
 *   tsx scripts/gen-plugin-entry.mts --check  只检查是否最新（CI 用）
 *
 * 正常流程里不用手动跑：服务端在重新打包前会自动生成。
 * 这个脚本存在的意义是 **CI 能抓漂移** —— 生成文件过期时，现象是
 * "装了插件但选择器里没有"，运行时极难定位。
 */
import { generatePluginEntry } from "../server/plugin/gen-entry";

const checkOnly = process.argv.includes("--check");
const res = generatePluginEntry({ check: checkOnly });

if (checkOnly) {
  if (res.changed) {
    console.error(`[gen-plugin-entry] ${res.outFile} 与插件目录不一致，重跑一次不带 --check 的命令`);
    process.exit(1);
  }
  console.log(`[gen-plugin-entry] 已是最新（${res.count} 个插件场景）`);
  process.exit(0);
}

console.log(
  `[gen-plugin-entry] ${res.changed ? "已更新" : "无变化"}：${res.count} 个插件场景` +
    (res.issues.length ? `，${res.issues.length} 条提示` : ""),
);
for (const i of res.issues) console.log(`  ⚠ ${i}`);
