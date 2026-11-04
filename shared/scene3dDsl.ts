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
const vec2 = z.tuple([z.number(), z.number()]);
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

/**
 * 虚线圆环：用来画行星轨道。
 *
 * 为什么不用 torus：torus 是实心管，画轨道会变成"甜甜圈"，而且它绕不出虚线。
 * 这里直接生成一圈**扁平虚线段**（每段一个四边形，全部合进一个 geometry），
 * 一次 draw call、宽度可调、天然落在 XZ 平面 —— 挂到带倾角的枢轴节点下，
 * 环面就会自动跟行星轨道同倾角。
 */
const dashRing = z.object({
  type: z.literal("dashRing"),
  radius: z.number().positive().default(4).describe("轨道半径"),
  width: z.number().positive().default(0.03).describe("虚线粗细（世界单位）"),
  count: z.number().int().min(8).max(400).default(72).describe("一圈里有多少段虚线"),
  duty: z
    .number()
    .min(0.05)
    .max(0.95)
    .default(0.55)
    .describe("实线占每段的比例：0.5≈标准虚线，0.15≈细密点线"),
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
  /**
   * 扇区（度）。**透明环套在球体外面的必配**：整环的 mesh 中心和球同心，
   * 透明排序分不出先后，背半环会透过球体显示。拆两个半环后中心分居两侧，
   * 排序必然"先远后近"。
   */
  thetaStart: z.number().optional().describe("扇区起始角（度，0=+X 逆时针）；拆半环用"),
  thetaLength: z.number().min(0).max(360).optional().describe("扇区跨度（度）；不写=整环"),
});

/**
 * 纯枢轴：**不画任何东西**，只提供一个可以位移/旋转的父级。
 *
 * 为什么必须有：整体移动一组节点（整列火车、整台车床、机器人的上半身）只能靠父子层级，
 * 而在它之前「枢轴」只能用 `box: 0.001 + opacity 0` 硬凑 —— 那是个隐形实体：
 * 它照样进渲染队列、照样参与拾取、照样在编辑器大纲里显示成"一个方盒子"，
 * 用户点它一下才发现这是个假的。实跑时蒸汽机车就是这么搭的。
 *
 * `geometry` 整个省略时也按枢轴处理（见 nodeSchema），写 `{type:"group"}` 只是把
 * 「我确实想要个空节点」这件事说明白。
 */
const group = z.object({
  type: z.literal("group"),
});

export const geometrySchema = z
  .discriminatedUnion("type", [
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
    dashRing,
    group,
  ])
  .describe(
    "几何体：type 决定可用字段——sphere{radius,segments}、ring{innerRadius,outerRadius}、dashRing{radius,count,duty}、group=纯枢轴（不画东西，只带子节点）等，" +
      "全表见 list_scene_types(type:\"scene3d\")。**省略即 group**",
  );

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
  envMapIntensity: z
    .number()
    .min(0)
    .max(4)
    .default(1)
    .describe(
      "环境反射强度。金属的亮度**几乎全来自它**，比 metalness 更能直接影响观感：" +
        "金属发黑先抬这个（1.4~2.0），想要哑光压到 0.4",
    ),
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
  /**
   * 基础色贴图（外部图片）。只开这一个槽位：normalMap 要烘焙素材（agent 产不出来），
   * alphaMap 的镂空需求用带透明通道的 PNG 贴 map 就能覆盖（渲染层自动允许 transparent）。
   *
   * 有 map 时 color 强制白色、body 失效 —— three 里 map 与 color 是相乘关系，
   * body 的降饱和压暗会把整张贴图染成脏色（果冻球问题的翻版）。
   */
  map: z
    .object({
      src: z
        .string()
        .min(1)
        .describe("贴图地址：/assets/xxx（先 upload_asset）、https:// 或 data:；PNG 自带透明可做镂空"),
      repeat: z
        .tuple([z.number().positive(), z.number().positive()])
        .default([1, 1])
        .describe("UV 平铺次数，[2,1] = 横向重复 2 次"),
      offset: vec2.default([0, 0]).describe("UV 偏移，0–1 为一个完整周期"),
      rotation: deg.default(0).describe("UV 旋转（度），绕 center 转"),
      center: vec2.default([0.5, 0.5]).describe("UV 旋转中心，[0.5,0.5] 即贴图中心"),
    })
    .optional()
    .describe(
      "基础色贴图。贴上去之后 color 不再生效（材质按白底 × 贴图算）；" +
        "icosahedron/dodecahedron/octahedron 的 UV 是球面投影碎面，不能贴图（会整报错），" +
        "要低多边形风格用 sphere + flatShading + 低 segments",
    ),
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

