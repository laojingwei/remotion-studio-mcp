/**
 * 3D 编辑视口 e2e（无头）。
 *
 * 用法：先起两个服务——
 *   1. API/静态: PORT=4399 npx tsx server/index.ts   （或任意端口，改下方 URL）
 *   2. vite:     npx vite --port 5177                （harness 页面走它，/api 由 vite.config 代理）
 * 然后：node scripts/test-viewport-pw.mjs
 *
 * harness（web/vp-test.html + vp-test.tsx）劫持了 store 的 apply 记录 op，
 * 所以这条链路能验到「手柄拖拽 → update_graph_node 的形状」而不落库。
 *
 * 无头环境的两个坑（脚本已处理，真机不受影响）：
 * - 软件渲染下真实输入管线会崩（CDP Input 域同样挂），交互全部用页面内合成 PointerEvent；
 * - 合成 pointermove 的 button 必须是 -1（无按键变化），否则 TransformControls.pointerMove 早退。
 */
import { chromium } from "playwright";
import * as THREE from "three";
import fs from "node:fs";
import { createHash } from "node:crypto";

const OUT = ".tmp-vp";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  channel: "msedge", // 用系统 Edge，不另下浏览器
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--in-process-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
page.on("crash", () => console.log("!! 页面崩溃"));

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE " + m.text().slice(0, 300)); });
page.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 300)));

const HARNESS = process.env.VP_URL ?? "http://localhost:5177/vp-test.html";
await page.goto(HARNESS, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 60000 });
await page.waitForTimeout(2500); // 等 WebGL 首帧与场景挂载

// headless 的真实输入管线对软件 WebGL 会崩（CDP Input 域同样挂），改在页面里派发合成事件。
// R3F 在 canvas 上监听 pointer 事件，合成 PointerEvent 走的是同一条监听路径。
const synthClick = (fx, fy, ctrl = false) =>
  page.evaluate(([fx_, fy_, ctrl_]) => {
    const el = document.querySelector("canvas");
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.x + r.width * fx_), cy = Math.round(r.y + r.height * fy_);
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true, ctrlKey: !!ctrl_ };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...opts }));
    return [cx, cy];
  }, [fx, fy, ctrl]);

const probe = await page.evaluate(() => ({
  canvas: (() => { const c = document.querySelector("canvas"); return c ? [c.width, c.height] : null; })(),
  tip: document.querySelector(".vp3d-tip")?.textContent ?? null,
  hud: document.querySelector(".vp3d-hud")?.textContent ?? null,
  empty: !!document.querySelector(".vp3d-empty"),
}));
console.log("初始探针:", JSON.stringify(probe, null, 1));

await page.screenshot({ path: `${OUT}/pw-1-initial.png` });

/* ── 9) 进编辑不自动播放 + 成片相机实体：可点选、可拖（写回 set_graph_camera） ── */
const frameA = await page.evaluate(() => document.querySelector(".vp3d-frame")?.textContent ?? "");
await page.waitForTimeout(1200);
const frameB = await page.evaluate(() => document.querySelector(".vp3d-frame")?.textContent ?? "");
console.log("进编辑不自动播放:", frameA === frameB ? "OK" : `!! 帧号自己走了 (${frameA} → ${frameB})`);

// 相机实体在 (0,1.6,7)：和 solar-pick 一样用 three 精确投影，别扫点猜
// （harness 里右栏是浮层，画布仍是全宽，扫描容易点到面板上）
const canvasBox = await page.evaluate(() => {
  const r = document.querySelector("canvas").getBoundingClientRect();
  return { w: r.width, h: r.height };
});
const camProbe = new THREE.PerspectiveCamera(45, canvasBox.w / canvasBox.h, 0.05, 400);
camProbe.position.set(0, 2.4, 9);
camProbe.lookAt(0, 0, 0);
camProbe.updateMatrixWorld();
const camNdc = new THREE.Vector3(0, 1.6, 7).project(camProbe);
const camFx = (camNdc.x + 1) / 2;
const camFy = (1 - camNdc.y) / 2;
console.log("相机实体投影:", camFx.toFixed(3), camFy.toFixed(3));

await synthClick(camFx, camFy);
await page.waitForTimeout(500);
const camTip = await page.evaluate(() => document.querySelector(".vp3d-tip")?.textContent ?? "");
const camSelected = camTip.includes("已选 成片相机");
console.log("点相机实体:", camSelected ? "OK" : `!! ${camTip}`);

