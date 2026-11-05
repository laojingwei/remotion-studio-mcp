/**
 * demo3d 太阳系运镜烘焙器。
 *
 * 用法：`npx tsx scripts/bake-demo3d-camera.mts`（写完自动同步 scripts/seeds/demo3d）。
 * 改运镜只改下面的 `BEATS`（分镜表）；时间表、过渡长度、方位避让都是自动算的。
 *
 * 三条硬约束，这次当成"数学前提"而不是"调参目标"：
 *
 * 1. **镜头方向是一阶量，不是位置的副产品。**
 *    只要 P（机位）和 T（看向点）各自插值，视线角速度就是 |P'−T'| / |P−T| ——
 *    相机一靠近主体，分母趋零，一点横向速度就是几百度/秒的甩镜。
 *    所以过渡段直接对**单位方向**做 slerp（角速度均匀可控），距离单独插值，
 *    最后反算 T = P + D·dist。视线的角速度因此可以事先算出来、卡上限。
 *
 * 2. **机位偏移写在"行星的随动系"里。**
 *    偏移由「背离太阳的径向 / 侧向 / 仰角」构成，行星公转多少机位就转多少 ——
 *    相机与天体走同一条弧，主体稳、背景流。写死绝对坐标就会"行星走弧、相机走弦"。
 *
 * 3. **整条轨迹是一条解析曲线，不是一堆线段。**
 *    全片只有一个 camAt(f)（C1 连续），烘焙只是为了把它塞进 240 段的关键帧格式：
 *    每段的切线取解析函数的中心差分，相邻段在共享锚点上算出**同一个数**，
 *    于是分段 Hermite 拼回来的曲线与原曲线处处相切 —— 没有折角，也就没有"抖"。
 */
import fs from "node:fs";
import { indexNodes, worldPointOf } from "../shared/scene3dTransform";

const FPS = 30;
const N = 2160;
const SEG = 240;
const STEP = N / SEG;

const p = JSON.parse(fs.readFileSync("data/projects/demo3d/project.json", "utf8"));
const scene = p.scenes[0];
const g = scene.props.graph;
const idx = indexNodes(g.nodes);

type PlanetKey = "mercury" | "venus" | "earth" | "mars" | "jupiter" | "saturn" | "uranus" | "neptune";
type Vec3 = [number, number, number];

const RADIUS: Record<PlanetKey, number> = {
  mercury: 0.084,
  venus: 0.209,
  earth: 0.22,
  mars: 0.117,
  jupiter: 1.55,
  saturn: 1.3,
  uranus: 0.62,
  neptune: 0.6,
};

const D2R = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

const planetPos = (key: PlanetKey, f: number): Vec3 => {
  const w = worldPointOf(idx, key, f);
  if (!w) throw new Error(`节点 ${key} 不存在`);
  return [w[0], w[1], w[2]];
};
const polar = (v: Vec3) => ({ r: Math.hypot(v[0], v[2]), th: Math.atan2(v[2], v[0]) });

/** 公转角速度（弧度/帧）。直接读轨道枢轴，别再手抄成度 */
const OMEGA: Record<string, number> = {};
for (const n of g.nodes as Array<{ id: string; anim?: Array<{ from?: { rotY?: number }; to?: { rotY?: number } }> }>) {
  if (!n.id.startsWith("piv_")) continue;
  const a = n.anim?.[0];
  if (!a?.from || !a?.to || typeof a.from.rotY !== "number" || typeof a.to.rotY !== "number") continue;
  OMEGA[n.id.slice(4)] = ((a.to.rotY - a.from.rotY) * D2R) / N;
}

/* ─────────────────────────── 分镜 ─────────────────────────── */

/** 2 点=单向推/拉；3 点=推到一半再退回来（掠过式），这样每颗行星的运动方式才能不一样 */
type Keyed = [number, number] | [number, number, number];

type Beat = {
  kind: "planet" | "sky";
  key?: PlanetKey;
  /** 时长权重（过渡段定下来后按权重分配剩余时间） */
  w: number;
  /** 天体在画面里的高度占比：小=远、大=迫近 */
  fill: Keyed;
  /** 0=逆光, 90=半明半暗, 180=顺光 */
  phi: Keyed;
  el: Keyed;
  fov: Keyed;
  r0?: number;
  r1?: number;
  y0?: number;
  y1?: number;
  th0?: number;
  th1?: number;
};

const at3 = (v: Keyed, u: number): number => {
  if (v.length === 2) return lerp(v[0], v[1], u);
  const t = u;
  return (1 - t) * (1 - t) * v[0] + 2 * (1 - t) * t * v[1] + t * t * v[2];
};
const shift3 = (v: Keyed, d: number): Keyed => v.map((x) => x + d) as Keyed;

