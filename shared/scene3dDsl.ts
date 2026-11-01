import { z } from "zod";

/**
 * scene3d 的场景图 DSL（M2）。
 *
 * 三条设计判断，和方案文档第十节之前的结论一脉相承：
 *
 * 1. **动画语法与 freeform 完全一致**：`{ at: [起, 止], from: {...}, to: {...}, ease }`。
 *    agent 不用学第二套；求值也是"逐帧纯函数"，不碰 clock、不碰 delta。
 *    区别只是键从 `x/y/size/rotate` 换成了 3D 的标量（见 ANIM_KEYS）。
 *
 * 2. **动画键一律用标量，不用向量**。`rotY: 360` 比 `rotation: [0,360,0]` 好写也好校验，
 *    而且和 freeform 的 `rotate` 是同一个心智。位置拆成 posX/posY/posZ。
 *
 * 3. **几何体、材质都是白名单 + discriminatedUnion**。
 *    白名单是这套东西的质量下限：允许任意 GLSL 就等于允许 agent 渲出一片彩虹噪点，
 *    而它自己看不懂错在哪（方案第八节明确不做）。判别联合的好处是报错会直接说
 *    "type 只能是 box/sphere/..."，而不是一句泛泛的 invalid input。
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const deg = z.number().describe("角度（度，不是弧度）");

/* ────────────────────────────── 几何体白名单 ────────────────────────────── */

const box = z.object({
  type: z.literal("box"),
  width: z.number().positive().default(1),
  height: z.number().positive().default(1),
  depth: z.number().positive().default(1),
});

const sphere = z.object({
  type: z.literal("sphere"),
  radius: z.number().positive().default(0.6),
  segments: z.number().int().min(4).max(96).default(32).describe("分段数，越高越圆也越慢"),
});

const cylinder = z.object({
  type: z.literal("cylinder"),
  radiusTop: z.number().positive().default(0.4),
  radiusBottom: z.number().positive().default(0.4),
  height: z.number().positive().default(1.2),
  segments: z.number().int().min(3).max(96).default(32),
});

const cone = z.object({
  type: z.literal("cone"),
  radius: z.number().positive().default(0.5),
  height: z.number().positive().default(1.1),
  segments: z.number().int().min(3).max(96).default(32),
});

const torus = z.object({
  type: z.literal("torus"),
  radius: z.number().positive().default(0.6),
  tube: z.number().positive().default(0.18),
  radialSegments: z.number().int().min(3).max(64).default(16),
  tubularSegments: z.number().int().min(8).max(256).default(96),
});

const torusKnot = z.object({
  type: z.literal("torusKnot"),
  radius: z.number().positive().default(0.55),
  tube: z.number().positive().default(0.16),
  p: z.number().int().min(1).max(12).default(2).describe("绕轴缠绕次数"),
  q: z.number().int().min(1).max(12).default(3).describe("绕环缠绕次数"),
});

const plane = z.object({
  type: z.literal("plane"),
  width: z.number().positive().default(2),
  height: z.number().positive().default(2),
});

const capsule = z.object({
  type: z.literal("capsule"),
  radius: z.number().positive().default(0.3),
  length: z.number().positive().default(0.8),
});

const icosahedron = z.object({
  type: z.literal("icosahedron"),
  radius: z.number().positive().default(0.7),
  detail: z.number().int().min(0).max(3).default(0).describe("0 = 保留棱角（远处也读得出是个多面体）"),
});

const dodecahedron = z.object({
  type: z.literal("dodecahedron"),
  radius: z.number().positive().default(0.7),
  detail: z.number().int().min(0).max(3).default(0),
});

const octahedron = z.object({
  type: z.literal("octahedron"),
  radius: z.number().positive().default(0.7),
  detail: z.number().int().min(0).max(3).default(0),
});