let camOps = null;
if (camSelected) {
  const selectCam = async () => {
    await synthClick(camFx, camFy);
    await page.waitForTimeout(320);
    const tip = await page.evaluate(() => document.querySelector(".vp3d-tip")?.textContent ?? "");
    return tip.includes("已选 成片相机");
  };
  for (const off of [20, 28, 36, 44, 52, 14, 60]) {
    const got = await page.evaluate(
      ([off_, fx_, fy_]) => {
        const el = document.querySelector("canvas");
        el.setPointerCapture = () => {};
        el.releasePointerCapture = () => {};
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width * fx_, cy = r.y + r.height * fy_;
        const mk = (x, y, type, buttons) =>
          new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: type === "pointermove" ? -1 : 0, buttons, isPrimary: true });
        const sx = cx + off_;
        for (let d = -10; d <= 10; d += 4) el.dispatchEvent(mk(sx + d, cy + d * 0.4, "pointermove", 0));
        for (let d = -10; d <= 10; d += 4) el.dispatchEvent(mk(sx + d, cy + d * 0.4, "pointermove", 0));
        el.dispatchEvent(mk(sx, cy, "pointerdown", 1));
        for (let i = 1; i <= 6; i++) el.dispatchEvent(mk(sx + i * 12, cy, "pointermove", 1));
        el.dispatchEvent(mk(sx + 72, cy, "pointerup", 0));
        const log = window.__opsLog;
        const last = log[log.length - 1];
        return last && last[0]?.op === "set_graph_camera" ? last : null;
      },
      [off, camFx, camFy],
    );
    if (got) {
      camOps = got;
      break;
    }
    if (!(await selectCam())) {
      console.log("相机重选失败，停止");
      break;
    }
  }
}
const camOp = camOps?.[0];
const camDp = camOp?.camera?.position;
const camDt = camOp?.camera?.target;
const camMoved = camDp && camDt;
const sameDelta =
  camMoved &&
  Math.abs(camDp[0] - 0 - (camDt[0] - 0)) < 1e-6 &&
  Math.abs(camDp[1] - 1.6 - camDt[1]) < 1e-6 &&
  Math.abs(camDp[2] - 7 - camDt[2]) < 1e-6;
console.log(
  "相机拖拽写回:",
  JSON.stringify(camOps),
  camMoved ? (sameDelta ? "OK（position/target 同步平移）" : "!! target 没跟位移") : "!! 没拖到",
);

// 1) 点右侧的方块（初始选中的是左侧红球，点了应该换成方块）
const canvas = page.locator("canvas");
const box = await canvas.boundingBox();
console.log("合成点击坐标:", await synthClick(0.66, 0.5));
await page.waitForTimeout(800);
const tipAfterClick = await page.evaluate(() => document.querySelector(".vp3d-tip")?.textContent ?? null);
console.log("点击方块后 tip:", tipAfterClick);
await page.screenshot({ path: `${OUT}/pw-2-clicked-box.png` });

// 2) 点空白处（左上角远处）→ 应取消选中，tip 提示「点物体选中」
await synthClick(0.08, 0.12);
await page.waitForTimeout(600);
const tipAfterBlank = await page.evaluate(() => document.querySelector(".vp3d-tip")?.textContent ?? null);
console.log("点空白后 tip:", tipAfterBlank);
await page.screenshot({ path: `${OUT}/pw-3-blank.png` });