const BEATS: Beat[] = [
  /* 开场：站在系统外，太阳占三成，缓慢压进去 —— 先让观众看清尺度 */
  { kind: "sky", w: 0.7, fill: [0, 0], phi: [0, 0], el: [0, 0], fov: [42, 42], r0: 27, r1: 21, y0: 8.4, y1: 6.6, th0: 0, th1: 7 },

  /* 水星：长焦小目标一路顶到近景，越推越快 —— "冲进内圈" */
  { kind: "planet", key: "mercury", w: 0.95, fill: [0.12, 0.52], phi: [64, 96], el: [2, 15], fov: [40, 34] },

  /* 金星：先贴到近景再退回中景 —— 和上一颗方向相反，节奏立刻不一样 */
  { kind: "planet", key: "venus", w: 1.05, fill: [0.5, 0.62, 0.3], phi: [104, 128, 132], el: [18, 14, 5], fov: [34, 36, 38] },

  /* 地球：环视 —— 从侧后方绕到向阳面，termi­nator 扫过整颗星球 */
  { kind: "planet", key: "earth", w: 2.9, fill: [0.3, 0.5, 0.46], phi: [70, 126, 152], el: [5, 18, 9], fov: [36, 33, 35] },

  /* 火星：高速掠过 —— 从远处冲到很近，再擦身离开 */
  { kind: "planet", key: "mars", w: 0.9, fill: [0.16, 0.6, 0.24], phi: [92, 112, 118], el: [8, 16, 22], fov: [40, 34, 38] },

  /* 木星：巨物缓慢压满画面，低机位仰视 */
  { kind: "planet", key: "jupiter", w: 1.45, fill: [0.28, 0.66], phi: [102, 124], el: [4, 12], fov: [38, 34] },

  /* 土星：贴着环平面掠过，再抬起来让环张开 */
  { kind: "planet", key: "saturn", w: 1.5, fill: [0.3, 0.46], phi: [106, 122], el: [-18, 8], fov: [42, 36] },

  /* 天王星：故意留小 —— 外圈的"空旷"本身就是尺度感 */
  { kind: "planet", key: "uranus", w: 0.8, fill: [0.12, 0.22], phi: [94, 106], el: [18, 26], fov: [40, 38] },

  /* 海王星：从近处退远，为收尾的拉升做预备 */
  { kind: "planet", key: "neptune", w: 0.8, fill: [0.34, 0.18], phi: [100, 112], el: [12, 20], fov: [38, 40] },

  /* 收尾：升到黄道面上方、一路退到能看全八条轨道 */
  { kind: "sky", w: 1.7, fill: [0, 0], phi: [0, 0], el: [0, 0], fov: [46, 52], r0: 58, r1: 142, y0: 22, y1: 82, th0: 0, th1: 16 },
];

/* ─────────────────────────── 机位求值 ─────────────────────────── */

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** 单位向量 slerp：角速度均匀，不会"快贴近目标时突然加速" */
const slerp = (a: Vec3, b: Vec3, t: number): Vec3 => {
  const d = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  const ang = Math.acos(d);
  if (ang < 1e-5) return unit([lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]);
  const s = Math.sin(ang);
  const k0 = Math.sin((1 - t) * ang) / s;
  const k1 = Math.sin(t * ang) / s;
  return unit([a[0] * k0 + b[0] * k1, a[1] * k0 + b[1] * k1, a[2] * k0 + b[2] * k1]);
};

const offsetOf = (anchor: Vec3, dist: number, phiDeg: number, elDeg: number): Vec3 => {
  const rad = Math.hypot(anchor[0], anchor[2]) || 1;
  const rx = anchor[0] / rad;
  const rz = anchor[2] / rad;
  const tx = rz;
  const tz = -rx;
  const phi = phiDeg * D2R;
  const el = elDeg * D2R;
  const hx = rx * Math.cos(phi) + tx * Math.sin(phi);
  const hz = rz * Math.cos(phi) + tz * Math.sin(phi);
  return [hx * Math.cos(el) * dist, Math.sin(el) * dist, hz * Math.cos(el) * dist];
};

const distForFill = (radius: number, fill: number, fov: number) => radius / Math.tan((fill * fov * D2R) / 2);

const aimOf = (anchor: Vec3, dist: number, fov: number): Vec3 => {
  const frameH = 2 * dist * Math.tan((fov * D2R) / 2);
  return [anchor[0], anchor[1] - 0.055 * frameH, anchor[2]];
};

