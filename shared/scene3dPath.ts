/**
 * 运动轨迹的空间曲线（三次贝塞尔 / Hermite）。
 *
 * 为什么单独一个文件：节点位置和相机位置都要用它，而 `evalNode` 与 `dslCamera`
 * 分属渲染层的两套代码——曲线数学各写一份，迟早出现"物体走曲线、相机走折线"的错位。
 *
 * ## 关键设计：`out` / `in` 是**相对直线方向**的偏移，且两者方向语义一致
 *
 * 直觉上"切线 = 出去的方向"，但那样会有两个坑：
 * 1. **零切线不等于直线**：Hermite 里 m0 = m1 = 0 得到的是 easeInOut 形状（两端慢、
 *    中间快），"没设置曲线"的段会全部变样。
 * 2. 终点切线天然是**反向**的（指向来路）。如果按物理方向存，用户想"两端对称向上鼓"
 *    就得写 `out:[0,6,0], in:[0,-6,0]` —— 正负号反直觉，agent 也几乎必然写错。
 *
 * 所以这里定义：m0 = (B−A) + out、m1 = (B−A) − in。
 * - out = in = 0 → m0 = m1 = B−A → 精确退化成线性（t=0.25 处正好 1/4 点）；
 * - out、in 都给 `[0,6,0]` → 这一段向上鼓出（两个手柄都朝上），符号直观；
 * - 所有老数据（没有 curve 的段）走的仍是原来的逐通道插值，一行都不变。
 */
export type Vec3 = [number, number, number];

export type PathCurve = {
  out?: readonly number[];
  in?: readonly number[];
  /**
   * 看向点自己的切线（只有相机的 curve 会用到）。
   *
   * 为什么必须分开：位置和看向点是**两条不同的曲线**。以前看向点硬套位置的
   * out/in，等于让镜头方向跟着机位的弯度走 —— 段边界上两条曲线的切线对不上，
   * 逐帧看就是"每隔 0.3 秒抖一下"。给了这两个字段就用它们，没给才回落到
   * 老行为（兼容既有数据）。
   */
  targetOut?: readonly number[];
  targetIn?: readonly number[];
};

/**
 * 小于这个量级的偏移按 0 处理：拖手柄时手抖会产生 1e-5 级别的残差，
 * 让它触发"曲线分支"只会往 DSL 里写一堆视觉上看不出来的脏数据。
 */
const EPS = 1e-4;

const nz = (v?: readonly number[]) => !!v && (Math.abs(v[0] ?? 0) > EPS || Math.abs(v[1] ?? 0) > EPS || Math.abs(v[2] ?? 0) > EPS);

/** 这一段是否真的被拉弯了。全零 = 直线，调用方走原来的插值路径（零回归） */
export const hasCurve = (c?: PathCurve | null): boolean => Boolean(c) && (nz(c?.out) || nz(c?.in));

/** 看向点是否给了**自己的**切线。没给时调用方沿用位置曲线（历史行为） */
export const hasTargetCurve = (c?: PathCurve | null): boolean =>
  Boolean(c) && (nz(c?.targetOut) || nz(c?.targetIn));

const v3 = (v?: readonly number[]): Vec3 => [v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0];

/**
 * 段内位置（p ∈ [0,1] 是**时间进度**，不是弧长）。
 *
 * 为什么不用弧长参数化：动画的"什么时候到哪儿"由 ease 决定，曲线只管"走哪条路"。
 * 混进弧长会让"缓动改成线性"这种操作同时改变路径上的停留位置，编辑手感会崩。
 */
export const pathAt = (a: Vec3, b: Vec3, out: Vec3, inn: Vec3, p: number): Vec3 => {
  const d0 = b[0] - a[0];
  const d1 = b[1] - a[1];
  const d2 = b[2] - a[2];
  // 切线 = 直线方向 ± 偏移；零偏移时两条切线都等于 (B−A)，Hermite 精确退化为线性
  const m0 = [d0 + out[0], d1 + out[1], d2 + out[2]] as Vec3;
  const m1 = [d0 - inn[0], d1 - inn[1], d2 - inn[2]] as Vec3;
  const t = Math.max(0, Math.min(1, p));
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return [
    h00 * a[0] + h10 * m0[0] + h01 * b[0] + h11 * m1[0],
    h00 * a[1] + h10 * m0[1] + h01 * b[1] + h11 * m1[1],
    h00 * a[2] + h10 * m0[2] + h01 * b[2] + h11 * m1[2],
  ];
};

