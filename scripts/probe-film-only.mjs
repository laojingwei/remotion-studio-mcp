/** 只截成片第 0 帧（光照回归用）。用法：node scripts/probe-film-only.mjs [url] [out.png] */
import { chromium } from "playwright";

const URL = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:5173";
const OUT = process.argv.find((a) => a.endsWith(".png")) ?? ".tmp-film-only.png";

const browser = await chromium.launch({
  headless: false,
  channel: "msedge",
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--in-process-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".stage-mode", { timeout: 120000 });
await page.waitForTimeout(4500);
await page.locator(".canvas-shell").screenshot({ path: OUT });
console.log("saved", OUT);
await browser.close();
