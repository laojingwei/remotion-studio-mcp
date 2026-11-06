/**
 * 发布包内容守卫：把「装完能不能用」变成一条可执行断言。
 *
 * ## 为什么需要它
 *
 * `package.json` 的 `files` 是发布包的唯一真源，而 `.gitignore` 里的东西
 * （`docs/` 整目录、`plugins/*`、生成物）不会自动进包。两边一叠加，最容易出现的
 * 事故就是「代码在、文档/示例不在」：发出去的包里 [`server/plugin/summary.ts`]
 * 还在对 agent 说"规则见 docs/PLUGIN-GUIDE.md"，用户打开却什么都没有。
 *
 * 2026-11-06 真发生过一次：`docs/PLUGIN-GUIDE.md` 和 8 个示例插件都没进包，
 * 而 publish.yml 只 `npm pack --dry-run | tail -12` 打印，不判死，流程照样绿。
 *
 * ## 判据
 *
 * 不用人眼比对，直接读 `npm pack --dry-run --json` 的真实清单（与 publish 同一份），
 * 断言两组规则：
 *   必须存在 —— 运行期入口、文档、示例、构建配置；
 *   必须不存在 —— 本机生成物（src/_plugins.generated.ts）、依赖、运行期数据、私货文档。
 *
 * `npm run check:package` 本地可跑；ci.yml 与 publish.yml 都会调它。
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 必须存在的单个文件（少一个就说明装完会用不了） */
const REQUIRED_FILES = [
  // 运行期入口
  "server/index.ts",
  "server/mcp-proxy.ts",
  "server/mcp-tools.ts",
  "server/plugin/gen-entry.ts",
  "web/index.html",
  "web/main.tsx",
  "src/index.ts",
  "shared/sceneMetas.ts",
  // 构建 / 启动配置
  "tsconfig.json",
  "vite.config.ts",
  "启动编辑器.bat",
  // 文档：代码里的报错与 list_plugins 都在指路它
  "docs/PLUGIN-GUIDE.md",
  "plugins/README.md",
  // 外部工具目录的说明：external-tools 技能要求"在 .other_modules/README.md 登记"，
  // 独立文件不进包时装完就是一句指向空目录的指令（663B，值得带）
  ".other_modules/README.md",
  // 包元信息
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
];

/**
 * 必须存在的目录（每项至少 1 个文件）。
 * 这些示例被 plugins/README.md 与本仓库文档/报错文案直接引用，缺了用户照着找就是空的。
 */
const REQUIRED_DIRS = [
  "plugins/_example-content",
  "plugins/_example-audit",
  "plugins/_example-brief",
  "plugins/_example-engineering",
  "plugins/_example-media",
  "plugins/_example-scene",
  "plugins/_example-text",
  "plugins/_example-tool",
  "plugins/_example-ui",
];

/** 必须不存在的路径（精确） */
const FORBIDDEN_EXACT = [
  // 本机生成物：import 的是 `../plugins/<某个人的插件>`，跟着包走会在别人机器上解析失败
  "src/_plugins.generated.ts",
];

/** 必须不存在的路径前缀 */
const FORBIDDEN_PREFIXES = [
  "node_modules/",
  "data/",
  "out/",
  "public/",
  ".workbuddy/",
  "memory/",
];

function fail(lines) {
  console.error("");
  for (const l of lines) console.error(l);
  console.error("");
  process.exit(1);
}

/*
 * 取 npm 的打包清单。
 *
 * **两种输出形状都要吃**：npm 10 及更早是数组 `[{…}]`，npm 12 起改成以包名为键的
 * 对象 `{"<包名>": {…}}`（npm/cli#9247 的 BREAKING CHANGE，没有回移到 v11）。
 * 而 publish.yml 发版前会 `npm install -g npm@latest`，所以 runner 上永远跑更新的那个：
 * 只认数组的写法会在这里直接抛 TypeError，崩溃点还是取值那一行——看起来像"守卫自己坏了"，
 * 把真正该报的问题盖掉（2026-11-07 发版就撞在这上面，npm 上 1.2.0 因此没发出去）。
 *
 * 再变形状时不要让它自己崩：拿不到合法的 entry 就带着「npm 版本 + 实际拿到了什么」退出。
 *
 * 复现/测试用：CHECK_PACKAGE_RAW_JSON=<文件> 可直接从文件读原始输出，绕过执行 npm。
 *   CHECK_PACKAGE_RAW_JSON=/tmp/pack-npm12.json node scripts/check-package.mjs
 */
