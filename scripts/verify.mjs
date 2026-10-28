#!/usr/bin/env node
/**
 * 端到端冒烟验证（CDP + 真实鼠标事件），不依赖任何测试框架。
 *
 *   npm run verify              # 无头 Edge/Chrome
 *   VERIFY_HEADFUL=1 npm run verify
 *
 * 做什么：
 *  1. 确保本地服务在跑（没跑就临时拉起，结束后关掉）
 *  2. 用 API 复制 demo 得到一个**临时工程**，后续所有拖动都改这份副本
 *  3. 打开编辑器，验证：加载 / 选中 / 安全区开关 / 拖动越界告警 / 吸附参考线 /
 *     多选整体缩放 / 撤销
 *  4. 删除临时工程、关浏览器，不留脏数据
 *
 * 需要前端已构建（npm run build），因为服务托管的是 dist/web。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const API = (process.env.SERVER_URL ?? "http://127.0.0.1:4380").replace(/\/$/, "");
const CDP_PORT = Number(process.env.CDP_PORT ?? 9300 + Math.floor(Math.random() * 200));
const HEADFUL = process.env.VERIFY_HEADFUL === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    console.log(`  PASS  ${name}`);
    return true;
  }
  failed++;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  return false;
};
const log = (msg) => console.log(`\n▸ ${msg}`);

/* ─────────────────────────── HTTP ─────────────────────────── */

