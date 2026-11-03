/**
 * 探针：播放时两条时间轴的播放头是否跟着走（真实编辑器）。
 *
 * 用法：node scripts/probe-playhead.mjs [url] [--headed]
 *   默认 http://localhost:4380。**必须 --headed**：无头 Chromium 不产帧、
 *   rAF 被冻住，播放头天然不动（跟产品无关，实测过）。
 *
 * 只读 + 播放/暂停，不改文档。
 */
import { chromium } from "playwright";

const args = process.argv.slice(2);
const URL = args.find((a) => a.startsWith("http")) ?? "http://localhost:4380";
const headed = args.includes("--headed");

const browser = await chromium.launch({
  headless: !headed,
  channel: "msedge",
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--in-process-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE " + m.text().slice(0, 200)); });
page.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 300)));

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".timeline", { timeout: 60000 });
await page.waitForTimeout(2000);

const snap = () =>
  page.evaluate(() => {
    const px = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(parseFloat(el.style.left) || 0) : null;
    };
    return {
      big: px(".tl-playhead-overlay"),
      small: px(".stl-playhead-overlay"),
      frame: Number(document.querySelector(".tl-meta")?.textContent?.match(/\/ (\d+)f$/)?.[1] ?? -1),
    };
  });

let pass = 0;
let fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra ?? ""}`); }
};

/** 采样一段时间，返回从起点前进的帧数 */
const watch = async (ms) => {
  const a = await snap();
  const t0 = Date.now();
  let b = a;
  while (Date.now() - t0 < ms) {
    await page.waitForTimeout(250);
    b = await snap();
  }
  return { a, b };
};

console.log("① 点播放按钮：");
await page.click(".play-toggle");
const r1 = await watch(2200);
console.log("   ", JSON.stringify(r1.a), "→", JSON.stringify(r1.b));
check("大时间轴播放头跟着走", r1.b.big !== r1.a.big && r1.b.frame > r1.a.frame, `${r1.a.big}→${r1.b.big}`);
check("场景时间轴播放头跟着走", r1.b.small !== r1.a.small, `${r1.a.small}→${r1.b.small}`);
await page.click(".play-toggle");

console.log("② 空格播放：");
await page.waitForTimeout(300);
await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true })));
const r2 = await watch(2200);
console.log("   ", JSON.stringify(r2.a), "→", JSON.stringify(r2.b));
check("空格播放时播放头跟着走", r2.b.big !== r2.a.big && r2.b.frame > r2.a.frame, `${r2.a.big}→${r2.b.big}`);
await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true })));

console.log("③ 暂停后停在播放处（不回跳）：");
const paused = await snap();
await page.waitForTimeout(500);
const still = await snap();
check("暂停后不在下一拍回跳", still.frame === paused.frame, `${paused.frame}→${still.frame}`);

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (errors.length) console.log("页面错误：", errors.slice(0, 5));
await browser.close();
process.exit(fail ? 1 : 0);