let raw;
try {
  raw = process.env.CHECK_PACKAGE_RAW_JSON
    ? fs.readFileSync(process.env.CHECK_PACKAGE_RAW_JSON, "utf8")
    : execSync("npm pack --dry-run --json", {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
} catch (err) {
  fail([
    "✗ 读不到 npm 打包清单（npm pack --dry-run --json 失败）",
    `  ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
  ]);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  fail([
    "✗ npm 的清单不是合法 JSON（可能有 banner / 警告混进了 stdout）",
    `  npm: ${process.env.npm_config_user_agent ?? "未知"}`,
    `  ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    `  输出头部：${String(raw).slice(0, 200).replace(/\n/g, "⏎")}`,
  ]);
}

const entries = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
const report = entries.find((e) => e && Array.isArray(e.files));
if (!report) {
  fail([
    "✗ 读不懂 npm 的打包清单（形状不在预期内）",
    `  npm: ${process.env.npm_config_user_agent ?? "未知"}`,
    `  顶层类型：${Array.isArray(parsed) ? "数组" : parsed === null ? "null" : typeof parsed}`,
    `  实际内容：${JSON.stringify(parsed).slice(0, 300)}`,
    "  已知形状：npm ≤11 是数组 [{files}]，npm ≥12 是对象 {\"<包名>\": {files}}；再变就更新这段解析",
  ]);
}

const files = (report.files ?? []).map((f) => String(f.path).split("\\").join("/"));
if (!files.length) fail(["✗ 打包清单是空的——检查 package.json 的 files 字段"]);

const problems = [];

// ① 必需文件
for (const f of REQUIRED_FILES) {
  if (!files.includes(f)) problems.push(`  缺文件：${f}`);
}

// ② 必需目录（至少 1 个文件）
for (const d of REQUIRED_DIRS) {
  if (!files.some((f) => f.startsWith(`${d}/`))) problems.push(`  缺目录（或目录为空）：${d}/`);
}

// ③ 禁止路径
for (const f of FORBIDDEN_EXACT) {
  if (files.includes(f)) problems.push(`  不该入包：${f}（本机生成物，会指向别人的插件目录）`);
}

// ④ 禁止前缀
for (const f of files) {
  for (const p of FORBIDDEN_PREFIXES) {
    if (f.startsWith(p)) problems.push(`  不该入包：${f}（${p}* 属于依赖/运行期数据/本机内务）`);
  }
}

// ⑤ 依赖目录：任何层级的 node_modules 都不该进包（files 里整目录放行时最容易漏）
const nm = files.filter((f) => f.includes("node_modules/"));
if (nm.length) {
  problems.push(`  不该入包：${nm.length} 个 node_modules 文件（例：${nm[0]}）`);
}

// ⑥ docs/ 只允许 PLUGIN-GUIDE.md：其余是本机工作笔记（复盘/计划），入库会变过期文档
const extraDocs = files.filter((f) => f.startsWith("docs/") && f !== "docs/PLUGIN-GUIDE.md");
if (extraDocs.length) {
  problems.push(`  不该入包：docs/ 下只该有 PLUGIN-GUIDE.md，多出 ${extraDocs.length} 个（例：${extraDocs[0]}）`);
}

// ⑦ .other_modules/ 只允许 README.md 与 .gitkeep：其余是第三方开源项目（anatomy 等），
// 按其自身设计"按需下载"，27MB 的副本进包会冻结版本、还得补第三方许可声明。
const OTHER_MODULES_ALLOWED = new Set([".other_modules/README.md", ".other_modules/.gitkeep"]);
const otherMods = files.filter((f) => f.startsWith(".other_modules/") && !OTHER_MODULES_ALLOWED.has(f));
if (otherMods.length) {
  problems.push(
    `  不该入包：.other_modules/ 下只该有 README.md 与 .gitkeep，多出 ${otherMods.length} 个（例：${otherMods[0]}）` +
      `——第三方工具按需下载，见 .other_modules/README.md`,
  );
}

if (problems.length) {
  fail([
    `✗ 发布包内容不合格（共 ${problems.length} 处）：`,
    ...problems,
    "",
    "  files 白名单在 package.json；规则与理由见 scripts/check-package.mjs 顶部注释。",
  ]);
}

const mb = ((report.size ?? 0) / 1024 / 1024).toFixed(2);
console.log(`✓ 发布包内容合格：${files.length} 个文件 / ${mb}MB`);
console.log(`  必需项 ${REQUIRED_FILES.length} 个文件 + ${REQUIRED_DIRS.length} 个示例目录齐全`);
console.log("  本机生成物、依赖、运行期数据均未混入");
