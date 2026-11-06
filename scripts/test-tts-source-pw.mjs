/**
 * 语音「来源」选择 + 预检分流的 e2e。
 *
 *   npm run build && node scripts/test-tts-source-pw.mjs
 *
 * 验的是这次修的两个缺口：
 * 1. 服务端 /api/tts/check 对插件 provider 不再做本机地址探测（以前固定 HEAD 内置
 *    endpoint，插件明明可用却报「连不上」，人跑去查本机端口）
 * 2. 编辑器语音 → 配置页有「语音来源」下拉：默认内置、能显示"已不可用"的残留选择
 *    （插件停用/卸载后 provider 还指着它）、内置字段区随之灰化
 *
 * 探针环境本地 TTS 服务必然没起：/api/tts/speakers、/api/tts/check 的 400 是预期噪音，
 * console 断言里过滤掉了。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PROBE_PORT ?? 4950);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ttssrc-"));
const SHOT = path.join(ROOT, "out", "probe-tts-source");
fs.mkdirSync(SHOT, { recursive: true });

const api = async (p, init) => {
  const r = await fetch(BASE + p, init);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const server = spawn(process.execPath, [tsxCli, path.join(ROOT, "server", "index.ts")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), STUDIO_DATA_ROOT: DATA_ROOT, STUDIO_LOG_DIR: path.join(DATA_ROOT, "logs"), CODEBUDDY_SAFE_DELETE_ENABLED: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {
    /* 起来之前 */
  }
  await sleep(500);
}

let pass = 0;
let fail = 0;
const ok = (n, c, d = "") => {
  if (c) {
    pass++;
    console.log("  ✓", n);
  } else {
    fail++;
    console.log("  ✗", n, d);
  }
};

/* ── 服务端：预检分流 ── */
{
  const r1 = await post("/api/tts/check", {});
  ok("内置 provider：走地址探测（reach 失败=本地没起服务，stage 应为 reach）", r1.body.stage === "reach", JSON.stringify(r1.body).slice(0, 200));

  await post("/api/tts/config", { provider: "fake-tts" });
  const r2 = await post("/api/tts/check", {});
  ok("插件 provider（假 id）：不再探地址，stage=provider", r2.body.stage === "provider" && r2.body.ok === true, JSON.stringify(r2.body).slice(0, 220));

  const r3 = await post("/api/tts/check", { deep: true });
  ok("插件 provider deep：报「没有这个语音 provider」而不是连不上", r3.body.stage === "synth" && /没有这个语音 provider/.test(r3.body.error ?? ""), JSON.stringify(r3.body).slice(0, 220));

  await post("/api/tts/config", { provider: "openai" });
  const r4 = await post("/api/tts/config", {});
  ok("切回内置：provider=openai", r4.body.config?.provider === "openai", JSON.stringify(r4.body.config?.provider));
}

/* ── 编辑器：来源下拉 ── */
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() !== "error") return;
  // 探针环境本地 TTS 服务必然没起：/api/tts/speakers、/api/tts/check 的 400 是预期噪音
  const url = m.location()?.url ?? "";
  if (url.includes("/api/tts/")) return;
  errors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  // 顶栏「⋯」菜单 → 语音
  await page.locator(".topbar-more > button").first().click();
  await page.locator('[role="menuitem"]', { hasText: "语音" }).click();
  await page.waitForSelector(".tts-dialog", { timeout: 15000 });
  await page.locator(".tts-tab", { hasText: "配置" }).click();
  await page.waitForSelector(".tts-builtin", { timeout: 10000 });

  const src = page.locator(".render-section", { hasText: "语音来源" }).first().locator("select");
  ok("配置页有「语音来源」下拉", (await src.count()) === 1);
  ok("默认选中内置", (await src.inputValue()) === "openai");
  const note = await page.locator(".tts-source-note").count();
  ok("内置来源下没有灰色提示条", note === 0, String(note));
  ok("内置字段区没有灰化", !(await page.locator(".tts-builtin").getAttribute("class")).includes("is-idle"));
  await page.screenshot({ path: path.join(SHOT, "1-builtin.png") });

  // 服务端已把 provider 切回 openai；现在切到一个"不可用"的 id，验 UI 防御
  await post("/api/tts/config", { provider: "ghost-tts" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".topbar-more > button").first().click();
  await page.locator('[role="menuitem"]', { hasText: "语音" }).click();
  await page.locator(".tts-tab", { hasText: "配置" }).click();
  await page.waitForSelector(".tts-builtin", { timeout: 10000 });
  const v2 = await page.locator(".render-section", { hasText: "语音来源" }).first().locator("select").inputValue();
  ok("provider 指向已不可用的插件时，select 仍显示它（不装作切回内置）", v2 === "ghost-tts", v2);
  const ghostOpt = await page.locator("option", { hasText: "已不可用" }).count();
  ok("并显式标出「已不可用」", ghostOpt === 1, String(ghostOpt));
  ok("内置字段区灰化（is-idle）", (await page.locator(".tts-builtin").getAttribute("class")).includes("is-idle"));
  await page.screenshot({ path: path.join(SHOT, "2-ghost.png") });

  ok("没有 console error", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (err) {
  fail++;
  console.log("  ✗ 异常：", String(err).slice(0, 400));
  await page.screenshot({ path: path.join(SHOT, "fail.png") }).catch(() => {});
} finally {
  console.log(`\n通过 ${pass} / 失败 ${fail}　截图：${SHOT}`);
  if (fail) console.log(log.slice(-1200));
  await browser.close();
  server.kill();
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