/**
 * 段 → 两个贝塞尔控制点（c1 靠起点、c2 靠终点），给视口画手柄用。
 *
 * 三次贝塞尔的控制点是 a + m0/3 与 b − m1/3。零偏移时它们落在 A→B 的 1/3、2/3 处，
 * 四点共线等距 —— 画出来就是一条直的、手柄"贴"在直线上，用户拖动才离开。
 */
export const pathControls = (a: Vec3, b: Vec3, out: Vec3, inn: Vec3): { c1: Vec3; c2: Vec3 } => {
  const m0: Vec3 = [b[0] - a[0] + out[0], b[1] - a[1] + out[1], b[2] - a[2] + out[2]];
  const m1: Vec3 = [b[0] - a[0] - inn[0], b[1] - a[1] - inn[1], b[2] - a[2] - inn[2]];
  return {
    c1: [a[0] + m0[0] / 3, a[1] + m0[1] / 3, a[2] + m0[2] / 3],
    c2: [b[0] - m1[0] / 3, b[1] - m1[1] / 3, b[2] - m1[2] / 3],
  };
};

/** 控制点 → out / in（拖完手柄写库用）。与 pathControls 严格互逆 */
export const pathTangents = (a: Vec3, b: Vec3, c1: Vec3, c2: Vec3): { out: Vec3; inn: Vec3 } => {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  return {
    out: [3 * (c1[0] - a[0]) - d[0], 3 * (c1[1] - a[1]) - d[1], 3 * (c1[2] - a[2]) - d[2]],
    inn: [d[0] - 3 * (b[0] - c2[0]), d[1] - 3 * (b[1] - c2[1]), d[2] - 3 * (b[2] - c2[2])],
  };
};

/**
 * 自动平滑（Catmull-Rom）：让拐点变成顺滑过弯。
 *
 * 段 [a→b] 两端各取"邻居差分的一半"作为切线：a 处用 (b − prev)/2，b 处用 (next − a)/2。
 * 相邻两段在共享关键帧处算出的是同一条切线，所以接缝是 C1 连续的（不会出现速度折角）。
 * 没有邻居（首/末段）就退化为直线，不会因为缺数据把轨迹拉飞。
 *
 * **切线必须限长**（这是实测踩出来的）：Catmull-Rom 的切线只跟邻居距离有关，跟本段长度无关。
 * 关键帧间隔一大（比如 0 帧到 851 帧、跨了大半个场景），切线会比本段还长好几倍，
 * 曲线就会甩出一个巨大的钩子——用户看到的是"点了平滑，轨迹反而更乱了"。
 * 这里把 out/in 的模长钳在段长的 0.75 倍：方向仍然按邻居走，甩出幅度有上限。
 */
const clampLen = (v: Vec3, max: number): Vec3 => {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(len) || len <= max || len < 1e-9) return v;
  const k = max / len;
  return [v[0] * k, v[1] * k, v[2] * k];
};

export const smoothTangents = (
  prev: Vec3 | null,
  a: Vec3,
  b: Vec3,
  next: Vec3 | null,
): { out: Vec3; inn: Vec3 } => {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const segLen = Math.hypot(d[0], d[1], d[2]);
  /** 零位移段（原地停住）：没有方向可言，直接给直线，别让邻居把它拉出一个小圈 */
  if (segLen < 1e-6) return { out: [0, 0, 0], inn: [0, 0, 0] };
  const cap = segLen * 0.75;
  const m0: Vec3 = prev ? [(b[0] - prev[0]) / 2, (b[1] - prev[1]) / 2, (b[2] - prev[2]) / 2] : d;
  const m1: Vec3 = next ? [(next[0] - a[0]) / 2, (next[1] - a[1]) / 2, (next[2] - a[2]) / 2] : d;
  return {
    out: clampLen([m0[0] - d[0], m0[1] - d[1], m0[2] - d[2]], cap),
    inn: clampLen([d[0] - m1[0], d[1] - m1[1], d[2] - m1[2]], cap),
  };
};