/**
 * 轨迹曲线（每段一个）。不写 = 直线。
 *
 * `out` / `in` 是**相对直线方向**的偏移量（世界单位），不是切线本身：
 * - 全零或缺省 → 这一段精确直线，和没有 curve 完全一样；
 * - `[0,2,0]` → 这一段路径向上鼓出 2 个单位（起手朝上、收尾朝上）；
 * - 想让它"斜着绕过去"就给 out/in 不同的水平分量。
 *
 * 数学上是 Hermite：切线 = (终点−起点) + 偏移，所以偏移为 0 时切线就等于直线方向，
 * 速度由 `ease` 单独控制——"走哪条路"和"什么时候到"互不干扰。
 */
export const curveSchema = z
  .object({
    out: vec3.optional().describe("起点出切线偏移（相对直线方向，世界单位）"),
    in: vec3.optional().describe("终点入切线偏移（相对直线方向，世界单位）"),
  })
  .optional()
  .describe("轨迹曲线：out/in 是相对直线的偏移，全零=直线；物体位置与相机位置都生效");

export const animSchema = z.object({
  at: z.tuple([z.number(), z.number()]).describe("起止帧 [start, end]（场景内帧号）"),
  from: z.object(animKeyShape).optional().describe("起点值，不写就用节点的基础值"),
  to: z.object(animKeyShape).optional().describe("终点值 —— **必须有至少一个**，否则这段动画等于没写"),
  curve: curveSchema,
  ease: z
    .enum(["linear", "easeInOut", "easeOut", "easeIn"])
    .default("easeInOut")
    .describe("缓动，和 freeform 同一套"),
});

/* ────────────────────────────── 节点与场景 ────────────────────────────── */

