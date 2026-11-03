/**
 * 同帧对比：编辑器「对齐成片相机」vs 成片预览。
 * 用法：node scripts/probe-light-mismatch.mjs [url] [frame]
 */
import { chromium } from "playwright";

const URL = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:5173";
const FRAME = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 0);

const browser = await chromium.launch({
  headless: false,
  channel: "msedge",
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--in-process-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 200)));
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".stage-mode", { timeout: 120000 });
await page.waitForTimeout(3000);

/* ── 1. 视口：跳到指定帧，对齐成片相机 ── */
await page.locator(".stage-mode button", { hasText: "3D 编辑" }).click();
await page.waitForSelector(".vp3d canvas", { timeout: 60000 });
await page.waitForTimeout(2500);
await page.locator(".vp3d-range").evaluate((el, f) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, String(f));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}, FRAME);
await page.waitForTimeout(900);
await page.locator(".vp3d-hud button", { hasText: "对齐成片相机" }).click();
await page.waitForTimeout(2200);
await page.locator(".vp3d").screenshot({ path: ".tmp-vp-aligned.png" });

const info = await page.evaluate(() => {
  const st = window.__vpState;
  // 生产构建里没有这个 dev 钩子（会被摇掉）：只截亮度，不读场景
  if (!st) return null;
  const V3 = st.camera.position.constructor;
  const lights = [];
  st.scene.traverse((o) => {
    if (o.isLight && o.type !== "AmbientLight") {
      const wp = o.getWorldPosition(new V3());
      lights.push({ t: o.type, i: o.intensity, p: [+wp.x.toFixed(2), +wp.y.toFixed(2), +wp.z.toFixed(2)] });
    }
  });
  let earth = null;
  st.scene.traverse((o) => {
    if (earth) return;
    if (o.isMesh && Math.abs((o.geometry?.parameters?.radius ?? 0) - 0.22) < 0.005) {
      const wp = o.getWorldPosition(new V3());
      earth = [+wp.x.toFixed(2), +wp.y.toFixed(2), +wp.z.toFixed(2)];
    }
  });
  const tg = window.__vpProbe?.controls?.target;
  return {
    lights,
    earth,
    cam: [+st.camera.position.x.toFixed(2), +st.camera.position.y.toFixed(2), +st.camera.position.z.toFixed(2)],
    target: tg ? [+tg.x.toFixed(2), +tg.y.toFixed(2), +tg.z.toFixed(2)] : null,
  };
});
console.log(`视口(对齐, ${FRAME} 帧):`, JSON.stringify(info));

/* ── 2. 成片：同帧 ── */
await page.locator(".stage-mode button", { hasText: "成片画面" }).click();
await page.waitForSelector(".canvas-shell", { timeout: 30000 });
await page.waitForTimeout(1200);
await page.waitForTimeout(1500);
await page.locator(".canvas-shell").screenshot({ path: ".tmp-film.png" });
console.log("frame label:", (await page.locator(".tl-meta").first().textContent().catch(() => "?"))?.trim());

await browser.close();
