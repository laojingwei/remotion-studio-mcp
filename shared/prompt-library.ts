/**
 * 提示词库的类型与分类常量，前后端共用。
 *
 * 库里装的是两种颗粒度的东西，**同一个面板、两套编号**：
 * · **整片配方（PM 段，153 条）**——答"这条片子怎么拍"：目标、三幕结构、动效铁律、禁止项。
 * · **单技法（TK 段，26 条）**——答"这个效果怎么做"：字雨、粒子聚形、图表生长，
 *   一条只有几十秒，可以塞进任何一条片子的某一幕。
 *
 * 为什么不合并成一种：配方是骨架，技法是零件。用配方的方式用技法（照它拍一整片）会空，
 * 用技法的方式用配方（塞进一幕）会崩。所以编号分两段、面板动作也分两种。
 *
 * 与风格库（`server/styles/`）的关系：风格答"画面长什么样"（画风），
 * 这里答"片子怎么拍 / 效果怎么做"（结构）。一个是形容词，一个是动宾短语，不要合并。
 *
 * 分类轴是"片子体裁"，由 md 所在文件夹推导（文件夹名是唯一事实来源）。
 * `scripts/build-prompt-library.mts` 也读这份定义，改文件夹只改这里。
 */

export type PromptGenre =
  | "promo"
  | "reel"
  | "explainer"
  | "story"
  | "scene3d"
  | "ui"
  | "lab"
  | "technique";

export type PromptGenreDef = {
  id: PromptGenre;
  /** 物理文件夹名（server/skills/prompt-library 下一级） */
  dir: string;
  label: string;
  hint: string;
  /** 占位卡色相：没有缩略图时按体裁给一个固定底色 */
  hue: number;
};

export const PROMPT_GENRES: PromptGenreDef[] = [
  { id: "promo", dir: "01-产品宣传", label: "产品宣传", hint: "把一件东西讲成值得要的样子：宣传片、上线片、路演", hue: 212 },
  { id: "reel", dir: "02-动效集锦", label: "动效集锦", hint: "炫手法：运镜、形变、字体、循环", hue: 274 },
  { id: "explainer", dir: "03-解说科普", label: "解说科普", hint: "把一件事讲明白：单图推拉、时间线、白板", hue: 96 },
  { id: "story", dir: "04-叙事短片", label: "叙事短片", hint: "无对白讲故事：欲望、三次失败、反转", hue: 28 },
  { id: "scene3d", dir: "05-三维场景", label: "三维场景", hint: "实物与空间：电影机运动、光与材质", hue: 190 },
  { id: "ui", dir: "06-界面版式", label: "界面版式", hint: "设计稿还原与版式实验", hue: 162 },
  { id: "lab", dir: "07-实验玩法", label: "实验玩法", hint: "改版、自选命题、快剪、音乐与物理玩法", hue: 342 },
  /**
   * 单技法（TK 段）与上面七类是**两种东西**，不要混着理解：
   * 上面每条是"一部片子怎么拍"（目标 / 三幕 / 铁律 / 禁止项）；
   * 这里每条是"一个效果怎么做"（字雨、粒子聚形、图表生长），只有几十秒，
   * 可以塞进任何一条片子的某一幕。所以面板上的动作也不同：前者是"按这套配方拍"，
   * 后者是"把这个技法加进片子"。
   *
   * 编号另起 TK 段：PM 号跟着源站 slug 排序走，技法没有源站 slug（它们来自代码样片），
   * 硬塞进 PM 序列会打乱已有编号，用户记住的 PM012 就换人了。
   */
  {
    id: "technique",
    dir: "08-技法",
    label: "单技法",
    hint: "一个效果本身：字雨、粒子聚形、图表生长——不是整片骨架，是往某一幕里加的一招",
    hue: 308,
  },
];

export const promptGenreOf = (id: string): PromptGenreDef | undefined => PROMPT_GENRES.find((g) => g.id === id);
export const promptGenreByLabel = (label: string): PromptGenreDef | undefined =>
  PROMPT_GENRES.find((g) => g.label === label);