/**
 * 同一顶点上"另一侧"的控制点：与拖动点关于锚点**共线反向**、长度按比例伸缩。
 *
 * 这就是编辑软件里说的"相切/连续（continuous）"：一颗关键帧两侧的切线共线，
 * 曲线经过它时不会出现折角（C1 连续）。拖一侧，另一侧沿反方向跟着走。
 *
 * 长度为什么按比例而不是"保持不变"：保持对侧长度不变时，用户把手柄拉得很远、
 * 另一侧却纹丝不动，看起来像没联动（实测过这种反馈）。按比例伸缩时两侧一起张开，
 * 视觉上是一条通条，和"相切"的直觉一致。
 *
 * `origLen` 是拖动侧原本的长度；它接近 0 时比例没有意义（0 除），直接按 1 处理，
 * 也就是两侧等长对称。
 */
export const mateHandle = (anchor: Vec3, dragged: Vec3, origLen: number, mateLen: number): Vec3 => {
  const v: Vec3 = [dragged[0] - anchor[0], dragged[1] - anchor[1], dragged[2] - anchor[2]];
  const len = Math.hypot(v[0], v[1], v[2]);
  /** 拖到锚点上：方向退化，对侧也收回锚点（否则会拿到一个 NaN 角度乱飞） */
  if (!(len > 1e-6)) return [anchor[0], anchor[1], anchor[2]];
  const k = origLen > 1e-6 ? mateLen / origLen : 1;
  return [anchor[0] - v[0] * k, anchor[1] - v[1] * k, anchor[2] - v[2] * k];
};

/** 三点是否共线反向（单测与调试用）：返回夹角余弦，-1 表示严格反向 */
export const collinearCos = (anchor: Vec3, p: Vec3, q: Vec3): number => {
  const a: Vec3 = [p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]];
  const b: Vec3 = [q[0] - anchor[0], q[1] - anchor[1], q[2] - anchor[2]];
  const la = Math.hypot(a[0], a[1], a[2]);
  const lb = Math.hypot(b[0], b[1], b[2]);
  if (la < 1e-9 || lb < 1e-9) return NaN;
  return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
};

/**
 * 只算**某一颗关键帧**处的切线（相邻两段靠近它的那一端）。
 *
 * 整条平滑会重算所有段，用户在一颗关键帧上点"平滑"时不该动别的点——所以单独给这个：
 * 返回 `{ inPrev, outNext }`，调用方把它们写进前段的 `in`、后段的 `out`，其余段一个字不改。
 *
 * 两颗邻居之间取中点方向的半量，两段拿到**同一条切线**（C1），这就是"这个点顺滑过弯"。
 * 缺邻居（首/末帧）返回 null：没有切线信息，别硬造一个把用户已调好的曲线改掉。
 *
 * 两侧共用同一个限长（取两段里较短的那段 × 0.75）：各钳各的会让两段切线不再共线，
 * "相切"当场失效——这比曲线略短要严重得多。
 */
export const smoothAtKey = (
  prev: Vec3 | null,
  key: Vec3,
  next: Vec3 | null,
  prevSpan: number,
  nextSpan: number,
): { inPrev: Vec3 | null; outNext: Vec3 | null } => {
  if (!prev || !next) return { inPrev: null, outNext: null };
  const m: Vec3 = [(next[0] - prev[0]) / 2, (next[1] - prev[1]) / 2, (next[2] - prev[2]) / 2];
  const cap = Math.min(prevSpan, nextSpan) * 0.75;
  if (!(cap > 1e-6)) return { inPrev: null, outNext: null };
  const mt = clampLen(m, cap);
  const d0: Vec3 = [key[0] - prev[0], key[1] - prev[1], key[2] - prev[2]];
  const d1: Vec3 = [next[0] - key[0], next[1] - key[1], next[2] - key[2]];
  /** 前段终切 = d0 − in = mt；后段起切 = d1 + out = mt */
  return {
    inPrev: [d0[0] - mt[0], d0[1] - mt[1], d0[2] - mt[2]],
    outNext: [mt[0] - d1[0], mt[1] - d1[1], mt[2] - d1[2]],
  };
};

/** 段端点值 → Vec3（缺通道用 from 补，保证曲线是"整点移动"而不是各轴各走各的） */
export const segEndpoints = (
  from: readonly number[],
  to: readonly number[],
): { a: Vec3; b: Vec3 } => ({
  a: v3(from),
  b: [to[0] ?? from[0], to[1] ?? from[1], to[2] ?? from[2]],
});