type Pose = { pos: Vec3; target: Vec3; fov: number; anchor: Vec3 };

const poseOf = (b: Beat, f: number, u: number): Pose => {
  const fov = at3(b.fov, u);
  if (b.kind === "sky") {
    const r = lerp(b.r0!, b.r1!, u);
    const y = lerp(b.y0!, b.y1!, u);
    const th = lerp(b.th0!, b.th1!, u) * D2R;
    return { pos: [Math.cos(th) * r, y, Math.sin(th) * r], target: [0, 0, 0], fov, anchor: [0, 0, 0] };
  }
  const key = b.key!;
  const anchor = planetPos(key, f);
  const fill = at3(b.fill, u);
  const dist = distForFill(RADIUS[key], fill, fov);
  const off = offsetOf(anchor, dist, at3(b.phi, u), at3(b.el, u));
  return {
    pos: [anchor[0] + off[0], anchor[1] + off[1], anchor[2] + off[2]],
    target: aimOf(anchor, dist, fov),
    fov,
    anchor,
  };
};

/* ─────────────────────────── 时间表 ─────────────────────────── */

type Schedule = { t0: number[]; t1: number[]; tr: number[] };

const buildSchedule = (scale = 1): Schedule => {
  let tr = BEATS.slice(0, -1).map(() => 66);
  let t0: number[] = [];
  let t1: number[] = [];
  for (let pass = 0; pass < 4; pass++) {
    const total = N - tr.reduce((a, b) => a + b, 0);
    const wsum = BEATS.reduce((a, b) => a + b.w, 0);
    t0 = [];
    t1 = [];
    let t = 0;
    for (let i = 0; i < BEATS.length; i++) {
      const len = Math.max(56, Math.round((total * BEATS[i].w) / wsum));
      t0.push(t);
      t1.push(t + len);
      t = t1[i] + (tr[i] ?? 0);
    }
    /* 过渡长度同时看两件事：视线要转多少度、机位要推拉多远。
       只按角度算的话，"远景拉到全景"这种角度变化很小、距离却翻几十倍的段落
       会被压成 1.4 秒 —— 结果就是火箭式拉远（实测 4.4 单位/帧）。 */
    tr = tr.map((v, i) => {
      const fa = t1[i];
      const fb = t1[i] + v;
      const pa = poseOf(BEATS[i], fa, 1);
      const pb = poseOf(BEATS[i + 1], fb, 0);
      const da = unit([pa.target[0] - pa.pos[0], pa.target[1] - pa.pos[1], pa.target[2] - pa.pos[2]]);
      const db = unit([pb.target[0] - pb.pos[0], pb.target[1] - pb.pos[1], pb.target[2] - pb.pos[2]]);
      const ang = Math.acos(clamp(da[0] * db[0] + da[1] * db[1] + da[2] * db[2], -1, 1)) / D2R;
      const distA = Math.max(0.3, Math.hypot(pa.target[0] - pa.pos[0], pa.target[1] - pa.pos[1], pa.target[2] - pa.pos[2]));
      const distB = Math.max(0.3, Math.hypot(pb.target[0] - pb.pos[0], pb.target[1] - pb.pos[1], pb.target[2] - pb.pos[2]));
      const zoom = Math.abs(Math.log(distB / distA)) * 46;
      return Math.round(clamp(Math.max(ang / 1.1, zoom) * scale, 46, 96));
    });
  }
  const total = N - tr.reduce((a, b) => a + b, 0);
  const wsum = BEATS.reduce((a, b) => a + b.w, 0);
  t0 = [];
  t1 = [];
  let t = 0;
  for (let i = 0; i < BEATS.length; i++) {
    const len = Math.max(56, Math.round((total * BEATS[i].w) / wsum));
    t0.push(t);
    t1.push(t + len);
    t = t1[i] + (tr[i] ?? 0);
  }
  t1[t1.length - 1] = N;
  return { t0, t1, tr };
};

const SCHED_RAW = buildSchedule();

/**
 * 方位角避让：镜头方向上如果正好"撞上"另一颗大行星，画面里会出现两颗同样大的球，
 * 观众分不清谁是谁（实测水星镜头背后挂着木星）。
 *
 * 只在 ±φ（镜头的另一侧）和 ±30° 里挑 —— 这几个候选的受光相位基本一致，
 * 换的只是"背景里有什么"，不会把主体从侧光变成逆光。
 */
