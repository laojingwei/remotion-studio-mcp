/**
 * 编辑器端到端回归（真浏览器 + 真服务 + 临时数据目录）。
 *
 *   npm run build && npm run test:e2e
 *
 * 为什么需要它：仓库里原有的 4 个 `test-*-pw.mjs` 是**探针**——截图、打日志、
 * 断言数为 0，而且要手工先起两个服务。编辑器的任何改动（面板、时间轴、3D 视口）
 * 都没有回归网，改坏了只能靠人眼。
 *
 * 这里只压 5 条最容易断的路径，刻意保持"少而稳"：
 *   1. 页面能加载，且没有 console error / pageerror（这条能抓到大部分白屏）
 *   2. 预览区真的渲染出了画布（不是空壳）
 *   3. 顶栏改工程名 → 真的走 ops 落库（rev 增加、内容一致）
 *   4. 点时间轴上的场次 → 右侧属性面板出现（选中链路）
 *   5. 刷新后仍是新名字（写盘 + 读回 + 首屏加载都对）
 *
 * 数据隔离：用 STUDIO_DATA_ROOT 指到临时目录，测试里建的删的一切都在临时目录，
 * 不会碰用户真实的 data/（工程列表、"最近打开"指针、ui 偏好都不受影响）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.E2E_PORT ?? 4500 + Math.floor(Math.random() * 300));
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "studio-e2e-"));
const SHOT_DIR = path.join(ROOT, "out", "e2e");

const failures = [];
const passed = [];
const check = (name, ok, detail = "") => {
  if (ok) {
    passed.push(name);
    console.log(`  [ok] ${name}`);
  } else {
    failures.push(`${name}${detail ? `：${detail}` : ""}`);
    console.error(`  [fail] ${name}${detail ? `：${detail}` : ""}`);
  }
};

const dist = path.join(ROOT, "dist", "web", "index.html");
if (!fs.existsSync(dist)) {
  console.error("✗ 没有构建产物 dist/web/index.html —— 先跑 npm run build");
  process.exit(1);
}

const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
if (!fs.existsSync(tsxCli)) {
  console.error(`✗ 找不到 tsx（${tsxCli}）—— 先 npm install`);
  process.exit(1);
}

const server = spawn(process.execPath, [tsxCli, path.join(ROOT, "server", "index.ts")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    STUDIO_DATA_ROOT: DATA_ROOT,
    STUDIO_LOG_DIR: path.join(DATA_ROOT, "logs"),
    // 删除类操作在宿主 safe-delete 拦截器下可能卡住整个进程（见 store.ts 注释）
    CODEBUDDY_SAFE_DELETE_ENABLED: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d.toString()));
server.stderr.on("data", (d) => (serverLog += d.toString()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error(`服务 40 秒内没起来：\n${serverLog.slice(-2000)}`);
}

const api = async (p, init) => {
  const res = await fetch(`${BASE}${p}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};

function stopServer() {
  if (!server.killed) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        server.kill("SIGTERM");
      }
    } catch {
      /* 已经退了 */
    }
  }
}

let browser;
try {
  console.log(`\n[e2e] 启动服务 :${PORT}（数据目录 ${DATA_ROOT}）`);
  const health = await waitHealth();
  check("服务就绪且版本号可读", Boolean(health.version), JSON.stringify(health).slice(0, 120));

  // 临时数据目录里由 ensureSeed 建出示例工程；取它的名字与场景数作为断言基准
  const { projects } = await api("/api/projects");
  // 临时目录里会有两个种子：demo（ensureSeed）+ demo3d（ensureDemo3D）
  const proj = projects.find((p) => p.id === "demo") ?? projects[0];
  check("临时数据目录里建出了种子工程", Boolean(proj) && projects.length <= 2, `实际 ${projects.length} 个`);
  const original = proj?.name ?? "";

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  try {
    browser = await chromium.launch({ headless: true, channel: "msedge" });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`CONSOLE ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => errors.push(`PAGEERROR ${String(e).slice(0, 300)}`));

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".project-name", { timeout: 30000 });

  /* 1. 首屏加载：工程名渲染出来、没有脚本错误 */
  const nameValue = await page.inputValue(".project-name");
  check("首屏渲染出工程名", nameValue === original, `页面 ${nameValue} / 服务端 ${original}`);

  /* 2. 预览区真的画了东西（空壳页面也能通过上面的断言） */
  const shell = await page.locator(".canvas-shell").first();
  await shell.waitFor({ timeout: 20000 });
  const box = await shell.boundingBox();
  check("预览画布有实际尺寸", Boolean(box && box.width > 200 && box.height > 100), JSON.stringify(box));

  /* 3. UI 改工程名 → ops 落库（rev 必须增加） */
  const newName = `E2E-${Date.now().toString(36)}`;
  const before = await api(`/api/projects/${proj.id}`);
  await page.fill(".project-name", newName);
  await page.waitForTimeout(800);
  const after = await api(`/api/projects/${proj.id}`);
  check("改工程名写回服务端", after.project.name === newName, `服务端 ${after.project.name}`);
  check("rev 递增", after.project.rev > before.project.rev, `${before.project.rev} → ${after.project.rev}`);

  /* 4. 点时间轴上的场次 → 右侧属性面板出现 */
  const block = page.locator(".tl-block").first();
  const hasBlock = (await block.count()) > 0;
  check("时间轴渲染出场景块", hasBlock);
  if (hasBlock) {
    await block.click({ force: true });
    await page.waitForTimeout(400);
    const panel = await page.locator(".panel.right").count();
    check("选中场景后右侧属性面板出现", panel > 0, `panel 数量 ${panel}`);
  }

  /* 5. 刷新后仍读到新名字（写盘 + 读回 + 首屏一致） */
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".project-name", { timeout: 20000 });
  const reloaded = await page.inputValue(".project-name");
  check("刷新后工程名持久化", reloaded === newName, `刷新后 ${reloaded}`);

  check("全程没有前端报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  if (failures.length) {
    await page.screenshot({ path: path.join(SHOT_DIR, "failure.png"), fullPage: true }).catch(() => {});
    console.error(`\n  失败截图：out/e2e/failure.png`);
  }
} catch (err) {
  failures.push(`执行中断：${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  await browser?.close().catch(() => {});
  stopServer();
  try {
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
}

console.log("");
if (failures.length) {
  console.error(`\x1b[31m${failures.length} 项失败\x1b[0m（通过 ${passed.length} 项）`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\x1b[32m编辑器 E2E 全部通过\x1b[0m（${passed.length} 项）`);