// 3) 拖动空白处 → 轨道相机（画布内容应该变化，验证不报错即可）
await page.evaluate(() => {
  const el = document.querySelector("canvas");
  const r = el.getBoundingClientRect();
  const mk = (x, y, buttons) => new PointerEvent("pointermove", { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, buttons, isPrimary: true });
  const x0 = r.x + r.width * 0.3, y0 = r.y + r.height * 0.5, x1 = r.x + r.width * 0.55, y1 = r.y + r.height * 0.4;
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x0, clientY: y0, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, isPrimary: true }));
  for (let i = 1; i <= 8; i++) el.dispatchEvent(mk(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8, 1));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x1, clientY: y1, pointerId: 1, pointerType: "mouse", button: 0, buttons: 0, isPrimary: true }));
});
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/pw-4-orbit.png` });
console.log("轨道拖动完成（无异常即通过）");

// 3.5) 拖三轴手柄：复位相机 → 选回红球 → 沿 X 手柄拖 → 应恰好落一条 update_graph_node。
// 注意：错过的点击会触发 onPointerMissed 清空选中，所以每次尝试都要重新确认选中态
const alignBtn = page.locator('.vp3d-btn', { hasText: "对齐成片相机" });
if (await alignBtn.count()) { await alignBtn.click(); await page.waitForTimeout(500); console.log("相机已复位"); }

const selectBall = async () => {
  for (const [fx, fy] of [[0.33, 0.5], [0.32, 0.5], [0.34, 0.5], [0.33, 0.49], [0.35, 0.51]]) {
    await synthClick(fx, fy);
    await page.waitForTimeout(450);
    const tip = await page.evaluate(() => document.querySelector(".vp3d-tip")?.textContent ?? "");
    if (tip.includes("红球")) return true;
  }
  return false;
};

let dragOps = null;
if (await selectBall()) {
  console.log("红球已选中，手柄已挂上");
  for (const off of [22, 30, 38, 46, 54, 16, 62, 70, -22, -30, -38]) {
    const got = await page.evaluate((off_) => {
      const el = document.querySelector("canvas");
      // 合成事件的 pointerId 没有活跃指针，setPointerCapture 会抛 NotFoundError
      // 并中断 TransformControls.onPointerDown（真机走真实指针不受影响），这里补丁成空操作
      el.setPointerCapture = () => {};
      el.releasePointerCapture = () => {};
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width * 0.33, cy = r.y + r.height * 0.5;
      // pointermove 的 button 必须是 -1（无按键变化）：TransformControls.pointerMove
      // 里 `pointer.button !== -1` 直接早退，传 0 会让拖拽"启动了但不动"
      const mk = (x, y, type, buttons) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: type === "pointermove" ? -1 : 0, buttons, isPrimary: true });
      const sx = cx + off_;
      // hover 扫掠：让 TransformControls 命中轴并进入 hover 态
      for (let d = -10; d <= 10; d += 4) el.dispatchEvent(mk(sx + d, cy + d * 0.4, "pointermove", 0));
      for (let d = -10; d <= 10; d += 4) el.dispatchEvent(mk(sx + d, cy + d * 0.4, "pointermove", 0));
      el.dispatchEvent(mk(sx, cy, "pointerdown", 1));
      for (let i = 1; i <= 6; i++) el.dispatchEvent(mk(sx + i * 14, cy, "pointermove", 1));
      el.dispatchEvent(mk(sx + 90, cy, "pointerup", 0));
      return (window).__opsLog.length;
    }, off);
    if (got > 0) { dragOps = { off, got }; break; }
    // 失败的尝试可能把手柄点掉了（错过手柄=拖视角/取消选中），重新选
    if (!(await selectBall())) { console.log("重选失败，停止"); break; }
  }
} else {
  console.log("红球选不上/手柄没挂上");
}
// 调试：看 hover / 拖拽到底走到哪一步
const opsLog = await page.evaluate(() => (window).__opsLog);
console.log("拖手柄写回的 op:", JSON.stringify(opsLog), "命中偏移:", dragOps?.off ?? "(未命中)");
await page.screenshot({ path: `${OUT}/pw-5-drag.png` });

// 4) 播放头：拖 range 到中间，帧号应变化
const range = page.locator(".vp3d-range");
if (await range.count()) {
  await range.fill("60");
  await page.waitForTimeout(400);
  const frame = await page.evaluate(() => document.querySelector(".vp3d-frame")?.textContent ?? null);
  console.log("拖播放头后帧号:", frame);
}

/* ────────────────── M3：大纲多选 / 复制节点 / 拖拽换父级 ────────────────── */

const lastOps = () =>
  page.evaluate(() => {
    const l = (window).__opsLog;
    return l[l.length - 1] ?? null;
  });
const opsCount = () => page.evaluate(() => (window).__opsLog.length);
const rowOf = (name) =>
  page
    .locator(".s3d-node")
    .filter({ has: page.locator(".s3d-node-name", { hasText: new RegExp(`^${name}$`) }) });

// 5) Ctrl 点选多选 → 批量条出现 → 隐藏 → 应恰好一条 apply 带两个 update_graph_node{hidden:true}
await rowOf("红球").click();
await rowOf("转动的方块").click({ modifiers: ["Control"] });
await page.waitForTimeout(300);
const batchText = await page.evaluate(() => document.querySelector(".s3d-batch")?.textContent ?? null);
console.log("批量条:", batchText);
await page.locator(".s3d-batch button", { hasText: "隐藏" }).click();
await page.waitForTimeout(300);
const hideOps = await lastOps();
const hideOk =
  Array.isArray(hideOps) &&
  hideOps.length === 2 &&
  hideOps.every((o) => o.op === "update_graph_node" && o.patch?.hidden === true);
console.log("批量隐藏写回:", JSON.stringify(hideOps), hideOk ? "OK" : "!! 形状不对");
await page.locator(".s3d-batch button", { hasText: "显示" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/pw-6-multiselect.png` });