const tunePhi = () => {
  const cands = [0, 0, -180, 30, -30, 60, -60];
  for (let i = 0; i < BEATS.length; i++) {
    const b = BEATS[i];
    if (b.kind !== "planet") continue;
    const mid = (SCHED_RAW.t0[i] + SCHED_RAW.t1[i]) / 2;
    let best = 0;
    let bestScore = Infinity;
    for (const delta of cands) {
      const probe: Beat = { ...b, phi: shift3(b.phi, delta) };
      const pose = poseOf(probe, mid, 0.5);
      const view = unit([pose.target[0] - pose.pos[0], pose.target[1] - pose.pos[1], pose.target[2] - pose.pos[2]]);
      const half = pose.fov / 2;
      let score = 0;
      for (const other of Object.keys(RADIUS) as PlanetKey[]) {
        if (other === b.key) continue;
        const P = planetPos(other, mid);
        const to = unit([P[0] - pose.pos[0], P[1] - pose.pos[1], P[2] - pose.pos[2]]);
        const ang = (Math.acos(clamp(view[0] * to[0] + view[1] * to[1] + view[2] * to[2], -1, 1)) * 180) / Math.PI;
        const d = Math.hypot(P[0] - pose.pos[0], P[1] - pose.pos[1], P[2] - pose.pos[2]);
        const apparent = (Math.atan(RADIUS[other] / d) * 180) / Math.PI;
        const reach = half * 1.28 + apparent;
        if (ang < reach) score += ((apparent * 2 * (1 - ang / reach)) ** 2) * 3;
      }
      /**
       * 受光相位也要挑：相位 0 = 正对太阳（一颗死白的圆盘，没有立体感），
       * 180 = 全黑只剩剪影。允许区间 25°~150°，越界按平方扣分。
       * 没有这一项时 ±180° 的候选会被选中（只因为背景更空），主体直接黑掉。
       */
      const midPhi = (b.phi[0] + b.phi[b.phi.length - 1]) / 2 + delta;
      const phase = 180 - midPhi;
      if (phase < 25) score += (25 - phase) ** 2 * 0.5;
      if (phase > 150) score += (phase - 150) ** 2 * 0.5;
      if (score < bestScore - 1e-6) {
        bestScore = score;
        best = delta;
      }
    }
    if (best) b.phi = shift3(b.phi, best);
  }
};
tunePhi();
let SCHED = buildSchedule();

/** 焦点弧：极坐标 Hermite，端点角速度取行星真实角速度（C1 接缝的来源） */
const arcFocus = (a: Beat, b: Beat, f: number, u: number, L: number): Vec3 => {
  const A = a.kind === "sky" ? ([0, 0, 0] as Vec3) : planetPos(a.key!, f);
  const B = b.kind === "sky" ? ([0, 0, 0] as Vec3) : planetPos(b.key!, f);
  const pa = polar(A);
  const pb = polar(B);
  let dth = pb.th - pa.th;
  while (dth > Math.PI) dth -= Math.PI * 2;
  while (dth < -Math.PI) dth += Math.PI * 2;
  const wa = a.kind === "sky" ? 0 : (OMEGA[a.key!] ?? 0);
  const wb = b.kind === "sky" ? 0 : (OMEGA[b.key!] ?? 0);
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  const r = h00 * pa.r + h01 * pb.r;
  const th = h00 * pa.th + h10 * (wa * L) + h01 * (pa.th + dth) + h11 * (wb * L);

  /**
   * 高度也要插，而且不能写死 0。
   *
   * 轨道枢轴带了倾角（水星 7°、木星 1.3°），所以行星的 y 根本不是 0 ——
   * 水星最高到 0.77。焦点弧的 y 写死 0 时，过渡段最后一帧会从 0 直接掉到
   * 行星真实高度（或反过来），接缝处 0.6 个单位的瞬移，逐帧看就是"疯狂抖一下"
   * （用户截图里那个尖角就是它）。端点导数取行星真实的竖直速度，接缝才连得上。
   */
  const vy = (beat: Beat): number => {
    if (beat.kind === "sky") return 0;
    const lo = Math.max(0, Math.min(N, f - 1));
    const hi = Math.max(0, Math.min(N, f + 1));
    return ((planetPos(beat.key!, hi)[1] - planetPos(beat.key!, lo)[1]) / Math.max(1, hi - lo)) * L;
  };
  const y = h00 * A[1] + h10 * vy(a) + h01 * B[1] + h11 * vy(b);
  return [Math.cos(th) * r, y, Math.sin(th) * r];
};

type Hit = { shot: number; u: number } | { trans: number; u: number };

