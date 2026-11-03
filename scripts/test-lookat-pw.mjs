/**
 * 相机「看向锁定」+ 运动辅助线的 e2e（无头）。
 *
 * 用法：先起 vite（npx vite --port 5177），然后 node scripts/test-lookat-pw.mjs。
 * 不需要后端：harness（web/vp-test.html）把 apply 劫持成"记录 op + 只应用 anim 相关 op"。
 *
 * 验的是四条：
 * 1. 点「锁定」写出的 op 是 set_graph_camera，且段上带 lookAt（不是只改 target 坐标）；
 * 2. 锁定后视口/面板都能读到"正锁定谁"（两处读的是同一个 dslCamera 结果）；
 * 3. 点「退出锁定」把 lookAt 拿掉，并且 **from 里不留 target**（否则退出会甩镜）；
 * 4. 轨迹切到"全部"不报错（NodeTrack 真的渲染了，而不是被条件挡住）。
 */
import { chromium } from "playwright";
import fs from "node:fs";

const OUT = ".tmp-lookat";
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

const lastOp = () => page.evaluate(() => window.__opsLog.at(-1)?.[0] ?? null);

/* ── 切到相机页 ── */
const tabHit = await page.locator('.s3d-tabs button:has-text("相机")').count();
if (!tabHit) {
  const tabs = await page.locator(".s3d-tabs").innerText().catch(() => "(找不到 .s3d-tabs)");
  console.log("页签文字:", JSON.stringify(tabs));
}
await page.locator('.s3d-tabs button:has-text("相机")').first().click();
await page.waitForTimeout(400);
const hasLockSection = await page.locator('text=看向锁定').count();
ok("相机页出现「看向锁定」", hasLockSection > 0);

/* ── 锁定当前帧 ── */
const lockBtn = page.locator('button:has-text("锁定")').first();
const lockBtnText = await lockBtn.innerText().catch(() => "");
console.log("  锁定按钮:", JSON.stringify(lockBtnText));
await lockBtn.click();
await page.waitForTimeout(500);

const op1 = await lastOp();
console.log("  锁定 op:", JSON.stringify(op1)?.slice(0, 400));
ok("锁定写出 set_graph_camera", op1?.op === "set_graph_camera");
ok("段上带 lookAt=a", Array.isArray(op1?.camera?.anim) && op1.camera.anim.some((a) => a.lookAt === "a"));

await page.screenshot({ path: `${OUT}/1-locked.png` });

