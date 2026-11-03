/**
 * 轨迹曲线（贝塞尔）的 e2e：面板「平滑 / 拉直」+ 视口手柄拖拽。
 *
 * 用法：先起 vite（npx vite --port 5177），再 node scripts/test-path-pw.mjs。
 * 不需要后端：harness 劫持 apply，只把 anim 相关 op 应用回 store（能读—改—写）。
 */
import { chromium } from "playwright";
import fs from "node:fs";

const OUT = ".tmp-path";
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
const opLen = () => page.evaluate(() => window.__opsLog.length);

/* ── 给 a 注入两段位移动画（3 个关键帧，平滑才有非零切线） ── */
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
              nodes: s.props.graph.nodes.map((n) =>
                n.id === "a"
                  ? {
                      ...n,
                      anim: [
                        { at: [0, 30], from: { posX: -1.7, posY: 0, posZ: 0 }, to: { posX: 0, posY: 0, posZ: 0.6 }, ease: "linear" },
                        { at: [30, 60], from: { posX: 0, posY: 0, posZ: 0.6 }, to: { posX: 1.7, posY: 0, posZ: 0 }, ease: "linear" },
                      ],
                    }
                  : n,
              ),
            },
          },
        },
  );
  window.__useDoc.setState({ project: { ...st.project, scenes }, selection: ["g:a"] });
});
await page.waitForTimeout(700);

/* ── 面板：平滑 ── */
const smoothBtn = page.locator('[data-scope="node"][data-kind="all"] button:has-text("平滑")');
ok("面板出现「平滑」按钮", (await smoothBtn.count()) > 0);

let before = await opLen();
await smoothBtn.click();
await page.waitForTimeout(600);
const opSmooth = await lastOp();
ok("平滑写出 update_graph_node", opSmooth?.op === "update_graph_node" && (await opLen()) > before, JSON.stringify(opSmooth)?.slice(0, 160));
const smoothAnim = opSmooth?.patch?.anim ?? [];
const nz = (v) => Array.isArray(v) && v.some((x) => Math.abs(x) > 1e-4);
ok(
  "两段都带上 curve，且切线为非零（真的弯了）",
  smoothAnim.length === 2 && smoothAnim.every((a) => a.curve) && smoothAnim.some((a) => nz(a.curve.out) || nz(a.curve.in)),
  JSON.stringify(smoothAnim.map((a) => a.curve)),
);
ok(
  "首段出手柄为 0、末段入手柄为 0（端点没有邻居，退化为直线起手/收尾）",
  !nz(smoothAnim[0]?.curve?.out) && !nz(smoothAnim[1]?.curve?.in),
  JSON.stringify(smoothAnim.map((a) => [a.curve?.out, a.curve?.in])),
);
/** 相邻段在 30 帧处相切：前段 in 与后段 out 必须同一条切线 */
const tanOf = (a) => {
  const d = [a.to.posX - a.from.posX, a.to.posY - a.from.posY, a.to.posZ - a.from.posZ];
  return [d[0] - (a.curve.in?.[0] ?? 0), d[1] - (a.curve.in?.[1] ?? 0), d[2] - (a.curve.in?.[2] ?? 0)];
};
const tanOut = (a) => {
  const d = [a.to.posX - a.from.posX, a.to.posY - a.from.posY, a.to.posZ - a.from.posZ];
  return [d[0] + (a.curve.out?.[0] ?? 0), d[1] + (a.curve.out?.[1] ?? 0), d[2] + (a.curve.out?.[2] ?? 0)];
};
if (smoothAnim.length === 2) {
  const m1 = tanOf(smoothAnim[0]);
  const m0 = tanOut(smoothAnim[1]);
  ok("接缝处切线连续（C1）", m1.every((v, i) => Math.abs(v - m0[i]) < 1e-3), `${JSON.stringify(m1)} vs ${JSON.stringify(m0)}`);
}

await page.screenshot({ path: `${OUT}/1-smoothed.png` });

