/**
 * 文档里的工具计数必须和真实工具表一致。
 *
 * 为什么要有这个测试：
 * 这类数字（「117 个工具」「其余 113 个按需」）散在 README 与两篇技能指南里，
 * 每加一个工具就要手工改 8 处，忘掉一处就是 agent 拿到错误预期。
 * 2026-11 就漂成了三个数：真实 117、README 113、指南 108——谁看谁的都不对。
 *
 * 所以这里把「数字」变成断言：加工具后跑一次 npm test，漏改哪里一目了然。
 * 注意：本测试只查**工具计数**这一类措辞；其他数字（技能篇数、场景类型数）不在这里管。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CORE_TOOL_NAMES, TOOLS } from "../server/mcp-tools";

const ROOT = path.resolve(import.meta.dirname, "..");
const total = TOOLS.length;
const core = CORE_TOOL_NAMES.size;
const onDemand = total - core;

let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  [ok] ${name}`);
  } catch (err) {
    failed++;
    console.log(`  [fail] ${name}\n        ${err instanceof Error ? err.message : String(err)}`);
  }
};

type Rule = { label: string; re: RegExp; file: string };

const FILES = ["README.md", "server/skills/manual.md", "server/skills/tools-quickref.md"];

/**
 * 「N 个工具」这句到底在说什么，得看前面的词：
 *   其余 N 个工具 …  → 按需个数
 *   常驻只有 N 个工具 → 常驻个数
 *   其他（117 个工具全表 / N 个工具） → 总数
 * 只认数字会误伤：「常驻只有 4 个工具」被当成总数去比 117，测试自己先报假警。
 */
const expectFor = (prefix: string): { expect: number; kind: string } => {
  if (/其余\s*$/.test(prefix)) return { expect: onDemand, kind: "按需" };
  if (/常驻(?:只有|的)?\s*$/.test(prefix)) return { expect: core, kind: "常驻" };
  return { expect: total, kind: "总数" };
};

const RULES: Rule[] = [];
for (const file of FILES) {
  RULES.push(
    { label: `${file}: 工具数措辞`, re: /(\d+)\s*个工具/g, file },
    { label: `${file}: 按需个数`, re: /(\d+)\s*个按需/g, file },
    { label: `${file}: 常驻+按需算式`, re: /(\d+)\s*个\s*=\s*4 常驻 \+ (\d+)\s*(?:个)?按需/g, file },
  );
}

console.log(`\n文档工具计数（真实：${total} = ${core} 常驻 + ${onDemand} 按需）\n`);

for (const rule of RULES) {
  const src = fs.readFileSync(path.join(ROOT, rule.file), "utf8");
  const hits = [...src.matchAll(rule.re)];
  if (!hits.length) continue; // 该文件没写这类措辞，就不管
  check(rule.label, () => {
    const bad: string[] = [];
    for (const h of hits) {
      const got = Number(h[1]);
      // 「N 个按需」与算式一律按按需数 / 总数比，不看前缀
      const isCountPhrase = rule.re.source.includes("个工具");
      const { expect, kind } = isCountPhrase
        ? expectFor(src.slice(Math.max(0, (h.index ?? 0) - 8), h.index ?? 0))
        : { expect: h[2] !== undefined ? total : onDemand, kind: h[2] !== undefined ? "总数" : "按需" };
      if (got !== expect) bad.push(`「${h[0].slice(0, 24)}」是${kind}数，应为 ${expect}`);
      if (h[2] !== undefined && Number(h[2]) !== onDemand) {
        bad.push(`「${h[0].slice(0, 24)}」的按需数应为 ${onDemand}`);
      }
    }
    assert.equal(
      bad.length,
      0,
      `与实际不符：${[...new Set(bad)].join("；")}（真实 ${total} = ${core} + ${onDemand}）`,
    );
  });
}

console.log(failed === 0 ? "\n文档计数一致\n" : `\n${failed} 处不一致\n`);
process.exit(failed === 0 ? 0 : 1);