// 6) 复制节点：红球 → 复制 → add_graph_node，label「红球 副本」、X 偏移 +1.4
await rowOf("红球").click();
await page.waitForTimeout(200);
const nBefore = await opsCount();
await page.locator("button", { hasText: "复制节点" }).first().click();
await page.waitForTimeout(400);
const dupOps = await lastOps();
const dup = Array.isArray(dupOps) ? dupOps[0] : null;
const dupOk =
  dup &&
  dup.op === "add_graph_node" &&
  dup.node?.label === "红球 副本" &&
  Math.abs(dup.node?.transform?.position?.[0] - (-1.7 + 1.4)) < 1e-6 &&
  !dup.node?.parent;
console.log("复制节点写回:", JSON.stringify(dupOps), dupOk ? "OK" : "!! 形状不对");
// 注：harness 的 apply 只记 op 不落库，所以副本行不会真的出现在大纲里（真实落库由 test-scene3d-edit.mts 覆盖）

// 7) 拖拽换父级：红球拖到「转动的方块」上 → update_graph_node{parent:"b"}（世界位置由服务端保持）
//    dragstart 和 drop 必须分两次 evaluate：React 要先拿着 dragId 重渲染，drop 闭包里才有值
await page.evaluate(() => {
  const find = (name) =>
    [...document.querySelectorAll(".s3d-node")].find(
      (el) => el.querySelector(".s3d-node-name")?.textContent === name,
    );
  const src = find("红球");
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
});
await page.waitForTimeout(150);
await page.evaluate(() => {
  const find = (name) =>
    [...document.querySelectorAll(".s3d-node")].find(
      (el) => el.querySelector(".s3d-node-name")?.textContent === name,
    );
  const src = find("红球");
  const dst = find("转动的方块");
  const dt = new DataTransfer();
  dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
  dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  src.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
});
await page.waitForTimeout(400);
const reparentOps = await lastOps();
const reparentOk =
  Array.isArray(reparentOps) &&
  reparentOps.length === 1 &&
  reparentOps[0].op === "update_graph_node" &&
  reparentOps[0].nodeId === "a" &&
  reparentOps[0].patch?.parent === "b";
console.log("拖拽换父级写回:", JSON.stringify(reparentOps), reparentOk ? "OK" : "!! 形状不对");
await page.screenshot({ path: `${OUT}/pw-7-reparent.png` });

// 8) 视口 Ctrl+点击加选：先重新对齐相机（3.5 的拖拽尝试会让 OrbitControls 在
//    React 置 disabled 前吃到 move，视角漂移），再扫描找方块的命中坐标
const alignAgain = page.locator(".vp3d-btn", { hasText: "对齐成片相机" });
if (await alignAgain.count()) {
  await alignAgain.click();
  await page.waitForTimeout(500);
}
let hitFx = null;
for (const fx of [0.55, 0.58, 0.61, 0.64, 0.67, 0.7, 0.73, 0.76, 0.52, 0.79]) {
  await synthClick(fx, 0.5);
  await page.waitForTimeout(350);
  const tip = await page.evaluate(() => document.querySelector(".vp3d-tip")?.textContent ?? "");
  console.log(`  扫描 fx=${fx} → ${tip}`);
  if (tip.includes("转动的方块")) {
    hitFx = fx;
    break;
  }
}
console.log("方块命中坐标 fx:", hitFx ?? "(未命中)");
if (hitFx) {
  await rowOf("红球").click();
  await page.waitForTimeout(200);
  await synthClick(hitFx, 0.5, true); // Ctrl 加选方块
  await page.waitForTimeout(400);
  const tipMulti = await page.evaluate(() => document.querySelector(".vp3d-tip")?.textContent ?? "");
  console.log("Ctrl+点击后 tip:", tipMulti, tipMulti.includes("等 2 个") ? "OK" : "!!");
  await page.screenshot({ path: `${OUT}/pw-8-canvas-multi.png` });
}


/* ────────────────── M4：关键帧编辑 / 相机运镜 / 轨迹 ────────────────── */

const keyRows = () => page.locator(".s3d-key").count();
const addKeyBtn = page.locator(".s3d-key-add");
const seekToFrame = async (f) => {
  await page.evaluate((f_) => {
    (window).__frameBus.seek(f_);
  }, f);
  await page.waitForTimeout(400);
};

// 9) 节点关键帧：**第 0 帧不用手动打**（它就是初始位置，改值即为起点）。
//    直接跳到 60 帧改值/打帧 → 自动补 0 帧锚点，成 1 段 [0,60]
await page.locator(".panel-tab", { hasText: "节点" }).click();
await page.waitForTimeout(200);
await rowOf("红球").click();
await page.waitForTimeout(250);
await seekToFrame(0);

