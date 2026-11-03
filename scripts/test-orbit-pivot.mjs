/**
 * 转视角基准点 e2e：**绕选中的物体做刚体旋转**——基准点不动、镜头不跳。
 *
 * 依赖 `web/vp-test.tsx`（两个节点 a(-1.7,0,0) / b(1.7,0,0)，初始选中 a）。
 * 用法：先 `npx vite --port 5177`，再 `node scripts/test-orbit-pivot.mjs`
 */
import { chromium } from "playwright";

const URL = process.argv.slice(2).find((a) => a.startsWith("http")) ?? "http://localhost:5177/vp-test.html";
const browser = await chromium.launch({
  headless: true,
  channel: "msedge",
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--in-process-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE " + m.text().slice(0, 200)); });

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 60000 });
await page.waitForTimeout(2500);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

/** 读相机位姿 */
const snap = () =>
  page.evaluate(() => {
    const p = window.__vpProbe;
    if (!p) return null;
    const { controls, camera } = p;
    const q = camera.quaternion;
    return {
      pos: [camera.position.x, camera.position.y, camera.position.z],
      tgt: [controls.target.x, controls.target.y, controls.target.z],
      quat: [q.x, q.y, q.z, q.w],
    };
  });

const select = (ids) => page.evaluate((v) => window.__useDoc.getState().setSelection(v), ids);

const drag = (dx, dy, steps = 8) =>
  page.evaluate(
    ({ dx, dy, steps }) => {
      const canvas = document.querySelector("canvas");
      const r = canvas.getBoundingClientRect();
      const x0 = r.left + r.width / 2;
      const y0 = r.top + r.height / 2;
      const ev = (type, x, y, btn) =>
        canvas.dispatchEvent(
          new PointerEvent(type, { bubbles: true, pointerId: 1, button: btn, clientX: x, clientY: y }),
        );
      ev("pointerdown", x0, y0, 0);
      for (let i = 1; i <= steps; i++) {
        ev("pointermove", x0 + (dx * i) / steps, y0 + (dy * i) / steps, -1);
      }
      ev("pointerup", x0 + dx, y0 + dy, 0);
    },
    { dx, dy, steps },
  );

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const same = (a, b, eps = 1e-6) => dist(a, b) <= eps;

console.log("① 初始：镜头还没动过");
const s0 = await snap();
check("拿到相机状态", Boolean(s0), JSON.stringify(s0));

console.log("② 只点一下（不拖）：镜头必须一动不动");
await drag(0, 0, 1);
const s1 = await snap();
check("点击不改相机位置", same(s0.pos, s1.pos, 1e-9), `${JSON.stringify(s0.pos)} → ${JSON.stringify(s1.pos)}`);
check("点击不改朝向", same(s0.quat, s1.quat, 1e-9), `${JSON.stringify(s0.quat)} → ${JSON.stringify(s1.quat)}`);
/**
 * 那一击正落在成片相机实体上，选中被改成 cam（画布点选是产品行为，不是 bug）。
 * 后面的用例都要从"选中 a"出发，复位一下。
 */
await select(["g:a"]);
const s1b = await snap();
check("复位选中后镜头仍不动", same(s1b.pos, s1.pos, 1e-9) && same(s1b.quat, s1.quat, 1e-9));

console.log("③ 选中 a 后拖动：绕 a 转，镜头不跳");
const pivotA = [-1.7, 0, 0];
await drag(160, 40);
const s2 = await snap();
check("拖动后选中没有意外变化", (await page.evaluate(() => window.__useDoc.getState().selection))[0] === "g:a");
check(
  "相机到 a 的距离不变（绕 a 转的刚体条件）",
  Math.abs(dist(s2.pos, pivotA) - dist(s1.pos, pivotA)) < 1e-3,
  `${dist(s1.pos, pivotA).toFixed(4)} → ${dist(s2.pos, pivotA).toFixed(4)}`,
);
check(
  "看向点到 a 的距离不变（朝向跟刚体一起转）",
  Math.abs(dist(s2.tgt, pivotA) - dist(s1.tgt, pivotA)) < 1e-3,
  `${dist(s1.tgt, pivotA).toFixed(4)} → ${dist(s2.tgt, pivotA).toFixed(4)}`,
);
check("镜头确实转了", dist(s2.pos, s1.pos) > 0.3, `${dist(s2.pos, s1.pos).toFixed(3)}`);
check("朝向跟着转（不是死盯一点）", dist(s2.quat, s1.quat) > 0.01, `${dist(s2.quat, s1.quat).toFixed(4)}`);

console.log("④ 换成选中 b 再拖：基准换成 b");
const pivotB = [1.7, 0, 0];
await select(["g:b"]);
const s3 = await snap();
check("选中变化本身不动镜头", same(s2.pos, s3.pos, 1e-9) && same(s2.quat, s3.quat, 1e-9));
await drag(-120, 0);
const s4 = await snap();
check(
  "相机到 b 的距离不变",
  Math.abs(dist(s4.pos, pivotB) - dist(s3.pos, pivotB)) < 1e-3,
  `${dist(s3.pos, pivotB).toFixed(4)} → ${dist(s4.pos, pivotB).toFixed(4)}`,
);
check(
  "相机到 a 的距离变了（说明不是绕 a 转的）",
  Math.abs(dist(s4.pos, pivotA) - dist(s3.pos, pivotA)) > 1e-2,
  `${dist(s3.pos, pivotA).toFixed(4)} → ${dist(s4.pos, pivotA).toFixed(4)}`,
);

console.log("⑤ 取消选中：基准回世界原点");
await select([]);
const s5 = await snap();
await drag(90, -50);
const s6 = await snap();
check(
  "相机到原点的距离不变",
  Math.abs(dist(s6.pos, [0, 0, 0]) - dist(s5.pos, [0, 0, 0])) < 1e-3,
  `${dist(s5.pos, [0, 0, 0]).toFixed(4)} → ${dist(s6.pos, [0, 0, 0]).toFixed(4)}`,
);

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (errors.length) console.log("页面错误：", errors.slice(0, 5));
await browser.close();
process.exit(fail ? 1 : 0);
