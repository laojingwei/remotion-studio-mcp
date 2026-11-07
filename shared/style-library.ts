/**
 * 风格库（341 条外部风格提示词）的类型与分类常量，前后端共用。
 *
 * 为什么单独一个文件：面板要按用途筛选、agent 要按用途检索、脚本要按用途建目录，
 * 三处必须用同一份定义，否则"文件夹名改了但筛选项没改"这类错会静默发生。
 *
 * 重要边界：这里的是**参考风格**，不是 `server/styles/<slug>.md` 那 43 个可 `apply_style`
 * 的内置风格。前者是「画风文字描述 + 一张静帧」，后者是「palette/font/radius 结构化预设」。
 * 两者混用会让用户以为勾了就能一键套上，实际做不到——所以面板里是分开的两个分区。
 */

/** 用途轴：决定库里哪个文件夹、面板哪个筛选项、agent 按什么检索 */
export type StyleUse = "structure" | "technique" | "texture" | "character" | "layout" | "kit";

export type StyleUseDef = {
  id: StyleUse;
  /** 物理文件夹名（server/skills/style-library 下一级）。改名只改这里，索引重建后自动跟随 */
  dir: string;
  label: string;
  hint: string;
  /** 占位卡的色相：无静帧时按用途给一个固定底色，一类一个颜色，扫一眼能分辨 */
  hue: number;
};

export const STYLE_USES: StyleUseDef[] = [
  { id: "structure", dir: "01-整片结构", label: "整片结构", hint: "整段视频怎么动、怎么剪、怎么讲", hue: 212 },
  { id: "technique", dir: "02-手法", label: "手法", hint: "单一机制：字雨、打字、粒子聚形、线墨、光效", hue: 274 },
  { id: "texture", dir: "03-画面质感", label: "画面质感", hint: "美术、年代、媒介质感——画面长什么样", hue: 28 },
  { id: "character", dir: "04-角色画风", label: "角色画风", hint: "角色与画法，含东方画风", hue: 342 },
  { id: "layout", dir: "05-版式配色", label: "版式配色", hint: "配色 + 字体 + 版式的整套搭配", hue: 162 },
  { id: "kit", dir: "06-成套方案", label: "成套方案", hint: "来自开源项目的完整做法，可整段借用", hue: 96 },
];

export const styleUseOf = (id: string): StyleUseDef | undefined => STYLE_USES.find((u) => u.id === id);
export const styleDirOf = (use: StyleUse): string => styleUseOf(use)!.dir;

/**
 * 气质轴：用户在面板里筛的就是这一层。
 *
 * 为什么这一层最重要：用户挑风格时脑子里是形容词（"想要压抑一点的"），不是编号也不是
 * "A-G 代码样片"。自动初判来自词表（见 server/styleLibrary.service.ts 的 MOOD_HINTS），
 * 面板里允许人工改，改过的写进 data/style-overrides.json —— 只存 diff，不给 341 条逐条打标。
 */
export const STYLE_MOODS = [
  "克制",
  "活泼",
  "高级",
  "温暖",
  "科技",
  "复古",
  "东方",
  "荒诞",
  "压抑",
  "浪漫",
] as const;

export type StyleMood = (typeof STYLE_MOODS)[number];

/** 一条风格 */
export type StyleItem = {
  id: string;
  name: string;
  /** 所属用途（由所在文件夹推导，不是手写） */
  use: StyleUse;
  /** 用途文件夹名，面板显示用 */
  dir: string;
  /** 原始系列，如 "A-G"、"O"；保留出处，方便维护与溯源 */
  series: string;
  /** 系列内的子类，如 "A 字" */
  sub?: string;
  /** - 长什么样：（341 条里 287 条有） */
  summary?: string;
  /** - 适合：（193 条有） */
  fit?: string;
  /** - 关键词：（124 条有） */
  tags: string[];
  moods: StyleMood[];
  /** 相对 style-library 的 webp 路径；没有静帧为 null */
  still: string | null;
  /** 相对 style-library 的 md 路径 */
  file: string;
  promptChars: number;
  /** md 的 sha1 前 12 位，增量重建用 */
  mdSha: string;
};

export type StyleLibraryIndex = {
  version: 1;
  builtAt: string;
  /** 相对工程根，诊断用 */
  sourceRoot: string;
  total: number;
  withStill: number;
  items: StyleItem[];
};

/** 内置 43 个风格的展示项：面板下半区用，和 341 条分区显示 */
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

export type StylePicks = {
  at: string;
  projectId?: string;
  /** 参考风格（341 条）的编号：**要翻译**成 theme/版式后才能落地 */
  ids: string[];
  /**
   * 内置风格（43 个）的 slug：带 palette/font 预设，**可以直接 apply_style**。
   *
   * 为什么和 ids 分开存而不是混成一个数组：这两者对 agent 的动作完全不同——
   * 混在一起存，agent 就得先猜"这个编号是参考还是内置"，猜错的代价是拿一行
   * palette 去当提示词翻译，或者反过来把一段画风描述当 slug 传给 apply_style。
   */
  builtinSlugs?: string[];
  note?: string;
};

/** 面板查询参数（前后端同一份，避免参数名对不上） */
export type StyleQuery = {
  q?: string;
  use?: StyleUse | "all";
  mood?: StyleMood | "all";
  withStill?: boolean;
  limit?: number;
};