console.log("打关键帧按钮:", (await addKeyBtn.count()) ? "有" : "!! 没有");
const zeroBtnDisabled = await addKeyBtn.isDisabled();
console.log(
  "第 0 帧的手动打帧按钮:",
  zeroBtnDisabled ? "已禁用（OK：0 帧即起点）" : "!! 应该禁用",
);
if (!zeroBtnDisabled) errors.push("第 0 帧的打帧按钮应禁用（0 帧就是初始位置，不需要手动 K）");

await seekToFrame(60);
const frameNow = await page.evaluate(() => document.querySelector(".vp3d-frame")?.textContent ?? null);
await addKeyBtn.click();
await page.waitForTimeout(450);
const keyOps = await lastOps();
const anim = keyOps?.[0]?.patch?.anim;
const keyOpOk =
  Array.isArray(anim) &&
  anim.length === 1 &&
  JSON.stringify(anim[0].at) === "[0,60]" &&
  typeof anim[0].from?.posX === "number" &&
  typeof anim[0].to?.posX === "number" &&
  typeof anim[0].ease === "string";
if (!keyOpOk) errors.push("M4 节点关键帧写回形状不对: " + JSON.stringify(anim));
console.log(
  "第 60 帧打第一颗（帧号",
  frameNow,
  "）：自动补 0 帧 → anim =",
  JSON.stringify(anim)?.slice(0, 160),
  keyOpOk ? "OK" : "!! 形状不对",
);
console.log("列表行数:", await keyRows(), (await keyRows()) === 2 ? "OK" : "!! 应为 2");
await page.screenshot({ path: `${OUT}/pw-9-node-keys.png` });

// 9.5) 整段平移 +1 帧 → [1,61]；再删掉一颗 → 退回单颗（anim 清空、留锚点）
await page.locator(".s3d-key-tools button", { hasText: "→1" }).click();
await page.waitForTimeout(400);
const shiftedAnim = (await lastOps())?.[0]?.patch?.anim;
const shiftOk = JSON.stringify(shiftedAnim?.[0]?.at) === "[1,61]";
if (!shiftOk) errors.push("M4 整段平移不对: " + JSON.stringify(shiftedAnim?.[0]?.at));
console.log("整段 +1 帧:", JSON.stringify(shiftedAnim?.[0]?.at), shiftOk ? "OK" : "!! 应为 [1,61]");

const opsBeforeDel = await opsCount();
await page.locator(".s3d-key").last().locator(".s3d-icon-btn").click();
await page.waitForTimeout(400);
const delAnim = (await lastOps())?.[0]?.patch;
const delOk = delAnim && "anim" in delAnim && !delAnim.anim;
if (!delOk) errors.push("M4 删关键帧后应清空 anim: " + JSON.stringify(delAnim));
console.log("删到单颗:", JSON.stringify(delAnim), delOk ? "OK（退回静态+锚点）" : "!! 应清空 anim");

// 10) 相机运镜关键帧：第 0 帧不用打（它就是起始机位），在 60 帧打一颗
//     → 自动补第 0 帧，set_graph_camera 带 1 段 [0,60]
await page.locator(".panel-tab", { hasText: "相机" }).click();
await page.waitForTimeout(300);
await seekToFrame(60);
await page.locator(".s3d-key-add").click();
await page.waitForTimeout(450);
const camKeyOps = await lastOps();
const camAnim = camKeyOps?.[0]?.camera?.anim;
const camAnimOk =
  camKeyOps?.[0]?.op === "set_graph_camera" &&
  Array.isArray(camAnim) &&
  camAnim.length === 1 &&
  JSON.stringify(camAnim[0].at) === "[0,60]" &&
  typeof camAnim[0].from?.targetX === "number";
if (!camAnimOk) errors.push("M4 相机运镜写回形状不对: " + JSON.stringify(camAnim));
console.log("相机运镜写回:", JSON.stringify(camAnim)?.slice(0, 180), camAnimOk ? "OK" : "!! 形状不对");

