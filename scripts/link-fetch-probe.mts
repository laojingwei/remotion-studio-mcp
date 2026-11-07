/**
 * 手动探针：验证薄条目外链抓取链路（不进 test/core，依赖外网）。
 * 用法：npx tsx scripts/link-fetch-probe.mts [编号，默认 M11]
 */
import { readPrompt } from "../server/styleLibrary.service";
import { fetchLinkHints, extractHttpLinks } from "../server/style-link.service";

const id = process.argv[2] ?? "M11";
const p = readPrompt(id) ?? "";
console.log(`[${id}] 薄条目判定:`, p.includes("提示词原文要去"));
console.log(`[${id}] 提取链接:`, JSON.stringify(extractHttpLinks(p)));
console.log("开始抓取…");
const hints = await fetchLinkHints(p);
console.log("=== agent 会看到的抓取结果（前 1500 字）===");
console.log(hints.slice(0, 1500));
console.log("=== 总长:", hints.length, "字 ===");