/** 取消选中再截一张：Gizmo 的三根轴线会盖住看向虚线，看不清锁定可视化本身 */
await page.evaluate(() => window.__useDoc.getState().setSelection([]));
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/1b-locked-no-gizmo.png` });

/* ── 两处状态一致：面板警告 + 视口 tip ── */
const warn = await page.locator(".s3d-warn").allInnerTexts();
const lockWarn = warn.find((t) => t.includes("正锁定"));
ok("面板显示「正锁定」", Boolean(lockWarn), JSON.stringify(warn));

/** 锁定是场景级状态：不选相机也要能看到（选了物体时最容易困惑"怎么转都不动"） */
const tipWhenNode = await page.evaluate(() => document.querySelector(".vp3d-tip")?.textContent ?? "");
ok("选中物体时 tip 也提示锁定", tipWhenNode.includes("镜头锁定"), tipWhenNode.slice(0, 160));

/** 选中相机：旋转手柄应被禁用（避免"拖了没反应"） */
await page.evaluate(() => window.__useDoc.getState().setSelection(["cam"]));
await page.waitForTimeout(450);
const tip = await page.evaluate(() => document.querySelector(".vp3d-tip")?.textContent ?? "");
ok("视口 tip 显示锁定", tip.includes("锁定"), tip.slice(0, 160));

const cam = await page.evaluate(() => {
  const st = window.__useDoc.getState();
  const g = st.project.scenes[0].props.graph;
  return { anim: g.camera?.anim, nodeA: g.nodes.find((n) => n.id === "a") };
});
ok("store 里相机段确实带 lookAt", Array.isArray(cam.anim) && cam.anim.some((a) => a.lookAt === "a"));

const rotateDisabled = await page.locator('.vp3d-hud .seg-item:has-text("旋转")').isDisabled();
ok("锁定中旋转模式被禁用", rotateDisabled === true);

/* ── 退出锁定 ── */
const exitBtn = page.locator('button:has-text("退出锁定")').first();
await exitBtn.click();
await page.waitForTimeout(500);
const op2 = await lastOp();
console.log("  退出 op:", JSON.stringify(op2)?.slice(0, 400));
const anim2 = op2?.camera?.anim ?? [];
ok("退出后没有段带 lookAt", anim2.every((a) => !a.lookAt));
ok(
  "退出段的 from 不带 target（否则会甩镜）",
  anim2.every((a) => !a.from || (a.from.targetX === undefined && a.from.targetY === undefined && a.from.targetZ === undefined)),
  JSON.stringify(anim2),
);

await page.screenshot({ path: `${OUT}/2-exited.png` });

/* ── 轨迹切"全部"：NodeTrack 渲染不报错 ── */
const allBtn = page.locator('.vp3d-hud .seg-item:has-text("全部轨迹")').first();
if (await allBtn.count()) {
  await allBtn.click();
  await page.waitForTimeout(900);
  ok("切到全部轨迹后没有新报错", errors.length === 0, errors.join("\n    "));
} else {
  ok("HUD 有「全部轨迹」开关", false);
}
await page.screenshot({ path: `${OUT}/3-alltracks.png` });

/* ── 段中间锁定：注入一段带缓动的运镜，在第 30 帧锁定 ── */
await page.evaluate(() => {
  const st = window.__useDoc.getState();
  const scenes = st.project.scenes.map((s) =>
    s.id !== "scene_vp"
      ? s
      : {
          ...s,
          props: {
            ...s.props,
            graph: {
              ...s.props.graph,
              camera: {
                ...s.props.graph.camera,
                anim: [
                  {
                    at: [0, 60],
                    from: { posX: 0, posY: 1.6, posZ: 7, targetX: 0, targetY: 0, targetZ: 0, fov: 42 },
                    to: { posX: 6, posY: 2, posZ: 9, targetX: 0, targetY: 0, targetZ: 0, fov: 42 },
                    ease: "easeInOut",
                  },
                ],
              },
            },
          },
        },
  );
  window.__useDoc.setState({ project: { ...st.project, scenes } });
  window.__frameBus.set(30);
});
await page.waitForTimeout(700);
const seeked = await page.evaluate(() => document.querySelector(".vp3d-frame")?.textContent ?? "");
ok("播放头跳到第 30 帧", seeked.trim().startsWith("30"), seeked);

await page.locator('button:has-text("锁定")').first().click();
await page.waitForTimeout(700);
const op3 = await lastOp();
const anim3 = op3?.camera?.anim ?? [];
const lockSegs = anim3.filter((a) => a.lookAt);
const covered = lockSegs.reduce((n, a) => n + (a.at[1] - a.at[0]), 0);
console.log("  段中间锁定:", JSON.stringify(anim3.map((a) => [a.at, a.ease, a.lookAt ?? null])));
ok("段中间锁定后覆盖到原段尾（30→60）", covered >= 30, `覆盖 ${covered} 帧，${lockSegs.length} 段`);
ok("锁定范围从 30 帧开始", lockSegs.length > 0 && lockSegs.every((a) => a.at[0] >= 30));

await page.screenshot({ path: `${OUT}/4-lock-mid.png` });

/* ── 锁定中拖相机：锁定不能被抹掉（用户报的问题） ── */
/** 先把视角摆到成片相机斜后方（HUD「看相机」）并选中它——否则相机可能在画面外 */
await page.locator('.vp3d-hud button:has-text("看相机")').first().click();
await page.waitForTimeout(600);

/**
 * 用页面里的 dslCamera 求"当前帧的真实机位"，再用视口相机投影成屏幕比例。
 * 不能硬编码初始机位：锁定测试在 f30，运镜已经走到中途，点旧坐标会点空。
 */
const proj = await page.evaluate(() => {
  const st = window.__useDoc.getState();
  const scene = st.project.scenes[0];
  const cam = window.__vpProbe?.camera;
  if (!cam || !window.__dslCamera) return null;
  const frame = window.__frameBus.get();
  const c = window.__dslCamera(scene.props.graph, frame / 30, 30);
  const p = cam.position.clone().set(c.worldPos[0], c.worldPos[1], c.worldPos[2]).project(cam);
  return { fx: (p.x + 1) / 2, fy: (1 - p.y) / 2, frame, worldPos: c.worldPos };
});
console.log("  相机实体:", JSON.stringify(proj));
ok("拿到相机实体的屏幕坐标", Boolean(proj) && proj.fx > 0 && proj.fx < 1 && proj.fy > 0 && proj.fy < 1);

const dragHandle = (fx, fy, off, baseLen) =>
  page.evaluate(
    ([fx_, fy_, off_, baseLen_]) => {
      const el = document.querySelector("canvas");
      el.setPointerCapture = () => {};
      el.releasePointerCapture = () => {};
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width * fx_;
      const cy = r.y + r.height * fy_;
      const mk = (x, y, type, buttons) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerId: 1,
          pointerType: "mouse",
          button: type === "pointermove" ? -1 : 0,
          buttons,
          isPrimary: true,
        });
      const sx = cx + off_;
      for (let d = -10; d <= 10; d += 4) el.dispatchEvent(mk(sx + d, cy + d * 0.4, "pointermove", 0));
      el.dispatchEvent(mk(sx, cy, "pointerdown", 1));
      for (let i = 1; i <= 6; i++) el.dispatchEvent(mk(sx + i * 12, cy, "pointermove", 1));
      el.dispatchEvent(mk(sx + 72, cy, "pointerup", 0));
      const log = window.__opsLog;
      if (log.length <= baseLen_) return null;
      const last = log[log.length - 1];
      return last && last[0]?.op === "set_graph_camera" ? last[0] : null;
    },
    [fx, fy, off, baseLen],
  );
let dragged = null;
let baseLen = 0;
if (proj) {
  /** 必须拿"拖动后**新增**的 op"：只取最后一条会读到上一次锁定留下的那条，测了个寂寞 */
  baseLen = await page.evaluate(() => window.__opsLog.length);
  for (const off of [0, 6, 12, 20, 28, 36, 44, 52, 60]) {
    dragged = await dragHandle(proj.fx, proj.fy, off, baseLen);
    if (dragged) break;
    // 手柄可能被点掉选中，重选一次再试
    await page.evaluate(() => window.__useDoc.getState().setSelection(["cam"]));
    await page.waitForTimeout(220);
  }
}
const endLen = await page.evaluate(() => window.__opsLog.length);
ok("拖动相机写出 set_graph_camera", Boolean(dragged), `op 数 ${baseLen}→${endLen}`);

const dragAnim = dragged?.camera?.anim ?? [];
console.log("  拖动后:", JSON.stringify(dragAnim.map((a) => [a.at, a.lookAt ?? null]))?.slice(0, 400));
ok(
  "拖完锁定还在（关键帧继承了 lookAt）",
  dragAnim.some((a) => a.lookAt === "a"),
  "拖动把 lookAt 抹掉了 —— commitCamera 没继承约束",
);
ok(
  "拖完锁定仍从拖动帧开始（不是晚 5 帧）",
  dragAnim.filter((a) => a.lookAt).length > 0 &&
    Math.min(...dragAnim.filter((a) => a.lookAt).map((a) => a.at[0])) === 30,
  `锁定段起点：${JSON.stringify(dragAnim.filter((a) => a.lookAt).map((a) => a.at))}`,
);

await page.screenshot({ path: `${OUT}/5-drag-locked.png` });

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (errors.length) console.log("页面错误:\n  " + errors.join("\n  "));
await browser.close();
process.exit(fail ? 1 : 0);