// 轨迹开关应随运镜出现。
// 注意它已经不是一个 `.vp3d-btn`，而是分段控件「无轨迹 / 选中轨迹 / 全部轨迹」
// （`hasAnyTrack` 为真时才渲染）。以前这里找 `.vp3d-btn`+文字「轨迹」，
// 控件改成分段之后就永远找不到——测试比实现旧，报的是假失败。
const trackSeg = page.locator(".seg", { hasText: "全部轨迹" });
const hasTrackSeg = (await trackSeg.count()) > 0;
if (!hasTrackSeg) errors.push("M4 有运镜时轨迹控件没出现");
if (hasTrackSeg) {
  // 光"出现"还不够：三个档位都在，且点击能切到「全部轨迹」
  const opts = await trackSeg.locator(".seg-item").allInnerTexts();
  const want = ["无轨迹", "选中轨迹", "全部轨迹"];
  if (JSON.stringify(opts) !== JSON.stringify(want)) {
    errors.push(`M4 轨迹档位不对：${JSON.stringify(opts)}（期望 ${JSON.stringify(want)}）`);
  }
  await trackSeg.locator(".seg-item", { hasText: "全部轨迹" }).click();
  await page.waitForTimeout(200);
  const on = await trackSeg.locator(".seg-item.is-on").innerText().catch(() => "");
  if (!on.includes("全部轨迹")) errors.push(`M4 点「全部轨迹」没生效（当前选中：${on || "无"}）`);
  // 切回默认，免得影响后面用例的截图与选中逻辑
  await trackSeg.locator(".seg-item", { hasText: "选中轨迹" }).click();
  await page.waitForTimeout(200);
}
console.log("轨迹控件:", hasTrackSeg ? "有（三档齐全、可切换）" : "!! 没有");
await page.screenshot({ path: `${OUT}/pw-10-cam-keys.png` });

// 11) 动画区间内拖节点 → 应写关键帧（而不是基础变换）
//     这是"有动画就拖不动"的正解：区间内的值由关键帧决定，改基础变换自然没反应
await page.locator(".panel-tab", { hasText: "节点" }).click();
await page.waitForTimeout(200);
await rowOf("红球").click();
await page.waitForTimeout(200);
// 9.5 留下的"单颗锚点"要先清掉，否则第一颗会跟它凑成 [1,0] 的短段
const clearKeyBtn = page.locator(".s3d-key-bar button", { hasText: "清空" });
if (await clearKeyBtn.count()) {
  await clearKeyBtn.click();
  await page.waitForTimeout(300);
}
await seekToFrame(60);
await addKeyBtn.click(); // 自动补 0 帧锚点 → [0,60]
await page.waitForTimeout(450);
console.log("（重建红球 [0,60] 关键帧，供拖动用例使用）:", JSON.stringify((await lastOps())?.[0]?.patch?.anim?.[0]?.at));

await seekToFrame(30);
if (await alignBtn.count()) {
  await alignBtn.click(); // 复位视角：红球回到 fx≈0.33，手柄位置可预期
  await page.waitForTimeout(600);
}
let nodeCoveredOps = null;
if (await selectBall()) {
  const beforeNodeDrag = await opsCount();
  for (const off of [22, 30, 38, 46, 54, 16, 62, 70]) {
    const res = await page.evaluate(
      ([off_, base_]) => {
        const el = document.querySelector("canvas");
        el.setPointerCapture = () => {};
        el.releasePointerCapture = () => {};
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width * 0.33, cy = r.y + r.height * 0.5;
        const mk = (x, y, type, buttons) =>
          new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: type === "pointermove" ? -1 : 0, buttons, isPrimary: true });
        const sx = cx + off_;
        for (let d = -10; d <= 10; d += 4) el.dispatchEvent(mk(sx + d, cy + d * 0.4, "pointermove", 0));
        for (let d = -10; d <= 10; d += 4) el.dispatchEvent(mk(sx + d, cy + d * 0.4, "pointermove", 0));
        el.dispatchEvent(mk(sx, cy, "pointerdown", 1));
        for (let i = 1; i <= 6; i++) el.dispatchEvent(mk(sx + i * 14, cy, "pointermove", 1));
        el.dispatchEvent(mk(sx + 84, cy, "pointerup", 0));
        const log = (window).__opsLog;
        return log.length > base_ ? log[log.length - 1] : null;
      },
      [off, beforeNodeDrag],
    );
    if (res) {
      nodeCoveredOps = res;
      break;
    }
    if (!(await selectBall())) break; // 错点会清空选中，重新确认
  }
}
const nodeCovered = nodeCoveredOps?.[0];
const nodeWroteKey = Boolean(
  nodeCovered &&
    nodeCovered.op === "update_graph_node" &&
    nodeCovered.patch?.anim &&
    !nodeCovered.patch?.transform,
);
console.log(
  "动画区间内拖节点:",
  nodeCovered
    ? nodeWroteKey
      ? `写了关键帧 OK（${nodeCovered.patch.anim.length} 段）`
      : `!! 写的是基础变换 ${JSON.stringify(nodeCovered.patch)}`
    : "（没抓到手柄，跳过）",
);
if (nodeCovered && !nodeWroteKey) errors.push("M4 动画区间内拖节点应写关键帧，实际写了基础变换");
await page.screenshot({ path: `${OUT}/pw-11-node-key-drag.png` });