const locate = (f: number): Hit => {
  for (let i = 0; i < BEATS.length; i++) {
    if (f >= SCHED.t0[i] && f <= SCHED.t1[i])
      return { shot: i, u: (f - SCHED.t0[i]) / Math.max(1, SCHED.t1[i] - SCHED.t0[i]) };
    if (i + 1 < BEATS.length && f > SCHED.t1[i] && f < SCHED.t0[i + 1])
      return { trans: i, u: (f - SCHED.t1[i]) / Math.max(1, SCHED.t0[i + 1] - SCHED.t1[i]) };
  }
  return { shot: BEATS.length - 1, u: 1 };
};

const camAt = (f: number): Pose => {
  const hit = locate(f);
  if ("shot" in hit) return poseOf(BEATS[hit.shot], f, smooth(clamp(hit.u, 0, 1)));

  const a = BEATS[hit.trans];
  const b = BEATS[hit.trans + 1];
  const raw = clamp(hit.u, 0, 1);
  const s = smooth(raw);
  const L = SCHED.t0[hit.trans + 1] - SCHED.t1[hit.trans];

  const pa = poseOf(a, f, 1);
  const pb = poseOf(b, f, 0);
  const F = arcFocus(a, b, f, raw, L);

  /* 机位偏移：方向 slerp（角速度均匀），长度几何插值（先退远再推近，不会贴脸横移） */
  const offA: Vec3 = [pa.pos[0] - pa.anchor[0], pa.pos[1] - pa.anchor[1], pa.pos[2] - pa.anchor[2]];
  const offB: Vec3 = [pb.pos[0] - pb.anchor[0], pb.pos[1] - pb.anchor[1], pb.pos[2] - pb.anchor[2]];
  const rA = Math.max(1e-3, Math.hypot(offA[0], offA[1], offA[2]));
  const rB = Math.max(1e-3, Math.hypot(offB[0], offB[1], offB[2]));
  const dir = slerp(unit(offA), unit(offB), s);
  const r = Math.exp(lerp(Math.log(rA), Math.log(rB), s));

  const gap = Math.hypot(
    (a.kind === "sky" ? 0 : planetPos(a.key!, f)[0]) - (b.kind === "sky" ? 0 : planetPos(b.key!, f)[0]),
    (a.kind === "sky" ? 0 : planetPos(a.key!, f)[2]) - (b.kind === "sky" ? 0 : planetPos(b.key!, f)[2]),
  );
  /**
   * 抬升用 **sin²(πu)** 而不是 sin(πu)。
   *
   * sin(πu) 在 u=1 的导数是 −π：过渡段收尾时相机还在往上"拽"，而下一段（跟拍：
   * 只会跟着行星慢慢漂）竖直速度≈0 —— 接缝处速度方向硬拐，烘焙出来的三次曲线
   * 再把这个拐点放大，实测出现 89°~151° 的单帧转向（用户截图里的尖角）。
   * sin² 两端一阶导都为 0，接缝处速度严丝合缝。
   */
  const hop = Math.min(8, Math.max(1.2, gap * 0.12)) * Math.sin(Math.PI * raw) ** 2;

  const pos: Vec3 = [F[0] + dir[0] * r, F[1] + dir[1] * r + hop, F[2] + dir[2] * r];

  /* 视线：单位方向 slerp + 距离插值，角速度因此可控 */
  const dA = unit([pa.target[0] - pa.pos[0], pa.target[1] - pa.pos[1], pa.target[2] - pa.pos[2]]);
  const dB = unit([pb.target[0] - pb.pos[0], pb.target[1] - pb.pos[1], pb.target[2] - pb.pos[2]]);
  const distA = Math.max(1e-3, Math.hypot(pa.target[0] - pa.pos[0], pa.target[1] - pa.pos[1], pa.target[2] - pa.pos[2]));
  const distB = Math.max(1e-3, Math.hypot(pb.target[0] - pb.pos[0], pb.target[1] - pb.pos[1], pb.target[2] - pb.pos[2]));
  const dirV = slerp(dA, dB, s);
  const dist = Math.exp(lerp(Math.log(distA), Math.log(distB), s));

  /**
   * 过渡中段把**视线方向**转向太阳（注意：只转方向，不动距离）。
   *
   * 两颗行星常相隔 80°+，纯 slerp 的中间一段镜头指着一片什么都没有的黑 ——
   * 实测过渡帧里只剩星点和轨道虚线，观众会以为"卡住了"。转向太阳后中段变成
   * "掠过日面"，既有主体也交代了"我在太阳系里飞"。
   *
   * 为什么不能直接把看向点拉向原点：相机这时离原点只有几个单位，看向点一靠近，
   * |P−T| 就塌到 0，视线角速度瞬间爆到 300°/s（实测）。转方向不改变距离，没有这个洞。
   *
   * 权重 sin²(πu)：两端严格 0，一阶导也是 0，接缝速度一点不受影响。
   */
  const w = 0.26 * Math.sin(Math.PI * raw) ** 2;
  const toSun = unit([-pos[0], -pos[1], -pos[2]]);
  const dirF = w > 1e-4 ? slerp(dirV, toSun, w) : dirV;
  const target: Vec3 = [pos[0] + dirF[0] * dist, pos[1] + dirF[1] * dist, pos[2] + dirF[2] * dist];
  return { pos, target, fov: lerp(pa.fov, pb.fov, s), anchor: F };
};