async function api(method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function serverUp() {
  try {
    const res = await fetch(`${API}/api/projects`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await serverUp()) {
    console.log(`服务已在运行：${API}`);
    return null;
  }
  console.log(`服务未启动，临时拉起 server…`);
  const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const port = new URL(API).port || "4380";
  const proc = spawn(process.execPath, [tsx, "server/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: port },
    stdio: "ignore",
    windowsHide: true,
  });
  for (let i = 0; i < 120; i++) {
    if (await serverUp()) return proc;
    await sleep(500);
  }
  proc.kill();
  throw new Error("服务启动超时（120 次探测）");
}

/* ─────────────────────────── 浏览器 ─────────────────────────── */

function findBrowser() {
  const candidates = [
    process.env.EDGE_PATH,
    process.env.CHROME_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  throw new Error("找不到 Edge/Chrome，可用 EDGE_PATH 环境变量指定");
}

async function launchBrowser() {
  const exe = findBrowser();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rms-verify-"));
  const args = [
    HEADFUL ? "--headless=false" : "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "--no-proxy-server",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--window-size=1600,1000",
    "about:blank",
  ];
  const proc = spawn(exe, args, { stdio: "ignore", windowsHide: true });
  const endpoint = `http://127.0.0.1:${CDP_PORT}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(800) });
      if (res.ok) return { proc, endpoint, userDataDir, exe };
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  proc.kill();
  throw new Error(`浏览器 20s 内没有暴露 CDP 端口 ${CDP_PORT}`);
}

class CDP {
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), 10000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket 连接失败"));
      };
    });
    return new CDP(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    };
    ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP 连接已关闭"));
      this.pending.clear();
    };
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      throw new Error(`页面脚本异常: ${desc}`);
    }
    return r.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function waitFor(cdp, expr, label, timeout = 15000) {
  const end = Date.now() + timeout;
  let lastErr = "";
  while (Date.now() < end) {
    try {
      if (await cdp.evaluate(expr)) return true;
    } catch (err) {
      lastErr = String(err);
    }
    await sleep(150);
  }
  throw new Error(`等待超时：${label}${lastErr ? ` (${lastErr})` : ""}`);
}

/* ─────────────────────────── 鼠标 ─────────────────────────── */

const mouseMove = (cdp, x, y, extra = {}) =>
  cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", ...extra });

async function click(cdp, x, y, modifiers = 0) {
  await mouseMove(cdp, x, y, { modifiers });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    modifiers,
  });
  await sleep(120);
}

/** 按住并移动（不松手），返回后调用 release() 才落库 */
async function pressAndDrag(cdp, from, to, steps = 10, modifiers = 0) {
  await mouseMove(cdp, from.x, from.y, { modifiers });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.x,
    y: from.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers,
  });
  await sleep(80);
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "left",
      buttons: 1,
      modifiers,
    });
    await sleep(25);
  }
  await sleep(120);
}

async function release(cdp, at) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: at.x,
    y: at.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(250);
}

/* ─────────────────────────── 页面小工具 ─────────────────────────── */

// 只返回"中心点没被别的盒子盖住"的元素：用户可能叠了很大的元素（比如视频），
// 直接点它的中心会命中上层，后续交互就全乱了
const boxesExpr = `[...document.querySelectorAll('.edit-box')].filter(b => {
  const r = b.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit && hit.closest('.edit-box') === b;
}).map(b => {
  const r = b.getBoundingClientRect();
  return { id: b.dataset.boxId, x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
})`;

const getBoxes = (cdp) => cdp.evaluate(boxesExpr);

const getCanvas = (cdp) =>
  cdp.evaluate(`(() => { const r = document.querySelector('.canvas-shell').getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);

const getSceneId = (cdp) =>
  cdp.evaluate(`document.querySelector('.scene-item.is-active')?.dataset.sceneId ?? null`);

const count = (cdp, sel) => cdp.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

const pressKey = (cdp, key, modifiers = 0) =>
  cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, modifiers, windowsVirtualKeyCode: 0 });

async function undoByKeyboard(cdp) {
  // 直接派发 window 事件：App 监听的是 window，不依赖焦点
  await cdp.evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`,
  );
  await sleep(600);
}

/** 模板元素在 scene.transforms，自由元素在 scene.elements，读的时候要分派 */
const transformOf = (project, sceneId, boxId) => {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) return null;
  if (boxId.startsWith("ov:")) {
    const el = (scene.elements ?? []).find((e) => `ov:${e.id}` === boxId);
    return el ? { x: el.x, y: el.y, rotate: el.rotate, scale: el.scale, z: el.z } : null;
  }
  const t = scene.transforms?.[boxId];
  return t ? { x: t.x, y: t.y, rotate: t.rotate, scale: t.scale, z: t.z } : null;
};

const scaleOf = (project, sceneId, boxId) => transformOf(project, sceneId, boxId)?.scale ?? 1;

/* ─────────────────────────── 主流程 ─────────────────────────── */

let browser = null;
let cdp = null;
let serverProc = null;
let testId = null;
let testName = null;
let extraProjectIds = [];
let extraTemplateIds = [];
let extraAssetFiles = [];

async function main() {
  serverProc = await ensureServer();

  // 前端产物检查：服务托管的是 dist/web
  const pageRes = await fetch(API + "/", { signal: AbortSignal.timeout(5000) });
  const html = await pageRes.text();
  if (!pageRes.ok || !html.includes('id="root"')) {
    throw new Error("前端没有构建产物，请先运行 npm run build");
  }

  log("准备临时工程（复制 demo，验证结束会删除）");
  testName = `verify_${Date.now().toString(36)}`;
  const dup = await api("POST", "/api/projects/demo/duplicate", { name: testName });
  testId = dup.project.id;
  console.log(`  临时工程：${testId} (${testName})`);

  // demo 的内容用户可能改过（删掉了自由元素），补一个，保证拖拽/缩放/删除步骤有对象
  const firstScene = dup.project.scenes[0];
  const firstSceneId = firstScene.id;
  // 只认"看得见"的自由元素：audio 元素不可见，没法做拖拽/缩放测试
  if (!(firstScene.elements ?? []).some((e) => e.kind !== "audio")) {
    await api("POST", `/api/projects/${testId}/ops`, {
      actor: "verify",
      ops: [
        {
          op: "add_element",
          sceneId: firstScene.id,
          element: { kind: "text", text: "verify", x: 30, y: 30, size: 6, fill: "#C6F24E" },
        },
      ],
    });
  }

  /* 再补一个自由画布场景：agent 生成的那种"一屏满是自定义元素"的画面。
     带一个全屏星点特效（考背景层不挡点击）+ 一段带位移关键帧的文字（考拖动会不会被关键帧盖住）+ 一个形状。 */
  const freeAdd = await api("POST", `/api/projects/${testId}/ops`, {
    actor: "verify",
    ops: [
      {
        op: "add_scene",
        type: "freeform",
        name: "verify_free",
        durationInFrames: 120,
        props: {
          background: { kind: "solid", colors: ["#101018"] },
          elements: [
            { type: "fx", kind: "stars", x: 50, y: 50, size: 110, density: 20, color: "#9FD8FF" },
            {
              type: "text",
              text: "自由画布文案",
              x: 50,
              y: 30,
              size: 7,
              fill: "#FFFFFF",
              weight: 800,
              from: 0,
              anim: [{ at: [0, 18], from: { opacity: 0, y: 38 }, to: { opacity: 1, y: 30 }, ease: "spring" }],
            },
            { type: "shape", shape: "circle", x: 30, y: 70, size: 14, fill: "#5AC8FA" },
          ],
        },
      },
    ],
  });
  const freeScene = { sceneId: freeAdd.createdSceneIds[0] };
  check("临时工程里建好了自由画布场景", !!freeScene.sceneId, JSON.stringify(freeAdd.createdSceneIds));

  log("启动浏览器");
  browser = await launchBrowser();
  const list = await (await fetch(`${browser.endpoint}/json/list`)).json();
  const target = list.find((t) => t.type === "page");
  if (!target) throw new Error("浏览器没有 page target");
  cdp = await CDP.open(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });

  log("打开编辑器并切到临时工程");
  await cdp.send("Page.navigate", { url: API + "/" });
  await waitFor(cdp, `!!document.querySelector('.app')`, "编辑器加载", 30000);
  await cdp.evaluate(`document.querySelector('.project-switch .caret').click()`);
  await waitFor(cdp, `!!document.querySelector('.menu')`, "工程菜单展开");
  const switched = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('.menu .menu-item')];
    const hit = items.find(b => b.textContent.includes(${JSON.stringify(testName)}));
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
  if (!switched) throw new Error("工程菜单里找不到临时工程");
  await waitFor(
    cdp,
    `document.querySelector('.project-name')?.value === ${JSON.stringify(testName)}`,
    "切换到临时工程",
  );
  await waitFor(cdp, `document.querySelectorAll('.edit-box').length >= 2`, "场景元素出现");

  const canvas = await getCanvas(cdp);
  console.log(`  画布：${Math.round(canvas.width)}×${Math.round(canvas.height)} @ (${Math.round(canvas.left)},${Math.round(canvas.top)})`);

  /* 1. 选中 */
  log("1/20 选中元素");
  let boxes = await getBoxes(cdp);
  check("场景元素盒数量 ≥ 2", boxes.length >= 2, `实际 ${boxes.length}`);
  await click(cdp, boxes[0].x, boxes[0].y);
  check("点击后选中 1 个元素", (await count(cdp, ".edit-box.is-selected")) === 1);

  /* 2. 安全区开关 */
  log("2/20 安全区辅助线开关");
  const toggledOn = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('.zoom-bar button')].find(x => /安全区/.test(x.textContent));
    if (!b) return false; b.click(); return true;
  })()`);
  check("找到「安全区」按钮", toggledOn);
  await sleep(200);
  check("打开后出现安全区虚线框", (await count(cdp, ".edit-safe")) === 1);
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('.zoom-bar button')].find(x => /安全区/.test(x.textContent));
    b?.click();
  })()`);
  await sleep(200);
  check("关闭后安全区框消失", (await count(cdp, ".edit-safe")) === 0);

  /* 3. 拖动越界告警 */
  log("3/20 拖动越界：红色描边 + 提示");
  boxes = await getBoxes(cdp);
  const dragTarget = { x: canvas.right + 42, y: boxes[0].y };
  await pressAndDrag(cdp, { x: boxes[0].x, y: boxes[0].y }, dragTarget, 12);
  check("拖动中元素盒标记为越界", (await count(cdp, ".edit-box.is-out")) >= 1);
  check("出现「超出画面」提示", (await count(cdp, '[data-warn="out"]')) === 1);
  const guidesWhileOut = await count(cdp, ".edit-guide");
  check("拖动中安全区框自动出现", (await count(cdp, ".edit-safe")) === 1);
  await release(cdp, dragTarget);
  await sleep(600);
  const projAfterOut = (await api("GET", `/api/projects/${testId}`)).project;
  const movedScene = await getSceneId(cdp);
  const movedT = transformOf(projAfterOut, movedScene, boxes[0].id);
  check("松手后位移落库", !!movedT && Math.abs(movedT.x) > 1, `x=${movedT?.x}`);

  /* 4. 吸附参考线 */
  log("4/20 拖动吸附到画布中心线");
  await undoByKeyboard(cdp);
  await sleep(300);
  boxes = await getBoxes(cdp);
  const center = { x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 };
  await pressAndDrag(cdp, { x: boxes[0].x, y: boxes[0].y }, center, 12);
  const guides = await count(cdp, ".edit-guide");
  check("拖动到中心时出现吸附参考线", guides >= 1, `guide=${guides}`);
  await release(cdp, center);
  await sleep(500);
  const projAfterSnap = (await api("GET", `/api/projects/${testId}`)).project;
  const snapped = transformOf(projAfterSnap, movedScene, boxes[0].id);
  check("吸附后写入的位移是有限数值", !snapped || Number.isFinite(snapped.x));
  await undoByKeyboard(cdp);
  await sleep(300);

  /* 5. 多选 + 整体等比缩放 */
  log("5/20 多选整体等比缩放");
  boxes = await getBoxes(cdp);
  await click(cdp, boxes[0].x, boxes[0].y);
  await click(cdp, boxes[1].x, boxes[1].y, 8); // 8 = Shift
  const selCount = await count(cdp, ".edit-box.is-selected");
  check("Shift 点击后选中 2 个元素", selCount === 2, `实际 ${selCount}`);
  check("出现整体包围盒", (await count(cdp, "[data-group-box]")) === 1);
  const groupHandle = await cdp.evaluate(`(() => {
    const h = document.querySelector('[data-group-box] [data-group-scale]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  check("整体缩放手柄存在", !!groupHandle);

  const groupRect = await cdp.evaluate(`(() => {
    const r = document.querySelector('[data-group-box]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const scaleBefore = (await api("GET", `/api/projects/${testId}`)).project;
  const before = boxes.slice(0, 2).map((b) => scaleOf(scaleBefore, movedScene, b.id));

  if (groupHandle) {
    const far = {
      x: groupRect.x + (groupHandle.x - groupRect.x) * 1.7,
      y: groupRect.y + (groupHandle.y - groupRect.y) * 1.7,
    };
    await pressAndDrag(cdp, groupHandle, far, 12);
    await release(cdp, far);
    await sleep(800);
  }

  const afterProject = (await api("GET", `/api/projects/${testId}`)).project;
  const after = boxes.slice(0, 2).map((b) => scaleOf(afterProject, movedScene, b.id));
  check(
    "两个元素都被放大（相对操作前）",
    after.every((s, i) => typeof s === "number" && s > before[i] * 1.05),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  );
  const afterT = boxes.slice(0, 2).map((b) => transformOf(afterProject, movedScene, b.id));
  check(
    "整体缩放同时按比例平移（x/y 有变化）",
    afterT.some((t) => t && (Math.abs(t.x) > 0.01 || Math.abs(t.y) > 0.01)),
    JSON.stringify(afterT),
  );

  /* 6. 撤销 */
  log("6/20 撤销回滚整体缩放");
  await undoByKeyboard(cdp);
  await sleep(700);
  const undone = (await api("GET", `/api/projects/${testId}`)).project;
  const undoneScales = boxes.slice(0, 2).map((b) => scaleOf(undone, movedScene, b.id));
  check(
    "撤销后 scale 回到操作前的值",
    undoneScales.every((s, i) => Math.abs((s ?? 1) - before[i]) < 0.01),
    `before=${JSON.stringify(before)} after undo=${JSON.stringify(undoneScales)}`,
  );

  /* 7. 整体移动：拖任一选中元素，整组一起走 */
  log("7/20 多选整体移动");
  boxes = await getBoxes(cdp);
  const moveBefore = (await api("GET", `/api/projects/${testId}`)).project;
  const moveB = boxes.slice(0, 2).map((b) => transformOf(moveBefore, movedScene, b.id) ?? { x: 0, y: 0 });
  const moveFrom = { x: boxes[0].x, y: boxes[0].y };
  const moveTo = { x: moveFrom.x + 90, y: moveFrom.y + 54 };
  await pressAndDrag(cdp, moveFrom, moveTo, 12);
  await release(cdp, moveTo);
  await sleep(800);
  const moveAfter = (await api("GET", `/api/projects/${testId}`)).project;
  const moveA = boxes.slice(0, 2).map((b) => transformOf(moveAfter, movedScene, b.id) ?? { x: 0, y: 0 });
  const dxs = moveA.map((t, i) => Number((t.x - moveB[i].x).toFixed(3)));
  const dys = moveA.map((t, i) => Number((t.y - moveB[i].y).toFixed(3)));
  check(
    "整体移动：两个元素位移完全相同",
    Math.abs(dxs[0] - dxs[1]) < 0.02 && Math.abs(dys[0] - dys[1]) < 0.02,
    `dx=${JSON.stringify(dxs)} dy=${JSON.stringify(dys)}`,
  );
  check("整体移动确实发生了", Math.abs(dxs[0]) > 0.5 || Math.abs(dys[0]) > 0.5, `dx=${dxs[0]} dy=${dys[0]}`);
  await undoByKeyboard(cdp);
  await sleep(600);

  /* 8. 整体旋转：角度加同一个 delta，位置绕整体中心转 */
  log("8/20 多选整体旋转");
  const rotHandle = await cdp.evaluate(`(() => {
    const h = document.querySelector('[data-group-box] [data-group-rotate]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  check("整体旋转手柄存在", !!rotHandle);
  if (rotHandle) {
    const gb = await cdp.evaluate(`(() => {
      const r = document.querySelector('[data-group-box]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const rotBefore = (await api("GET", `/api/projects/${testId}`)).project;
    const rb = boxes.slice(0, 2).map((b) => transformOf(rotBefore, movedScene, b.id)?.rotate ?? 0);
    const radius = Math.max(90, Math.abs(rotHandle.y - gb.y));
    // 手柄默认在整体中心正上方，拖到正右方 ≈ 顺时针 90°
    const rotTo = { x: gb.x + radius, y: gb.y };
    await pressAndDrag(cdp, rotHandle, rotTo, 14);
    await release(cdp, rotTo);
    await sleep(800);
    const rotAfter = (await api("GET", `/api/projects/${testId}`)).project;
    const ra = boxes.slice(0, 2).map((b) => transformOf(rotAfter, movedScene, b.id)?.rotate ?? 0);
    const deltas = ra.map((r, i) => Number((r - rb[i]).toFixed(2)));
    check(
      "整体旋转：两个元素角度同步变化",
      Math.abs(deltas[0] - deltas[1]) < 0.5 && Math.abs(deltas[0]) > 10,
      `deltas=${JSON.stringify(deltas)}`,
    );
    const positionMoved = boxes.slice(0, 2).every((b) => {
      const b0 = transformOf(rotBefore, movedScene, b.id) ?? { x: 0, y: 0 };
      const b1 = transformOf(rotAfter, movedScene, b.id) ?? { x: 0, y: 0 };
      return Math.abs(b1.x - b0.x) > 0.05 || Math.abs(b1.y - b0.y) > 0.05;
    });
    check("整体旋转带动位置绕中心转动", positionMoved);
    await undoByKeyboard(cdp);
    await sleep(600);
  }

  /* 9. Ctrl+A 全选 */
  log("9/20 Ctrl+A 全选");
  boxes = await getBoxes(cdp);
  await cdp.evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))`,
  );
  await sleep(300);
  const selectedAll = await count(cdp, ".edit-box.is-selected");
  const totalBoxes = await count(cdp, ".edit-box");
  check(
    "Ctrl+A 选中场景内全部元素",
    selectedAll === totalBoxes && boxes.length >= 2,
    `selected=${selectedAll} total=${totalBoxes}`,
  );

  /* 10. 单元素角点缩放（回归：多选点已选元素现在是整体移动，先点空白回到单选） */
  log("10/20 单选角点缩放（回归）");
  const blank = await cdp.evaluate(`(() => {
    const c = document.querySelector('.canvas-shell').getBoundingClientRect();
    const pts = [
      [c.left + 14, c.top + 14], [c.right - 14, c.top + 14],
      [c.left + 14, c.bottom - 14], [c.right - 14, c.bottom - 14],
      [c.left + c.width / 2, c.top + c.height / 2],
    ];
    for (const [x, y] of pts) {
      const el = document.elementFromPoint(x, y);
      if (el && !el.closest('.edit-box') && !el.closest('.edit-handle')) return { x, y };
    }
    return null;
  })()`);
  check("找得到画布空白点", !!blank);
  if (blank) {
    await click(cdp, blank.x, blank.y);
    check("点空白取消全选", (await count(cdp, ".edit-box.is-selected")) === 0);
  }
  boxes = (await getBoxes(cdp)).sort((a, b) =>
    a.id.startsWith("ov:") ? -1 : b.id.startsWith("ov:") ? 1 : 0,
  );
  await click(cdp, boxes[0].x, boxes[0].y);
  check("再次点击进入单选", (await count(cdp, ".edit-box.is-selected")) === 1);
  const scaleHandle = await cdp.evaluate(`(() => {
    const h = document.querySelector('.edit-box.is-active .edit-handle.scale');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  check("单选时出现角点缩放手柄", !!scaleHandle);
  if (scaleHandle && boxes.length) {
    const preScale =
      scaleOf((await api("GET", `/api/projects/${testId}`)).project, movedScene, boxes[0].id) || 1;
    const c = { x: boxes[0].x, y: boxes[0].y };
    const far = {
      x: c.x + (scaleHandle.x - c.x) * 1.8,
      y: c.y + (scaleHandle.y - c.y) * 1.8,
    };
    await pressAndDrag(cdp, scaleHandle, far, 10);
    await release(cdp, far);
    await sleep(700);
    const p2 = (await api("GET", `/api/projects/${testId}`)).project;
    const s2 = scaleOf(p2, movedScene, boxes[0].id);
    check(
      "角点拖动后元素被放大",
      typeof s2 === "number" && s2 > preScale * 1.05,
      `pre=${preScale} after=${s2}`,
    );
    await undoByKeyboard(cdp);
    await sleep(600);
    const p3 = (await api("GET", `/api/projects/${testId}`)).project;
    const s3 = scaleOf(p3, movedScene, boxes[0].id);
    check("撤销后角点缩放恢复", Math.abs(s3 - preScale) < 0.01, `pre=${preScale} after undo=${s3}`);
  }

  /* 11. 自由画布：agent 生成的内容要能拖、能缩放、能删、能就地改文案 */
  log("11/20 自由画布的元素编辑");
  const freeSceneId = freeScene.sceneId;
  /** 切到某个场景（靠场景列表点选） */
  const gotoScene = async (sceneId) => {
    await cdp.evaluate(`document.querySelector('.scene-item[data-scene-id="${sceneId}"]')?.click()`);
    await sleep(700);
  };
  const freeEls = async () => {
    const p = (await api("GET", `/api/projects/${testId}`)).project;
    return p.scenes.find((s) => s.id === freeSceneId)?.props?.elements ?? [];
  };
  const boxOf = async (id) => (await getBoxes(cdp)).find((b) => b.id === id) ?? null;

  await gotoScene(freeSceneId);
  await waitFor(cdp, `document.querySelectorAll('.edit-box').length >= 3`, "自由画布元素出现");
  check("自由画布元素都有选框（3 个）", (await count(cdp, ".edit-box")) === 3);

  // 全屏特效的选框不该拦住文字：文字中心必须能点到它自己
  const textBox = await boxOf("fc:1");
  check("文字元素的选框可点击（没被背景特效挡住）", !!textBox, JSON.stringify((await getBoxes(cdp)).map((b) => b.id)));
  const lowPE = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('.edit-box')].find((x) => x.dataset.boxId === 'fc:0');
    return b ? getComputedStyle(b).pointerEvents : 'missing';
  })()`);
  check("背景特效的选框不拦点击（pointer-events:none）", lowPE === "none", lowPE);

  await click(cdp, textBox.x, textBox.y);
  check("点文字选中 1 个自由画布元素", (await count(cdp, ".edit-box.is-selected")) === 1);
  check("选中框就是文字那个", (await cdp.evaluate(`document.querySelector('.edit-box.is-selected')?.dataset.boxId`)) === "fc:1");

  // 拖动：位移要落库，并且关键帧的 y 跟着一起平移（否则窗口内拖了等于没拖）
  const elBefore = (await freeEls())[1];
  const dragTo = { x: textBox.x + 70, y: textBox.y + 55 };
  await pressAndDrag(cdp, { x: textBox.x, y: textBox.y }, dragTo, 12);
  await release(cdp, dragTo);
  await sleep(700);
  const elAfter = (await freeEls())[1];
  check("拖动后元素位移落库", elAfter.x > elBefore.x + 1 && elAfter.y > elBefore.y + 1,
    `before=(${elBefore.x},${elBefore.y}) after=(${elAfter.x},${elAfter.y})`);
  const dy = elAfter.y - elBefore.y;
  check("关键帧 y 跟着平移（不然动画窗口内会跳回原位）",
    Math.abs((elAfter.anim?.[0]?.to?.y ?? 0) - (elBefore.anim?.[0]?.to?.y ?? 0) - dy) < 0.2,
    JSON.stringify(elAfter.anim));
  check("关键帧终点与本体位置一致（拖动后仍对齐）",
    Math.abs((elAfter.anim?.[0]?.to?.y ?? 0) - elAfter.y) < 0.05,
    `to.y=${elAfter.anim?.[0]?.to?.y} y=${elAfter.y}`);

  await undoByKeyboard(cdp);
  await sleep(700);
  const elUndo = (await freeEls())[1];
  check("撤销把位置和关键帧一起还原",
    Math.abs(elUndo.x - elBefore.x) < 0.01 && Math.abs(elUndo.anim[0].to.y - elBefore.anim[0].to.y) < 0.01);

  // 角点缩放：scale 手柄只对自由画布元素存在，之前完全没有这个入口
  const tb2 = await boxOf("fc:1");
  await click(cdp, tb2.x, tb2.y);
  const scHandle = await cdp.evaluate(`(() => {
    const h = document.querySelector('.edit-box.is-active .edit-handle.scale');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  check("自由画布元素出现角点缩放手柄", !!scHandle);
  if (scHandle) {
    const far = { x: tb2.x + (scHandle.x - tb2.x) * 1.9, y: tb2.y + (scHandle.y - tb2.y) * 1.9 };
    await pressAndDrag(cdp, scHandle, far, 10);
    await release(cdp, far);
    await sleep(700);
    const scaled = (await freeEls())[1];
    check("角点拖动后元素被放大", scaled.scale > elBefore.scale + 0.05, `scale=${scaled.scale}`);
    await undoByKeyboard(cdp);
    await sleep(600);
  }

  // 重置变换：必须写回 props.elements，绝不能落到模板用的 scene.transforms（画面上毫无反应）
  const tb5 = await boxOf("fc:1");
  await click(cdp, tb5.x, tb5.y);
  const rotH = await cdp.evaluate(`(() => {
    const h = document.querySelector('.edit-box.is-active .edit-handle.rotate');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  check("自由画布元素出现旋转手柄", !!rotH);
  if (rotH) {
    const radius = Math.max(60, Math.abs(tb5.y - rotH.y));
    const rotTo = { x: tb5.x + radius, y: tb5.y };
    await pressAndDrag(cdp, rotH, rotTo, 12);
    await release(cdp, rotTo);
    await sleep(700);
    const rotated = (await freeEls())[1];
    check("拖旋转手柄后 rotate 落库", Math.abs(rotated.rotate) > 10, `rotate=${rotated.rotate}`);

    await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('.arrange-text')].find((x) => x.textContent.trim() === '重置变换');
      b?.click();
    })()`);
    await sleep(700);
    const resetEl = (await freeEls())[1];
    const resetProj = (await api("GET", `/api/projects/${testId}`)).project;
    const resetScene = resetProj.scenes.find((x) => x.id === freeSceneId);
    check("重置变换把 rotate/scale 还原", Math.abs(resetEl.rotate) < 0.01 && Math.abs(resetEl.scale - 1) < 0.01,
      `rotate=${resetEl.rotate} scale=${resetEl.scale}`);
    check("重置变换没有污染 scene.transforms", !resetScene?.transforms?.["fc:1"],
      JSON.stringify(resetScene?.transforms ?? null));
  }

  // 双击就地改文案：选框盖在元素上，命中判定必须走选框上的 data-box-id
  const opened = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('.edit-box')].find(x => x.dataset.boxId === 'fc:1');
    if (!b) return false;
    b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  check("双击文字弹出就地编辑框", opened && (await count(cdp, ".inline-edit")) === 1);
  if (await count(cdp, ".inline-edit")) {
    const edited = await cdp.evaluate(`(() => {
      const ta = document.querySelector('.inline-edit');
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      set.call(ta, '就地改过的文案');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await sleep(700);
    const afterEdit = (await freeEls())[1];
    check("就地编辑写入 elements[].text", edited && afterEdit.text === "就地改过的文案", afterEdit.text);
    await undoByKeyboard(cdp);
    await sleep(600);
  }

  // 删除 + 撤销
  const tb3 = await boxOf("fc:1");
  await click(cdp, tb3.x, tb3.y);
  await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
  await sleep(700);
  check("Delete 删掉自由画布元素", (await count(cdp, ".edit-box")) === 2);
  await undoByKeyboard(cdp);
  await sleep(800);
  check("撤销后元素回来", (await count(cdp, ".edit-box")) === 3);

  // 背景特效：点它（穿过不可点击的选框）能选中，说明整块背景不是死区。
  // 注意落点要避开画面最底部 —— 那里是 Remotion 自带的控制条，点下去会 seek 到别的场景
  const fxSpot = { x: canvas.left + 18, y: canvas.top + canvas.height * 0.55 };
  await click(cdp, fxSpot.x, fxSpot.y);
  check(
    "点背景特效可以选中它",
    (await cdp.evaluate(`document.querySelector('.edit-box.is-selected')?.dataset.boxId`)) === "fc:0",
    await cdp.evaluate(`document.querySelector('.edit-box.is-selected')?.dataset.boxId ?? 'none'`),
  );

  // 图层顺序 = 数组顺序：置顶把文字挪到数组末尾
  const tb4 = await boxOf("fc:1");
  check("文字选框仍在", !!tb4, JSON.stringify((await getBoxes(cdp)).map((b) => b.id)));
  if (tb4) {
    await click(cdp, tb4.x, tb4.y);
    await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('.arrange-btn')].find((x) => (x.getAttribute('title') || '').startsWith('置顶'));
      b?.click();
    })()`);
    await sleep(800);
    const ordered = await freeEls();
    check(
      "置顶 = 移到 elements 末尾（数组顺序就是图层顺序）",
      ordered[ordered.length - 1]?.type === "text" && ordered[0]?.type === "fx",
      ordered.map((e) => `${e.type}:${e.text ?? ""}`).join(" | "),
    );
  }

  await gotoScene(firstSceneId);
  await waitFor(cdp, `document.querySelectorAll('.edit-box').length >= 2`, "切回原场景", 8000);

  /* 12. 自定义模板：保存 → 列表 → 套用 → 删除 */
  log("12/20 自定义模板：保存 / 列表 / 套用 / 删除");
  const tplName = `verify_tpl_${Date.now().toString(36)}`;
  const saved = await api("POST", "/api/templates", {
    projectId: testId,
    name: tplName,
    description: "verify.mjs 自动创建",
  });
  const tplId = saved.template?.key;
  if (tplId) extraTemplateIds.push(tplId);
  check("保存当前工程为模板", !!tplId && tplId.startsWith("tpl_"), `got ${tplId}`);
  check(
    "模板目录里存在 template.json 和素材目录",
    !!tplId &&
      fs.existsSync(path.join(ROOT, "data", "templates", tplId, "template.json")) &&
      fs.existsSync(path.join(ROOT, "data", "templates", tplId, "assets")),
  );

  const tplList = (await api("GET", "/api/templates")).templates;
  const mine = tplList.find((t) => t.key === tplId);
  const srcProject = (await api("GET", `/api/projects/${testId}`)).project;
  check("模板列表包含自定义模板（kind=custom）", !!mine && mine.kind === "custom");
  check("模板场景数 = 源工程场景数", mine?.sceneCount === srcProject.scenes.length, `${mine?.sceneCount} vs ${srcProject.scenes.length}`);

  const renamedTpl = await api("PATCH", `/api/templates/${tplId}`, { name: `${tplName}_改名` });
  check("模板可重命名", renamedTpl.template?.name === `${tplName}_改名`, renamedTpl.template?.name);

  const fromTpl = await api("POST", "/api/projects/from-template", {
    templateId: tplId,
    name: "verify_from_template",
  });
  const tplProjectId = fromTpl.project.id;
  extraProjectIds.push(tplProjectId);
  check("从自定义模板生成新工程（id 不同）", tplProjectId !== testId);
  check(
    "新工程场景类型与源工程一致",
    JSON.stringify(fromTpl.project.scenes.map((s) => s.type)) ===
      JSON.stringify(srcProject.scenes.map((s) => s.type)),
  );
  check(
    "新工程的实例字段是新生成的（rev=1、场景 id 全换）",
    fromTpl.project.rev === 1 &&
      fromTpl.project.scenes.every((s) => !srcProject.scenes.some((o) => o.id === s.id)),
  );

  // 删工程后模板仍可用（素材与工程解耦）
  await api("DELETE", `/api/projects/${tplProjectId}`);
  extraProjectIds = extraProjectIds.filter((id) => id !== tplProjectId);
  const again = await api("POST", "/api/projects/from-template", { templateId: tplId, name: "verify_again" });
  extraProjectIds.push(again.project.id);
  check("删掉原工程后模板仍能套用", again.project.scenes.length === srcProject.scenes.length);

  await api("DELETE", `/api/templates/${tplId}`);
  extraTemplateIds = extraTemplateIds.filter((id) => id !== tplId);
  check("删除模板后目录被清掉", !fs.existsSync(path.join(ROOT, "data", "templates", tplId)));

  /* 12. 工程包导出 / 导入 */
  log("13/20 工程包导出 / 导入");
  const zipRes = await fetch(`${API}/api/projects/${testId}/export`);
  check("导出接口返回 zip", zipRes.ok && (zipRes.headers.get("content-type") ?? "").includes("zip"));
  const zipBuf = new Uint8Array(await zipRes.arrayBuffer());
  check(
    "zip 头是 PK\x03\x04",
    zipBuf.length > 22 && zipBuf[0] === 0x50 && zipBuf[1] === 0x4b && zipBuf[2] === 0x03 && zipBuf[3] === 0x04,
    `len=${zipBuf.length}`,
  );

  const form = new FormData();
  form.append("file", new Blob([zipBuf], { type: "application/zip" }), "bundle.zip");
  const impRes = await fetch(`${API}/api/projects/import`, { method: "POST", body: form });
  const imp = await impRes.json();
  check(
    "导入成功并生成新工程（id 不同）",
    impRes.ok && !!imp.project && imp.project.id !== testId,
    JSON.stringify(imp).slice(0, 160),
  );
  if (imp.project) {
    extraProjectIds.push(imp.project.id);
    const srcProject2 = (await api("GET", `/api/projects/${testId}`)).project;
    check("导入工程场景数与原工程一致", imp.project.scenes.length === srcProject2.scenes.length);
    check(
      "导入工程场景类型一致",
      JSON.stringify(imp.project.scenes.map((s) => s.type)) ===
        JSON.stringify(srcProject2.scenes.map((s) => s.type)),
    );
    check("导入是全新实例（rev=1）", imp.project.rev === 1);
    check("导入时素材都没缺", Array.isArray(imp.warnings) && imp.warnings.length === 0, JSON.stringify(imp.warnings));
  }

  /* 13. 渲染产物清理 */
  log("14/20 渲染产物清理");
  // 产物按工程分目录：假成片要落在临时工程自己的目录里，清理才不会当孤儿整块删
  const verifyPid = testId;
  const videoDir = path.join(ROOT, "out", "projects", verifyPid, "videos");
  fs.mkdirSync(videoDir, { recursive: true });
  const fakeVideos = ["a", "b", "c"].map((s, i) =>
    path.join(videoDir, `verify_${i}_portrait__${verifyPid}.mp4`),
  );
  const baseTime = Date.now() - 3 * 60 * 1000;
  fakeVideos.forEach((file, i) => {
    fs.writeFileSync(file, Buffer.alloc(1024));
    const t = new Date(baseTime + i * 60 * 1000);
    fs.utimesSync(file, t, t);
  });

  const dry = await api("POST", "/api/outputs/cleanup", {
    projectId: verifyPid,
    keepVideos: 1,
    removeOrphans: false,
    dryRun: true,
  });
  check(
    "dryRun：统计到 2 个待删成片",
    dry.removedVideos === 2 && dry.removedStills === 0,
    JSON.stringify(dry),
  );
  check("dryRun：文件一个都没删", fakeVideos.every((f) => fs.existsSync(f)));

  const real = await api("POST", "/api/outputs/cleanup", {
    projectId: verifyPid,
    keepVideos: 1,
    removeOrphans: false,
  });
  check(
    "真清理：只剩最新 1 个成片",
    fakeVideos.filter((f) => fs.existsSync(f)).length === 1,
    fakeVideos.map((f) => `${path.basename(f)}=${fs.existsSync(f)}`).join(", "),
  );
  check(
    "清理报告与实际情况一致",
    real.removedVideos === 2 && real.removedFiles === 2,
    JSON.stringify(real),
  );

  for (const f of fakeVideos) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* 可能已经被清理掉 */
    }
  }

  /* 14. 删除确认 + 下拉菜单点外部收回 */
  log("15/20 删除确认与下拉收回");
  await cdp.evaluate(`document.querySelector('.project-switch .caret').click()`);
  await waitFor(cdp, `!!document.querySelector('.menu')`, "工程菜单打开");
  // 落点必须真的在菜单外面：工程多了以后菜单会长到 800+ px 高，
  // 写死"画布左下角"会正好点进菜单里（本机就出现过，误判成功能坏了）
  const stagePoint = await cdp.evaluate(`(() => {
    const r = document.querySelector('.stage').getBoundingClientRect();
    const m = document.querySelector('.menu')?.getBoundingClientRect();
    const cands = [
      { x: r.right - 15, y: r.bottom - 15 },
      { x: r.right - 15, y: r.top + 60 },
      { x: r.left + r.width * 0.8, y: r.bottom - 15 },
    ];
    for (const p of cands) {
      const inside = m && p.x >= m.left && p.x <= m.right && p.y >= m.top && p.y <= m.bottom;
      if (!inside) return p;
    }
    return cands[0];
  })()`);
  await click(cdp, stagePoint.x, stagePoint.y);
  check("点击菜单外自动收回", (await count(cdp, ".menu")) === 0);

  boxes = await getBoxes(cdp);
  // 删除/撤销的断言看全量盒子（含被大元素盖住、点不到的那些）
  const boxCount = await count(cdp, ".edit-box");
  const overlayBox = boxes.find((b) => b.id.startsWith("ov:"));
  check("存在可删除的自由元素", !!overlayBox, boxes.map((b) => b.id).join(","));
  if (overlayBox) {
    await click(cdp, overlayBox.x, overlayBox.y);
    check("选中一个自由元素", (await count(cdp, ".edit-box.is-selected")) === 1);
    await cdp.evaluate(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`,
    );
    await sleep(400);
    const afterDelete = await count(cdp, ".edit-box");
    check(
      "删元素不弹确认，直接删掉（可撤销）",
      (await count(cdp, ".confirm-card")) === 0 && afterDelete === boxCount - 1,
      `boxes=${afterDelete}`,
    );
    await undoByKeyboard(cdp);
    await sleep(700);
    check("撤销后元素回来", (await count(cdp, ".edit-box")) === boxCount);
  }

  /* 15. 素材缩略图 + 删除回收 + 引用保护 */
  log("16/20 素材缩略图与回收");
  const PNG_1PX = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const assetDir = path.join(ROOT, "public", "assets");

  const uploadAsset = async (name) => {
    const form = new FormData();
    form.append("name", name);
    form.append("w", "1");
    form.append("h", "1");
    form.append("file", new Blob([PNG_1PX], { type: "image/png" }), "verify.png");
    form.append("thumb", new Blob([Buffer.from("RIFFxxxxWEBPVP8 ")], { type: "image/webp" }), "thumb.webp");
    const res = await fetch(`${API}/api/library`, { method: "POST", body: form });
    return { ok: res.ok, data: await res.json() };
  };

  /** /assets/library/x.png → public/assets/library/x.png（v0.98 起素材分层，不能再按 basename 拼） */
  const absAsset = (url) => path.join(assetDir, ...String(url ?? "").replace(/^\/assets\//, "").split("/"));
  const hasAsset = (url) => !!url && fs.existsSync(absAsset(url));

  const up1 = await uploadAsset("verify_asset_1");
  const a1 = up1.data.item;
  check("上传素材登记了缩略图", up1.ok && !!a1?.thumbUrl, JSON.stringify(up1.data).slice(0, 120));
  check("上传的库素材落在 assets/library/", !!a1 && a1.url.startsWith("/assets/library/"), a1?.url ?? "");
  check("原图与缩略图都落盘", hasAsset(a1?.url) && hasAsset(a1?.thumbUrl));

  const del1 = await fetch(`${API}/api/library/${a1.id}`, { method: "DELETE" });
  const del1Body = await del1.json();
  check(
    "删除素材条目时回收原图 + 缩略图",
    del1Body.reclaimed === 2 && !hasAsset(a1.url) && !hasAsset(a1.thumbUrl),
    JSON.stringify(del1Body),
  );

  // 引用保护：素材被工程使用时，删库条目不能删文件
  const up2 = await uploadAsset("verify_asset_2");
  const a2 = up2.data.item;
  extraAssetFiles.push(String(a2?.url ?? "").replace(/^\/assets\//, ""));
  const refScene = (await api("GET", `/api/projects/${testId}`)).project.scenes[0].id;
  await api("POST", `/api/projects/${testId}/ops`, {
    ops: [
      {
        op: "add_element",
        sceneId: refScene,
        element: { kind: "image", name: "verify_ref", src: a2.url, x: 50, y: 50, size: 20 },
      },
    ],
    actor: "user",
  });
  const del2 = await fetch(`${API}/api/library/${a2.id}`, { method: "DELETE" });
  const del2Body = await del2.json();
  check(
    "被工程引用的原图不回收",
    hasAsset(a2.url),
    JSON.stringify(del2Body),
  );
  check(
    "缩略图随条目一起回收（不再需要）",
    !!a2?.thumbUrl && !hasAsset(a2.thumbUrl),
    JSON.stringify(del2Body),
  );

  /* 15.5 批量删除 + 素材面板交互（v1.00） */
  log("16/21 素材批量删除与元素预览");

  // 面板交互：点卡片先开预览（不再直接落进场景），拖动才放
  await cdp.evaluate(`document.querySelector('.scene-item')?.click()`);
  await sleep(300);
  await cdp.evaluate(`[...document.querySelectorAll('.panel-tab')].find(b=>b.textContent.trim()==='元素')?.click()`);
  await sleep(400);
  const elsBefore = ((await api("GET", `/api/projects/${testId}`)).project.scenes[0].elements ?? []).length;
  await cdp.evaluate(`document.querySelector('.lib-grid .lib-item')?.click()`);
  await sleep(400);
  check("点素材卡片弹出预览浮窗", (await count(cdp, ".el-preview")) === 1);
  const elsAfterClick = ((await api("GET", `/api/projects/${testId}`)).project.scenes[0].elements ?? []).length;
  check("只是点一下不会再往场景里加元素", elsAfterClick === elsBefore, `${elsBefore} → ${elsAfterClick}`);
  await cdp.evaluate(`[...document.querySelectorAll('.el-preview button')].find(b=>b.textContent.trim()==='关闭')?.click()`);
  await sleep(250);
  check("预览浮窗能关掉", (await count(cdp, ".el-preview")) === 0);

  // 预览里的「放入画面」才是真的加
  await cdp.evaluate(`document.querySelector('.lib-grid .lib-item')?.click()`);
  await sleep(350);
  await cdp.evaluate(`[...document.querySelectorAll('.el-preview button')].find(b=>b.textContent.trim()==='放入画面')?.click()`);
  await sleep(700);
  const elsAfterAdd = ((await api("GET", `/api/projects/${testId}`)).project.scenes[0].elements ?? []).length;
  check("预览里点「放入画面」才加元素", elsAfterAdd === elsBefore + 1, `${elsBefore} → ${elsAfterAdd}`);

  // 本工程素材：批量删除 + 多选（切到这个页签会重新读目录，所以刚上传的立刻能看到）
  const uploadProjectFile = async (name) => {
    const form = new FormData();
    form.append("file", new Blob([PNG_1PX], { type: "image/png" }), name);
    const res = await fetch(`${API}/api/projects/${testId}/assets`, { method: "POST", body: form });
    return { ok: res.ok, data: await res.json() };
  };
  const pf1 = await uploadProjectFile("verify_pf_1.png");
  const pf2 = await uploadProjectFile("verify_pf_2.png");
  // 一段 0.2s 静音 wav：音频/视频的预览必须能直接播放（不能只画个 ♪）
  const wavBuf = (() => {
    const sr = 8000;
    const n = Math.round(sr * 0.2);
    const b = Buffer.alloc(44 + n * 2);
    b.write("RIFF", 0);
    b.writeUInt32LE(36 + n * 2, 4);
    b.write("WAVE", 8);
    b.write("fmt ", 12);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(1, 22);
    b.writeUInt32LE(sr, 24);
    b.writeUInt32LE(sr * 2, 28);
    b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34);
    b.write("data", 36);
    b.writeUInt32LE(n * 2, 40);
    return b;
  })();
  const pf3Form = new FormData();
  pf3Form.append("file", new Blob([wavBuf], { type: "audio/wav" }), "verify_pf_3.wav");
  const pf3 = await (
    await fetch(`${API}/api/projects/${testId}/assets`, { method: "POST", body: pf3Form })
  ).json();

  // 服务端必须给对 Content-Type：octet-stream 会让 Chromium 直接拒绝解码，
  // 现象是播放器在、点播放没反应（图片不受影响，所以极易误判成前端问题）
  const mediaRes = await fetch(`${API}${pf3.url}`);
  check(
    "音频响应的 Content-Type 是 audio/wav（不是 octet-stream）",
    (mediaRes.headers.get("content-type") ?? "").startsWith("audio/wav"),
    mediaRes.headers.get("content-type") ?? "(空)",
  );
  const rangedRes = await fetch(`${API}${pf3.url}`, { headers: { range: "bytes=0-99" } });
  check(
    "音频支持 Range（206），播放器才能拖进度",
    rangedRes.status === 206 && /^bytes 0-99\//.test(rangedRes.headers.get("content-range") ?? ""),
    `${rangedRes.status} ${rangedRes.headers.get("content-range") ?? ""}`,
  );

  await cdp.evaluate(`[...document.querySelectorAll('.lib-src')].find(b=>b.textContent.includes('本工程'))?.click()`);
  await sleep(600);

  // 最新上传的排在第一个 → 点它就是那个 wav
  await cdp.evaluate(`document.querySelector('.lib-grid .lib-item')?.click()`);
  await sleep(600);
  check("音频素材的预览里有播放器", (await count(cdp, ".el-preview-audio-player")) === 1);
  const audioSrc = await cdp.evaluate(
    `document.querySelector('.el-preview-audio-player')?.getAttribute('src') ?? ''`,
  );
  check(
    "播放器指向这个文件本身",
    String(audioSrc).startsWith("/assets/projects/"),
    String(audioSrc),
  );
  // 播放器在 ≠ 能播：读一下解码状态（MIME 错时 readyState=0 且 error.code=4）
  const mediaState = await cdp.evaluate(`(() => {
    const a = document.querySelector('.el-preview-audio-player');
    if (!a) return 'no-element';
    return JSON.stringify({
      ready: a.readyState,
      err: a.error ? a.error.code : 0,
      dur: Number.isFinite(a.duration) ? Math.round(a.duration * 100) / 100 : -1,
    });
  })()`);
  let st = {};
  try {
    st = JSON.parse(String(mediaState));
  } catch {
    st = {};
  }
  check(
    "浏览器真的能解码这个音频（readyState ≥ 1 且无 error）",
    Number(st.ready) >= 1 && !st.err,
    String(mediaState),
  );
  check(
    "读到了真实时长（元数据解析成功）",
    Number(st.dur) > 0,
    `duration=${st.dur}`,
  );

  await cdp.evaluate(`[...document.querySelectorAll('.el-preview button')].find(b=>b.textContent.trim()==='关闭')?.click()`);
  await sleep(250);
  await cdp.evaluate(`[...document.querySelectorAll('.lib-head-ops .mini')].find(b=>b.textContent.trim()==='多选')?.click()`);
  await sleep(300);
  check("「本工程」能进多选模式", (await count(cdp, ".lib-multi-bar")) === 1);
  check("多选模式给每张卡片画了勾选圈", (await count(cdp, ".lib-check")) > 0);
  await cdp.evaluate(`[...document.querySelectorAll('.lib-head-ops .mini')].find(b=>b.textContent.includes('退出多选'))?.click()`);
  await sleep(200);
  check("能退出多选", (await count(cdp, ".lib-multi-bar")) === 0);

  const pjNames = [pf1.data.url, pf2.data.url, pf3.url].map((u) => String(u).split("/").pop());
  const pjBulk = await api("POST", `/api/projects/${testId}/assets/delete`, {
    names: [...pjNames, "not-exist.png"],
  });
  check(
    "批量删本工程素材：删掉 3 个、缺失 1 个",
    pjBulk.deleted === 3 && pjBulk.missing.length === 1,
    JSON.stringify(pjBulk),
  );
  check(
    "批量删本工程素材：文件真的没了",
    pjNames.every((n) => !fs.existsSync(path.join(assetDir, "projects", testId, n))),
  );

  // 批量删「我的素材」条目
  const bl1 = (await uploadAsset("verify_bulk_1")).data.item;
  const bl2 = (await uploadAsset("verify_bulk_2")).data.item;
  const bulkDel = await api("POST", "/api/library/delete", { ids: [bl1.id, bl2.id, "as_not_exist"] });
  check(
    "批量删「我的素材」：条目删掉、文件回收、缺失项如实回报",
    bulkDel.deleted === 2 &&
      bulkDel.reclaimed === 4 &&
      !hasAsset(bl1.url) &&
      !hasAsset(bl2.url) &&
      bulkDel.missing.length === 1,
    JSON.stringify(bulkDel),
  );

  /* 16. 历史快照与回滚 */
  log("17/20 历史快照与回滚");
  const histBefore = (await api("GET", `/api/projects/${testId}`)).project;
  const baseRev = histBefore.rev;
  const baseName = histBefore.name;
  const renamed = `verify_renamed_${Date.now().toString(36)}`;
  await api("POST", `/api/projects/${testId}/ops`, {
    ops: [{ op: "update_project", patch: { name: renamed } }],
    actor: "user",
  });
  const afterRename = (await api("GET", `/api/projects/${testId}`)).project;
  check("改名生效", afterRename.name === renamed, afterRename.name);

  const hist = (await api("GET", `/api/projects/${testId}/history`)).entries;
  const histTarget = hist.find((h) => h.rev === baseRev);
  check("历史里有目标 rev 的快照", !!histTarget && histTarget.snapshot === true, JSON.stringify(hist.slice(0, 3)));

  const restored = await api("POST", `/api/projects/${testId}/restore/${baseRev}`);
  check("回滚后工程名恢复", restored.project.name === baseName, restored.project.name);
  check("回滚生成新的 rev", restored.project.rev > afterRename.rev, `rev=${restored.project.rev}`);

  const missing = await fetch(`${API}/api/projects/${testId}/restore/999999`, { method: "POST" });
  check("不存在的 rev 返回 404", missing.status === 404, `status=${missing.status}`);

  /* 17. 音效轨 CRUD */
  log("18/20 音效轨");
  const beforeTracks = (await api("GET", `/api/projects/${testId}`)).project.audioTracks ?? [];
  const addRes = await api("POST", `/api/projects/${testId}/ops`, {
    ops: [
      {
        op: "add_audio_track",
        clip: { src: "/assets/mvmeix26-gkv3.wav", name: "verify_sfx", from: 12, volume: 0.5 },
      },
    ],
    actor: "user",
  });
  const addedTracks = addRes.project.audioTracks ?? [];
  const track = addedTracks[addedTracks.length - 1];
  check("添加音效轨", addedTracks.length === beforeTracks.length + 1);
  check(
    "音轨参数正确（起点 / 音量）",
    track?.from === 12 && track?.volume === 0.5,
    JSON.stringify(track),
  );

  const upd = await api("POST", `/api/projects/${testId}/ops`, {
    ops: [{ op: "update_audio_track", trackId: track.id, patch: { volume: 0.2 } }],
    actor: "user",
  });
  check(
    "更新音轨音量",
    upd.project.audioTracks.find((t) => t.id === track.id)?.volume === 0.2,
  );

  const delTrack = await api("POST", `/api/projects/${testId}/ops`, {
    ops: [{ op: "remove_audio_track", trackId: track.id }],
    actor: "user",
  });
  check("删除音轨", (delTrack.project.audioTracks ?? []).every((t) => t.id !== track.id));

  /* 18. 视频元素 */
  log("19/20 视频元素");
  const videoScene = (await api("GET", `/api/projects/${testId}`)).project.scenes[0].id;
  const addVideo = await api("POST", `/api/projects/${testId}/ops`, {
    ops: [
      {
        op: "add_element",
        sceneId: videoScene,
        element: {
          kind: "video",
          name: "verify_video",
          src: "/assets/demo.mp4",
          aspect: 1.7778,
          size: 30,
        },
      },
    ],
    actor: "user",
  });
  const videoEl = (addVideo.project.scenes[0].elements ?? []).find((e) => e.name === "verify_video");
  check("添加视频元素", videoEl?.kind === "video", JSON.stringify(videoEl).slice(0, 120));
  check("视频默认静音 + 循环", videoEl?.muted === true && videoEl?.loop === true);
  const updVideo = await api("POST", `/api/projects/${testId}/ops`, {
    ops: [
      {
        op: "update_element",
        sceneId: videoScene,
        elementId: videoEl.id,
        patch: { muted: false, startFrom: 10 },
      },
    ],
    actor: "user",
  });
  const videoAfter = (updVideo.project.scenes[0].elements ?? []).find((e) => e.id === videoEl.id);
  check("视频可以取消静音并改起始帧", videoAfter?.muted === false && videoAfter?.startFrom === 10);

  /* 19. 删除工程不闪「正在连接本地服务…」 */
  /* 20. 多轨时间轴：拖动改时间 / 换轨 / 同轨重叠吸附 */
  log("20/22 多轨时间轴：拖动改时间 / 换轨 / 吸附");

  const blockOf = (sceneId) =>
    cdp.evaluate(`(() => {
      const el = document.querySelector('[data-scene-block="${sceneId}"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left + Math.min(40, r.width / 2)),
        y: Math.round(r.top + r.height / 2),
        left: r.left,
        top: r.top,
        w: r.width,
        h: r.height,
        start: Number(el.dataset.start),
        dur: Number(el.dataset.dur),
        track: Number(el.dataset.track),
      };
    })()`);

  // 拖一块：先按下、走 steps、停住（便于检查拖动中的状态），再松手
  const grabBlock = async (sceneId, dxFrames, dy = 0) => {
    // 时间轴是横向滚动的：块在视口外就点不到，先滚进来再拖
    await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-scene-block="${sceneId}"]');
      el?.scrollIntoView({ block: 'nearest', inline: 'center' });
    })()`);
    await sleep(200);
    const b = await blockOf(sceneId);
    if (!b) throw new Error(`时间轴上找不到块 ${sceneId}`);
    if (b.x < 6 || b.x > 1590) throw new Error(`块 ${sceneId} 不在视口内（x=${b.x}）`);
    const ppf = (b.w + 2) / Math.max(1, b.dur);
    const to = { x: b.x + dxFrames * ppf, y: b.y + dy };
    await pressAndDrag(cdp, { x: b.x, y: b.y }, to, 10);
    return { b, ppf, to };
  };
  const dropBlock = async (to) => {
    await release(cdp, to);
    await sleep(600);
    return (await api("GET", `/api/projects/${testId}`)).project;
  };

  // 前置清理：demo 里可能已经有多轨内容（用户手动拖过），轨道 1 会被占住，
  // 后面"拖到 0 帧吸附开头"这类断言就会被同轨吸附推走。先清空非主轨。
  {
    const dirty = (await api("GET", `/api/projects/${testId}`)).project.scenes.filter(
      (x) => (x.track ?? 0) > 0,
    );
    if (dirty.length) {
      await api("POST", `/api/projects/${testId}/ops`, {
        actor: "verify",
        ops: dirty.map((x) => ({ op: "remove_scene", sceneId: x.id })),
      });
      console.log(`  清掉 demo 里 ${dirty.length} 个非主轨场景（保证轨道 1 是空的）`);
    }
  }

  // 造一条独立的画中画轨：轨道 1 + 40% 小窗
  const pipAdd = await api("POST", `/api/projects/${testId}/ops`, {
    actor: "verify",
    ops: [
      {
        op: "add_scene",
        type: "title",
        name: "verify_pip",
        durationInFrames: 60,
        start: 40,
        track: 1,
        transitionIn: null,
        props: { title: "PIP" },
      },
    ],
  });
  const pipId = pipAdd.createdSceneIds[0];
  await api("POST", `/api/projects/${testId}/ops`, {
    actor: "verify",
    ops: [{ op: "set_scene_box", sceneId: pipId, box: { x: 72, y: 26, scale: 0.34, radius: 3 } }],
  });
  await waitFor(
    cdp,
    `document.querySelectorAll('.tl-lane-scene').length >= 2`,
    "时间轴出现第二条场景轨道",
  );
  check(
    "画中画场景在独立轨道上（data-track=1）",
    (await blockOf(pipId))?.track === 1,
    JSON.stringify(await blockOf(pipId)),
  );
  check(
    "轨道头显示「轨道 1」",
    (await cdp.evaluate(`[...document.querySelectorAll('.tl-head-track')].map((x) => x.textContent)`)).some(
      (t) => t.includes("轨道 1"),
    ),
  );

  // ① 拖动改时间 + 吸附到 0（吸附时要有参考线）
  await cdp.evaluate(`document.querySelector('.tl-body').scrollLeft = 0`);
  // 拖到"距 0 帧还差 1 帧"的位置 → 触发吸附（吸附阈值 8px，硬拖到负数是夹紧、不画参考线）
  const drag1 = await grabBlock(pipId, -39);
  const guideDuring = await count(cdp, ".tl-snap-guide");
  const draggingClass = await count(cdp, ".tl-block.is-dragging");
  check("拖动中块有 .is-dragging（还没落库）", draggingClass === 1, `实际 ${draggingClass}`);
  check("吸附时画参考线", guideDuring === 1, `参考线 ${guideDuring} 条`);
  let proj = await dropBlock(drag1.to);
  let pipScene = proj.scenes.find((x) => x.id === pipId);
  check("松手后起点落库为 0（吸附到开头）", pipScene?.start === 0, `start=${pipScene?.start}`);
  check("拖到轨道 1 之外不影响轨道号", (pipScene?.track ?? 0) === 1, `track=${pipScene?.track}`);

  // ② 往右拖 40 帧：没有吸附目标时就是自由位置
  const drag2 = await grabBlock(pipId, 100);
  proj = await dropBlock(drag2.to);
  pipScene = proj.scenes.find((x) => x.id === pipId);
  check(
    "自由拖动按像素换算成帧落库（约 +100 帧）",
    (pipScene?.start ?? -1) >= 90 && (pipScene?.start ?? -1) <= 110,
    `start=${pipScene?.start}`,
  );

  // ②b 右边缘拉伸：时长跟着像素走（和拖动定位共用同一套块，别把两者搞混）
  const durBefore = (await blockOf(pipId)).dur;
  const handlePos = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-scene-block="${pipId}"] .tl-handle-right');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  check("场景块右边缘有拉伸手柄", !!handlePos);
  if (handlePos) {
    const toHandle = { x: handlePos.x + 30 * drag2.ppf, y: handlePos.y };
    await pressAndDrag(cdp, handlePos, toHandle, 8);
    await release(cdp, toHandle);
    await sleep(600);
    proj = (await api("GET", `/api/projects/${testId}`)).project;
    const durAfter = proj.scenes.find((x) => x.id === pipId).durationInFrames;
    check(
      "拖右边缘把时长拉长约 30 帧",
      durAfter > durBefore + 20 && durAfter < durBefore + 40,
      `${durBefore} → ${durAfter}`,
    );
  }

  // ②c 左边缘拉伸：右端钉住，起点跟着走（等于裁头）
  const leftHandlePos = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-scene-block="${pipId}"] .tl-handle-left');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  check("场景块左边缘也有拉伸手柄", !!leftHandlePos);
  if (leftHandlePos) {
    proj = (await api("GET", `/api/projects/${testId}`)).project;
    const beforeLeft = proj.scenes.find((x) => x.id === pipId);
    const endBefore = beforeLeft.start + beforeLeft.durationInFrames;
    const toLeft = { x: leftHandlePos.x + 24 * drag2.ppf, y: leftHandlePos.y };
    await pressAndDrag(cdp, leftHandlePos, toLeft, 8);
    const duringLeft = await blockOf(pipId);
    check(
      "左拉过程中块实时变窄（预览生效）",
      duringLeft.dur < beforeLeft.durationInFrames - 4,
      `${beforeLeft.durationInFrames} → ${duringLeft.dur}`,
    );
    await release(cdp, toLeft);
    await sleep(700);
    proj = (await api("GET", `/api/projects/${testId}`)).project;
    const afterLeft = proj.scenes.find((x) => x.id === pipId);
    check(
      "左拉后起点落库（右移）",
      afterLeft.start > beforeLeft.start + 4,
      `${beforeLeft.start} → ${afterLeft.start}`,
    );
    check(
      "左拉后时长变短",
      afterLeft.durationInFrames < beforeLeft.durationInFrames - 4,
      `${beforeLeft.durationInFrames} → ${afterLeft.durationInFrames}`,
    );
    check(
      "左拉后右端不动（end 守恒）",
      Math.abs(afterLeft.start + afterLeft.durationInFrames - endBefore) <= 1,
      `end ${endBefore} → ${afterLeft.start + afterLeft.durationInFrames}`,
    );
  }

  // ②d 松手不闪：松手那一刻块不能跳回旧位置（采样 data-start 看有没有回落）
  await cdp.evaluate(`(() => {
    window.__tlSamples = [];
    window.__tlStop = false;
    const tick = () => {
      const el = document.querySelector('[data-scene-block="${pipId}"]');
      if (el) window.__tlSamples.push(Number(el.dataset.start));
      if (!window.__tlStop) requestAnimationFrame(tick);
    };
    tick();
  })()`);
  const dragFlash = await grabBlock(pipId, 60);
  const idxAtRelease = await cdp.evaluate(`window.__tlSamples.length`);
  proj = await dropBlock(dragFlash.to);
  const tlSamples = await cdp.evaluate(`(() => { window.__tlStop = true; return window.__tlSamples; })()`);
  const tlTail = tlSamples.slice(idxAtRelease);
  const tlTarget = tlSamples[tlSamples.length - 1];
  check("采样器采到了松手后的画面", tlTail.length >= 10, `松手后仅 ${tlTail.length} 帧`);
  check(
    "松手后块不跳回旧位置（没有一闪一闪）",
    tlTail.every((v) => v === tlTarget),
    `目标 ${tlTarget}，松手后出现 ${[...new Set(tlTail.filter((v) => v !== tlTarget))].join(",")}`,
  );

  // ②e 主轨内拖动 = **重排**（不是"按绝对时间放、撞上就一路推到末尾"）
  await cdp.evaluate(`document.querySelector('.tl-body').scrollLeft = 0`);
  await sleep(300);
  const mainBlocks = () =>
    cdp.evaluate(`(() => {
      return [...document.querySelectorAll('[data-scene-block]')]
        .filter((el) => el.dataset.track === '0')
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            id: el.dataset.sceneBlock,
            start: Number(el.dataset.start),
            left: Math.round(r.left),
            cx: Math.round(r.left + r.width / 2),
            cy: Math.round(r.top + r.height / 2),
            w: Math.round(r.width),
          };
        })
        .sort((a, b) => a.start - b.start);
    })()`);
  const mb = await mainBlocks();
  if (mb.length >= 3) {
    const mover = mb[0];
    const second = mb[1];
    const fromMain = { x: Math.round(mover.left + mover.w / 2), y: mover.cy };
    const toMain = { x: Math.round(second.left + second.w * 0.78), y: mover.cy };
    // 顺手测拖动流畅度：拖到一半时开始采样帧间隔
    await cdp.evaluate(`(() => {
      window.__vf = [];
      window.__vfStop = false;
      let prev = performance.now();
      const tick = (t) => {
        window.__vf.push(t - prev);
        prev = t;
        if (!window.__vfStop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })()`);
    await pressAndDrag(cdp, fromMain, toMain, 12);
    const duringMain = (await mainBlocks()).map((b) => b.id);
    check("拖动中主轨已按插入位置预览", duringMain[1] === mover.id, duringMain.join(","));
    await release(cdp, toMain);
    await sleep(900);
    const vf = await cdp.evaluate(`(() => { window.__vfStop = true; return window.__vf; })()`);
    proj = (await api("GET", `/api/projects/${testId}`)).project;
    const mainOrder = proj.scenes.filter((x) => (x.track ?? 0) === 0).map((x) => x.id);
    check("主轨拖动 = 重排：落到第 2 位", mainOrder[1] === mover.id, mainOrder.join(","));
    check(
      "主轨拖动不会把块扔到末尾",
      mainOrder[mainOrder.length - 1] !== mover.id,
      mainOrder.join(","),
    );
    check("原来的第 1 幕顺延到第 2 位", mainOrder[0] === second.id, mainOrder.join(","));
    const usableFrames = vf.slice(3).filter((x) => x > 0 && x < 500);
    const avgFrame = usableFrames.reduce((a, b) => a + b, 0) / Math.max(1, usableFrames.length);
    check(
      "拖动流畅（平均帧间隔 < 35ms，即 ≥28fps）",
      avgFrame < 35,
      `${avgFrame.toFixed(1)}ms / ${usableFrames.length} 帧`,
    );
  }

  // ③ 往下拖一行 = 换轨道：主轨第 3 幕拖到轨道 1
  const third = proj.scenes.filter((x) => (x.track ?? 0) === 0)[2];
  const drag3 = await grabBlock(third.id, 0, 34);
  proj = await dropBlock(drag3.to);
  const movedDown = proj.scenes.find((x) => x.id === third.id);
  check("往下拖一行 → 轨道号变成 1", (movedDown?.track ?? 0) === 1, `track=${movedDown?.track}`);

  // ④ 同轨重叠：把这块拖到画中画身上，必须被推到它末尾（同轨不重叠）
  pipScene = proj.scenes.find((x) => x.id === pipId);
  const other = proj.scenes.find((x) => x.id === third.id);
  const overlapDrag = await grabBlock(third.id, pipScene.start - other.start + 5);
  proj = await dropBlock(overlapDrag.to);
  const a = proj.scenes.find((x) => x.id === pipId);
  const b2 = proj.scenes.find((x) => x.id === third.id);
  const noOverlap =
    !(a.start < b2.start + b2.durationInFrames && a.start + a.durationInFrames > b2.start);
  check(
    "同轨拖动重叠时被吸附，不产生两块重叠",
    noOverlap,
    `pip ${a.start}~${a.start + a.durationInFrames} / moved ${b2.start}~${b2.start + b2.durationInFrames}`,
  );

  // ⑤ 删除轨道：轨道头的 × 把这一轨的场景并回主轨（内容不删、恢复全屏）
  const track2 = await api("POST", `/api/projects/${testId}/ops`, {
    actor: "verify",
    ops: [
      {
        op: "add_scene",
        type: "title",
        name: "verify_t2_a",
        durationInFrames: 45,
        start: 900,
        track: 2,
        transitionIn: null,
        props: { title: "T2A" },
      },
      {
        op: "add_scene",
        type: "title",
        name: "verify_t2_b",
        durationInFrames: 45,
        start: 960,
        track: 2,
        transitionIn: null,
        props: { title: "T2B" },
      },
    ],
  });
  const [t2a, t2b] = track2.createdSceneIds;
  await api("POST", `/api/projects/${testId}/ops`, {
    actor: "verify",
    ops: [{ op: "set_scene_box", sceneId: t2a, box: { x: 72, y: 26, scale: 0.34 } }],
  });
  await waitFor(cdp, `document.querySelectorAll('.tl-head-track .tl-head-x').length >= 1`, "轨道头出现删除按钮");
  const headX = await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.tl-head-track .tl-head-x')];
    const b = btns[btns.length - 1];
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await click(cdp, headX.x, headX.y);
  await sleep(900);
  proj = (await api("GET", `/api/projects/${testId}`)).project;
  const delA = proj.scenes.find((x) => x.id === t2a);
  const delB = proj.scenes.find((x) => x.id === t2b);
  check(
    "删轨道后这幕回到主轨",
    (delA?.track ?? 0) === 0 && (delB?.track ?? 0) === 0,
    `A track=${delA?.track} / B track=${delB?.track}`,
  );
  check("删轨道不删内容（场景还在）", !!delA && !!delB);
  check("删轨道时清掉画面框（恢复全屏）", !delA?.box, JSON.stringify(delA?.box ?? null));
  check(
    "并回主轨末尾且按顺序相接",
    (delB?.start ?? 0) >= (delA?.start ?? 0) + (delA?.durationInFrames ?? 0),
    `A ${delA?.start}~${(delA?.start ?? 0) + (delA?.durationInFrames ?? 0)} / B ${delB?.start}`,
  );
  check(
    "轨道 2 那一行消失",
    (await cdp.evaluate(`[...document.querySelectorAll('.tl-head-track')].map((x) => x.textContent)`)).every(
      (t) => !t.includes("轨道 2"),
    ),
  );

  /* 21. 画中画：画布上拖框 + 面板改参数 */
  log("21/22 画中画：画布上拖框 / 拖角点缩放 / 面板");

  const pipBlockBox = async (sceneId) => {
    // 先滚到可见：块可能在时间轴横向滚动区外面，直接点会打到别处
    await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-scene-block="${sceneId}"]');
      el?.scrollIntoView({ block: 'nearest', inline: 'center' });
    })()`);
    await sleep(250);
    const b = await blockOf(sceneId);
    if (!b) throw new Error(`找不到块 ${sceneId}`);
    await click(cdp, b.x, b.y);
    await sleep(600);
  };
  await pipBlockBox(pipId);
  await waitFor(cdp, `!!document.querySelector('.pip-frame')`, "画布上出现画中画框", 8000);
  check(
    "画布上出现画中画框（.pip-frame）",
    (await count(cdp, ".pip-frame")) >= 1,
    `数量 ${await count(cdp, ".pip-frame")}`,
  );
  check(
    "选中的小窗带 is-selected（可以拖标题条/角点）",
    (await count(cdp, ".pip-frame.is-selected")) === 1,
  );

  const boxNow = async () =>
    (await api("GET", `/api/projects/${testId}`)).project.scenes.find((x) => x.id === pipId)?.box;
  const rectOf = (sel) =>
    cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    })()`);

  const beforeBox = await boxNow();
  const bar = await rectOf(".pip-frame.is-selected .pip-bar");
  check("小窗有可拖动的标题条", !!bar);
  if (bar) {
    const toBar = { x: bar.x - 50, y: bar.y + 30 };
    await pressAndDrag(cdp, { x: bar.x, y: bar.y }, toBar, 8);
    await release(cdp, toBar);
    await sleep(700);
    const after = await boxNow();
    check(
      "拖标题条 → 小窗位置落库（x 变小、y 变大）",
      after.x < beforeBox.x - 1 && after.y > beforeBox.y + 1,
      `x ${beforeBox.x}→${after.x} / y ${beforeBox.y}→${after.y}`,
    );

    const se = await rectOf(".pip-frame.is-selected .pip-handle.se");
    check("选中后出现四角缩放手柄", !!se);
    if (se) {
      const scaleBefore = (await boxNow()).scale;
      const toSe = { x: se.x + 40, y: se.y + 40 };
      await pressAndDrag(cdp, { x: se.x, y: se.y }, toSe, 8);
      await release(cdp, toSe);
      await sleep(700);
      const scaled = (await boxNow()).scale;
      check("拖角点 → 小窗放大", scaled > scaleBefore + 0.02, `${scaleBefore} → ${scaled}`);

      // 一次拖动只能是一步撤销：撤销一次就该回到拖动前的尺寸
      await undoByKeyboard(cdp);
      await sleep(700);
      const undoneBox = await boxNow();
      check(
        "小窗缩放只占一步撤销",
        Math.abs(undoneBox.scale - scaleBefore) < 0.01,
        `撤销后 ${undoneBox.scale}，期望 ${scaleBefore}`,
      );
    }
  }

  // 面板：任意一幕都能一键变成画中画
  const plainScene = (await api("GET", `/api/projects/${testId}`)).project.scenes.find(
    (x) => !x.box && (x.track ?? 0) === 0,
  );
  if (plainScene) {
    await pipBlockBox(plainScene.id);
    const clicked = await cdp.evaluate(`(() => {
      const btns = [...document.querySelectorAll('.panel.right button')];
      const hit = btns.find((b) => b.textContent.includes('设为画中画'));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    check("面板里有「设为画中画」按钮", clicked);
    await sleep(800);
    const madePip = (await api("GET", `/api/projects/${testId}`)).project.scenes.find(
      (x) => x.id === plainScene.id,
    );
    check(
      "按钮把它变成轨道 1 的小窗",
      (madePip?.track ?? 0) === 1 && !!madePip?.box && madePip.box.scale < 0.5,
      JSON.stringify({ track: madePip?.track, box: madePip?.box }),
    );
  }

  /* 22. 音频面板：配平 / 压平动态按钮（编辑器里能直接点，不是只能靠 agent） */
  log("22/24 音频配平与动态压缩按钮");
  const audioProject = await api("POST", `/api/projects/${testId}/duplicate`, {
    name: `verify_audio_${Date.now().toString(36)}`,
  });
  extraProjectIds.push(audioProject.project.id);
  const audioId = audioProject.project.id;
  // 自造测试音频：不依赖 data 里恰好有哪个素材（用户随时会清空 assets）
  const audioSrcPath = "/assets/verify_audio_tmp.wav";
  {
    const SR = 44100;
    const n = Math.round(SR * 2);
    const buf = Buffer.alloc(44 + n * 2);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(SR, 24);
    buf.writeUInt32LE(SR * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
      const amp = i < n / 2 ? 0.03 : 0.08; // 前轻后响：顺带能验证曲线不是常数
      buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / SR) * 32767), 44 + i * 2);
    }
    fs.writeFileSync(path.join(ROOT, "public", "assets", "verify_audio_tmp.wav"), buf);
  }
  await api("POST", `/api/projects/${audioId}/ops`, {
    ops: [{ op: "set_audio", audio: { src: audioSrcPath, volume: 1, fadeIn: 0, fadeOut: 0 } }],
    actor: "user",
  });
  const loud = await api("POST", "/api/audio/loudness", { src: audioSrcPath });
  check("响度接口能测出 LUFS 与峰值", Number.isFinite(loud.result.lufs), JSON.stringify(loud.result).slice(0, 120));

  // 用与按钮完全相同的公式算期望值（按钮内部调的就是 shared/audio#gainForTarget）
  const wantDb = -23 - loud.result.lufs;
  const peakCapDb = -1 - loud.result.peakDb;
  const expectedGain = Math.max(0, Math.min(Math.pow(10, wantDb / 20), Math.pow(10, peakCapDb / 20), 5));

  await cdp.evaluate(`location.reload()`);
  await waitFor(cdp, `!!document.querySelector('.app')`, "页面重载", 30000);
  await cdp.evaluate(`document.querySelector('.project-switch .caret').click()`);
  await waitFor(cdp, `!!document.querySelector('.menu')`, "工程菜单打开");
  await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('.menu .menu-item')]
      .find((b) => b.textContent.includes(${JSON.stringify(audioProject.project.name)}));
    if (el) el.click();
  })()`);
  await waitFor(
    cdp,
    `document.querySelector('.project-name')?.value === ${JSON.stringify(audioProject.project.name)}`,
    "切到音频验证工程",
  );

  await waitFor(
    cdp,
    `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '配平到 -23');
      return !!b && !b.disabled;
    })()`,
    "配平按钮出现且可用（说明响度已测完）",
    25000,
  );
  const hasCompress = await cdp.evaluate(
    `[...document.querySelectorAll('button')].some((x) => x.textContent.trim() === '压平动态')`,
  );
  check("面板上有「配平到 -23」与「压平动态」两个按钮", hasCompress);

  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '配平到 -23').click()`,
  );
  let balanced = null;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const p = (await api("GET", `/api/projects/${audioId}`)).project;
    if (p.audio && Math.abs(p.audio.volume - expectedGain) < 0.03) {
      balanced = p.audio;
      break;
    }
  }
  check(
    "点击配平后音量 = 目标增益（含峰值上限）",
    !!balanced,
    `期望 ${expectedGain.toFixed(2)}（实测 LUFS ${loud.result.lufs} / 峰值 ${loud.result.peakDb}dBFS）`,
  );

  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '压平动态').click()`,
  );
  let compressed = null;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const p = (await api("GET", `/api/projects/${audioId}`)).project;
    if (p.audio?.gainCurve?.values?.length) {
      compressed = p.audio.gainCurve;
      break;
    }
  }
  check(
    "点击压平动态后写入增益曲线",
    !!compressed && compressed.values.some((v) => Math.abs(v - 1) > 0.05),
    compressed ? `${compressed.values.length} 点 @${compressed.stepMs}ms` : "没有曲线",
  );

  // 撤销必须真的把曲线删掉（不是只隐藏按钮）
  await waitFor(
    cdp,
    `[...document.querySelectorAll('button')].some((x) => x.textContent.trim() === '撤销')`,
    "撤销按钮出现",
    8000,
  );
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '撤销').click()`,
  );
  let cleared = null;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const p = (await api("GET", `/api/projects/${audioId}`)).project;
    if (!p.audio?.gainCurve) {
      cleared = p.audio;
      break;
    }
  }
  check("撤销后增益曲线被清除、音量保留", !!cleared, JSON.stringify(cleared)?.slice(0, 120));

  /* 23. 自由画布场景也能在面板里设转场（FreeformInspector 曾整栏接管右栏，转场控件没入口） */
  log("23/24 自由画布场景的转场入口");
  const ffProject = await api("POST", `/api/projects/${testId}/duplicate`, {
    name: `verify_ff_${Date.now().toString(36)}`,
  });
  extraProjectIds.push(ffProject.project.id);
  const ffId = ffProject.project.id;
  const ffSceneId = ffProject.project.scenes[0].id;
  await api("POST", `/api/projects/${ffId}/ops`, {
    actor: "verify",
    ops: [
      {
        op: "set_scene_type",
        sceneId: ffSceneId,
        type: "freeform",
        props: {
          background: { kind: "solid", colors: ["#101820"] },
          elements: [
            // 压到底部的形状：选框会盖住播放器控制条所在的那块（回归用，见下面的命中测试）
            { type: "shape", x: 50, y: 85, size: 100, fill: "#334455" },
            { type: "text", text: "自由画布", x: 50, y: 50, size: 12, fill: "#FFFFFF" },
          ],
        },
      },
      // 先清空，后面点按钮写的值才不会被「本来就有」蒙对
      { op: "update_scene", sceneId: ffSceneId, patch: { transitionIn: null } },
    ],
  });
  const ffBefore = (await api("GET", `/api/projects/${ffId}`)).project.scenes.find(
    (s) => s.id === ffSceneId,
  );
  check(
    "自由画布场景已建立且初始无入场转场",
    ffBefore?.type === "freeform" && !ffBefore?.transitionIn,
    JSON.stringify(ffBefore?.transitionIn ?? null),
  );

  await cdp.evaluate(`location.reload()`);
  await waitFor(cdp, `!!document.querySelector('.app')`, "页面重载", 30000);
  await cdp.evaluate(`document.querySelector('.project-switch .caret').click()`);
  await waitFor(cdp, `!!document.querySelector('.menu')`, "工程菜单打开");
  await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('.menu .menu-item')]
      .find((b) => b.textContent.includes(${JSON.stringify(ffProject.project.name)}));
    if (el) el.click();
  })()`);
  await waitFor(
    cdp,
    `document.querySelector('.project-name')?.value === ${JSON.stringify(ffProject.project.name)}`,
    "切换到自由画布工程",
  );
  await cdp.evaluate(`document.querySelector('[data-scene-block="${ffSceneId}"]')?.click()`);

  let ffHasUI = false;
  try {
    await waitFor(
      cdp,
      `[...document.querySelectorAll('.panel.right label')].some((x) => x.textContent.includes('入场转场'))`,
      "自由画布面板出现转场控件",
      8000,
    );
    ffHasUI = true;
  } catch {
    ffHasUI = false;
  }
  check("自由画布面板里有「入场转场」控件", ffHasUI);

  await cdp.evaluate(
    `[...document.querySelectorAll('.panel.right .seg-item')].find((x) => x.textContent.trim() === '淡入')?.click()`,
  );
  let ffAfter = null;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const s = (await api("GET", `/api/projects/${ffId}`)).project.scenes.find((x) => x.id === ffSceneId);
    if (s?.transitionIn) {
      ffAfter = s.transitionIn;
      break;
    }
  }
  check("点「淡入」后转场真的落库", ffAfter?.type === "fade", JSON.stringify(ffAfter ?? null));

  /*
   * 控制条不被选框挡住：画布底部有一个铺到底的元素，它的 `.edit-box` 是 z-index 5，
   * 而播放器 controls 容器默认 z-index auto —— 不修就是"点播放变成选中元素"。
   */
  const barHit = await cdp.evaluate(`(() => {
    const b = document.querySelector('[aria-label="Play video"], [aria-label="Pause video"]');
    if (!b) return { ok: false, why: '控制条没渲染' };
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      ok: el === b || !!el?.closest('[aria-label="Play video"], [aria-label="Pause video"]'),
      hit: String(el?.className || el?.tagName || ''),
    };
  })()`);
  check("元素选框盖住画面底部时，播放键仍点得到", barHit?.ok, JSON.stringify(barHit));

  log("24/24 删除工程不闪 loading");
  const delProject = await api("POST", `/api/projects/${testId}/duplicate`, {
    name: `verify_del_${Date.now().toString(36)}`,
  });
  extraProjectIds.push(delProject.project.id);

  await cdp.evaluate(`location.reload()`);
  await waitFor(cdp, `!!document.querySelector('.app')`, "页面重载", 30000);
  await cdp.evaluate(`document.querySelector('.project-switch .caret').click()`);
  await waitFor(cdp, `!!document.querySelector('.menu')`, "工程菜单打开");
  await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('.menu .menu-item')]
      .find((b) => b.textContent.includes(${JSON.stringify(delProject.project.name)}));
    if (el) el.click();
  })()`);
  await waitFor(
    cdp,
    `document.querySelector('.project-name')?.value === ${JSON.stringify(delProject.project.name)}`,
    "切换到待删除工程",
  );

  await cdp.evaluate(`(() => {
    window.__bootCount = 0;
    new MutationObserver(() => {
      if (document.querySelector('.boot')) window.__bootCount++;
    }).observe(document.body, { childList: true, subtree: true });
  })()`);
  await cdp.evaluate(`document.querySelector('.project-switch .caret').click()`);
  await sleep(200);
  await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('.menu .menu-item')]
      .find((b) => b.textContent.includes('删除当前工程'));
    if (el) el.click();
  })()`);
  await sleep(200);
  await cdp.evaluate(`document.querySelector('.confirm-btn.is-danger')?.click()`);
  await sleep(1500);

  const bootCount = await cdp.evaluate(`window.__bootCount`);
  check("删除工程时没有闪「正在连接本地服务…」", bootCount === 0, `boot 出现 ${bootCount} 次`);
  check("删除后自动切到其他工程", (await cdp.evaluate(`!!document.querySelector('.app')`)) === true);

  /* 25. 工作空间弹窗与目录浏览（v1.00） */
  log("25/25 工作空间与目录浏览");
  await cdp.evaluate(
    `[...document.querySelectorAll('.topbar button')].find(b=>b.textContent.trim()==='工作空间')?.click()`,
  );
  await sleep(600);
  check("工作空间弹窗能打开", (await count(cdp, ".ws-dialog")) === 1);
  check("能列出 data/public/out 三块", (await count(cdp, ".ws-dir")) === 3);
  await cdp.evaluate(
    `[...document.querySelectorAll('.ws-row button')].find(b=>b.textContent.includes('浏览'))?.click()`,
  );
  await sleep(900);
  check("点「浏览…」打开目录浏览器", (await count(cdp, ".fp-dialog")) === 1);
  const driveItems = await count(cdp, ".fp-item");
  check("目录浏览器列出了盘符", driveItems > 0, `items=${driveItems}`);
  await cdp.evaluate(`document.querySelector('.fp-item')?.click()`);
  await sleep(800);
  check(
    "点盘符能进到下一层",
    (await count(cdp, ".fp-crumbs .mini")) >= 3,
    `crumbs=${await count(cdp, ".fp-crumbs .mini")}`,
  );
  await cdp.evaluate(
    `[...document.querySelectorAll('.fp-actions button')].find(b=>b.textContent.trim()==='取消')?.click()`,
  );
  await sleep(300);
  check(
    "取消后回到工作空间弹窗",
    (await count(cdp, ".fp-dialog")) === 0 && (await count(cdp, ".ws-dialog")) === 1,
  );
  await cdp.evaluate(
    `[...document.querySelectorAll('.ws-head button')].find(b=>b.textContent.trim()==='关闭')?.click()`,
  );
  await sleep(250);
  check("工作空间弹窗能关掉", (await count(cdp, ".ws-dialog")) === 0);

  /* 收尾 */
  console.log(`\n浏览器内实测完成：${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
}