const ring = z.object({
  type: z.literal("ring"),
  /**
   * innerRadius 必须是 `min(0)` 而不是 `positive()`：**0 就是实心圆盘**，
   * 而实心圆盘恰恰是最常用的那个——地面上的光斑、镜头光晕、圆形色块都靠它。
   * 这条是实跑打出来的：第一版写成 positive()，agent 想画一个光斑直接被拒。
   */
  innerRadius: z.number().min(0).default(0.35),
  outerRadius: z.number().positive().default(0.6),
});

export const geometrySchema = z.discriminatedUnion("type", [
  box,
  sphere,
  cylinder,
  cone,
  torus,
  torusKnot,
  plane,
  capsule,
  icosahedron,
  dodecahedron,
  octahedron,
  ring,
]);

/* ────────────────────────────── 材质白名单 ────────────────────────────── */

/**
 * 颜色可以写主题语义名（`primary` / `accent` / `secondary` / `text` / `muted`），
 * 也可以写 `#RRGGBB`。语义名是让 3D 跟整体风格联动的关键，写死色值就联动不了。
 */
const colorToken = z
  .string()
  .describe("主题语义色 primary/accent/secondary/text/muted，或 #RRGGBB");

const bodyTone = z
  .boolean()
  .default(true)
  .describe(
    "true（默认）= 按「金属本体」处理：自动降饱和 + 压暗到统一亮度，" +
      "主题亮色也不会变成果冻。想要原始色值就传 false（比如自发光的小球）",
  );

/**
 * 材质用**单个对象 + type 枚举**，不用判别联合。
 *
 * 判别联合要求先想清楚 type 再挑字段，对 agent 是额外的认知负担；
 * 而且它想写的往往就是"蓝色、有点金属、毛一点"，不该被迫先给材质分类。
 * 这里所有字段都有默认值，只有 type 决定哪些字段**生效**（其余忽略，不报错）。
 */
export const materialSchema = z.object({
  type: z
    .enum(["standard", "physical", "basic"])
    .default("standard")
    .describe(
      "standard=PBR 通用金属/塑料（默认）；physical=玻璃/透射，要通透感用它；basic=不受光（线框 HUD、纯色剪影）",
    ),
  color: colorToken.default("accent"),
  metalness: z.number().min(0).max(1).default(0.4).describe("standard 有效：1=纯金属"),
  roughness: z.number().min(0).max(1).default(0.35).describe("standard/physical 有效：越小高光越锐"),
  emissive: colorToken.optional().describe("自发光颜色，给了才发光（辉光只吃够亮的部分）"),
  emissiveIntensity: z.number().min(0).max(4).default(1),
  transmission: z.number().min(0).max(1).default(0.9).describe("physical 有效：0=实心 1=全透明"),
  thickness: z.number().positive().default(0.4).describe("physical 有效：玻璃厚度感"),
  ior: z.number().min(1).max(2.5).default(1.5).describe("physical 有效：折射率"),
  wireframe: z.boolean().default(false).describe("basic 有效：线框"),
  side: z
    .enum(["front", "back", "double"])
    .default("front")
    .describe(
      "哪一面可见。平面/圆盘（plane、ring）默认只朝 +Z：把它们转成「朝下」后会整片消失——" +
        "地面光斑、贴地标线这类用法必须传 double",
    ),
  flatShading: z.boolean().default(false).describe("平面着色：多面体想棱角分明时开"),
  opacity: z.number().min(0).max(1).default(1),
  body: bodyTone,
});

/* ────────────────────────────── 关键帧 ────────────────────────────── */

/**
 * 可动画的标量键。和 freeform 的 `x/y/size/rotate/scale/opacity` 是同构的，
 * 只是把"平面"换成了"空间"。
 */
export const ANIM_KEYS = ["posX", "posY", "posZ", "rotX", "rotY", "rotZ", "scale", "opacity"] as const;
export type AnimKey = (typeof ANIM_KEYS)[number];