/**
 * 过渡长度的闭环。
 *
 * 分镜表里只按「两端视线方向差」算长度，但过渡中段还有一次"向太阳偏转再转回来"，
 * 实际扫过的角度可能是两端差的两倍多 —— 于是 180° 的甩镜被排成 1.4 秒，实测
 * 8.4°/帧（252°/s），看着就是抽一下。这里直接量解析路径的逐帧角速度，超标就整体
 * 加长过渡重排；分镜权重会自动把时间从停留段匀出来，总长不变。
 */
const peakAngular = () => {
  let prev: Vec3 | null = null;
  let peak = 0;
  for (let f = 0; f <= N; f++) {
    const c = camAt(f);
    const d = unit([c.target[0] - c.pos[0], c.target[1] - c.pos[1], c.target[2] - c.pos[2]]);
    if (prev) {
      const ang = Math.acos(clamp(d[0] * prev[0] + d[1] * prev[1] + d[2] * prev[2], -1, 1)) / D2R;
      peak = Math.max(peak, ang);
    }
    prev = d;
  }
  return peak;
};
{
  let scale = 1;
  for (let it = 0; it < 6; it++) {
    const peak = peakAngular();
    if (peak <= 3.2) break;
    scale *= Math.min(1.2, Math.sqrt(peak / 3.2));
    SCHED = buildSchedule(scale);
  }
}

/* ─────────────────────────── 烘焙 ─────────────────────────── */

const round = (v: number) => Math.round(v * 10000) / 10000;
const velOf = (fn: (f: number) => Vec3, f: number): Vec3 => {
  const lo = Math.max(0, f - 1);
  const hi = Math.min(N, f + 1);
  const a = fn(lo);
  const b = fn(hi);
  return [(b[0] - a[0]) / (hi - lo), (b[1] - a[1]) / (hi - lo), (b[2] - a[2]) / (hi - lo)];
};

const posAt = (f: number) => camAt(f).pos;
const tgtAt = (f: number) => camAt(f).target;

/**
 * **自适应关键帧**：240 段不是等距 9 帧，而是按"速度变化有多快"分配。
 *
 * 为什么必须这样：从海王星特写拉回全景，机位在 2 秒里要挪 78 个单位 —— 平均 1.2/帧，
 * 而收尾/起步那几帧速度是从 0 开始按 0.2 单位/帧² 往上冲的。等距 9 帧取样时，
 * 一段之内速度能翻 30 倍，三次 Hermite 表示不了这种加速度，只能"先往回甩再冲出去"，
 * 逐帧看就是尖锐的折角（用户截图里那些 V 形）。把关键帧挪到加速度大的地方，
 * 段内速度变化就摊平了，曲线才贴得住。
 */
const cost: number[] = [0];
{
  let acc = 0;
  for (let f = 1; f <= N; f++) {
    const p1 = velOf(posAt, f);
    const p0 = velOf(posAt, Math.max(0, f - 1));
    const t1 = velOf(tgtAt, f);
    const t0 = velOf(tgtAt, Math.max(0, f - 1));
    const a =
      Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) +
      Math.hypot(t1[0] - t0[0], t1[1] - t0[1], t1[2] - t0[2]);
    // 基础权重 1：匀速区也不会因为"没有加速度"被饿到没有关键帧
    acc += 1 + 60 * a;
    cost.push(acc);
  }
}
const bounds: number[] = [0];
{
  const total = cost[N];
  for (let i = 1; i < SEG; i++) {
    const target = (total * i) / SEG;
    const prev = bounds[i - 1];
    let g = prev + 2;
    while (g < N && g - prev < 26 && cost[g] < target) g++;
    const remain = SEG - i;
    if (N - g < remain * 2) g = Math.max(prev + 2, N - remain * 2);
    bounds.push(Math.min(g, N));
  }
  bounds.push(N);
}