async function cleanup() {
  if (cdp) cdp.close();
  if (browser?.proc) {
    try {
      browser.proc.kill();
    } catch {
      /* ignore */
    }
  }
  if (browser?.userDataDir) {
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(browser.userDataDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  }
  for (const file of extraAssetFiles) {
    try {
      if (!file) continue;
      fs.unlinkSync(path.join(ROOT, "public", "assets", ...file.split("/")));
    } catch {
      /* 可能不在 */
    }
  }
  try {
    fs.rmSync(path.join(ROOT, "public", "assets", "verify_audio_tmp.wav"), { force: true });
  } catch {
    /* 忽略 */
  }
  for (const id of extraProjectIds) {
    try {
      await api("DELETE", `/api/projects/${id}`);
      console.log(`已删除临时工程 ${id}`);
    } catch {
      /* 上一步可能已经删过 */
    }
  }
  for (const id of extraTemplateIds) {
    try {
      await api("DELETE", `/api/templates/${id}`);
      console.log(`已删除临时模板 ${id}`);
    } catch {
      /* 忽略 */
    }
  }
  if (testId) {
    try {
      await api("DELETE", `/api/projects/${testId}`);
      console.log(`已删除临时工程 ${testId}`);
    } catch (err) {
      console.log(`临时工程删除失败（可手动清理）：${err.message}`);
      failed++;
    }
  }
  if (serverProc) {
    try {
      serverProc.kill();
    } catch {
      /* ignore */
    }
  }
}

try {
  await main();
} catch (err) {
  failed++;
  console.error(`\n验证中断：${err instanceof Error ? err.message : err}`);
} finally {
  await cleanup();
}

console.log(`\n${failed === 0 ? "VERIFY OK" : `VERIFY FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
