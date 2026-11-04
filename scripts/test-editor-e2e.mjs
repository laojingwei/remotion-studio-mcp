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

  /* 4b. 顶栏「产物」按钮：点开要出浮框（有产物列产物，没产物给空态，不能白屏） */
  const outputsBtn = page.locator(".outputs-toggle");
  check("顶栏有产物按钮", (await outputsBtn.count()) === 1);
  if (await outputsBtn.count()) {
    await outputsBtn.click();
    await page.waitForTimeout(700);
    const pop = await page.locator(".out-pop").count();
    const rows = await page.locator(".out-row").count();
    const empty = await page.locator(".out-empty").count();
    check("产物浮框能打开且有内容", pop === 1 && (rows > 0 || empty > 0), `浮框 ${pop} / 条目 ${rows} / 空态 ${empty}`);
    // 点一条产物 → 预览区要出现对应元素（图/视频/音频/文本之一）
    if (rows > 0) {
      await page.locator(".out-row").first().click();
      await page.waitForTimeout(900);
      const prev = await page.locator(".out-preview").count();
      const media = await page
        .locator(".out-preview img, .out-preview video, .out-preview audio, .out-preview-text")
        .count();
      check("点开产物能预览", prev === 1 && media > 0, `预览区 ${prev} / 媒体 ${media}`);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check("Esc 关闭产物浮框", (await page.locator(".out-pop").count()) === 0);

    /*
     * 再点一次「产物」按钮也要能关上。这里有个真坑：外点关闭监听的是 document
     * 的 mousedown，按钮自己的 onClick 是 click——mousedown 先关、click 再翻回来，
     * 用户看到的就是"点按钮关不掉"。修复是让弹层把触发器排除在"外面"之外。
     */
    await outputsBtn.click();
    await page.waitForTimeout(500);
    check("产物浮框又打开了", (await page.locator(".out-pop").count()) === 1);
    await outputsBtn.click();
    await page.waitForTimeout(400);
    check("再点「产物」按钮能关上", (await page.locator(".out-pop").count()) === 0);
  }

  /* 4c. 时间码批注：写完要落盘，并且能出现在列表里（agent 靠这份数据改片） */
  const annoBtn = page.locator(".anno-fab");
  check("画面有「批注」按钮", (await annoBtn.count()) === 1);
  if (await annoBtn.count()) {
    await annoBtn.click();
    await page.waitForTimeout(400);
    const text = "E2E：这一帧转场太硬";
    await page.locator(".anno-input").fill(text);
    await page.locator(".anno-save").click();
    await page.waitForTimeout(800);
    const items = await page.locator(".anno-item").count();
    const { annotations } = await api(`/api/projects/${proj.id}/annotations`);
    check(
      "批注落盘且出现在列表里",
      items >= 1 && annotations.some((a) => a.text === text && a.resolved === false),
      `列表 ${items} 条 / 接口 ${annotations.length} 条`,
    );
    // 接口里的幕内帧必须是个有效值（存成 NaN 的话 agent 定位会全错）
    const saved = annotations.find((a) => a.text === text);
    check(
      "批注带幕内帧",
      Boolean(saved) && Number.isInteger(saved.frameInScene) && saved.frameInScene >= 0 && Boolean(saved.sceneId),
      saved ? `scene=${saved.sceneId} frame=${saved.frameInScene}` : "没存上",
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check("Esc 关闭批注浮框", (await page.locator(".anno-pop").count()) === 0);
  }

  /* 4d. 运行日志抽屉：「⋯」→ 运行日志（agent 干了什么，用户自己也看得到） */
  await page.locator(".topbar-more > button").click();
  await page.waitForTimeout(250);
  const logItem = page.locator(".topbar-more-menu .menu-item").filter({ hasText: "运行日志" });
  check("「⋯」菜单里有运行日志", (await logItem.count()) === 1);
  if (await logItem.count()) {
    await logItem.click();
    await page.waitForTimeout(700);
    const drawer = await page.locator(".log-drawer").count();
    const rows = await page.locator(".log-row").count();
    const empty = await page.locator(".log-empty").count();
    check("运行日志抽屉能打开", drawer === 1 && (rows > 0 || empty > 0), `抽屉 ${drawer} / 行 ${rows}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    check("Esc 关闭运行日志", (await page.locator(".log-drawer").count()) === 0);
  }

  /*
   * 4e. 归档：只从列表收起来，一个文件都不删。
   * 用户最容易被"工程怎么不见了"吓到，所以这条要压两件事：
   *  · 归档后列表里真的没了（否则归档等于没做）
   *  · 顶栏还挂着「已归档」标签、点一下就能回来（否则就是"删了"）
   */
  const openProjectMenu = async () => {
    await page.locator(".caret").click();
    await page.waitForSelector(".menu", { timeout: 8000 });
    await page.waitForTimeout(200);
  };
  await openProjectMenu();
  const archItem = page.locator(".menu-item").filter({ hasText: "归档这个工程" });
  check("项目面板里有「归档这个工程」", (await archItem.count()) === 1);
  if (await archItem.count()) {
    await archItem.first().click();
    await page.waitForTimeout(900);
    check("归档后顶栏出现「已归档」标签", (await page.locator(".proj-archived-pill").count()) === 1);
    const archivedRow = (await api("/api/projects")).projects.find((p) => p.id === proj.id);
    check("归档时间写进工程列表", Boolean(archivedRow?.archivedAt), String(archivedRow?.archivedAt));

    await openProjectMenu();
    const liveRows = await page.locator(".menu-projects .menu-item").allInnerTexts();
    check(
      "已归档的工程不在默认列表里",
      !liveRows.some((t) => t.includes(newName)),
      liveRows.join(" | ").slice(0, 120),
    );
    const archToggle = page.locator(".proj-arch");
    check("面板出现「归档 N」开关", (await archToggle.count()) === 1);
    if (await archToggle.count()) {
      await archToggle.click();
      await page.waitForTimeout(400);
      const archRows = await page.locator(".menu-projects .menu-item.is-archived").allInnerTexts();
      check(
        "打开归档开关能看见它（还标着已归档）",
        archRows.some((t) => t.includes(newName)),
        archRows.join(" | ").slice(0, 120),
      );
    }

    /*
     * 行内「恢复」：悬停归档行出现按钮，点一下还原——不用先点行切过去再点顶栏标签。
     * 用一个"非当前"的归档工程来测（demo），顺带压住"恢复不该切换当前工程"。
     */
    await page.locator(".caret").click();
    await page.waitForTimeout(300);
    // 临时数据根里不一定有 demo，自己造一个"非当前"的工程再归档它，确定性强
    const created = await api("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "E2E 归档对照" }),
    });
    const otherId = created.project?.id;
    check("REST 能创建对照工程", Boolean(otherId), JSON.stringify(created).slice(0, 80));
    if (otherId) {
      await api(`/api/projects/${otherId}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
    }
    // 面板列表来自首屏 load() 拉的快照，REST 改完必须整页重载才能看见
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".project-name", { timeout: 20000 });
    await openProjectMenu();
    await page.locator(".proj-arch").click();
    await page.waitForTimeout(400);
    const demoRow = page
      .locator(".menu-projects .menu-item.is-archived")
      .filter({ hasText: "归档对照" })
      .first();
    check("对照工程出现在归档列表里", (await demoRow.count()) === 1);
    if (await demoRow.count()) {
      await demoRow.hover();
      await page.waitForTimeout(300);
      const restore = demoRow.locator(".menu-restore");
      check("悬停归档行出现「恢复」按钮", (await restore.count()) === 1);
      if (await restore.count()) {
        await restore.click();
        await page.waitForTimeout(1000);
        const otherAfter = (await api("/api/projects")).projects.find((p) => p.id === otherId);
        check("行内「恢复」一步还原对照工程", !otherAfter?.archivedAt, String(otherAfter?.archivedAt));
        check("行内恢复不切换当前工程", (await page.inputValue(".project-name")) === newName);
        check("恢复后面板还开着（没跳走）", (await page.locator(".menu").count()) === 1);
      }
    }
    // 恢复归档开关到收起态，继续后面的"点顶栏标签恢复"流程
    await page.locator(".proj-arch").click();
    await page.waitForTimeout(300);
    await page.locator(".caret").click();
    await page.waitForTimeout(300);
    check("再点一次能收起项目面板", (await page.locator(".menu").count()) === 0);

    await page.locator(".proj-archived-pill").click();
    await page.waitForTimeout(900);
    check("点「已归档」标签即恢复", (await page.locator(".proj-archived-pill").count()) === 0);
    const restored = (await api("/api/projects")).projects.find((p) => p.id === proj.id);
    check("恢复后归档标记被清掉", !restored?.archivedAt, String(restored?.archivedAt));
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