const anim: Record<string, unknown>[] = [];
for (let i = 0; i < SEG; i++) {
  const f0 = bounds[i];
  const f1 = bounds[i + 1];
  const A = camAt(f0);
  const B = camAt(f1);
  const span = f1 - f0;
  const dP: Vec3 = [B.pos[0] - A.pos[0], B.pos[1] - A.pos[1], B.pos[2] - A.pos[2]];
  const dT: Vec3 = [B.target[0] - A.target[0], B.target[1] - A.target[1], B.target[2] - A.target[2]];

  const vP0 = velOf(posAt, f0);
  const vP1 = velOf(posAt, f1);
  const vT0 = velOf(tgtAt, f0);
  const vT1 = velOf(tgtAt, f1);
  const m0: Vec3 = [vP0[0] * span, vP0[1] * span, vP0[2] * span];
  const m1: Vec3 = [vP1[0] * span, vP1[1] * span, vP1[2] * span];
  const q0: Vec3 = [vT0[0] * span, vT0[1] * span, vT0[2] * span];
  const q1: Vec3 = [vT1[0] * span, vT1[1] * span, vT1[2] * span];

  const out: Vec3 = [m0[0] - dP[0], m0[1] - dP[1], m0[2] - dP[2]];
  const inn: Vec3 = [dP[0] - m1[0], dP[1] - m1[1], dP[2] - m1[2]];
  const tOut: Vec3 = [q0[0] - dT[0], q0[1] - dT[1], q0[2] - dT[2]];
  const tIn: Vec3 = [dT[0] - q1[0], dT[1] - q1[1], dT[2] - q1[2]];
  const flat = [...out, ...inn, ...tOut, ...tIn].every((v) => Math.abs(v) < 1e-5);

  anim.push({
    at: [f0, f1],
    from: {
      posX: round(A.pos[0]), posY: round(A.pos[1]), posZ: round(A.pos[2]),
      targetX: round(A.target[0]), targetY: round(A.target[1]), targetZ: round(A.target[2]),
      fov: round(A.fov),
    },
    to: {
      posX: round(B.pos[0]), posY: round(B.pos[1]), posZ: round(B.pos[2]),
      targetX: round(B.target[0]), targetY: round(B.target[1]), targetZ: round(B.target[2]),
      fov: round(B.fov),
    },
    ease: "linear",
    ...(flat
      ? {}
      : { curve: { out: out.map(round), in: inn.map(round), targetOut: tOut.map(round), targetIn: tIn.map(round) } }),
  });
}


/* ─────────────────────────── 右侧介绍卡片 ─────────────────────────── */

/**
 * 卡片文案跟分镜一起生成，不手写帧号：镜头推到哪颗星，卡片就是哪颗星。
 * 每行不超过 16 字 —— 右侧栏只有 27% 画幅宽，再长就折行，折行会破坏"一条条落下"的节奏。
 */
const CARD_TEXT: Record<PlanetKey, { kicker: string; title: string; lines: string[] }> = {
  mercury: {
    kicker: "第 1 颗 · 类地行星",
    title: "水星",
    lines: ["距太阳 5,790 万公里", "直径 4,879 公里，比月球略大", "昼夜温差接近 600℃"],
  },
  venus: {
    kicker: "第 2 颗 · 类地行星",
    title: "金星",
    lines: ["距太阳 1.08 亿公里", "二氧化碳大气压是地球的 92 倍", "地表 464℃，比水星更热"],
  },
  earth: {
    kicker: "第 3 颗 · 类地行星",
    title: "地球",
    lines: ["距太阳 1.5 亿公里", "直径 12,742 公里", "已知唯一存在生命的行星"],
  },
  mars: {
    kicker: "第 4 颗 · 类地行星",
    title: "火星",
    lines: ["距太阳 2.28 亿公里", "奥林匹斯山高 21.9 公里", "太阳系最高的火山"],
  },
  jupiter: {
    kicker: "第 5 颗 · 气态巨行星",
    title: "木星",
    lines: ["距太阳 7.78 亿公里", "质量是其余七颗之和的 2.5 倍", "大红斑已持续数百年"],
  },
  saturn: {
    kicker: "第 6 颗 · 气态巨行星",
    title: "土星",
    lines: ["距太阳 14.3 亿公里", "环系由水冰碎块组成", "铺开 28 万公里，厚不足 1 公里"],
  },
  uranus: {
    kicker: "第 7 颗 · 冰巨星",
    title: "天王星",
    lines: ["距太阳 28.7 亿公里", "自转轴倾斜 98°", "几乎是躺着绕太阳转"],
  },
  neptune: {
    kicker: "第 8 颗 · 冰巨星",
    title: "海王星",
    lines: ["距太阳 45 亿公里", "风速可达 2,100 公里/时", "太阳系最猛的风"],
  },
};

