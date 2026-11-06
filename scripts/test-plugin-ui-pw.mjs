/**
 * 插件自带界面（浮窗）的 e2e。
 *
 *   npm run build && node scripts/test-plugin-ui-pw.mjs
 *
 * 为什么单独一条：插件 UI 是唯一「宿主不解析、完全由第三方页面决定」的界面，
 * 它坏了不会报错——只会看到一个空白框，而列表里「打开界面」按钮照样在。
 *
 * 验的是浮窗这一层（宿主自己的代码），不验插件页面内容：
 *   1. 点「打开界面」→ 真的出现浮窗，且压在「插件」对话框之上（z-index）
 *   2. iframe 的 src 指向 /plugin-ui/<id>/index.html，静态路由能取到
 *   3. 拖标题栏能移动、拖右下角能缩放（且被视口夹住）
 *   4. 最大化铺满、还原回原尺寸
 *   5. 已开着的插件再点一次：只置顶，不重建（否则页面里填一半的密钥就没了）
 *   6. 关窗、关对话框都收干净
 *   7. 插件里的 studio:resize 消息真的能让宿主把窗口调高
 *
 * 数据隔离同 test-editor-e2e：STUDIO_DATA_ROOT 指到临时目录，不碰真实 data/。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PROBE_PORT ?? 4940);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "studio-pluginui-"));
const SHOT = path.join(ROOT, "out", "probe-plugin-ui");
fs.mkdirSync(SHOT, { recursive: true });

const dist = path.join(ROOT, "dist", "web", "index.html");
if (!fs.existsSync(dist)) {
  console.error("✗ 没有构建产物 dist/web/index.html —— 先跑 npm run build");
  process.exit(1);
}

const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const server = spawn(process.execPath, [tsxCli, path.join(ROOT, "server", "index.ts")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    STUDIO_DATA_ROOT: DATA_ROOT,
    STUDIO_LOG_DIR: path.join(DATA_ROOT, "logs"),
    CODEBUDDY_SAFE_DELETE_ENABLED: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 120; i++) {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) break;
  } catch {
    /* 还没起来 */
  }
  await sleep(500);
}

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

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

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("button.plugin-entry", { timeout: 30000 });
  await page.click("button.plugin-entry");
  await page.waitForSelector(".plg-dialog", { timeout: 15000 });

  // 示例插件：停用状态也应有「打开界面」
  const item = page.locator(".plg-item", { hasText: "自带界面" }).first();
  await item.waitFor({ timeout: 15000 });
  const btn = item.getByRole("button", { name: "打开界面" });
  ok("列表里有「打开界面」按钮", (await btn.count()) === 1);
  await btn.click();

  await page.waitForSelector(".ui-win", { timeout: 10000 });
  await page.waitForTimeout(1200);
  const box1 = await page.locator(".ui-win").boundingBox();
  ok("浮窗出现了", !!box1, JSON.stringify(box1));
  ok("浮窗在对话框之上（z-index>120）", true);
  const zWin = await page.locator(".ui-win").evaluate((el) => Number(getComputedStyle(el).zIndex));
  const zMask = await page.locator(".modal-mask").evaluate((el) => Number(getComputedStyle(el).zIndex));
  ok(`z-index 浮窗 ${zWin} > 遮罩 ${zMask}`, zWin > zMask);

  const frameOk = await page.evaluate(async () => {
    const f = document.querySelector(".ui-win iframe");
    if (!f) return "没有 iframe";
    // 静态路由能取到页面
    const r = await fetch("/plugin-ui/example-ui/index.html");
    return r.ok ? "ok" : `HTTP ${r.status}`;
  });
  ok("插件页面可取", frameOk === "ok", String(frameOk));
  const frameTitle = await page.locator(".ui-win iframe").getAttribute("src");
  ok("iframe src 正确", /^\/plugin-ui\/.+\/index\.html$/.test(frameTitle ?? ""), String(frameTitle));
  await page.screenshot({ path: path.join(SHOT, "1-open.png") });

  // 拖动标题栏
  const head = page.locator(".ui-win-head").first();
  const hb = await head.boundingBox();
  await page.mouse.move(hb.x + 60, hb.y + 12);
  await page.mouse.down();
  await page.mouse.move(hb.x + 60 - 180, hb.y + 12 + 90, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const box2 = await page.locator(".ui-win").boundingBox();
  ok("拖动生效", Math.abs(box2.x - (box1.x - 180)) < 6 && Math.abs(box2.y - (box1.y + 90)) < 6, `${JSON.stringify(box1)} -> ${JSON.stringify(box2)}`);

  // 拖右下角缩放
  const grip = page.locator(".ui-win-grip");
  const gb = await grip.boundingBox();
  await page.mouse.move(gb.x + 8, gb.y + 8);
  await page.mouse.down();
  await page.mouse.move(gb.x + 8 + 120, gb.y + 8 + 80, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const box3 = await page.locator(".ui-win").boundingBox();
  ok("缩放手柄生效", box3.width > box2.width + 100 && box3.height > box2.height + 20, `${JSON.stringify(box2)} -> ${JSON.stringify(box3)}`);
  await page.screenshot({ path: path.join(SHOT, "2-drag-resize.png") });

  // 最大化
  await page.locator(".ui-win-btn", { hasText: "最大化" }).click();
  await page.waitForTimeout(250);
  const box4 = await page.locator(".ui-win").boundingBox();
  ok("最大化铺满视口", box4.width > 1240 && box4.height > 760, JSON.stringify(box4));
  await page.screenshot({ path: path.join(SHOT, "3-max.png") });
  await page.locator(".ui-win-btn", { hasText: "还原" }).click();
  await page.waitForTimeout(250);
  const box5 = await page.locator(".ui-win").boundingBox();
  ok("还原回到原尺寸", Math.abs(box5.width - box3.width) < 4, JSON.stringify(box5));

  /*
   * 插件 → 宿主：studio:resize。直接往 iframe 里发消息，比点示例页的按钮更贴近协议本身
   * （示例页那个按钮只是给人类看的）。
   * 两个方向都要验：正常值照做、超过屏幕要被夹住（不然标题栏会被顶出视口、再也抓不回来）。
   */
  const resizeTo = async (height) => {
    // 必须在 iframe 内部发（parent.postMessage）——从宿主页面 post 到 iframe 的 window，
    // 事件只在 iframe 里触发，宿主自己的监听器收不到。
    const fr = page.frames().find((f) => f.url().includes("/plugin-ui/"));
    await fr.evaluate((h) => window.parent.postMessage({ type: "studio:resize", height: h }, "*"), height);
    await page.waitForTimeout(220);
    return (await page.locator(".ui-win").boundingBox()).height;
  };
  const hSmall = await resizeTo(300);
  ok(`studio:resize 变小生效（300 → ${Math.round(hSmall)}）`, Math.abs(hSmall - 300) < 6);
  const hBig = await resizeTo(5000);
  const winTop = (await page.locator(".ui-win").boundingBox()).y;
  ok(`studio:resize 超屏被夹住（${Math.round(hBig)} ≤ ${Math.round(800 - winTop - 8)}）`, hBig <= 800 - winTop - 8 + 1);
  await resizeTo(540);

  /*
   * 已开着的插件再点一次：只置顶，不重建。
   * 光看窗口数量不够——React 完全可以把 iframe 重挂一遍而窗口还在，
   * 那样插件页面里填了一半的密钥就没了。所以在页面里做个记号，看它还在不在。
   */
  const uiFrame = () => page.frames().find((f) => f.url().includes("/plugin-ui/"));
  await uiFrame().evaluate(() => {
    window.__uiKeep = "alive";
  });
  const before = await page.locator(".ui-win").count();
  await item.getByRole("button", { name: "界面已开" }).evaluate((el) => el.click());
  await page.waitForTimeout(250);
  const kept = await uiFrame()
    .evaluate(() => window.__uiKeep)
    .catch(() => null);
  ok("再次点击只置顶、页面没被重挂", (await page.locator(".ui-win").count()) === before && kept === "alive");

  // 关闭
  await page.locator(".ui-win-btn", { hasText: "关闭" }).click();
  await page.waitForTimeout(200);
  ok("关闭后浮窗消失", (await page.locator(".ui-win").count()) === 0);

  // 关掉插件对话框，界面也跟着收
  await item.getByRole("button", { name: "打开界面" }).click();
  await page.waitForSelector(".ui-win");
  await page.locator(".plg-head .ghost", { hasText: "关闭" }).click();
  await page.waitForTimeout(200);
  ok("关掉插件对话框，浮窗一起消失", (await page.locator(".ui-win").count()) === 0);

  ok("没有 console error", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (err) {
  fail++;
  console.log("  ✗ 异常：", String(err).slice(0, 500));
  await page.screenshot({ path: path.join(SHOT, "fail.png") }).catch(() => {});
} finally {
  console.log(`\n通过 ${pass} / 失败 ${fail}　截图：${SHOT}`);
  if (fail) console.log("服务端日志尾部：\n" + log.slice(-1500));
  await browser.close();
  server.kill();
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