const animKeyShape = {
  posX: z.number().optional(),
  posY: z.number().optional(),
  posZ: z.number().optional(),
  rotX: deg.optional(),
  rotY: deg.optional(),
  rotZ: deg.optional(),
  scale: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
};

export const animSchema = z.object({
  at: z.tuple([z.number(), z.number()]).describe("起止帧 [start, end]（场景内帧号）"),
  from: z.object(animKeyShape).optional().describe("起点值，不写就用节点的基础值"),
  to: z.object(animKeyShape).optional().describe("终点值 —— **必须有至少一个**，否则这段动画等于没写"),
  ease: z
    .enum(["linear", "easeInOut", "easeOut", "easeIn"])
    .default("easeInOut")
    .describe("缓动，和 freeform 同一套"),
});

/* ────────────────────────────── 节点与场景 ────────────────────────────── */

export const nodeSchema = z.object({
  id: z.string().min(1).describe("节点 id，同一场景内唯一；子节点用 parent 引用它"),
  parent: z.string().optional().describe("父节点 id（做卫星、层级旋转用）。扁平数组 + parent 引用，不用嵌套"),
  geometry: geometrySchema,
  material: materialSchema.optional().describe("不写就是一层中性暗金属"),
  transform: z
    .object({
      position: vec3.default([0, 0, 0]),
      rotation: z.tuple([deg, deg, deg]).default([0, 0, 0]),
      scale: z.number().positive().default(1),
      /**
       * 非等比缩放。`scale` 只能整体放大，"同一束光摊成更长的椭圆"这种就必须分轴。
       * 实跑时卡住的正是这个：光斑要拉长，只有 scale 做不出来。
       */
      scaleXYZ: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).optional(),
    })
    .optional(),
  anim: z.array(animSchema).max(8).optional().describe("关键帧，最多 8 段"),
});

/* ────────────────────────────── 光源 ────────────────────────────── */

/**
 * 场景里的灯。和材质一样用**单对象 + type 枚举**，字段按 type 生效。
 *
 * 为什么需要它：`graph` 搭出来的东西默认是被 `look` 那四盏**固定方向**的灯照的，
 * 所以「地球的明暗面」永远不对着太阳 —— 位置在绕圈，光照却纹丝不动。
 * 科普片里这一条是致命的：观众看到的是「地球不转向太阳」，而全片的论点正是「歪着转」。
 */
export const lightSchema = z.object({
  id: z.string().optional(),
  type: z
    .enum(["ambient", "directional", "point", "spot"])
    .default("point")
    .describe(
      "ambient=均匀环境光（没有方向，别拿它当主光）；" +
        "directional=平行光（太阳在无穷远、不需要距离衰减时用它）；" +
        "point=点光（放在太阳位置，地球绕过来就会被照亮，最常用）；" +
        "spot=聚光（灯光打在小块区域上）",
    ),
  color: colorToken.default("text").describe("光色"),
  intensity: z
    .number()
    .min(0)
    .default(6)
    .describe(
      "强度。注意 three 的光是**物理单位**：point/spot 默认 decay=2，" +
        "照度按 1/距离² 衰减，所以距离 2 时要 20 上下才够亮；directional/ambient 不受距离影响，1~3 就够",
    ),
  position: vec3.default([0, 0, 0]).describe("灯的位置（point/spot 用；directional 只用它定方向）"),
  target: vec3.default([0, 0, 0]).describe("照向哪里（directional/spot 用，默认原点）"),
  angle: z.number().min(1).max(89).default(30).describe("spot 的光锥半角（度）"),
  penumbra: z.number().min(0).max(1).default(0.4).describe("spot 边缘软硬，0=硬边"),
  distance: z.number().min(0).default(0).describe("point/spot 的照射距离，0=无限"),
  decay: z
    .number()
    .min(0)
    .max(4)
    .default(2)
    .describe("衰减指数，2=物理正确；设 0 就没有距离衰减（调不好亮度时先试这个）"),
});

