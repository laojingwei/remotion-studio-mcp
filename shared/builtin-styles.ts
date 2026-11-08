/**
 * 内置风格（`server/styles/`，77 个）与面板勾选的类型，前后端共用。
 *
 * 这里原来还装着一整套「参考风格」：341 条画风提示词、用途轴（6 类）、气质轴（10 种）。
 * 那批已经拆完了 —— 能升级的并进了内置风格（保证能 apply_style）和提示词库，
 * 其余的删了。所以这个文件现在只服务一件事：**能一键套的风格，以及用户挑了哪几个**。
 *
 * 留一条教训：当时"参考风格"和"内置风格"分成两个分区，是因为前者只能当文字参考、
 * 后者有 palette/font 预设。这个区分本身没错，错在**同一批东西被整理了两遍**——
 * 参考风格里的画法被提炼成内置风格，两边于是长期重复。现在只有一份。
 */

/**
 * 样张的构图模板。
 *
 * 为什么不是「每个风格存一整段 freeform 元素数组」：77 段硬编码坐标没法维护，
 * 调一个间距要改 77 处，而且手写坐标一定会翻车（实测 8 个样本里有 2 个首版就错了：
 * 方块堆到标题上、点云纵向塌成一条细线）。模板负责坐标与排版，风格只填参数。
 *
 * 每个模板对应一种「视觉语法」，不是一个花哨样式：
 * · `giantType`  字号本身是风格（瑞士/编辑/构成主义）
 * · `stack`      一个物件 = 一个写明数量，可数（数据实体化/积木）
 * · `halftone`   明暗由网点直径决定（半调/丝印）
 * · `pointfield` 点是测量值不是装饰（点云/测绘）
 * · `engrave`    黑是版、白是刻掉的（木刻/铜版）
 * · `catalogue`  编号 + 条目，靠"第几张"推进（图鉴/清单）
 * · `readout`    读数 + 准星（全息/卫星/测控）
 * · `collage`    论点由版面倾角给出（构成主义/达达）
 */
export type ShowcaseTemplate =
  | "giantType"
  | "stack"
  | "halftone"
  | "pointfield"
  | "engrave"
  | "catalogue"
  | "readout"
  | "collage"
  // ── 第二批：覆盖"画面上得有个东西"的那几类 ──
  // 前 8 个都假定"信息就是内容"（字/数/点/网点）。但插画、纸艺、像素、老片、材质
  // 这五类的看点是"画面上那个东西"，纯排版演示它们等于什么都没说。
  | "figureGrid" // 插画/卡通/扁平：一组图形占满画面
  | "layeredPaper" // 纸艺/剪纸/立体书：多层纸片前后错落
  | "pixelGrid" // 像素/低多边/终端：方块阵列拼出的形
  | "vintageFrame" // 老片/CRT/默片：放映窗 + 颗粒 + 上下遮幅
  | "singleObject"; // 材质/3D/显微/建筑：一个大物件 + 标注行

/**
 * 一个风格的「样张配方」。
 *
 * 只说**要表达什么**，坐标交给模板。这样 77 个风格只需要填文案与数量，
 * 以后换配色、调间距只改模板一处。
 */
export type Showcase = {
  template: ShowcaseTemplate;
  /** 主文案，`\n` 换行（最多 3 行）。必须贴这个风格的题材，不是"示例文字" */
  title: string;
  /** 需要换 primary 色的强调词（可选） */
  emphasis?: string;
  /** 一句说明 / 副标 */
  sub?: string;
  /** 条目文案：`catalogue` 用 3–4 条，`stack` 用左右两组标签 */
  items?: string[];
  /** 数值对：`readout` 用前 3 个；`stack` 用左右两组的数值 */
  values?: { value: string; label: string }[];
  /** `stack` 用：每堆几个。它决定"数得出多少"，不是装饰参数 */
  count?: number;
  /**
   * 布局变体（0–4）。同一个模板服务多个风格时，**布局必须跟着变**——
   * 21 个风格共用一套图形位置，出来就是"新的千篇一律"（实测过：8 格只有配色不同）。
   * 按风格性质分：绘画类散落、纹样类对称、材质类靠大三角、卡通类横向排列。
   */
  variant?: number;
  /** 底部注脚：比例尺 / 出处 / 编号 */
  note?: string;
  /**
   * 这个风格必须靠真实影像/照片才成立、而样张里没有时，**画面上明写这句**。
   *
   * 为什么宁可在图上写"此处需真实影像"也不放一张假图：用户挑风格时看的是效果，
   * 一张 AI 生成的假卫星图会让他以为这风格"能做出那种影像"，成片时才发现不能。
   * 空着是诚实的，假图是有害的。
   */
  placeholder?: string;
  /**
   * 主标题字号系数（0–1）。**不写进 presets.json**，只由 `adaptShowcaseToBrief` 在
   * probe_style 把风格文案换成用户 brief 时算出来：模板里的字号是按 4–6 字的招牌句定的，
   * 用户的标题常有十来个字，原字号下会换行并压住下面的元素（实测过）。
   */
  titleScale?: number;
};

/** 内置风格的展示项：面板卡片用 */
export type BuiltinStyleItem = {
  slug: string;
  name: string;
  hasPreset: boolean;
  /** 有静帧才有：相对 server/styles 的 webp */
  still: string | null;
};

/**
 * 内置风格的详情（右抽屉）。
 *
 * 字段和后端 `StylePreset` 一一对应，但**刻意独立声明**：这份要发给浏览器，
 * 不能因为后端加了内部字段就悄悄扩大前端暴露面。改这里时对照 server/styles.service.ts。
 */
export type BuiltinStyleDetail = {
  slug: string;
  name: string;
  hasPreset: boolean;
  preset: {
    name: string;
    palette: Record<string, string>;
    font: { heading: string; body: string };
    radius: number;
    motion?: string;
    transition?: { type: string; durationInFrames: number };
    sceneBias?: string[];
    subtitle?: Record<string, unknown>;
    forbidden?: string[];
  } | null;
  /** 风格规则正文（本质 / 辨识信号 / 最俗的版本 / 配色 / 字体 / 运动 / 坑） */
  rules: string;
};

/**
 * 面板里勾选的风格。
 *
 * 只剩一组了：`builtinSlugs`。以前还有一组 `ids`（参考风格编号，要翻译才能落地），
 * 两组分开存是因为 agent 对它们的动作不同；参考风格删掉之后，这个区分也没有意义了。
 */
export type StylePicks = {
  at: string;
  projectId?: string;
  /** 内置风格的 slug：带 palette/font 预设，可以直接 apply_style */
  builtinSlugs: string[];
  note?: string;
};
