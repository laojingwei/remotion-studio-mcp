/**
 * 版本一致性检查：package.json 是唯一来源。
 *
 * 起因：同一个版本号曾经散在四个地方且各不相同
 *   package.json 1.0.8 / mcp-tools.ts 1.1.0 / index.ts 0.44.0 / README 1.1.0
 * 发版 workflow 只比对 tag 与 package.json，另外三处漂移永远查不出来。
 *
 * 用法：
 *   node scripts/check-version.mjs          # 本地/CI 检查
 *   （CI 里若是 tag 触发，会自动与 GITHUB_REF_NAME 比对）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;
const errors = [];
const notes = [];

if (!/^\d+\.\d+\.\d+/.test(version ?? "")) {
  errors.push(`package.json 的 version 不像版本号：${version}`);
}

/* 1) 代码里不允许再出现写死的版本（McpServer / initialize 回执必须读 VERSION） */
const scanDirs = ["server", "shared", "src", "web"];
const offenders = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(p);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    const text = fs.readFileSync(p, "utf8");
    // version: "1.2.3"（serverInfo / McpServer 选项）；注释里的不算。
    //
    // 必须**行首锚定**：不锚定会把三元兜底值误判成写死版本，例如
    //   version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    // 里的 `pkg.version : "0.0.0"` 会被 `version\s*:` 命中（2026-11-06 实际误报过，
    // 而这行恰好出现在发布闸门里，会把发版直接卡死）。
    // `0.0.0` 是"不知道版本"的占位值，不是包版本，也一并放过。
    for (const line of text.split("\n")) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      const m = /^\s*version\s*:\s*["'](\d+\.\d+\.\d+)["']/.exec(line);
      if (m && m[1] !== "0.0.0") offenders.push(`${path.relative(ROOT, p)} → ${m[0].trim()}`);
    }
  }
};
for (const d of scanDirs) {
  const abs = path.join(ROOT, d);
  if (fs.existsSync(abs)) walk(abs);
}
if (offenders.length) {
  errors.push(`以下位置写死了版本号，应改为 import { VERSION } from "./version"：\n  - ${offenders.join("\n  - ")}`);
}

/* 2) README 里的版本行必须跟上（不要求格式统一，只要求出现同一个号） */
const readmePath = path.join(ROOT, "README.md");
if (fs.existsSync(readmePath)) {
  const readme = fs.readFileSync(readmePath, "utf8");
  const m = /版本\**\s*([0-9]+\.[0-9]+\.[0-9]+)/.exec(readme);
  if (m && m[1] !== version) {
    errors.push(`README 写的是 ${m[1]}，package.json 是 ${version}（发版时一起改）`);
  } else if (m) {
    notes.push(`README 版本一致：${m[1]}`);
  }
}

/* 2.5) package-lock.json 的根版本也必须跟上。
 *
 * 这一条是补漏：lock 不需要手改（`npm version x.y.z --no-git-tag-version` 会同步），
 * 但真改版本号时如果只动了 package.json，lock 会静静停在几个版本之前
 * （曾经 1.1.3 的仓库里躺着 1.0.8，一路没人发现）。lock 不进发布包，
 * 所以不影响用户，但它进 git，看的人会以为版本对不上是漏提交。
 */
const lockPath = path.join(ROOT, "package-lock.json");
if (fs.existsSync(lockPath)) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const lockVer = lock?.version ?? lock?.packages?.[""]?.version;
    if (lockVer && lockVer !== version) {
      errors.push(
        `package-lock.json 的版本是 ${lockVer}，package.json 是 ${version}` +
          `（跑一次 npm version ${version} --allow-same-version --no-git-tag-version 即可同步）`,
      );
    } else {
      notes.push(`package-lock 版本一致：${lockVer}`);
    }
  } catch (e) {
    errors.push(`package-lock.json 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/* 4) CHANGELOG 顶部必须有当前版本的一节。
 *
 * 版本号一致只能说明"改对了数字"，说明不了"这一版做了什么" ——
 * 升级的人真正需要的是变更内容，所以把它也纳入闸口：忘写就发不出去。 */
const changelogPath = path.join(ROOT, "CHANGELOG.md");
if (!fs.existsSync(changelogPath)) {
  errors.push("缺少 CHANGELOG.md（发版必须写清这一版改了什么）");
} else {
  const md = fs.readFileSync(changelogPath, "utf8");
  const headings = [...md.matchAll(/^##\s+\[?([0-9]+\.[0-9]+\.[0-9]+)\]?/gm)].map((m) => m[1]);
  if (!headings.includes(version)) {
    errors.push(`CHANGELOG.md 里没有 ${version} 这一节（发版时在顶部加：新增 / 变更 / 修复）`);
  } else if (headings[0] !== version) {
    notes.push(`⚠ CHANGELOG.md 最新一节是 ${headings[0]}，${version} 不在最前（可能忘了置顶）`);
  } else {
    notes.push(`CHANGELOG.md 有 ${version} 一节`);
  }
}

/* 3) tag 触发时，tag 必须等于 package.json */
const refType = process.env.GITHUB_REF_TYPE;
const refName = process.env.GITHUB_REF_NAME;
if (refType === "tag" && refName) {
  const tag = refName.replace(/^v/, "");
  if (tag !== version) errors.push(`tag ${refName} 与 package.json 版本 ${version} 不一致`);
  else notes.push(`tag 与 package.json 一致：${tag}`);
}

if (errors.length) {
  console.error("✗ 版本一致性检查未通过：");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`✓ 版本一致：${version}`);
for (const n of notes) console.log(`  ${n}`);
