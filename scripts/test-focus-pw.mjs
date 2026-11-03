/**
 * 双击聚焦的 e2e（无头）。
 *
 * 用法：npx vite --port 5177 之后 node scripts/test-focus-pw.mjs。
 *
 * 验两件事，都是"手感"层面容易被忽略、但错了很明显的：
 * 1. 双击物体 → 观察镜头推到它跟前（target 落在它身上、距离明显变小）；
 * 2. 双击相机实体 → 镜头推到相机旁边（不是飞回世界原点）。
 *
 * 顺带验一下：这个世界坐标 → 屏幕坐标的投影在双击前后都算得准（否则双击的是空气）。
 */
import { chromium } from "playwright";
import fs from "node:fs";

const OUT = ".tmp-focus";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  channel: "msedge",
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--in-process-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
page.on("crash", () => console.log("!! 页面崩溃"));
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push("CONSOLE " + m.text().slice(0, 300));
});
page.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 300)));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, detail ? `\n    ${detail}` : "");
  }
};

await page.goto(process.env.VP_URL ?? "http://localhost:5177/vp-test.html", { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 60000 });
await page.waitForTimeout(2200);

const project = (world) =>
  page.evaluate((w) => {
    const cam = window.__vpProbe?.camera;
    if (!cam) return null;
    const p = cam.position.clone().set(w[0], w[1], w[2]).project(cam);
    return [(p.x + 1) / 2, (1 - p.y) / 2];
  }, world);

const viewState = () =>
  page.evaluate(() => {
    const { camera, controls } = window.__vpProbe;
    return {
      pos: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
      dist: camera.position.distanceTo(controls.target),
    };
  });

/** r3f 的 onDoubleClick 走原生 dblclick（用事件坐标做 raycast），不需要先派 pointer 序列 */
const doubleClick = (fx, fy) =>
  page.evaluate(
    ([fx_, fy_]) => {
      const el = document.querySelector("canvas");
      // 合成事件没有真实 pointer，r3f 内部调 setPointerCapture 会抛 NotFoundError
      el.setPointerCapture = () => {};
      el.releasePointerCapture = () => {};
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width * fx_;
      const cy = r.y + r.height * fy_;
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
    },
    [fx, fy],
  );

const near = (a, b, eps = 0.12) => Math.abs(a - b) <= eps;
const near3 = (a, b, eps = 0.12) => near(a[0], b[0], eps) && near(a[1], b[1], eps) && near(a[2], b[2], eps);

/* ── 双击红球（节点 a 在 -1.7,0,0） ── */
const ballFx = await project([-1.7, 0, 0]);
const before = await viewState();
ok("红球在视口内", ballFx && ballFx[0] > 0 && ballFx[0] < 1 && ballFx[1] > 0 && ballFx[1] < 1, JSON.stringify(ballFx));

if (ballFx) {
  await doubleClick(ballFx[0], ballFx[1]);
  await page.waitForTimeout(600);
  const after = await viewState();
  console.log("  双击前:", JSON.stringify(before));
  console.log("  双击后:", JSON.stringify(after));
  ok("双击物体后 target 落到物体上", near3(after.target, [-1.7, 0, 0]), JSON.stringify(after.target));
  ok("双击物体后镜头明显拉近", after.dist < before.dist - 1, `${before.dist.toFixed(2)} → ${after.dist.toFixed(2)}`);
}

await page.screenshot({ path: `${OUT}/1-focused-node.png` });

/**
 * 用「看相机」把观察镜头摆到相机实体斜后方 2.6 单位。
 * 不能用「对齐成片相机」：那会让观察相机和相机实体几乎重合，
 * 而拾取逻辑在"站在相机里（距离<1）"时故意跳过相机（否则那颗拾取球会吃掉全屏点击）。
 */
await page.locator('.vp3d-hud button:has-text("看相机")').first().click();
await page.waitForTimeout(600);
const camFx = await project([0, 1.6, 7]);
ok("相机实体在视口内", camFx && camFx[0] > 0 && camFx[0] < 1 && camFx[1] > 0 && camFx[1] < 1, JSON.stringify(camFx));

if (camFx) {
  await doubleClick(camFx[0], camFx[1]);
  await page.waitForTimeout(600);
  const afterCam = await viewState();
  console.log("  双击相机后:", JSON.stringify(afterCam));
  ok("双击相机后 target 落到相机实体上", near3(afterCam.target, [0, 1.6, 7], 0.35), JSON.stringify(afterCam.target));
  ok("双击相机后镜头贴到旁边", afterCam.dist < 6, afterCam.dist.toFixed(2));
}

await page.screenshot({ path: `${OUT}/2-focused-camera.png` });

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (errors.length) console.log("页面错误:\n  " + errors.join("\n  "));
await browser.close();
process.exit(fail ? 1 : 0);