export const nodeSchema = z.object({
  id: z.string().min(1).describe("节点 id，同一场景内唯一；子节点用 parent 引用它"),
  /**
   * 人给节点起的名字。
   *
   * 为什么必须有：编辑器的大纲里如果没有它，一屏全是 `n_3f2a`、`earth-group`
   * 这类 id，用户没法在十几个节点里认出"哪颗是土星"——点错三次之后就再也不想开这个面板了。
   * 渲染不读它，纯给人看（agent 写 graph 时顺手写上，人接手时省一半时间）。
   */
  label: z.string().optional().describe("节点显示名（大纲里显示，方便人认；不影响渲染）"),
  hidden: z.boolean().optional().describe("true = 连同子树不渲染（编辑器临时隐藏，数据仍在）"),
  locked: z.boolean().optional().describe("true = 编辑器里锁住，防误拖误删（渲染照常）"),
  parent: z.string().optional().describe("父节点 id（做卫星、层级旋转用）。扁平数组 + parent 引用，不用嵌套"),
  /**
   * 不写 = `{type:"group"}` 纯枢轴。
   *
   * 用 `.default()` 而不是 `.optional()`：渲染端、编辑器、校验器几十处都在读
   * `node.geometry.type`，做成可选就要在每一处加 `?.`，而"没有几何体"的语义
   * 本来就是"这是个枢轴"，给个具名默认值比让字段变成 undefined 干净得多。
   */
  geometry: geometrySchema
    .default({ type: "group" })
    .describe("几何体；**不写 = 纯枢轴（group，不渲染，只带子节点）**"),
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
      /**
       * 相机关键帧：让相机自己飞（推拉、摇移、对准某颗行星）。
       * 与节点动画同一套语法：{ at:[起,止], from:{...}, to:{...}, ease }。
       * 键：posX/posY/posZ = 相机位置；targetX/Y/Z = 看向的点；fov = 视场角。
       * 同一 key 的多段必须首尾相接、不重叠（边界帧 end = 下一段 start − 1）。
       */
      anim: z
        .array(
          z.object({
            at: z.tuple([z.number(), z.number()]),
            from: z
              .object({
                posX: z.number().optional(),
                posY: z.number().optional(),
                posZ: z.number().optional(),
                targetX: z.number().optional(),
                targetY: z.number().optional(),
                targetZ: z.number().optional(),
                fov: z.number().optional(),
              })
              .optional(),
            to: z
              .object({
                posX: z.number().optional(),
                posY: z.number().optional(),
                posZ: z.number().optional(),
                targetX: z.number().optional(),
                targetY: z.number().optional(),
                targetZ: z.number().optional(),
                fov: z.number().optional(),
              })
              .optional(),
            ease: z.enum(["linear", "easeInOut", "easeOut", "easeIn"]).default("easeInOut"),
            curve: curveSchema,
            /**
             * 跟随某个节点：这一段的 posX/Y/Z 与 targetX/Y/Z 全部变成**相对该节点**的偏移。
             *
             * 行星一直在公转，用绝对坐标写"贴在地球旁边"的镜头，过几帧地球就跑出画了。
             * 加了 follow，相机就钉在节点上，节点动到哪儿镜头跟到哪儿；推拉环绕仍然靠
             * 段内的 from→to。切换 follow 的帧必须让前后两段的绝对位置对齐，否则会跳。
             */
            follow: z
              .string()
              .optional()
              .describe("跟随节点 id：本段的 pos/target 解释为相对该节点世界坐标的偏移"),
            /**
             * 段内**锁定看向**某个节点（机位自由、镜头死盯目标）。
             *
             * 和 follow 的分工：follow 管"相机在哪"（位置参考系），lookAt 管"镜头朝哪"。
             * 两者可同时给（边跟着飞边盯着它），也可以给不同节点（跟着 A 移动、却看向 B）。
             *
             * 三条语义，和渲染端 dslCamera 严格一致：
             * 1. 段内 target = 该节点**当前帧**的世界位置 + lookAtOffset，targetX/Y/Z 被忽略；
             * 2. 段结束按 hold 语义持续（最后一段永不退出 = 锁到片尾）；
             * 3. **退出时不必手写目标点**：下一段不给 lookAt、也不给 from 的 target，
             *    起点会自动落在"退出帧那一刻的锁定点"上，镜头不会甩。
             */
            lookAt: z
              .string()
              .optional()
              .describe(
                "锁定看向的节点 id：本段 target 强制 = 该节点世界位置 + lookAtOffset（targetX/Y/Z 失效）",
              ),
            lookAtOffset: vec3
              .optional()
              .describe("锁定点偏移（世界轴向），看向头顶/脚底用 [0,0.6,0]"),
          }),
        )
        .max(240)
        .optional()
        .describe("相机运镜关键帧（位置/看向点/视场角），用于推拉摇移与对准某颗行星"),
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
  /**
   * 世界（背景）。**不是主题色**。
   *
   * 原来的做法是直接把主题的 `background` 当 3D 世界底色 —— 暗色主题下就是一张纯黑纸，
   * 物体像贴在黑布上：没有空气感、地平线不存在、远景和主体糊成一片。
   * 成熟软件里"世界"是一个独立的东西（Blender 的 world、C4D 的背景对象），
   * 它有自己的一套亮度：天顶偏暗、地平线偏亮，中间带一道漫射光带。
   *
   * `auto` 按主题的**明暗**挑一套中性色（色相固定，不跟主题色走）：
   * 暗主题给深蓝灰的夜，浅主题给冷白的天光。
   */
  world: z
    .object({
      mode: z
        .enum(["auto", "gradient", "color", "image"])
        .default("auto")
        .describe(
          "auto=按主题明暗自动挑中性色；gradient=用 top/bottom 自己给；color=纯色；" +
            "image=用一张等距柱状全景图（.hdr / .jpg）当世界",
        ),
      color: colorToken.optional().describe("mode=color 时的纯色"),
      top: colorToken.optional().describe("天顶色（mode=gradient）"),
      bottom: colorToken.optional().describe("地平线色（mode=gradient）"),
      glow: colorToken.optional().describe("地平线漫射光带的颜色（on gradient 才生效）"),
      image: z
        .string()
        .optional()
        .describe(
          "等距柱状全景图（比例 2:1）。**优先 .hdr**：普通 JPG 只有 0–1 的亮度，" +
            "当照明时没有太阳那种高动态，金属会发闷。站内素材写 /assets/…（先 upload_asset）",
        ),
      imageLighting: z
        .boolean()
        .default(true)
        .describe(
          "同一张全景图同时当环境光照（IBL）。**这是「像真的」的最大一步**：" +
            "照片里有真实的太阳方位、天空梯度、地面反光，物体是被「那个地方」照亮的",
        ),
      imageRotation: z
        .number()
        .default(0)
        .describe("背景绕 Y 轴转（度）。用来把太阳/地平线挪到想要的方位"),
      imageIntensity: z
        .number()
        .min(0.2)
        .max(2)
        .default(1)
        .describe(
          "背景亮度倍数。**主体偏暗时先降这个**（0.7–0.85），不要降曝光：" +
            "曝光一降，物体上辛苦打的光也一起没了。真实拍摄就是这么做的——按主体曝光，天空过曝或压暗",
        ),
      envIntensity: z
        .number()
        .min(0.05)
        .max(3)
        .optional()
        .describe(
          "全景图当照明时的环境强度（不写=1）。**城市夜景/室内这类「本身就很亮」的全景图**给 0.2–0.4：" +
            "HDR 里的灯箱、玻璃幕墙是几千尼特的实测值，全强度照进来整张画面直接过曝",
        ),
      haze: z
        .number()
        .min(0)
        .max(1)
        .default(0.35)
        .describe(
          "空气透视（雾）浓度，0=关。真实感的一大半来自它：远处的东西必须淡进背景，" +
            "否则再好的光照也像「把模型摆在黑房间里」。天文/星空场景给 0",
        ),
      vignette: z.number().min(0).max(1).default(0.32).describe("四角压暗（屏幕空间），0=关"),
    })
    .optional()
    .describe("世界背景：独立于主题的渐变天空 / 全景图 + 空气透视，解决「背景乌漆麻黑」"),

  /**
   * 自动铺一块地面。
   *
   * 接触阴影是「真实」最便宜的那一半：物体有没有落地、零件之间有没有分界，
   * 全靠投影和遮挡。没有地面时，一切都在虚空里飘着。
   */
  ground: z
    .object({
      y: z.number().default(0).describe("地面高度（世界单位）"),
      /**
       * `solid` = 实体地面（有自己的颜色，能反射环境）；`shadow` = **只留影子**。
       *
       * 用全景图当世界时必须用 `shadow`：照片里本来就有一片真实的地面，
       * 再铺一块实体平面，等于在地上盖了块棕色塑料布 —— 照片的地平线、草的纹理全没了。
       * `shadow` 材质是透明的，只在有阴影的地方变暗，看起来就像"影子落在照片的地上"。
       */
      mode: z.enum(["solid", "shadow"]).default("solid").describe("solid=实体地面；shadow=只接阴影（配全景图用）"),
      color: colorToken.default("#191C22"),
      /** shadow 模式下的阴影浓度（0–1），太黑会显脏 */
      shadowOpacity: z.number().min(0).max(1).default(0.55),
      roughness: z.number().min(0).max(1).default(0.72),
      metalness: z.number().min(0).max(1).default(0.06),
      size: z.number().positive().default(160).describe("边长，给大一点让边缘出画"),
      shadow: z.boolean().default(true).describe("接收投影（关掉就只剩一块底色）"),
    })
    .optional()
    .describe("自动地面：接投影、给反射底色，让物体「落地」"),

  post: z
    .object({
      bloom: z.number().min(0).max(2).default(1).describe("辉光强度倍数：1=当前 look 的默认值，0=关"),
      threshold: z.number().min(0).max(1).optional().describe("覆盖辉光阈值，不写就用 look 的"),
      /**
       * 色调映射。默认开 ACES：真实世界的动态范围远大于屏幕，
       * 不做滚降就只能"高光切白、暗部糊死"（这正是不开时的观感）。
       *
       * 曝光 1.25 是配 ACES 的补偿系数：ACES 在中灰附近约压 20%，
       * 乘 1.25 之后中间调回到原位，只有高光被压平 —— 白拿的层次。
       */
      tonemap: z
        .enum(["aces", "none"])
        .default("aces")
        .describe("aces=电影感滚降（默认）；none=逐像素还原色值（要和 2D 精确对色时才用）"),
      exposure: z.number().min(0.4).max(3).default(1.25).describe("曝光（仅 tonemap=aces 时生效）"),
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
  /**
   * 贴图的两条结构校验（zod 表达不了的）：
   *
   * 1. 三个多面体的 UV 是把顶点三维坐标**球面投影**成二维得到的——贴图必然碎成
   *    三角形、极点挤压成针尖、接缝断裂，而且**不随任何参数变好**。agent 看不到
   *    渲染结果，只会盲试烧渲染轮次，所以必须在这里拦死，并把需求引到能做对的
   *    路径上（sphere + flatShading + 低 segments，UV 是正经经纬展开）。
   * 2. src 的形态白名单：站内素材是 /assets/ 前缀（staticFile 解析），http(s)/data
   *    原样用——和 image/iso/freeform 的 resolveSrc 约定一致。相对路径和 ../
   *    在渲染端要么 404 要么越界，提前报出来。
   */
  const POLY = new Set(["icosahedron", "dodecahedron", "octahedron"]);
  for (const n of spec.nodes) {
    const map = n.material?.map;
    if (!map) continue;
    if (POLY.has(n.geometry.type)) {
      issues.push(
        `节点「${n.id}」是 ${n.geometry.type}，它的 UV 是球面投影碎面，贴图会撕裂——` +
          `不能贴图。要低多边形地球风格：用 sphere + flatShading + 低 segments（UV 是正规的）`,
      );
    }
    const src = map.src;
    const ok =
      /^(https?:)?\/\//.test(src) || src.startsWith("data:") || /^\/assets\//.test(src);
    if (!ok) {
      issues.push(
        `节点「${n.id}」的贴图 src「${src}」不合法（可用：/assets/xxx 先 upload_asset、https://、data:）`,
      );
    }
  }
  /**
   * 相机引用的节点 id（follow / lookAt）。
   *
   * 这两条都必须在这里拦死：渲染端对"节点不存在"只能静默降级（follow 退化成原点偏移、
   * lookAt 退回上一段的 target），成片里表现为"镜头没跟住 / 没锁上"，而 agent 从
   * 渲染结果完全看不出是 id 拼错了一个字符 —— 它只会去改运镜参数，越改越远。
   */
  for (const a of spec.camera?.anim ?? []) {
    const span = `第 ${a.at[0]}–${a.at[1]} 帧`;
    if (a.follow && !ids.has(a.follow)) {
      issues.push(`相机${span}要跟随节点「${a.follow}」，但场景里没有这个节点（可用：${[...ids].join("、")}）`);
    }
    if (a.lookAt && !ids.has(a.lookAt)) {
      issues.push(`相机${span}要锁定节点「${a.lookAt}」，但场景里没有这个节点（可用：${[...ids].join("、")}）`);
    }
  }
  return issues;
}

/* ────────────────────────────── 软提示（不拦截写入） ────────────────────────────── */

/**
 * 「能写进去，但成片大概率不好看」的问题。**不能混进 dslIssues**：
 * 那里是硬拦截（写完就 throw），而这些是"骨架搭到一半"的正常中间态。
 *
 * 现在只放三类，都是实测翻过车的：
 *
 * 1. **空枢轴**：agent 想整体移动一组节点，会先建 group 再加子节点。中间那一瞬间
 *    它就是空的，写不进去等于不让它搭骨架 —— 但要提示它"这么渲出来什么都没有"。
 * 2. **枢轴上的材质**：group 没有表面，material 无处施加。不报的话 agent 会反复调色。
 * 3. **自定义灯把场景压黑**：给了 `lights` 就撤掉 look 的四盏方向光，同时环境反射
 *    只剩 55%。金属材质的亮部**几乎全来自环境反射**，所以「metalness 0.9 + ambient 0.55」
 *    这种看着挺亮的配置，渲出来是近剪影（蒸汽机车首版实测，只能靠抬 ambient 到 1.6 救）。
 *    这条只给数值建议，不替 agent 改值 —— 天文场景就是要压暗夜面，硬提亮会毁掉昼夜对比。
 */
export function dslWarnings(spec: Scene3DDsl): string[] {
  const out: string[] = [];
  const hasChild = new Set(spec.nodes.map((n) => n.parent).filter(Boolean) as string[]);
  for (const n of spec.nodes) {
    const pivot = !n.geometry || n.geometry.type === "group";
    if (!pivot) continue;
    if (!hasChild.has(n.id)) {
      out.push(
        `节点「${n.id}」是纯枢轴（group）但下面没有任何子节点——它本身不渲染，这一幕里看不到它。` +
          `要么给它几何体，要么把要一起动的节点 parent 到它下面`,
      );
    }
    if (n.material) {
      out.push(`节点「${n.id}」是纯枢轴（group），material 没有表面可施加，不会生效`);
    }
  }

  const lights = spec.lights ?? [];
  if (!lights.length) return out;
  /**
   * 全景图当照明时，环境反射是**满强度**（`world.mode=image` 且没关 imageLighting）。
   *
   * 这时候不能再套下面那套「环境只剩 55% → 抬 ambient」的规则：照片里的太阳
   * 本身就是主光，再让 agent 把 ambient 抬到 1.2–2.0，画面会整体发灰发平 ——
   * 等于用一层灰光盖掉 HDRI 的全部方向感。
   */
  const imageLit = spec.world?.mode === "image" && spec.world.imageLighting !== false;
  const sum = (type: string) =>
    lights.filter((l) => l.type === type).reduce((s, l) => s + (l.intensity ?? 0), 0);
  const ambient = sum("ambient");
  const directional = sum("directional");
  const hasPointish = lights.some((l) => l.type === "point" || l.type === "spot");
  const metals = spec.nodes.filter(
    (n) => (n.material?.type ?? "standard") !== "basic" && (n.material?.metalness ?? 0.4) >= 0.6,
  );
  if (!ambient) {
    out.push(
      `自定义灯光里没有 ambient：背光面只剩 0.35 的内置兜底，形体容易糊成一片。` +
        `想看清暗部就加 {type:"ambient", color:"…", intensity:1.2}（天文场景要暗夜面可以不加）`,
    );
  } else if (!imageLit && metals.length && ambient < 1.0) {
    out.push(
      `有 ${metals.length} 个金属节点（metalness ≥ 0.6，如「${metals[0].id}」），但 ambient 只有 ${ambient}：` +
        `金属的亮部几乎全来自环境反射，而自定义灯场景的环境反射只保留 55% —— 渲出来容易是剪影。` +
        `把 ambient 抬到 1.2–2.0，或把 metalness 降到 0.4–0.6（想要亮铬感就走前者）`,
    );
  }
  if (!imageLit && !directional && !hasPointish && ambient < 0.6) {
    out.push(
      `这组灯既没有 directional/point/spot，ambient 也只有 ${ambient}：整场只剩一层平光，` +
        `东西会是一块没有明暗的剪影。至少补一盏 directional（intensity 2 上下）做主光`,
    );
  }
  return out;
}