/**
 * 画风耦合度：这条配方对"画面长什么样"的依赖有多深。
 *
 * 面板上「选完配方再挑风格」这个流程能不能成立，全看这个字段：
 * · `free`    正文里既没写媒介也没写配色/字体 —— 换任何风格都不伤内容（约 23 条）
 * · `partial` 只写了配色/字体，没锚在媒介上 —— 换风格时这几句要跟着换（约 115 条）
 * · `bound`   锚在媒介上（手绘/像素/剪纸/定格…）—— 只能换同媒介的风格，跨媒介会毁片（约 15 条）
 *
 * 为什么要有它：不标的话，用户给一部"手绘动物活起来"套上"暗色发布会"，
 * 出来的东西既不是手绘也不是发布会，而系统不会报任何错。
 */
export type PromptFidelity = "free" | "partial" | "bound";

export const PROMPT_FIDELITIES: { id: PromptFidelity; label: string; hint: string }[] = [
  { id: "free", label: "画风自由", hint: "换任何风格都不伤内容" },
  { id: "partial", label: "画风部分", hint: "配色与字体跟着风格换，结构不动" },
  { id: "bound", label: "绑在媒介上", hint: "只能换同媒介的风格，跨媒介会毁片" },
];

export const promptFidelityLabel = (id: PromptFidelity): string =>
  PROMPT_FIDELITIES.find((f) => f.id === id)?.label ?? id;

/** 一条可替换的槽位（源站的 {{field}} 落成中文） */
export type PromptSlot = {
  label: string;
  value: string;
  /** ` —— ` 之后的填写口径 */
  hint?: string;
};

/** 列表项：面板卡片用。不含正文（正文按需单独取，别让列表一次背 100KB） */
export type PromptItem = {
  id: string;
  name: string;
  genre: PromptGenre;
  /** 体裁文件夹名 */
  dir: string;
  /** 「长什么样」：卡片摘要 */
  summary: string;
  /** 「适合」 */
  fit: string;
  tags: string[];
  /** 「时长」整行，如 `15 秒 · 1920×1080 · 120 BPM`；没有就空 */
  duration: string;
  creator: string;
  /** 原贴 */
  url: string;
  /** 源页 */
  page: string;
  /** 同稿说明（同一段提示词被多人提交时才有） */
  dup?: string;
  /**
   * 画风耦合度。技法（TK）恒为 `bound`——一个效果本身就是一种画法，谈不上"换风格"。
   */
  fidelity: PromptFidelity;
  /** 相对库根的 webp 路径；没有缩略图为 null */
  still: string | null;
  /** 相对库根的 md 路径 */
  file: string;
  promptChars: number;
  /** md 的 sha1 前 12 位，增量重建用 */
  mdSha: string;
};

/** 详情：抽屉里显示 + 「发给 agent」的来源 */
export type PromptDetail = {
  item: PromptItem;
  slots: PromptSlot[];
  prompt: string;
};

export type PromptLibraryIndex = {
  version: 1;
  builtAt: string;
  sourceRoot: string;
  total: number;
  withStill: number;
  items: PromptItem[];
};

export type PromptQuery = {
  q?: string;
  genre?: PromptGenre | "all";
  withStill?: boolean;
};

/**
 * 采纳的配方。**只有一条**，不是数组。
 *
 * 风格库那边是多选（参考画风可以同时参考五张图，越多越有参照），
 * 但提示词库一条就是一部片子的完整骨架：贯穿物、三幕结构、动效铁律、禁止项。
 * 同时照三套骨架拍，等于让 agent 自己编一个折中方案——那不是"参考"，是"失焦"。
 * 所以这里是单条，多选在语义上就是错的。
 *
 * `at` 是采纳时间：agent 看到留言后可能过一会儿才读盘，有戳才能判断"这是新的还是上次的"。
 */
export type PromptPick = {
  id: string;
  name: string;
  genre: PromptGenre;
  note?: string;
  at: string;
};
