/**
 * 场景的「性质」分类 —— 与版式定义分开的一张表。
 *
 * 为什么单独一个文件：设计锁（designLock）要读它，场景元信息（sceneMetas）也要读它，
 * 而 sceneMetas 依赖 zod 与 freeform，designLock 不该为了一个 Set 去拖那一串。
 */

/**
 * 动效场景：画面主体是**运动本身**（光晕、颗粒、漏光、逐字弹跳、遮罩上翻），
 * 不是版面。它们不参与「一屏文字元素数 / 标题字号」这类版式审计 ——
 * 一个逐字动画天然有几十个 span，按版面口径算就是每条必违规。
 *
 * 注意：它们仍然参与**转场审计**（转场时长与白名单跟版式无关）。
 */
export const MOTION_SCENE_TYPES = new Set([
  "glow",
  "grain",
  "lightleak",
  "kinetic",
  "maskreveal",
  // 第二批：文字强调
  "typewriter",
  "counter",
  "gradienttext",
  "scramble",
  // 第二批：背景氛围（本来就一堆粒子/光斑，按版面口径算必违规）
  "bokeh",
  "sparks",
  "vhs",
  // 第三批：文字强调（都是"一句/一行在动"，字号由版式自己按字长算）
  "highlight",
  "stomp",
  "wipe",
  "marquee",
  // 第三批：背景氛围
  "spotlight",
  "gridflow",
  "rain",
  "liquid",
  // 第五批：粒子氛围
  "confetti",
  "snow",
  "fireworks",
  "smoke",
  // 第六批
  "wave",
  "slot",
  "matrix",
  // M3：3D 场景当氛围层（BACKDROP 里有它，MOTION 漏了同步——子集校验一直挂着）
  "scene3d",
]);

export const isMotionScene = (type?: string): boolean =>
  !!type && MOTION_SCENE_TYPES.has(type);

/**
 * 「自由排版」幕：freeform 自由画布，或任何显式声明 layoutFree 的幕。
 *
 * 这是动画工具不是 PPT——字雨、落字、文字海、文字飞出画面都是正常设计语言：
 * 元素几十个、字号由动画决定、文字落出去完全不回来。对这些幕做「一屏几个字 /
 * 字号档位 / 出框 / 安全区」的版面审计就是条条必违规，所以直接豁免
 * （设计锁 / check_project 竖屏构图与安全区 / add_element 宽度提醒都看这个函数）。
 * freeform 天然就是自由排版，不用声明；其它类型 agent 想造假效，
 * update_scene(sceneId, { layoutFree: true }) 一行声明，审计回执会记账让用户看得见。
 */
export const isLayoutFreeScene = (s?: { type?: string; layoutFree?: boolean }): boolean =>
  !!s && (s.layoutFree === true || s.type === "freeform");

/**
 * agent 默认能查到的**内置**场景类型。
 *
 * 为什么要有这张表：78 个内置版式是给人挑的骨架（标题页/柱状图/价格表…），
 * agent 一看清单就顺手挑一个，画面立刻被锁进既有骨架，自由发挥反而没了。
 * 默认只把"能力型"和"运动型"场景交给 agent：
 *
 *   - MOTION_SCENE_TYPES = 动效类 15 + 氛围类 12 + 3D（scene3d）；
 *   - iso：等轴测图解，和 3D 一样是能力型场景（用户明确要求不隐藏）；
 *   - freeform：自由画布；empty：空白场景。
 *
 * 其余固定版式默认隐藏，但**没有从注册表里删**——老工程还要渲染、
 * 编辑器还要能选、用户点名时 agent 也还能查字段。可见性只是清单上的标签。
 * 插件场景不在这张表里：它们由 `jsonToSceneMeta` 单独打 `agentVisible: true`。
 */
export const AGENT_VISIBLE_BUILTIN_TYPES = new Set<string>([
  ...MOTION_SCENE_TYPES,
  "iso",
  "freeform",
  "empty",
]);

export const isAgentVisibleBuiltinType = (type?: string): boolean =>
  !!type && AGENT_VISIBLE_BUILTIN_TYPES.has(type);

/**
 * 可以当「氛围层」叠在版式底下的动效类型（Scene.backdrop.type 只能填这些）。
 *
 * 只有纯氛围的类型在名单里。带正文的那几个（打字机 / 数字滚动 / 渐变字 / 乱码 /
 * 荧光扫亮 / 冲击字 / 色带擦除 / 跑马灯）本身有字，垫在别的版式下面会同时出现两套字
 * —— 那不是"氛围"，是事故。
 *
 * 为什么单独一张表而不是复用 MOTION_SCENE_TYPES：
 * MOTION 是"不参与版面审计"的性质，BACKDROP 是"能不能当背景"的能力，
 * 两者只是部分重合，语义不同，会一直分叉（荧光扫亮是 MOTION 但不是 BACKDROP）。
 */
export const BACKDROP_TYPES = [
  // 第一批 / 第二批
  "glow",
  "grain",
  "lightleak",
  "bokeh",
  "sparks",
  "vhs",
  // 第三批：没有正文，纯氛围
  "spotlight",
  "gridflow",
  "rain",
  "liquid",
  // 第五批：粒子氛围
  "confetti",
  "snow",
  "fireworks",
  "smoke",
  // 第六批：只有 matrix（wave/slot 带正文，垫在别的版式下会出现两套字）
  "matrix",
  /**
   * 3D 场景当氛围层。层次由 place / z 决定，和别的氛围层一样：
   * - 垫在版式**下面**：画不透明底色，当背景用（辉光有底才成立）；
   * - 盖在内容**上面**：自动切成透明画布，否则整块把字盖住。
   *
   * 用法：`backdrop: { type: "scene3d", props: { preset: "particle-field" } }`。
   * 垫底下时它比"整幕 3D + 底部叠字"少一整类遮挡问题（3D 退成背景，字永远在前）。
   */
  "scene3d",
] as const;

export type BackdropType = (typeof BACKDROP_TYPES)[number];

/**
 * 有「完整一轮」概念的氛围类型 —— 只有它们支持 mode="once"（走完一轮就停）。
 *
 * 漏光是"扫过一条带子"；光晕/散景/流体是永续漂移，颗粒/磁带逐帧随机，
 * 网格是一直往前流的，它们都没有"一轮"可言，给了 once 也只是原地定住，
 * 用户会以为设置没生效。所以面板上只对这张表里的类型显示"播放次数"。
 */
export const PERIODIC_BACKDROP_TYPES = new Set(["lightleak", "fireworks"]);

export const isPeriodicBackdrop = (type?: string): boolean =>
  !!type && PERIODIC_BACKDROP_TYPES.has(type);

export const isBackdropType = (type?: string): boolean =>
  !!type && (BACKDROP_TYPES as readonly string[]).includes(type);