const cards = BEATS.flatMap((b, i) => {
  const txt =
    b.kind === "planet"
      ? CARD_TEXT[b.key!]
      : i === BEATS.length - 1
        ? { kicker: "尾声 · 全景", title: "八颗行星", lines: ["四颗类地，四颗巨行星", "46 亿年前由同一片星云凝聚而成"] }
        : null;
  if (!txt) return [];
  return [{ from: Math.round(SCHED.t0[i] + 8), to: Math.round(SCHED.t1[i] - 4), ...txt }];
});
scene.props.cards = cards;
console.log(`  卡片 ${cards.length} 张`);

g.camera = { ...(g.camera ?? {}), anim };
scene.durationInFrames = N;
p.rev = (p.rev ?? 0) + 1;
p.updatedAt = new Date().toISOString();
fs.writeFileSync("data/projects/demo3d/project.json", JSON.stringify(p, null, 2) + "\n");

if (process.env.DBG) {
  const [a, b] = process.env.DBG.split("-").map(Number);
  for (let fr = a; fr <= b; fr++) {
    const c = camAt(fr);
    const n = camAt(fr + 1);
    const v = [n.pos[0] - c.pos[0], n.pos[1] - c.pos[1], n.pos[2] - c.pos[2]];
    const h = locate(fr);
    console.log("  ->", JSON.stringify(h), BEATS[(h as {shot?:number}).shot ?? 0]?.key ?? "");
    console.log("f" + fr, c.pos.map((x) => x.toFixed(3)).join(","), "v=" + v.map((x) => x.toFixed(3)).join(","));
  }
}

/* ─────────────────────────── 自检 ─────────────────────────── */

const DEG = 180 / Math.PI;
let minSun = Infinity;
let minSunF = 0;
let maxAng = 0;
let maxAngF = 0;
let maxLin = 0;
let maxDist = 0;
let prevD: Vec3 | null = null;
let prevP: Vec3 | null = null;
for (let f = 0; f <= N; f++) {
  const c = camAt(f);
  const r = Math.hypot(c.pos[0], c.pos[1], c.pos[2]);
  if (r < minSun) {
    minSun = r;
    minSunF = f;
  }
  maxDist = Math.max(maxDist, Math.hypot(c.target[0] - c.pos[0], c.target[1] - c.pos[1], c.target[2] - c.pos[2]));
  const d = unit([c.target[0] - c.pos[0], c.target[1] - c.pos[1], c.target[2] - c.pos[2]]);
  if (prevD) {
    const ang = Math.acos(clamp(d[0] * prevD[0] + d[1] * prevD[1] + d[2] * prevD[2], -1, 1)) * DEG;
    if (ang > maxAng) {
      maxAng = ang;
      maxAngF = f;
    }
  }
  if (prevP) maxLin = Math.max(maxLin, Math.hypot(c.pos[0] - prevP[0], c.pos[1] - prevP[1], c.pos[2] - prevP[2]));
  prevD = d;
  prevP = c.pos;
}
console.log(`✓ ${anim.length} 段 / ${(N / FPS).toFixed(1)}s`);
console.log(`  太阳净空 ${minSun.toFixed(2)}（f${minSunF}，太阳半径 2）`);
console.log(`  视线角速度峰值 ${maxAng.toFixed(2)}°/帧（f${maxAngF}）= ${(maxAng * FPS).toFixed(0)}°/s`);
console.log(`  机位线速度峰值 ${(maxLin * FPS).toFixed(1)} 单位/秒`);
console.log(`  相机到主体最远 ${maxDist.toFixed(1)}`);
const seedPath = "scripts/seeds/demo3d/project.json";
if (fs.existsSync(seedPath)) {
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const S = seed.scenes[0];
  const L = p.scenes[0];
  S.durationInFrames = L.durationInFrames;
  S.props.post = L.props.post;
  S.props.graph.nodes = L.props.graph.nodes;
  S.props.graph.lights = L.props.graph.lights;
  S.props.graph.camera = L.props.graph.camera;
  // cards 也要同步：漏了这行的话，包里的种子永远是 0 张卡片，
  // 用户「重置示例」后右侧什么都不出现（1.1.2 发布前实测踩过）
  S.props.cards = L.props.cards ?? [];
  seed.audioTracks = p.audioTracks;
  fs.writeFileSync(seedPath, JSON.stringify(seed, null, 2) + "\n");
  console.log("  seed 已同步");
}

console.log(
  "  分镜 " + BEATS.map((b, i) => `${b.key ?? "sky"}${(SCHED.t0[i] / FPS).toFixed(1)}-${(SCHED.t1[i] / FPS).toFixed(1)}s`).join(" | "),
);
