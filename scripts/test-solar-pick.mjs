/**
 * 真实编辑器的 3D 拾取 e2e（无头）。
 *
 * 防回归的点：
 * - 点轨道环/隐形枢轴（0.01 的 pivot 球）不能再被选中——R3F 的递归射线会把
 *   环网格的命中冒认给挂 handler 的枢轴祖先（太阳系 31 节点实测扫点 19 次全错），
 *   现在画布点选是自管的：环命中整条丢弃 + 屏幕空间宽容拾取。
 * - 小目标宽容拾取：行星在画面上只有几个像素，±10~14px 偏移也要点得中。
 * - 大纲树是兜底选择路径，必须能选中视野外的节点。
 *
 * 用法：PORT=4399 npx tsx server/index.ts 起一个实例，然后 node scripts/test-solar-pick.mjs
 * （脚本自建工程、跑完删除；API 地址在下方 BASE 改。）
 */
import { chromium } from "playwright";
import * as THREE from "three";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:4399";
const NAME = "e2e 太阳系拾取";

const j = async (path, init) => {
  const res = await fetch(BASE + path, init);
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
};
const ops = (id, body) =>
  j(`/api/projects/${id}/ops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "user", ops: body }),
  });

// ── 1. 造一个迷你太阳系：环 + 隐形枢轴 + 小行星，结构和真实项目同构 ──
const created = await j("/api/projects", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: NAME }),
});
const pid = created.project.id;
const r = await ops(pid, [
  {
    op: "add_scene",
    type: "scene3d",
    props: {
      graph: {
        camera: { position: [0, 2, 9], target: [0, 0, 0], fov: 42 },
        nodes: [
          { id: "sun", label: "太阳", geometry: { type: "sphere", radius: 1 }, material: { color: "#FFD27A", emissive: "#FF8A3D" } },
          { id: "piv_mercury", geometry: { type: "sphere", radius: 0.01 } },
          { id: "orbit_mercury", parent: "piv_mercury", geometry: { type: "dashRing", radius: 1.6 } },
          { id: "mercury", label: "水星", parent: "piv_mercury", geometry: { type: "sphere", radius: 0.05 }, transform: { position: [1.6, 0, 0] } },
          { id: "piv_earth", geometry: { type: "sphere", radius: 0.01 } },
          { id: "orbit_earth", parent: "piv_earth", geometry: { type: "dashRing", radius: 3 } },
          { id: "earth", label: "地球", parent: "piv_earth", geometry: { type: "sphere", radius: 0.2 }, transform: { position: [3, 0, 0] } },
        ],
        lights: [{ type: "point", position: [0, 0, 0], intensity: 20 }],
      },
    },
  },
]);
const sceneId = r.createdSceneIds[0];
console.log("测试工程已建:", pid, "场景:", sceneId);

const browser = await chromium.launch({ headless: true, channel: "msedge", args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 160)));

try {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  // 切到测试工程
  await page.locator('button[title="切换项目"]').click();
  await page.waitForTimeout(800);
  await page.locator('button', { hasText: NAME }).first().click();
  await page.waitForTimeout(4000);

  await page.locator(`[data-scene-id="${sceneId}"]`).click();
  await page.waitForTimeout(2500);
  await page.locator(".stage-mode button", { hasText: "3D 编辑" }).click();
  await page.waitForSelector(".vp3d canvas", { timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => document.querySelector(".vp3d-btn")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForTimeout(500);

  const rect = await page.evaluate(() => { const b = document.querySelector("canvas").getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const synth = (cx, cy) => page.evaluate(([x, y]) => {
    const c = document.querySelector("canvas");
    const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, isPrimary: true };
    c.dispatchEvent(new PointerEvent("pointerdown", o));
    c.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
    c.dispatchEvent(new MouseEvent("click", o));
  }, [cx, cy]);

  // ── 2. 精确定位行星（视口相机是确定性的：Canvas 默认 [0,2.4,9] fov45 看 0,0,0）──
  const proj = (x, y, z) => {
    const cam = new THREE.PerspectiveCamera(45, rect.w / rect.h, 0.05, 400);
    cam.position.set(0, 2.4, 9);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const v = new THREE.Vector3(x, y, z).project(cam);
    return { x: rect.x + ((v.x + 1) / 2) * rect.w, y: rect.y + ((1 - v.y) / 2) * rect.h, z: v.z };
  };
  const targets = [
    { id: "地球", pos: proj(3, 0, 0) },
    { id: "水星", pos: proj(1.6, 0, 0) },
  ];

  // ── 3. 粗网格扫点：只断言"环/枢轴一次都不许被选中" ──
  const selected = new Map();
  for (let gx = rect.x + 45; gx < rect.x + rect.w; gx += 90) {
    for (let gy = rect.y + 45; gy < rect.y + rect.h; gy += 90) {
      await synth(Math.round(gx), Math.round(gy));
      await page.waitForTimeout(80);
      const tip = await page.evaluate(() => document.querySelector(".vp3d-tip")?.textContent ?? "");
      const m = tip.match(/已选 (.+?) ·/);
      if (m) selected.set(m[1], (selected.get(m[1]) ?? 0) + 1);
    }
  }
  const ids = [...selected.keys()];
  const bad = ids.filter((id) => /^(piv_|orbit_)/.test(id));
  console.log("扫点选中:", JSON.stringify([...selected.entries()]), "| 环/枢轴误选:", bad.length);

  // ── 4. 精确点行星 + 宽容拾取（±10~14px 偏移仍应命中同一颗）──
  let directOk = 0;
  let near = 0;
  for (const t of targets) {
    await synth(Math.round(t.pos.x), Math.round(t.pos.y));
    await page.waitForTimeout(150);
    const tip = await page.evaluate(() => document.querySelector(".vp3d-tip")?.textContent ?? "");
    if (tip.includes(`已选 ${t.id}`)) directOk++;
    let hit = 0;
    for (const [dx, dy] of [[10, 0], [-10, 0], [0, 10], [0, -10], [12, 8], [-12, -8]]) {
      await synth(Math.round(t.pos.x + dx), Math.round(t.pos.y + dy));
      await page.waitForTimeout(100);
      const tip2 = await page.evaluate(() => document.querySelector(".vp3d-tip")?.textContent ?? "");
      if (tip2.includes(`已选 ${t.id}`)) hit++;
    }
    if (hit >= 2) near++;
    console.log(`${t.id}: 直接命中=${tip.includes("已选 " + t.id) ? "是" : "否"} | ±14px 宽容 ${hit}/6`);
  }

  // ── 4. 大纲树兜底：点"地球"行 → 应选中 ──
  let treeOk = false;
  const row = page.locator(".s3d-node .s3d-node-name", { hasText: /^地球/ }).first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(500);
    const tip = await page.evaluate(() => document.querySelector(".vp3d-tip")?.textContent ?? "");
    treeOk = tip.includes("已选 地球");
  }
  console.log("大纲树点选 地球:", treeOk ? "成功" : "失败");

  const ok = bad.length === 0 && directOk === targets.length && near === targets.length && treeOk && errors.length === 0;
  console.log("\n错误:", errors.length ? errors.join("\n") : "（无）");
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
  if (!ok) process.exitCode = 1;
} finally {
  await browser.close();
  await fetch(`${BASE}/api/projects/${pid}`, { method: "DELETE" });
  console.log("测试工程已删除");
}