// 12) 运镜区间内拖相机 → 应写关键帧（而不是 camera.position）
//     先把视角摆到相机斜后方并选中它，实体就在画面中心，手柄抓得到
await page.locator(".panel-tab", { hasText: "相机" }).click();
await page.waitForTimeout(200);
await page.locator(".vp3d-btn", { hasText: "看相机" }).click();
await page.waitForTimeout(800);
await seekToFrame(30);
const beforeCamDrag = await opsCount();
let coveredCamOps = null;
for (const off of [20, 28, 36, 44, 52, 14, 60]) {
  const res = await page.evaluate(
    ([off_, base_]) => {
      const el = document.querySelector("canvas");
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width * 0.5, cy = r.y + r.height * 0.5;
      const mk = (x, y, type, buttons) =>
        new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: type === "pointermove" ? -1 : 0, buttons, isPrimary: true });
      const sx = cx + off_;
      for (let d = -10; d <= 10; d += 4) el.dispatchEvent(mk(sx + d, cy + d * 0.4, "pointermove", 0));
      for (let d = -10; d <= 10; d += 4) el.dispatchEvent(mk(sx + d, cy + d * 0.4, "pointermove", 0));
      el.dispatchEvent(mk(sx, cy, "pointerdown", 1));
      for (let i = 1; i <= 6; i++) el.dispatchEvent(mk(sx + i * 12, cy + i * 6, "pointermove", 1));
      el.dispatchEvent(mk(sx + 72, cy + 36, "pointerup", 0));
      const log = (window).__opsLog;
      return log.length > base_ ? log[log.length - 1] : null;
    },
    [off, beforeCamDrag],
  );
  if (res) {
    coveredCamOps = res;
    break;
  }
}
const camCovered = coveredCamOps?.[0];
const camWroteKey = Boolean(camCovered && camCovered.camera && "anim" in camCovered.camera);
console.log(
  "运镜区间内拖相机:",
  camCovered ? (camWroteKey ? "写了关键帧 OK" : "!! 写的是基准机位") : "（没抓到手柄，跳过）",
);
if (camCovered && !camWroteKey) errors.push("M4 运镜区间内拖相机应写关键帧，实际写了基准机位");
await page.screenshot({ path: `${OUT}/pw-12-cam-key-drag.png` });


// 13) 面板的数值：有关键帧时显示"当前帧的动画值"，改数值写的是关键帧
//     （以前显示基础变换，第 0 帧看着像最后一帧的值，被当成"关键帧坏了"报上来）
await page.locator(".panel-tab", { hasText: "节点" }).click();
await page.waitForTimeout(200);
await rowOf("红球").click();
await page.waitForTimeout(250);
const clearKeys = page.locator(".s3d-key-bar button", { hasText: "清空" });
if (await clearKeys.count()) {
  await clearKeys.click();
  await page.waitForTimeout(350);
}
await seekToFrame(60);
await addKeyBtn.click(); // 自动补 0 帧锚点
await page.waitForTimeout(500);

const posBox = () => page.locator(".s3d-row").filter({ hasText: "位置" }).locator("input").nth(0);
const before60 = await posBox().inputValue();
await posBox().fill("3.3");
await posBox().press("Enter");
await page.waitForTimeout(700);
const writeOp = (await lastOps())?.[0];
const wroteKey = Boolean(writeOp?.patch?.anim && !writeOp?.patch?.transform);
if (!wroteKey) errors.push("M4 区间内改数值应写关键帧，实际: " + JSON.stringify(writeOp?.patch)?.slice(0, 120));
console.log("区间内改数值:", wroteKey ? `写了关键帧 OK（${writeOp.patch.anim.length} 段）` : "!! 写的是基础变换");

await seekToFrame(0);
const at0 = await posBox().inputValue();
await seekToFrame(60);
const at60 = await posBox().inputValue();
const animValuesDiffer = at0 !== at60;
if (!animValuesDiffer) errors.push(`M4 面板应显示当前帧的动画值，实际两帧都是 ${at0}`);
console.log(`面板位置：第0帧 ${at0} / 第60帧 ${at60}`, animValuesDiffer ? "OK（各帧显示各自的值）" : "!! 两帧相同");
await page.screenshot({ path: `${OUT}/pw-13-key-values.png` });


// 14) 滚轮缩放：改过图之后仍然有效
//     回归点：配置 effect 的 cleanup 曾经 dispose 掉 OrbitControls，而图一变（加节点、
//     拖完写回、打关键帧都会改图）effect 就重跑 → 画布还在但再也缩放不动、转不了视角。
//     这里用 store 直接把节点挪到 -80，逼 extent（进而 effect）变化，再滚轮看画面动不动。
const clipBox = await page.locator("canvas").boundingBox();
const clip = {
  x: Math.round(clipBox.x + 20),
  y: Math.round(clipBox.y + 90),
  width: Math.round(Math.min(320, clipBox.width - 40)),
  height: 180,
};
const shotHash = async () => createHash("md5").update(await page.screenshot({ clip })).digest("hex");