/* ── 上一帧跳回 0，看轨迹是不是弯的（截图人工核对） ── */
await page.evaluate(() => window.__frameBus.set(15));
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/2-curve-at-15.png` });

/* ── 视口：点关键帧球 → 手柄 → 拖动 ── */
/** 世界坐标 → 屏幕比例（用视口相机投影，和鼠标事件同一套坐标系） */
const project = (world) =>
  page.evaluate((w) => {
    const cam = window.__vpProbe?.camera;
    if (!cam) return null;
    const p = cam.position.clone().set(w[0], w[1], w[2]).project(cam);
    return [(p.x + 1) / 2, (1 - p.y) / 2];
  }, world);

/** 平滑之后，0 帧那个关键帧球的屏幕位置（节点在 0 帧的世界坐标就是 transform.position） */
const ballFx = await project([-1.7, 0, 0]);
ok("关键帧球在视口内", ballFx && ballFx[0] > 0 && ballFx[0] < 1 && ballFx[1] > 0 && ballFx[1] < 1, JSON.stringify(ballFx));

const synthClick = (fx, fy) =>
  page.evaluate(([fx_, fy_]) => {
    const el = document.querySelector("canvas");
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width * fx_;
    const cy = r.y + r.height * fy_;
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...opts }));
  }, [fx, fy]);

if (ballFx) {
  /**
   * 直接点球（保持选中）：轨迹只在"选中/全部"模式下画，取消选中球就没了。
   * 球会和 TransformControls 的中心手柄重叠，TC 会抢到 pointerdown —— 这是真实交互的一部分，
   * 靠"位移为 0 就不写库"兜底，所以点一下不会凭空多出关键帧。
   */
  await synthClick(ballFx[0], ballFx[1]);
  await page.waitForTimeout(600);
  const selectedNow = await page.evaluate(() => window.__useDoc.getState().selection);
  ok("点轨迹球后仍是该物体被选中", selectedNow.includes("g:a"), JSON.stringify(selectedNow));

  /** 手柄是 canvas 里的 3D 对象，DOM 查不到：直接遍历场景图看有没有挂上（dev 有 __vpState 探针） */
  const handleSides = await page.evaluate(() => {
    const scene = window.__vpState?.scene;
    if (!scene) return null;
    const out = [];
    scene.traverse((o) => {
      const side = o.userData?.side;
      if (side === "out" || side === "in") out.push(side);
    });
    return out;
  });
  console.log("  手柄:", JSON.stringify(handleSides));
  ok("点球后出现贝塞尔手柄", Array.isArray(handleSides) && handleSides.length > 0, JSON.stringify(handleSides));
  /**
   * 这里点的是**首帧**（0 帧）。首帧只有「出发段」，以前只画得出一个出手柄，
   * 用户报过"点平滑后只有一个手柄"——所以首/末帧必须把同一段的两个控制点都补出来。
   */
  ok(
    "首帧也有两个手柄（补上同一段的另一个控制点）",
    Array.isArray(handleSides) && handleSides.length === 2 && handleSides.includes("out") && handleSides.includes("in"),
    JSON.stringify(handleSides),
  );

  /** 手柄到端点的连线（用户报过"只看到两个球、没有线"） */
  const lineInfo = await page.evaluate(() => {
    const scene = window.__vpState?.scene;
    const out = [];
    scene?.traverse((o) => {
      if (o.isLine && o.renderOrder === 992) {
        out.push({
          visible: o.visible,
          count: o.geometry?.attributes?.position?.count ?? 0,
          culled: o.frustumCulled,
        });
      }
    });
    return out;
  });
  const visibleLines = lineInfo.filter((l) => l.visible);
  ok(
    "手柄有线（可见的每条都有两个端点；没有手柄的那一侧隐藏是正常的）",
    visibleLines.length >= 1 && visibleLines.every((l) => l.count === 2),
    JSON.stringify(lineInfo),
  );
  ok(
    "连线关闭视锥剔除（拖动后不会凭空消失）",
    lineInfo.length >= 1 && lineInfo.every((l) => l.culled === false),
    JSON.stringify(lineInfo),
  );
  await page.screenshot({ path: `${OUT}/3-handles.png` });

  /* ── 拖出手柄：应该写出 curve.out ── */
  const handlePos = await page.evaluate(() => {
    const scene = window.__vpState?.scene;
    let pos = null;
    scene?.traverse((o) => {
      if (o.userData?.side === "out") pos = [o.position.x, o.position.y, o.position.z];
    });
    return pos;
  });
  const handleFx = handlePos ? await project(handlePos) : null;
  console.log("  手柄世界位置:", JSON.stringify(handlePos), "屏幕:", JSON.stringify(handleFx));

  if (handleFx) {
    const beforeDrag = await opLen();
    /** 拖手柄时把视角一起转掉是真实被报过的 bug：这里记下相机位置，拖完必须一模一样 */
    const camBefore = await page.evaluate(() => {
      const c = window.__vpProbe?.camera;
      return c ? [c.position.x, c.position.y, c.position.z] : null;
    });
    await page.evaluate(
      ([hx, hy]) => {
        const el = document.querySelector("canvas");
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width * hx;
        const cy = r.y + r.height * hy;
        const mk = (type, x, y, buttons) =>
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
        el.dispatchEvent(mk("pointerdown", cx, cy, 1));
        // 往右拖 200px：这个视角下屏幕右方 ≈ 世界 +X，方向判断比上下更稳
        for (let i = 1; i <= 8; i++) window.dispatchEvent(mk("pointermove", cx + (200 * i) / 8, cy, 1));
        window.dispatchEvent(mk("pointerup", cx + 200, cy, 0));
      },
      handleFx,
    );
    await page.waitForTimeout(700);
    const opDrag = await lastOp();
    const afterDrag = await opLen();
    ok("拖手柄写出新的 op", afterDrag > beforeDrag, `op 数 ${beforeDrag}→${afterDrag}`);
    const seg = opDrag?.patch?.anim?.[0];
    ok(
      "curve.out 被写出来且非零",
      Boolean(seg?.curve?.out) && seg.curve.out.some((v) => Math.abs(v) > 1e-3),
      JSON.stringify(seatCurveOf(opDrag)),
    );
    ok("curve 朝屏幕右方（世界 +X）", (seg?.curve?.out?.[0] ?? 0) > 0.3, JSON.stringify(seg?.curve?.out));

    const camAfter = await page.evaluate(() => {
      const c = window.__vpProbe?.camera;
      return c ? [c.position.x, c.position.y, c.position.z] : null;
    });
    const camMoved =
      camBefore && camAfter
        ? Math.hypot(camAfter[0] - camBefore[0], camAfter[1] - camBefore[1], camAfter[2] - camBefore[2])
        : 0;
    ok("拖手柄不会把视角一起转", camMoved < 1e-3, `视角位移 ${camMoved.toFixed(4)}`);

    /** 手柄颜色必须和轨迹(accent)/锁定(primary)/选中框(#C6F24E)都拉开 */
    const handleColor = await page.evaluate(() => {
      const scene = window.__vpState?.scene;
      let hex = null;
      scene?.traverse((o) => {
        if (o.isGroup && o.userData?.side) {
          const m = o.children.find((c) => c.isMesh);
          if (m?.material?.color) hex = m.material.color.getHexString();
        }
      });
      return hex;
    });
    ok("手柄用专用品红（不和选中框/Gizmo 三轴撞色）", handleColor === "ff4fa3", String(handleColor));
  }
}

/** 从 op 里摘 curve 出来打日志（避免整条 anim 刷屏） */
function seatCurveOf(op) {
  return (op?.patch?.anim ?? []).map((a) => a?.curve ?? null);
}

/* ── 中间关键帧：两个手柄相切联动，Shift 只动一侧 ── */
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
              nodes: s.props.graph.nodes.map((n) =>
                n.id === "a"
                  ? {
                      ...n,
                      anim: [
                        {
                          at: [0, 30],
                          from: { posX: -1.7, posY: 0, posZ: 0 },
                          to: { posX: 0, posY: 0, posZ: 0.6 },
                          ease: "linear",
                          curve: { out: [0, 0, 0], in: [0, 0.9, 0] },
                        },
                        {
                          at: [30, 60],
                          from: { posX: 0, posY: 0, posZ: 0.6 },
                          to: { posX: 1.7, posY: 0, posZ: 0 },
                          ease: "linear",
                          curve: { out: [0, 0.9, 0], in: [0, 0, 0] },
                        },
                      ],
                    }
                  : n,
              ),
            },
          },
        },
  );
  window.__useDoc.setState({ project: { ...st.project, scenes }, selection: ["g:a"] });
});
await page.waitForTimeout(700);

const midFx = await project([0, 0, 0.6]);
ok("中间关键帧球算得出屏幕位置", midFx && midFx[0] > 0 && midFx[0] < 1 && midFx[1] > 0 && midFx[1] < 1, JSON.stringify(midFx));

if (midFx) {
  await synthClick(midFx[0], midFx[1]);
  await page.waitForTimeout(650);

  const midHandles = await page.evaluate(() => {
    const scene = window.__vpState?.scene;
    const list = [];
    scene?.traverse((o) => {
      const side = o.userData?.side;
      if (side === "out" || side === "in") {
        list.push({ side, p: [o.position.x, o.position.y, o.position.z], a: o.userData.anchor });
      }
    });
    return list;
  });
  ok("中间帧有两个手柄", midHandles.length === 2, JSON.stringify(midHandles));
  const ho = midHandles.find((h) => h.side === "out");
  const hi = midHandles.find((h) => h.side === "in");
  ok(
    "两个手柄挂在同一个锚点上（同一顶点两侧，才谈得上相切）",
    Boolean(ho && hi) && Math.hypot(...ho.a.map((v, i) => v - hi.a[i])) < 1e-4,
    JSON.stringify([ho?.a, hi?.a]),
  );

  if (ho && hi) {
    const outFx = await project(ho.p);
    const beforeMate = await opLen();
    /** 拖出侧 160px 右 + 60px 上；拖动中读两球位置，松手前就能判断是否联动 */
    const live = await page.evaluate(
      ([hx, hy]) => {
        const el = document.querySelector("canvas");
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width * hx;
        const cy = r.y + r.height * hy;
        const mk = (type, x, y, buttons, shiftKey = false) =>
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
            shiftKey,
          });
        const read = () => {
          const scene = window.__vpState?.scene;
          const out = {};
          scene?.traverse((o) => {
            const side = o.userData?.side;
            if (side === "out" || side === "in") {
              out[side] = { p: [o.position.x, o.position.y, o.position.z], a: o.userData.anchor };
            }
          });
          return out;
        };
        el.dispatchEvent(mk("pointerdown", cx, cy, 1));
        for (let i = 1; i <= 8; i++) {
          window.dispatchEvent(mk("pointermove", cx + (160 * i) / 8, cy - (60 * i) / 8, 1));
        }
        const during = read();
        window.dispatchEvent(mk("pointerup", cx + 160, cy - 60, 0));
        return during;
      },
      outFx,
    );
    const dOut = live.out.p;
    const dIn = live.in.p;
    const anchor = live.out.a;
    const v1 = [dOut[0] - anchor[0], dOut[1] - anchor[1], dOut[2] - anchor[2]];
    const v2 = [dIn[0] - anchor[0], dIn[1] - anchor[1], dIn[2] - anchor[2]];
    const n1 = Math.hypot(...v1);
    const n2 = Math.hypot(...v2);
    const cos = n1 > 1e-6 && n2 > 1e-6 ? (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (n1 * n2) : 99;
    ok("拖动时对侧手柄跟着动（相切联动）", n2 > 1e-6 && Math.abs(cos + 1) < 1e-3, `cos=${cos.toFixed(4)} n1=${n1.toFixed(3)} n2=${n2.toFixed(3)}`);
    ok("拖动中两球关于锚点反向共线", Math.abs(cos + 1) < 1e-3, `cos=${cos.toFixed(4)}`);

    await page.waitForTimeout(800);
    const opPair = await lastOp();
    const pairAnim = opPair?.patch?.anim ?? [];
    ok("联动一次写回两段（不是各写一半的两笔）", (await opLen()) === beforeMate + 1 && pairAnim.length === 2, `op 数 ${beforeMate}→${await opLen()}`);
    /** 接缝处 C1：前段终切 (K−prev)−inn 与后段起切 (next−K)+out 必须同向 */
    const tanIn = (a) => [
      a.to.posX - a.from.posX - (a.curve?.in?.[0] ?? 0),
      a.to.posY - a.from.posY - (a.curve?.in?.[1] ?? 0),
      a.to.posZ - a.from.posZ - (a.curve?.in?.[2] ?? 0),
    ];
    const tanOut = (a) => [
      a.to.posX - a.from.posX + (a.curve?.out?.[0] ?? 0),
      a.to.posY - a.from.posY + (a.curve?.out?.[1] ?? 0),
      a.to.posZ - a.from.posZ + (a.curve?.out?.[2] ?? 0),
    ];
    if (pairAnim.length === 2) {
      const m1 = tanIn(pairAnim[0]);
      const m0 = tanOut(pairAnim[1]);
      const cos2 = (m1[0] * m0[0] + m1[1] * m0[1] + m1[2] * m0[2]) / (Math.hypot(...m1) * Math.hypot(...m0));
      ok("写回后接缝切线同向（曲线过关键帧不打折）", cos2 > 0.999, `cos=${cos2.toFixed(4)} ${JSON.stringify([m1, m0])}`);
    }

    /** ── Shift：只动被拖的一侧，另一段原样不动 ── */
    const animBeforeShift = await page.evaluate(
      () =>
        window.__useDoc.getState().project.scenes.find((s) => s.id === "scene_vp").props.graph.nodes.find((n) => n.id === "a").anim,
    );
    const outNow = await page.evaluate(() => {
      const scene = window.__vpState?.scene;
      let p = null;
      scene?.traverse((o) => {
        if (o.userData?.side === "out") p = [o.position.x, o.position.y, o.position.z];
      });
      return p;
    });
    const outFx2 = outNow ? await project(outNow) : null;
    if (outFx2) {
      await page.evaluate(
        ([hx, hy]) => {
          const el = document.querySelector("canvas");
          const r = el.getBoundingClientRect();
          const cx = r.x + r.width * hx;
          const cy = r.y + r.height * hy;
          const mk = (type, x, y, buttons, shiftKey = false) =>
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
              shiftKey,
            });
          el.dispatchEvent(mk("pointerdown", cx, cy, 1, true));
          for (let i = 1; i <= 8; i++) window.dispatchEvent(mk("pointermove", cx + (120 * i) / 8, cy - (110 * i) / 8, 1, true));
          window.dispatchEvent(mk("pointerup", cx + 120, cy - 110, 0, true));
        },
        outFx2,
      );
      await page.waitForTimeout(800);
      const animAfterShift = await page.evaluate(
        () =>
          window.__useDoc.getState().project.scenes.find((s) => s.id === "scene_vp").props.graph.nodes.find((n) => n.id === "a").anim,
      );
      ok(
        "Shift 拖动只改被拖的那一段，另一段原样不动",
        JSON.stringify(animBeforeShift[0]?.curve) === JSON.stringify(animAfterShift[0]?.curve),
        `前段 curve ${JSON.stringify(animBeforeShift[0]?.curve)} → ${JSON.stringify(animAfterShift[0]?.curve)}`,
      );
      ok(
        "Shift 拖完被拖的那一段确实变了",
        JSON.stringify(animBeforeShift[1]?.curve) !== JSON.stringify(animAfterShift[1]?.curve),
        JSON.stringify(animAfterShift[1]?.curve),
      );
    }
    await page.screenshot({ path: `${OUT}/6-mid-mate.png` });
  }
}

/* ── 面板「此点」平滑 / 拉直：只改这一帧两侧，其它关键帧一个字不动 ── */
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
              nodes: s.props.graph.nodes.map((n) =>
                n.id === "a"
                  ? {
                      ...n,
                      anim: [
                        {
                          at: [0, 30],
                          from: { posX: -1.7, posY: 0, posZ: 0 },
                          to: { posX: 0, posY: 0, posZ: 0.6 },
                          ease: "linear",
                          curve: { out: [0, 0, 0], in: [0, 0.4, 0] },
                        },
                        {
                          at: [30, 60],
                          from: { posX: 0, posY: 0, posZ: 0.6 },
                          to: { posX: 1.7, posY: 0, posZ: 0 },
                          ease: "linear",
                          curve: { out: [0, 0.4, 0], in: [0, 0, 0] },
                        },
                        {
                          at: [60, 90],
                          from: { posX: 1.7, posY: 0, posZ: 0 },
                          to: { posX: 1.7, posY: 0, posZ: 1.6 },
                          ease: "linear",
                          curve: { out: [0, 0, 0], in: [0, 0, 0] },
                        },
                      ],
                    }
                  : n,
              ),
            },
          },
        },
  );
  window.__useDoc.setState({ project: { ...st.project, scenes }, selection: ["g:a"] });
});
await page.waitForTimeout(700);

const readNodeAnim = () =>
  page.evaluate(
    () =>
      window.__useDoc.getState().project.scenes.find((s) => s.id === "scene_vp").props.graph.nodes.find((n) => n.id === "a").anim,
  );

const kNested = [1.7, 0, 0];
const k60 = await project(kNested);
ok("60 帧的关键帧球算得出屏幕位置", k60 && k60[0] > 0 && k60[0] < 1 && k60[1] > 0 && k60[1] < 1, JSON.stringify(k60));

if (k60) {
  await synthClick(k60[0], k60[1]);
  await page.waitForTimeout(650);
  const pointSmooth = page.locator('[data-scope="node"][data-kind="point"] button:has-text("平滑")');
  ok("停在关键帧上时「此点平滑」可用", !(await pointSmooth.isDisabled()));

  const animBefore = await readNodeAnim();
  const beforePoint = await opLen();
  await pointSmooth.click();
  await page.waitForTimeout(700);
  const animAfter = await readNodeAnim();

  ok("此点平滑写出 op", (await opLen()) > beforePoint, `op 数 ${beforePoint}→${await opLen()}`);
  ok(
    "与这个点无关的那一段（第 1 段）完全没变",
    JSON.stringify(animAfter[0]?.curve) === JSON.stringify(animBefore[0]?.curve),
    `${JSON.stringify(animBefore[0]?.curve)} → ${JSON.stringify(animAfter[0]?.curve)}`,
  );
  ok(
    "前一段的入侧被平滑（非零）",
    (animAfter[1]?.curve?.in ?? []).some((v) => Math.abs(v) > 1e-3),
    JSON.stringify(animAfter[1]?.curve),
  );
  ok(
    "后一段的出侧被平滑（非零）",
    (animAfter[2]?.curve?.out ?? []).some((v) => Math.abs(v) > 1e-3),
    JSON.stringify(animAfter[2]?.curve),
  );
  /** 该点处相切：前段终切 与 后段起切 同向 */
  {
    const a1 = animAfter[1];
    const a2 = animAfter[2];
    const m1 = [
      a1.to.posX - a1.from.posX - (a1.curve?.in?.[0] ?? 0),
      a1.to.posY - a1.from.posY - (a1.curve?.in?.[1] ?? 0),
      a1.to.posZ - a1.from.posZ - (a1.curve?.in?.[2] ?? 0),
    ];
    const m0 = [
      a2.to.posX - a2.from.posX + (a2.curve?.out?.[0] ?? 0),
      a2.to.posY - a2.from.posY + (a2.curve?.out?.[1] ?? 0),
      a2.to.posZ - a2.from.posZ + (a2.curve?.out?.[2] ?? 0),
    ];
    const cos = (m1[0] * m0[0] + m1[1] * m0[1] + m1[2] * m0[2]) / (Math.hypot(...m1) * Math.hypot(...m0));
    ok("此点两侧相切（C1）", cos > 0.999, `cos=${cos.toFixed(4)}`);
  }

  const pointStraight = page.locator('[data-scope="node"][data-kind="point"] button:has-text("拉直")');
  await pointStraight.click();
  await page.waitForTimeout(700);
  const animStraight = await readNodeAnim();
  ok(
    "拉直此点后，无关的第 1 段仍然没变",
    JSON.stringify(animStraight[0]?.curve) === JSON.stringify(animBefore[0]?.curve),
    JSON.stringify(animStraight[0]?.curve),
  );
  ok(
    "拉直此点后，前段入侧 / 后段出侧都归零",
    !(animStraight[1]?.curve?.in ?? []).some((v) => Math.abs(v) > 1e-3) &&
      !(animStraight[2]?.curve?.out ?? []).some((v) => Math.abs(v) > 1e-3),
    JSON.stringify([animStraight[1]?.curve, animStraight[2]?.curve]),
  );
  await page.screenshot({ path: `${OUT}/7-point-smooth.png` });
}

/* ── 相机轨迹的曲线：点相机关键帧球 → 手柄 → 拖 ── */
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
                position: [0, 1.6, 7],
                target: [0, 0, 0],
                anim: [
                  { at: [0, 30], from: { posX: 0, posY: 1.6, posZ: 7, targetX: 0, targetY: 0, targetZ: 0, fov: 42 }, to: { posX: 3, posY: 1.8, posZ: 8, targetX: 0, targetY: 0, targetZ: 0, fov: 42 }, ease: "linear" },
                  { at: [30, 60], from: { posX: 3, posY: 1.8, posZ: 8, targetX: 0, targetY: 0, targetZ: 0, fov: 42 }, to: { posX: 6, posY: 1.6, posZ: 7, targetX: 0, targetY: 0, targetZ: 0, fov: 42 }, ease: "linear" },
                ],
              },
            },
          },
        },
  );
  window.__useDoc.setState({ project: { ...st.project, scenes }, selection: ["g:a"] });
  window.__frameBus.set(0);
});
await page.waitForTimeout(700);

/** 先把视角摆到成片相机斜后方（HUD「看相机」），否则相机轨迹点可能落在画面外 */
await page.locator('.vp3d-hud button:has-text("看相机")').first().click();
await page.waitForTimeout(650);
const camBallFx = await project([0, 1.6, 7]);
ok("相机轨迹点算得出屏幕位置（且在画面内）", camBallFx && camBallFx[0] > 0 && camBallFx[0] < 1 && camBallFx[1] > 0 && camBallFx[1] < 1, JSON.stringify(camBallFx));

if (camBallFx) {
  await synthClick(camBallFx[0], camBallFx[1]);
  await page.waitForTimeout(600);
  const selCam = await page.evaluate(() => window.__useDoc.getState().selection);
  ok("点相机轨迹点选中了成片相机", selCam.includes("cam"), JSON.stringify(selCam));

  const handlePos = await page.evaluate(() => {
    const scene = window.__vpState?.scene;
    let pos = null;
    scene?.traverse((o) => {
      if (o.userData?.side === "out") pos = [o.position.x, o.position.y, o.position.z];
    });
    return pos;
  });
  ok("相机轨迹也出现贝塞尔手柄", Boolean(handlePos), JSON.stringify(handlePos));

  if (handlePos) {
    const hFx = await project(handlePos);
    const before = await opLen();
    await page.evaluate(
      ([hx, hy]) => {
        const el = document.querySelector("canvas");
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width * hx;
        const cy = r.y + r.height * hy;
        const mk = (type, x, y, buttons) =>
          new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: type === "pointermove" ? -1 : 0, buttons, isPrimary: true });
        el.dispatchEvent(mk("pointerdown", cx, cy, 1));
        for (let i = 1; i <= 8; i++) window.dispatchEvent(mk("pointermove", cx + (180 * i) / 8, cy, 1));
        window.dispatchEvent(mk("pointerup", cx + 180, cy, 0));
      },
      hFx,
    );
    await page.waitForTimeout(700);
    const opCam = await lastOp();
    ok("拖相机手柄写出 set_graph_camera", opCam?.op === "set_graph_camera" && (await opLen()) > before, JSON.stringify(opCam)?.slice(0, 120));
    const camAnim = opCam?.camera?.anim ?? [];
    const seg0 = camAnim[0];
    ok(
      "相机段写出非零 curve.out",
      Boolean(seg0?.curve?.out) && seg0.curve.out.some((v) => Math.abs(v) > 1e-3),
      JSON.stringify(camAnim.map((a) => [a.at, a.curve ?? null])),
    );
  }
}

await page.screenshot({ path: `${OUT}/4-cam-handle.png` });

/* ── 相机页的「平滑」按钮（和节点版同一套算法，但写的是 camera.anim） ── */
await page.locator('.s3d-tabs button:has-text("相机")').first().click();
await page.waitForTimeout(400);
const beforeSmooth = await opLen();
const camSmoothBtn = page.locator('[data-scope="cam"][data-kind="all"] button:has-text("平滑")');
if (await camSmoothBtn.count()) {
  await camSmoothBtn.click();
  await page.waitForTimeout(600);
  const opCamSmooth = await lastOp();
  ok(
    "相机页「平滑」写出 set_graph_camera，中间段带 curve、端点段不留零值",
    opCamSmooth?.op === "set_graph_camera" &&
      (await opLen()) > beforeSmooth &&
      (opCamSmooth.camera?.anim ?? []).some((a) => a.curve) &&
      (opCamSmooth.camera?.anim ?? []).every((a) => !a.curve || a.curve.out || a.curve.in),
    JSON.stringify((opCamSmooth?.camera?.anim ?? []).map((a) => a.curve)),
  );
} else {
  ok("相机页出现「平滑」按钮", false);
}

/* ── 长运镜平滑不甩钩（用户报的"点了平滑轨迹反而炸开"） ── */
await page.evaluate(() => {
  const st = window.__useDoc.getState();
  const mk = (p, q) => ({ from: p, to: q, ease: "linear" });
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
                position: [0, 2, 10],
                target: [0, 0, 0],
                anim: [
                  {
                    at: [0, 425],
                    ...mk({ posX: 0, posY: 2, posZ: 10 }, { posX: 8, posY: 2, posZ: 6 }),
                  },
                  {
                    at: [425, 851],
                    ...mk({ posX: 8, posY: 2, posZ: 6 }, { posX: 0, posY: 2, posZ: 2 }),
                  },
                ],
              },
            },
          },
        },
  );
  window.__useDoc.setState({ project: { ...st.project, scenes } });
});
await page.waitForTimeout(600);
await page.locator('[data-scope="cam"][data-kind="all"] button:has-text("平滑")').click();
await page.waitForTimeout(700);
const opLong = await lastOp();
const animLong = opLong?.camera?.anim ?? [];
const mag = (v) => (Array.isArray(v) ? Math.hypot(v[0], v[1], v[2]) : 0);
const segLenOf = (a) => Math.hypot(a.to.posX - a.from.posX, a.to.posY - a.from.posY, a.to.posZ - a.from.posZ);
console.log("  长运镜平滑:", JSON.stringify(animLong.map((a) => [a.at, a.curve?.out, a.curve?.in])));
ok(
  "长运镜平滑后切线不超过段长的 0.75 倍（不甩钩）",
  animLong.length === 2 &&
    animLong.every((a) => !a.curve || (mag(a.curve.out) <= segLenOf(a) * 0.75 + 0.01 && mag(a.curve.in) <= segLenOf(a) * 0.75 + 0.01)),
  JSON.stringify(animLong.map((a) => [mag(a.curve?.out), segLenOf(a)])),
);
ok("长运镜确实被平滑（至少一段有非零曲线）", animLong.some((a) => mag(a.curve?.out) > 0.1 || mag(a.curve?.in) > 0.1));

await page.screenshot({ path: `${OUT}/5-long-smooth.png` });

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (errors.length) console.log("页面错误:\n  " + errors.join("\n  "));
await browser.close();
process.exit(fail ? 1 : 0);