export const dslSchema = z.object({
  camera: z
    .object({
      position: vec3.default([0, 1.6, 6]).describe("相机位置"),
      target: vec3.default([0, 0, 0]).describe("看向哪里"),
      fov: z.number().min(10).max(120).default(42),
      orbit: z
        .object({ degPerSec: z.number().default(0) })
        .optional()
        .describe("绕 target 匀速环绕（度/秒），0=静止。只转相机，不动物体"),
    })
    .optional(),
  nodes: z.array(nodeSchema).min(1).max(48).describe("节点数组，扁平结构 + parent 引用"),
  lights: z
    .array(lightSchema)
    .max(8)
    .optional()
    .describe(
      "自定义光源。**给了它，look 的四盏方向光（主光/边光/补光）就全部关掉**，" +
        "只剩一点环境底光防止死黑 —— 也就是说这一场的明暗完全由这里的光决定。" +
        "典型用法：太阳在原点时，放一盏 type 为 point 的光在同一点，地球绕到哪儿就照到哪儿",
    ),
  particles: z
    .object({
      count: z.number().int().min(0).max(6000).default(800),
      spread: vec3.default([6, 4, 6]).describe("分布半径"),
      size: z.number().positive().default(0.06),
      color: colorToken.default("accent"),
      drift: z.number().min(0).default(0.3).describe("漂移速度，0=完全静止"),
      opacity: z.number().min(0).max(1).default(0.85),
    })
    .optional()
    .describe("一层粒子（一次 draw call）。想要「星云感」就只给粒子、不给节点"),
  post: z
    .object({
      bloom: z.number().min(0).max(2).default(1).describe("辉光强度倍数：1=当前 look 的默认值，0=关"),
      threshold: z.number().min(0).max(1).optional().describe("覆盖辉光阈值，不写就用 look 的"),
    })
    .optional(),
});

export type Scene3DDsl = z.infer<typeof dslSchema>;
export type DslNode = z.infer<typeof nodeSchema>;
export type DslMaterial = z.infer<typeof materialSchema>;
export type DslAnim = z.infer<typeof animSchema>;

/* ────────────────────────────── 结构性校验 ────────────────────────────── */

/**
 * 结构性问题必须在**进渲染之前**报出来，而不是让浏览器抛一个看不懂的堆栈。
 *
 * 校验三件 zod 表达不了的事：id 重复、parent 指向不存在的节点、parent 成环
 * （A→B→A 会让递归渲染直接爆栈）。
 */
export function dslIssues(spec: Scene3DDsl): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const n of spec.nodes) {
    if (ids.has(n.id)) issues.push(`节点 id 重复：「${n.id}」`);
    ids.add(n.id);
  }
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  for (const n of spec.nodes) {
    if (!n.parent) continue;
    if (!byId.has(n.parent)) {
      issues.push(`节点「${n.id}」的 parent「${n.parent}」不存在（可用：${[...ids].join("、")}）`);
      continue;
    }
    // 顺着 parent 往上走，走超过节点数就一定成环
    let cur: DslNode | undefined = byId.get(n.parent);
    let hops = 0;
    while (cur?.parent && hops++ <= spec.nodes.length) {
      if (cur.parent === n.id) {
        issues.push(`节点「${n.id}」与「${cur.id}」的 parent 关系成环`);
        break;
      }
      cur = byId.get(cur.parent);
    }
  }
  for (const n of spec.nodes) {
    for (const a of n.anim ?? []) {
      const hasTo = a.to && Object.values(a.to).some((v) => typeof v === "number");
      if (!hasTo) {
        issues.push(`节点「${n.id}」有一段关键帧只有 from 没有 to，这段动画不会生效`);
      }
      if (a.at[1] < a.at[0]) issues.push(`节点「${n.id}」的关键帧 at 写成 [${a.at.join(", ")}]，end 小于 start`);
    }
  }
  return issues;
}