await page.evaluate(() => {
  const st = window.__useDoc.getState();
  const scenes = st.project.scenes.map((s) =>
    s.id === "scene_vp"
      ? {
          ...s,
          props: {
            ...s.props,
            graph: {
              ...s.props.graph,
              nodes: s.props.graph.nodes.map((n) =>
                n.id === "a" ? { ...n, transform: { ...(n.transform || {}), position: [-80, 0, 0] } } : n,
              ),
            },
          },
        }
      : s,
  );
  window.__useDoc.setState({ project: { ...st.project, scenes } });
});
await page.waitForTimeout(1200);

const hBefore = await shotHash();
await page.mouse.move(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2);
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(60);
}
await page.waitForTimeout(700);
const hAfter = await shotHash();
const zoomAlive = hBefore !== hAfter;
if (!zoomAlive) errors.push("缩放失效：改图之后滚轮不再改变画面（OrbitControls 可能已被 dispose）");
console.log("改图后滚轮缩放:", zoomAlive ? "OK（画面有变化）" : "!! 画面没变（控件已失效）");
await page.screenshot({ path: `${OUT}/pw-14-zoom-after-graph.png` });


// 15) 第 0 帧锁定 + 同帧覆盖
//     a) 没有任何关键帧时，直接在 60 帧改数值 → 自动补 0 帧锚点，0 帧保持初始位置
//     b) 同一帧再按一次 = 覆盖那一帧，颗数不变（以前按钮是 disabled，点不动）
await page.locator(".panel-tab", { hasText: "节点" }).click();
await page.waitForTimeout(200);
await rowOf("红球").click();
await page.waitForTimeout(250);
const clearAll = page.locator(".s3d-key-bar button", { hasText: "清空" });
if (await clearAll.count()) {
  await clearAll.click();
  await page.waitForTimeout(400);
}

const basePos = await page.evaluate(() => {
  const st = window.__useDoc.getState();
  const n = st.project.scenes[0].props.graph.nodes.find((x) => x.id === "a");
  return n?.transform?.position?.[0] ?? 0;
});

await seekToFrame(60);
await posBox().fill(String(basePos + 3));
await posBox().press("Enter");
await page.waitForTimeout(800);
const lockOps = (await lastOps())?.[0];
const lockAnim = lockOps?.patch?.anim;
const framesOf = (a) => (Array.isArray(a) ? a.map((seg) => seg.at) : null);
const zeroLocked =
  Array.isArray(lockAnim) &&
  lockAnim.length === 1 &&
  JSON.stringify(lockAnim[0].at) === "[0,60]" &&
  Math.abs(lockAnim[0].from.posX - basePos) < 1e-3 &&
  Math.abs(lockAnim[0].to.posX - (basePos + 3)) < 1e-3;
if (!zeroLocked) {
  errors.push(
    `0 帧锁定失败：期望 from.posX=${basePos} → to.posX=${basePos + 3}，实际 ${JSON.stringify(framesOf(lockAnim))} ` +
      JSON.stringify(lockAnim?.[0]?.from?.posX) + "→" + JSON.stringify(lockAnim?.[0]?.to?.posX),
  );
}
console.log(
  `非0帧改数值：from ${lockAnim?.[0]?.from?.posX} → to ${lockAnim?.[0]?.to?.posX}（初始 ${basePos}）`,
  zeroLocked ? "OK（自动补第 0 帧、0 帧不动）" : "!! 0 帧被改掉了",
);

const beforeOverwrite = await keyRows();
const addBtnHere = page.locator(".s3d-key-add");
const labelHere = (await addBtnHere.textContent())?.trim() ?? "";
await addBtnHere.click();
await page.waitForTimeout(500);
const afterOverwrite = await keyRows();
const overwriteOk = afterOverwrite === beforeOverwrite;
if (!overwriteOk) errors.push(`同帧打帧应覆盖（颗数不变），实际 ${beforeOverwrite} → ${afterOverwrite}`);
console.log(
  `同帧打帧：按钮「${labelHere}」→ 颗数 ${beforeOverwrite} → ${afterOverwrite}`,
  overwriteOk ? "OK（覆盖，不新增）" : "!! 多出了一颗",
);
await page.screenshot({ path: `${OUT}/pw-15-zero-frame-lock.png` });

console.log("\n错误:", errors.length ? errors.join("\n") : "（无）");
await browser.close();
const failed = errors.length > 0;
console.log(failed ? "RESULT: FAILED" : "RESULT: PASS");
process.exit(failed ? 1 : 0);
