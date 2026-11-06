import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import { PROJECTS_ROOT } from "./paths";
import path from "node:path";
import { frozenSnapshot, hasHook, runHook } from "./plugin/hooks";
import { pluginBriefSteps } from "./plugin/brief-steps";
import {
  deriveDesignLock,
  designLockSummary,
  FORM_SPECS,
  normalizeForm,
  type DesignLock,
  type VideoForm,
} from "../shared/designLock";
import { estimateSceneCount, segmentDurationIssues } from "../shared/scenePacing";

/**
 * 创作需求（brief）：9 步问诊，每步有必填项。
 *
 * 为什么要分步：一次性问 9 个问题，agent 容易漏、用户容易烦；
 * 按步骤走，每步只问 2–3 个必答项，问完才往下做——这是作品质量的保证。
 */
/* ─────────────────── v4：制作前确认十步的结构化字段 ─────────────────── */

/** 第 1 步：一句话内容。拆三段，才能校验"动作有没有落地"（一个自由字符串校验不了） */
export type CoreSentence = {
  /** 让【谁】看 */
  who?: string;
  /** 知道 / 相信【什么】 */
  believe?: string;
  /** 然后去做【什么动作】 */
  action?: string;
};

/** 第 2 步：段落表。这是分镜的**单一真源** —— 没有它，分几幕、每幕多长只能凭感觉。 */
export type BriefSegment = {
  /** 起始秒（含） */
  startSec?: number;
  /** 结束秒（不含） */
  endSec?: number;
  /** 这一段的**一句内容**（不是标题，是内容） */
  content?: string;
  /** 这一段包含哪些镜头（shots[].id） */
  shotIds?: string[];
};

/**
 * 第 5 步：镜头清单。
 * 实拍片要能直接排拍摄；动画片转成"元素/图解点"（subject 写"无出镜·图解"）。
 */
export type BriefShot = {
  id?: string;
  /** 一句话描述这一镜发生什么 */
  desc?: string;
  /** 谁出镜：真人 / 演员 / 手部 / 无人出镜 / 客户 */
  subject?: string;
  /** 在哪拍：办公室 / 门店 / 工厂 / 户外 / 白底 / 绿幕 / 无实拍 */
  location?: string;
  /** 产品状态：全新 / 使用中 / 特写 / 对比 / 拆解 */
  productState?: string;
  durationSec?: number;
  /** 归属段落（BriefSegment 的序号或 shotIds 关联键） */
  segmentId?: string;
};

/** 第 3 步：开头 3 秒。唯一能靠抽帧自动校验的字段 */
export type OpenThree = {
  /** 第一帧画面是什么 */
  firstFrame?: string;
  /** 第一句台词/字幕是什么 */
  firstLine?: string;
  /** BGM 是否直接起（是 / 否 / 入场后再起） */
  bgmStart?: string;
};

/** 第 3 步：结尾动作 */
export type EndingSpec = {
  /** 最后一句口播 */
  lastLine?: string;
  /** 让观众做什么（一个动作） */
  cta?: string;
  /** 二维码 / 联系方式放哪儿 */
  qr?: string;
  /** 活动时间 */
  date?: string;
  /** Logo 怎么出现 */
  logo?: string;
};

/** 第 4 步：必须出现的信息 + 出现在哪儿 */
export type BriefMustInfo = {
  text?: string;
  /** 出现位置：字幕 / 画面正文 / 结尾 / 封面（不填=任意位置） */
  where?: string;
};

/** 第 7 步：参考必须指到时间点。"发个链接"等于没说。 */
export type BriefRef = {
  /** 参考来源（链接 / 作品名 / 客户自己的往期片） */
  source?: string;
  /** **必须填**：参考哪一段，如 "00:03–00:08" */
  range?: string;
  /** 参考什么维度：节奏 / 字幕 / 色调 / 转场 / BGM / 叙事结构 */
  aspect?: string[];
  /** 明确不参考什么（防止整体照搬） */
  antiAspect?: string[];
};

/** 第 8 步：素材清单 + 责任人 + 截止 */
export type BriefAsset = {
  item?: string;
  /** 谁提供（客户 / 我 / n/a 表示工具不负责的外部事项） */
  owner?: string;
  /** 截止时间 */
  due?: string;
  /** 授权情况：肖像权 / 音乐字体版权 / 场地授权 */
  license?: string;
};

/** 第 9 步：交付版本 */
export type BriefDeliverable = {
  /** 主片 / 竖版 / 横版 / 封面 / 字幕文件 / 无字幕版 / 压缩版 / 工程文件 */
  type?: string;
  /** 规格：1080×1920 / H.264 / 30fps… */
  spec?: string;
};

/** 第 10 步：验收 */
export type BriefAcceptance = {
  approver?: string;
  /** 判据：信息准确 / 品牌合规 / 字幕无误 / 节奏 / 画质 */
  criteria?: string[];
  /** 允许几轮修改 */
  reviseRounds?: number;
  /** 反馈方式：一次集中给 / 随时提 */
  feedbackMode?: string;
};

export type Brief = {
  /* 0 工程归属 */
  /** 这次是「新增」还是「改已有」（改已有的还要写 changeScope） */
  editMode?: string;
  /** 改已有工程时：这次只动什么（只改文案 / 换风格 / 重做分镜 / 加幕 / 配音重录…） */
  changeScope?: string;
  /* 1 目标与受众 */
  goal?: string;
  /** 用途类型（见 server/skills/formats.md 的 A–I），如「B 产品宣传」 */
  format?: string;
  audience?: string;
  platform?: string;
  /* 2 时长与节奏 */
  durationSec?: number;
  pace?: string;
  /* 3 画幅与规格 */
  aspect?: string;
  versions?: string;
  /* 4 风格与视觉 */
  style?: string;
  /** 版式体系：内置场景 / 自由画布 freeform / 混合 */
  layoutMode?: string;
  benchmark?: string;
  /** 3 个候选结构 → 选哪个、为什么 */
  structure?: string;
  /** 风格辨识信号：挑 2–3 个，翻掉哪些俗套 */
  signals?: string[];
  /** 观众记住的一句话或一个画面 */
  takeaway?: string;
  /** 前 1 秒发生什么 */
  hook?: string;
  /** 记忆点：第几秒、什么手法 */
  signature?: string;
  palette?: string;
  /** 字体 / 排版方案 */
  type?: string;
  /** 运动气质 */
  motion?: string;
  /** 材质 / 纹理 */
  texture?: string;
  forbidden?: string[];
  /* 5 内容要点 */
  mustInclude?: string[];
  avoid?: string[];
  copySource?: string;
  /* 6 素材 */
  assetsNote?: string;
  assetConstraints?: string;
  /* 7 音频 */
  voice?: string;
  subtitle?: string;
  music?: string;
  /** 声音计划：BGM/音效来源、情绪曲线、人声避让（见 server/skills/sound.md） */
  soundPlan?: string;
  /* 8 交付 */
  delivery?: string;
  deadline?: string;
  /* 9 其它约束 */
  brandRules?: string;
  release?: string;
  languages?: string;
  notes?: string;
  /* 10 稿件（brief 确认后单独走，见 server/skills/script.md） */
  /** 稿件类型：口播稿 / 屏幕文案 / 双轨 / 无稿 / 用户已给稿 */
  scriptType?: string;
  /* 11 观感与规格（决定"好看"和"专业"，见 server/skills/craft.md） */
  /** 情绪基准：3 个形容词（高级 / 亲切 / 燃 / 冷静 / 好笑…）——比风格名更接近用户语言 */
  mood?: string[];
  /** 安全区：投放端 UI 要避让的区域（抖音竖屏右侧按钮 / 底部文案 / 顶部状态栏） */
  safeArea?: string;
  /** 封面：要不要单独做、封面文案、用哪一帧 */
  cover?: string;
  /** 字幕规格：字号 / 位置 / 描边或底色 / 是否逐句高亮 / 是否双语 */
  subtitleSpec?: string;
  /** 音效层：要不要做声音设计（转场 / 文字入场 / 重点重音），还是只要 BGM */
  sfx?: string;

  /* ── v4：制作前确认十步（内容骨架 → 画面清单 → 声音字幕 → 素材交付） ── */
  /** 第 1 步：一句话内容（谁 / 相信什么 / 做什么动作） */
  core?: CoreSentence;
  /** 第 2 步：主形态（口播讲解 / 产品演示 / 情景剧 / 客户证言 / 前后对比 / 动画演示 / 混剪） */
  form?: string;
  /** 第 2 步：段落表（每段时长 + 一句内容） */
  segments?: BriefSegment[];
  /** 第 3 步：开头 3 秒 */
  open3?: OpenThree;
  /** 第 3 步：结尾动作 */
  ending?: EndingSpec;
  /** 第 4 步：必须出现的信息（带"出现在哪儿"） */
  mustInfo?: BriefMustInfo[];
  /** 第 4 步：绝对不出现（禁用词 / 竞品 / 人物） */
  bans?: string[];
  /** 第 5 步：镜头清单 */
  shots?: BriefShot[];
  /** 第 6 步：配音规格（性别/语速/是否真人原声） */
  voiceSpec?: { gender?: string; speed?: string; isHuman?: boolean };
  /** 第 6 步：BGM 情绪与强度 */
  bgm?: { mood?: string; energy?: string };
  /** 第 7 步：参考标注（必须指到时间点） */
  refs?: BriefRef[];
  /**
   * 第 7 步的出口：客户确实没有参考时，写清"没有"以及**你打算怎么定风格**。
   * 为什么不直接放过空 refs：没有参考又没有替代依据，风格只能瞎猜——
   * 这正是上次「太空旷」的起点。要放过，就得先把这个缺口用什么补上写清楚。
   */
  noRefReason?: string;
  /** 第 8 步：素材清单 + 责任人 + 截止 */
  assets?: BriefAsset[];
  /** 第 9 步：交付版本列表 */
  deliverables?: BriefDeliverable[];
  /** 第 10 步：验收标准 + 修改轮次 */
  acceptance?: BriefAcceptance;

  /* ── v4：四档位（只收档位，不收实现类型；类型由设计锁推导） ── */
  /** 信息密度：杂志 / 讲稿 / 海报 */
  density?: string;
  /** 动感：克制 / 标准 / 活泼 */
  motionLevel?: string;
  /** 转场性格：利落 / 柔和 / 动感 */
  transitionTone?: string;
  /** 特效：关 / 点缀 / 允许（默认关） */
  effects?: string;
  /** 背景明暗：浅 / 深 */
  bgTone?: string;
  /** 第 6 步：口播语气（专业讲解 / 朋友聊天 / 情绪独白 / 广告腔） */
  scriptTone?: string;
  /** 第 6 步：要不要分点（1、2、3 列举） */
  bulleted?: boolean;

  /** 推导出来的设计锁（save_brief 时按 form + 档位自动生成，也可显式覆盖） */
  designLock?: DesignLock;

  /** 已完成的步骤（编号以当前生效的问诊模板为准，不再固定 1–9） */
  steps?: number[];
  /**
   * 插件问诊问到的额外内容（键 = 步骤里 `x.` 后面的部分，如 `x.competitor`）。
   *
   * 为什么单开一个命名空间，而不是往 Brief 上直接加字段：
   * 1. `keyof Brief` 是编译期封闭的，插件的字段名写不进去；
   * 2. 这些字段**不参与设计锁推导**（`recomputeDesignLock` 只读 form/density/motionLevel
   *    等 7 个内置字段）。混在主对象里会让人误以为"填了就生效"——
   *    而事实是填了只作记录。语义分开，才不会被误用。
   */
  x?: Record<string, unknown>;
  /**
   * 来源存证：哪些字段是 agent 替用户拍板的（用户没有明确回答）。
   * 存在的意义：缺了它，「9 步问诊」可以全程零交互地自己填完，
   * 好模型能编出一份自洽到用户看不出破绽的 brief。写完 confirm_brief 会拦一次。
   */
  assumed?: string[];
  /**
   * 逐条核对记录：每个 assumed 字段对应一句**用户原话**。
   *
   * 为什么不是个布尔：`acknowledgedAssumptions=true` 只能表达「我说我核对过」，
   * 工具无从验证，事后也查不出用户到底同意了哪几条。
   * 事故里 16 项 agent 自己拍的板，一个 true 就全过了，回执还写着「已核对」——
   * 等于工具帮着把话说圆了。
   */
  assumptionChecks?: { field: string; userSaid: string; at: string }[];
  /** 用户确认需求的时间（confirm_brief 写入；没有它不允许开建） */
  confirmedAt?: string;
  updatedAt?: string;
};

export type BriefStep = {
  no: number;
  title: string;
  /**
   * [key, label]：缺失时用它提示 agent 去问。
   *
   * key 是 `Brief` 的字段名；以 `x.` 开头的是**扩展字段**（落进 `brief.x`），
   * 给插件定义的问诊用。校验在 `normalizeSteps` 里做，不在类型上卡死——
   * 类型卡死会让插件永远只能问内置那 45 个字段，"用自己的问诊方式"就成了空话。
   */
  required: [string, string][];
  /** 建议问的问题（示范） */
  questions: string[];
  /**
   * 是否属于"必答主体"。默认 true。
   *
   * 以前这里是 `CORE_STEPS = BRIEF_STEPS.filter(s => s.no <= 9)` —— 用步号硬切，
   * 于是"第 10 步稿件、第 11 步观感"必须排在内置的 9 步之后才不会进必答。
   * 插件一旦改写步骤数量，`no <= 9` 就毫无意义（它可能只有 6 步，也可能有 12 步）。
   * 改成显式标记后：**步数随便定，哪些算"必答"由数据自己说**。
   */
  core?: boolean;
};

/**
 * 内置问诊的 11 步（1–9 必答，10 稿件 / 11 观感在确认后单独走）。
 *
 * ⚠️ 注意数组**物理顺序**里 `no: 11` 排在 `no: 10` 前面（当年先加了 11 后加的 10）。
 * 所有逻辑都按 `no` 查（`find(s => s.no === x)`），与物理顺序无关，所以一直没出问题。
 * 但这意味着**「数组下标 + 1」不等于步号**——插件步骤按顺序自动编号时不要照抄这个假设；
 * 内置这份也刻意没动，改动会改变 `intake` 步骤表的展示顺序（属于无收益的行为变更）。
 */
const BUILTIN_STEPS: BriefStep[] = [
  {
    no: 1,
    title: "目标与受众",
    required: [
      ["goal", "目标（要达成什么）"],
      ["platform", "投放平台"],
    ],
    questions: [
      "给谁看？要达成什么（涨粉 / 卖货 / 汇报 / 教学 / 品牌宣传）？",
      "投放在哪个平台（抖音 / 小红书 / B站 / 视频号）？",
      "这次是**新增一支**，还是**改已有工程**？改已有的：只改什么（只改文案 / 换风格 / 重做分镜 / 加幕 / 重配音）？写进 editMode + changeScope",
    ],
  },
  {
    no: 2,
    title: "时长与节奏",
    required: [["durationSec", "时长（秒）"]],
    questions: ["视频多长（秒）？允许上下浮动吗？", "节奏：快剪 / 慢叙 / 卡点？"],
  },
  {
    no: 3,
    title: "画幅与规格",
    required: [["aspect", "画幅"]],
    questions: [
      "竖屏 9:16、横屏 16:9 还是 1:1？",
      "要几版（只要竖屏 / 竖+横 / 多语言）？",
      "投放端有没有平台 UI 要避让（抖音竖屏右侧按钮约 12% 宽、底部文案约 16% 高）？字幕 / 二维码 / 联系方式打算放哪儿？→ 写进 safeArea",
    ],
  },
  {
    no: 4,
    title: "风格与视觉",
    required: [
      ["style", "风格（43 种之一或参考）"],
      ["layoutMode", "版式体系（内置场景 / 自由画布 / 混合）"],
    ],
    questions: [
      "用哪种风格（list_styles 里 43 种），还是有参考作品？",
      "版式怎么来：内置 75 个现成版式（快）／自由画布 freeform 自己排版（独特）／混合？",
      "配色 / 字体有要求吗？",
      "绝对不能出现什么（视觉俗套 / 竞品元素）？",
      "对标：1–2 个参考作品，学它什么、**不学它什么**？（写进 benchmark——没有对标，风格和分镜只能靠猜）",
      "用 3 个形容词描述你希望看完的感觉（高级 / 亲切 / 燃 / 冷静 / 好笑…）→ 写进 mood；风格名是行业语，情绪才是验收标准",
    ],
  },
  {
    no: 5,
    title: "内容要点",
    // 2026-10-31 退役：老字段 mustInclude 与 v4 的 mustInfo 是同一件事的两个名字，
    // 填了 v4 的仍被判「缺必填」——这是 confirm_brief 连拒三次（6/9→7/9→8/9）的直接原因。
    // 现在只认 mustInfo，save_brief 的 shape 里也删掉了 mustInclude。
    required: [["mustInfo", "必须出现的信息（文本 + 出现位置）"]],
    questions: [
      "必须出现的信息（产品名 / 价格 / 口号 / 二维码 / 时间地点）？每条写 text，再标出现在哪（字幕 / 画面 / 结尾 / 封面）→ 写进 mustInfo",
      "不能提的词或竞品？",
    ],
  },
  {
    no: 6,
    title: "素材",
    required: [["assetsNote", "素材情况（没有写「无」）"]],
    questions: ["有现成素材吗（图 / 视频 / 音频 / logo）？没有就写「无」", "素材有版权或品牌约束吗？"],
  },
  {
    no: 7,
    title: "音频",
    required: [
      ["voice", "配音方式"],
      ["subtitle", "字幕方式"],
    ],
    questions: [
      "要不要配音（音色 / 语言 / 语速）？还是不要旁白？",
      "字幕：硬字幕 / 只出 SRT / 都不要？",
      "BGM 有要求吗？",
      "要不要做音效（转场 whoosh / 文字入场 / 重点重音）？还是只要一条 BGM？→ 写进 sfx",
      "字幕规格：字号大还是小、放底部还是中部、要不要描边或底色、要不要逐句高亮、要不要双语？一屏放几个字（默认 8–16，最多 18）？→ 写进 subtitleSpec",
    ],
  },
  {
    no: 8,
    title: "交付",
    // 同上：delivery（自由文本）退役，只认结构化的 deliverables
    required: [
      ["deliverables", "交付清单（类型 + 规格）"],
      ["deadline", "截止时间"],
    ],
    questions: [
      "交付格式 / 画幅 / 要不要字幕文件？",
      "封面怎么做：用片头第一帧、单独做一张（大标题 + 产品/人物），还是不要封面？封面文案写什么？→ 写进 cover",
      "什么时候要？",
    ],
  },
  {
    no: 9,
    title: "其它约束",
    required: [["brandRules", "品牌规范（没有写「无」）"]],
    questions: ["有品牌规范吗（禁用色 / logo 规则）？没有就写「无」", "需要多语言版本吗？有发布限制吗？"],
  },
  {
    // 第 11 步不进必答：它管"好不好看"，写分镜时可以还没定，
    // 但请用户验收前必须齐（request_review 会拦）——验收标准没定，看片就是白看。
    core: false,
    no: 11,
    title: "观感与规格",
    required: [
      ["mood", "情绪基准（3 个形容词）"],
      ["safeArea", "安全区（投放端 UI 避让）"],
      ["cover", "封面要求"],
      ["subtitleSpec", "字幕规格"],
      ["sfx", "音效层（要 / 不要）"],
    ],
    questions: [
      "你希望看完觉得：高级 / 亲切 / 燃 / 冷静 / 好笑…？给 3 个词（写进 mood）。风格选对了但情绪跑偏，成片就会像模板。",
      "投放时哪些区域会被平台 UI 压住？字幕、二维码、联系方式要避开哪里？（写进 safeArea）",
      "封面：用片头第一帧，还是单独做一张？封面文案是什么？（写进 cover）",
      "字幕：字号 / 位置 / 描边或底色 / 逐句高亮 / 双语？一屏几个字？（写进 subtitleSpec；默认一屏 8–16 字、不带标点，见 get_guide(\"subtitle\")）",
      "音效：只放 BGM，还是要做声音设计（转场 / 文字入场 / 重点重音）？（写进 sfx）",
    ],
  },
  {
    // 第 10 步不进必答（避免存量的已确认 brief 被卡住），
    // 它在 brief 确认之后单独走：先定稿件类型，再写稿、再请用户确认，然后才写分镜。
    core: false,
    no: 10,
    title: "稿件",
    required: [["scriptType", "稿件类型（口播稿 / 屏幕文案 / 双轨 / 无稿 / 用户已给稿）"]],
    questions: [
      "稿子谁来写：用户给稿、我写、还是改写已有的？（写进 copySource）",
      "要哪种稿：口播稿（给配音读）/ 屏幕文案（只出现在画面上）/ 双轨（两者都要）/ 无稿（纯视觉）？",
      "口播的话，语气是哪种：朋友聊天 / 专业讲解 / 广告腔 / 情绪独白？",
    ],
  },
];

/* ─────────────────── 问诊步骤：内置 + 插件 ─────────────────── */

/**
 * 把插件给的原始 JSON 校验成 `BriefStep[]`。
 *
 * **编号由这里自动分配**（按数组顺序 1..n），不采信用户写的 `no`。
 * 原因：手写编号必然出现重复（两个都写 1）或跳号（1,2,5），
 * 而 `no` 是 `save_brief(step=N)` 与进度判定的键——重复和跳号都会让进度算错，
 * 且错得很隐蔽（界面显示"已完成 3 步"但下一步提示是空的）。
 * 顺序即编号，用户想调整顺序就调数组顺序。
 */
function normalizeSteps(raw: unknown[], label: string): { steps: BriefStep[]; issues: string[] } {
  const issues: string[] = [];
  const steps: BriefStep[] = [];

  raw.forEach((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push(`${label}第 ${i + 1} 项不是对象，已跳过`);
      return;
    }
    const o = item as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) {
      issues.push(`${label}第 ${i + 1} 项缺 title，已跳过`);
      return;
    }

    const required: [string, string][] = [];
    const reqRaw = Array.isArray(o.required) ? o.required : [];
    for (const r of reqRaw) {
      if (!Array.isArray(r) || r.length < 2) {
        issues.push(`「${title}」的 required 里有一项不是 [字段, 说明] 形式，已忽略`);
        continue;
      }
      const key = typeof r[0] === "string" ? r[0].trim() : "";
      if (!key) {
        issues.push(`「${title}」的 required 里有空字段名，已忽略`);
        continue;
      }
      const lb = typeof r[1] === "string" && r[1].trim() ? r[1].trim() : key;
      required.push([key, lb]);
    }

    const questions = (Array.isArray(o.questions) ? o.questions : []).filter(
      (q): q is string => typeof q === "string" && !!q.trim(),
    );

    steps.push({
      no: steps.length + 1,
      title,
      required,
      questions,
      // 不写 core 就是必答；写 false 才进"确认后单独走"那批
      core: o.core === false ? false : true,
    });
  });

  if (!steps.length) issues.push(`${label}没有一步是合法的（每步至少要有一个 title）`);
  return { steps, issues };
}

export type BriefStepsSource = {
  steps: BriefStep[];
  source: "builtin" | "plugin";
  pluginId?: string;
  mode?: "replace" | "append";
  issues: string[];
};

/**
 * 当前生效的问诊步骤（插件优先，插件坏了就回退内置）。
 *
 * **不做缓存**：与技能/风格一致，改完文件下一次调用就是新内容。
 * 代价是每次要扫一遍插件目录（约 10ms 量级），所以调用方要注意
 * **一次业务里只算一次**（`briefProgress` 就是这么做的，见其注释）。
 */
export function briefStepsSource(): BriefStepsSource {
  const found = pluginBriefSteps();
  if (!found.raw) {
    return { steps: BUILTIN_STEPS, source: "builtin", issues: found.issues };
  }

  const label = `插件「${found.raw.pluginId}」的问诊步骤：`;
  const parsed = normalizeSteps(found.raw.steps, label);
  const issues = [...found.issues, ...parsed.issues];
  if (!parsed.steps.length) {
    return { steps: BUILTIN_STEPS, source: "builtin", issues: [...issues, "插件步骤全部不合法，已回退内置问诊"] };
  }

  if (found.raw.mode === "append") {
    const base = BUILTIN_STEPS.length;
    const appended = parsed.steps.map((s, i) => ({ ...s, no: base + i + 1 }));
    return {
      steps: [...BUILTIN_STEPS, ...appended],
      source: "plugin",
      pluginId: found.raw.pluginId,
      mode: "append",
      issues,
    };
  }

  return {
    steps: parsed.steps,
    source: "plugin",
    pluginId: found.raw.pluginId,
    mode: "replace",
    issues,
  };
}

/** 当前生效的步骤（多数调用方要的就是这个） */
export function briefSteps(): BriefStep[] {
  return briefStepsSource().steps;
}

/**
 * 必答主体。
 *
 * 以前是 `BRIEF_STEPS.filter(s => s.no <= 9)` —— 用步号硬切。
 * 现在按 `core !== false` 判：插件定义几步就几步，哪些算"必答"由数据自己说。
 */
export function coreSteps(steps?: BriefStep[]): BriefStep[] {
  return (steps ?? briefSteps()).filter((s) => s.core !== false);
}

/** 步骤数量（文案用；不要写死 9） */
export const stepCountLabel = (steps: BriefStep[]): string => `${coreSteps(steps).length}`;

/* ─────────────────── v4：四组交付 + 覆盖率闸口 ─────────────────── */

/**
 * 问诊按"生产依赖"分成 4 组，而不是按"问题类别"分 9 步：
 * 内容骨架没定，画面清单无从谈起；画面没定，声音字幕只能瞎配。
 * 9 步仍然保留（save_brief(step=N) 的兼容通道），但 agent 应按这 4 组跟用户过。
 */
export const CONFIRM_GROUPS: {
  no: number;
  title: string;
  covers: string;
  /** 这一组要拿到什么（人读） */
  output: string;
  /** 本组要提交的 save_brief 参数名 —— 只说要问什么、不说要交什么，agent 只能去猜（9 次往返的成因） */
  fields: string[];
  /** 一条能直接抄的最小 payload（字段名 + 结构，省掉"嵌套对象长什么样"的试错） */
  sample: string;
  questions: string[];
}[] = [
  {
    no: 1,
    title: "内容骨架",
    covers: "第 1–4 步",
    output: "一句话核心 + 主形态 + 段落表 + 开头3秒/结尾 + 必现禁用清单",
    fields: ["core", "form", "segments", "open3", "ending", "mustInfo", "bans"],
    sample:
      `core:{who:"同行小主播",believe:"一万音浪到手只有 370",action:"别被流水骗"},` +
      ` form:"口播讲解",` +
      ` segments:[{startSec:0,endSec:3,content:"钩子"},{startSec:3,endSec:12,content:"拆账"}],` +
      ` mustInfo:[{text:"370 元",where:"字幕"}], bans:["保证收益"]`,
    questions: [
      "这条视频让【谁】看完后，知道/相信【什么】，并去做【什么动作】？（拆三段写进 core）",
      "主形态是哪一种：口播讲解 / 产品演示 / 情景剧 / 客户证言 / 前后对比 / 动画演示 / 混剪？（写进 form）",
      "段落表：0–3s 钩子是什么、3–10s 痛点、10–30s 方案、30–45s 证据、45–60s 结尾——每段**一句内容**，写进 segments",
      "开头 3 秒：第一帧画面是什么、第一句台词/字幕是什么、BGM 是否直接起？（写进 open3）",
      "结尾：最后一句口播、让观众做什么、二维码/联系方式/活动时间/Logo 怎么出现？（写进 ending）",
      "必须出现的信息逐条列（产品名/卖点/价格/时间/电话/地址/免责声明）→ mustInfo；绝对不出现的 → bans",
    ],
  },
  {
    no: 2,
    title: "画面清单",
    covers: "第 5 步",
    output: "镜头清单（能直接安排拍摄；动画片改成元素/图解清单）",
    fields: ["shots"],
    sample: `shots:[{desc:"主播对着账单特写", subject:"无人出镜", location:"无实拍", durationSec:4, segmentId:"1"}]`,
    questions: [
      "谁出镜：真人 / 演员 / 手部 / 无人出镜 / 客户出镜？",
      "在哪拍：办公室 / 门店 / 工厂 / 户外 / 白底 / 绿幕？（动画片写「无实拍」）",
      "产品状态：全新 / 使用中 / 特写 / 对比 / 拆解？",
      "要哪些镜头：开箱 / 使用 / 细节 / 对比 / 客户采访 / 团队 / 环境？每个镜头一句话描述 + 时长 → shots",
      "动画/混剪形态：把「镜头」换成「元素/图解点」——每一屏要出现什么图形、图表、关键词",
    ],
  },
  {
    no: 3,
    title: "声音字幕",
    covers: "第 6–7 步",
    output: "配音规格 + 字幕规格 + BGM 情绪 + 参考标注（指到时间点）",
    fields: ["voiceSpec", "subtitleSpec", "bgm", "sfx", "refs", "noRefReason", "motionLevel", "transitionTone", "effects", "bgTone"],
    sample:
      `voiceSpec:{gender:"女声",speed:"1.5×"}, subtitleSpec:"硬字幕 一屏≤15字 距底18%",` +
      ` bgm:{mood:"克制",energy:"中"}, refs:[{source:"某条爆款", range:"00:03–00:08", aspect:["节奏","字幕"]}]`,
    questions: [
      "旁白：男声/女声/AI、语速、是否真人原声？（写进 voiceSpec）",
      "字幕：语言 / 是否双语 / 关键词是否大字 / 样式（描边或底色）？（写进 subtitleSpec）",
      "BGM 风格与强度（克制/中/强）？要不要音效？（写进 bgm / sfx）",
      "参考：给 1–2 个参考，并且**指到具体时间点**——参考 00:03–00:08 的节奏，还是字幕样式、色调、转场、BGM、叙事结构？写进 refs（range 必填，只有链接不算）",
      "客户确实没有参考：别空着，写 noRefReason（≥8 字）——「没有参考，风格按 X 定」（比如按行业惯例 / 按他们官网 VI / 按上次那条爆款）",
      "另外四类只收档位：动感（克制/标准/活泼）、转场性格（利落/柔和/动感）、特效（关/点缀/允许）、背景（浅/深）",
    ],
  },
  {
    no: 4,
    title: "素材与交付",
    covers: "第 8–10 步",
    output: "素材清单+责任人+截止 + 交付版本列表 + 验收标准",
    fields: ["assets", "deliverables", "deadline", "acceptance", "brandRules"],
    sample:
      `deliverables:[{type:"竖屏 MP4",spec:"1080×1920 H.264"},{type:"封面",spec:"竖屏 PNG"}],` +
      ` deadline:"2026-11-01 18:00", assets:[{item:"Logo",owner:"客户",due:"10-31",license:"已授权"}],` +
      ` acceptance:{approver:"客户老板",criteria:["信息准确","字幕无误"],rounds:2}`,
    questions: [
      "客户提供什么：Logo/VI/产品图/视频素材/文案/数据/案例？缺什么谁补？谁寄样品？（写进 assets，每条要有 owner + due）",
      "肖像权 / 音乐字体版权 / 场地授权谁负责？（写进 assets[].license；工具不负责的写 owner=n/a）",
      "交付哪些版本：主片、横版几条、竖版几条、封面、字幕文件、无字幕版、压缩版、工程文件？（写进 deliverables）",
      "谁拍板验收？按什么验收（信息准确/品牌合规/字幕无误/节奏/画质）？几轮修改？反馈是否一次集中给？（写进 acceptance）",
    ],
  },
];

export type CoverageProblem = { code: string; message: string; blocking: boolean };
export type BriefCoverage = {
  ok: boolean;
  blocking: CoverageProblem[];
  warnings: CoverageProblem[];
  /** 明确定过的"判断项"数量（形态 + 四档位 + 情绪 + 参考） */
  judgedFilled: number;
  /** agent 替用户拍板的字段数 */
  agentAssumed: number;
  summary: string;
};

const normText = (s: unknown): string =>
  String(s ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。！？、；：""''（）()《》·—–\-…]/g, "")
    .toLowerCase();

const nonEmpty = (s: unknown): boolean => String(s ?? "").trim().length > 0;

/**
 * 「确认到什么程度算完」的六条机器判据（对应 v4 文档 §2）。
 *
 * 为什么不用"必填有没有填"：填了不等于说清。段落表只写标题不算内容，
 * 参考只给链接不算指到点，素材没责任人等于没人给 —— 这些必须逐条判内容。
 */
/**
 * 幕数量级参考（一句话，给 confirm_brief 拍板时用）。
 *
 * 为什么不放进 briefCoverage.warnings：每份 brief 都会带这一条，
 * 报「5–45 幕」这种宽区间等于没说，只会把真问题淹掉。
 * 它在「拍板这一刻」有信息价值，在「体检」里只是噪声。
 */
export function sceneCountHint(brief: Brief | null): string | null {
  const total = Number(brief?.durationSec ?? 0);
  const segs = (brief?.segments ?? []).filter(Boolean).length;
  if (!(total > 0)) return null;
  const est = estimateSceneCount(total);
  if (!est.max) return null;
  return (
    `${total}s → 大概 ${est.min}–${est.max} 幕（按每幕 2–20s 估的量级，**不是标准**）。` +
    `真正定幕数的是段落表里的 ${segs} 段：每段要说几件事、每件事要不要单独一幕`
  );
}

export function briefCoverage(brief: Brief | null, opts?: { fps?: number }): BriefCoverage {
  const b = brief ?? {};
  const blocking: CoverageProblem[] = [];
  const warnings: CoverageProblem[] = [];

  // ① 一句话能复述
  const core = b.core ?? {};
  for (const [k, label] of [
    ["who", "让【谁】看"],
    ["believe", "知道/相信【什么】"],
    ["action", "去做【什么动作】"],
  ] as const) {
    if (!nonEmpty(core[k])) {
      blocking.push({ code: `core.${k}`, message: `第 1 步缺「${label}」`, blocking: true });
    }
  }
  if (String(core.believe ?? "").length > 40) {
    warnings.push({
      code: "core.believe.long",
      message: `「相信什么」有 ${String(core.believe).length} 字，超过 40 —— 一句话复述不出来，说明还没想清`,
      blocking: false,
    });
  }

  // ② 主形态
  if (!nonEmpty(b.form)) {
    blocking.push({ code: "form", message: "第 2 步缺主形态（form）：形态不定，后面 5 组问题全都会问错", blocking: true });
  }

  // ③ 段落表：有时长、有内容、连续、总长对得上
  const segs = (b.segments ?? []).filter((s) => s && (nonEmpty(s.content) || s.startSec !== undefined));
  if (!segs.length) {
    blocking.push({
      code: "segments.empty",
      message: "第 2 步缺段落表（segments）：没有它，分镜只能凭感觉分幕",
      blocking: true,
    });
  } else {
    segs.forEach((s, i) => {
      if (!nonEmpty(s.content)) {
        blocking.push({ code: `segments.${i}.content`, message: `段落表第 ${i + 1} 段只有时长没有内容`, blocking: true });
      }
      if (!(Number(s.startSec) >= 0) || !(Number(s.endSec) > Number(s.startSec))) {
        blocking.push({
          code: `segments.${i}.range`,
          message: `段落表第 ${i + 1} 段时长不合法（${s.startSec}–${s.endSec}）`,
          blocking: true,
        });
      }
    });
    const sum = segs.reduce((n, s) => n + Math.max(0, Number(s.endSec) - Number(s.startSec)), 0);
    const target = Number(b.durationSec ?? 0);
    if (target > 0 && Math.abs(sum - target) / target > 0.05) {
      blocking.push({
        code: "segments.sum",
        message: `段落表合计 ${sum.toFixed(1)}s，与目标时长 ${target}s 差 ${(Math.abs(sum - target) / target * 100).toFixed(0)}%（容忍 5%）`,
        blocking: true,
      });
    }
    // 单段时长：短到放不下一句话要拦，长到该拆幕要提醒
    // （段落是内容单位、不是画面单位，所以"段长"不等于"幕长"）
    const rawSegs = (b.segments ?? []).filter(Boolean);
    const dur = segmentDurationIssues(rawSegs as never[]);
    for (const x of dur.blocking) {
      blocking.push({ code: `segments.${x.index}.short`, message: x.message, blocking: true });
    }
    for (const x of dur.warnings) {
      warnings.push({ code: `segments.${x.index}.dur`, message: x.message, blocking: false });
    }

    // 段落必须连续，不能有空洞
    const sorted = [...segs].sort((x, y) => Number(x.startSec) - Number(y.startSec));
    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(Number(sorted[i].startSec) - Number(sorted[i - 1].endSec)) > 0.5) {
        blocking.push({
          code: "segments.gap",
          message: `段落表第 ${i} 段与第 ${i + 1} 段之间有空档（${sorted[i - 1].endSec} → ${sorted[i].startSec}）`,
          blocking: true,
        });
      }
    }
  }

  // ④ 镜头清单：按形态决定问到什么程度（这是"防空转"的关键）
  const form = normalizeForm(b.form);
  const shotLevel = FORM_SPECS[form]?.shots ?? "simple";
  const shots = (b.shots ?? []).filter(Boolean);
  if (shotLevel === "full") {
    if (!shots.length) {
      blocking.push({
        code: "shots.empty",
        message: `「${form}」是实拍形态，必须有镜头清单（shots）：没有它不能排拍摄`,
        blocking: true,
      });
    }
    shots.forEach((s, i) => {
      if (!nonEmpty(s.desc)) blocking.push({ code: `shots.${i}.desc`, message: `镜头 ${i + 1} 缺描述`, blocking: true });
      if (!(Number(s.durationSec) > 0)) {
        blocking.push({ code: `shots.${i}.durationSec`, message: `镜头 ${i + 1} 缺时长`, blocking: true });
      }
      if (!nonEmpty(s.segmentId)) {
        blocking.push({ code: `shots.${i}.segmentId`, message: `镜头 ${i + 1} 没归属段落（segmentId）`, blocking: true });
      }
    });
    // 每一段至少 1 镜
    const known = new Set(shots.map((s) => String(s.segmentId ?? "")));
    segs.forEach((s, i) => {
      const key = String(i + 1);
      if (known.size && !known.has(key) && !known.has(String(s.shotIds?.[0] ?? ""))) {
        // 只在镜头用了「序号」约定时报，避免误伤自定义 id
        const anyNumber = [...known].every((k) => /^\d+$/.test(k));
        if (anyNumber) {
          blocking.push({ code: `shots.segment.${i}`, message: `段落 ${i + 1} 一个镜头都没有`, blocking: true });
        }
      }
    });
  } else if (shotLevel === "simple") {
    if (!shots.length) {
      blocking.push({
        code: "shots.empty",
        message: `「${form}」至少要写清出镜方式（shots 里 1 条：谁出镜 / 什么背景）`,
        blocking: true,
      });
    } else {
      shots.forEach((s, i) => {
        if (!nonEmpty(s.desc) && !nonEmpty(s.subject)) {
          blocking.push({ code: `shots.${i}.desc`, message: `第 ${i + 1} 条既没描述也没写出镜方式`, blocking: true });
        }
      });
    }
  } else {
    // list：动画/混剪不强制镜头，但如果写了就得有描述
    shots.forEach((s, i) => {
      if (!nonEmpty(s.desc)) blocking.push({ code: `shots.${i}.desc`, message: `素材点 ${i + 1} 缺描述`, blocking: true });
    });
  }

  // ⑤ 参考必须指到时间点
  const refs = (b.refs ?? []).filter(Boolean);
  if (!refs.length) {
    const reason = String(b.noRefReason ?? "").trim();
    if (reason.length >= 8) {
      // 有出口但要留痕：没有参考就必须写清"靠什么替代"
      warnings.push({
        code: "refs.none",
        message: `客户没有参考，已记录替代依据：${reason}。风格将按这个依据 + 形态默认值定，验收时先对这条`,
        blocking: false,
      });
    } else {
      blocking.push({
        code: "refs.empty",
        message:
          "第 7 步缺参考标注（refs）：没有参考，风格与节奏只能靠猜——这是上次「太空旷」的根因。" +
          "客户确实没有参考时，写 noRefReason（至少 8 字）：说明「没有参考，风格按什么定」",
        blocking: true,
      });
    }
  }
  refs.forEach((r, i) => {
    if (!nonEmpty(r.range)) {
      blocking.push({
        code: `refs.${i}.range`,
        message: `参考 ${i + 1} 没指到时间点（只给链接等于没说，写 "00:03–00:08"）`,
        blocking: true,
      });
    }
    if (!(r.aspect ?? []).filter(nonEmpty).length) {
      blocking.push({
        code: `refs.${i}.aspect`,
        message: `参考 ${i + 1} 没说参考哪一点（节奏 / 字幕 / 色调 / 转场 / BGM / 叙事）`,
        blocking: true,
      });
    }
  });

  // ⑥ 素材有责任人 + 截止
  const assets = (b.assets ?? []).filter(Boolean);
  if (!assets.length) {
    warnings.push({
      code: "assets.empty",
      message: "没有素材清单（assets）：缺料会在铺开后才暴露",
      blocking: false,
    });
  }
  assets.forEach((a, i) => {
    if (!nonEmpty(a.item)) blocking.push({ code: `assets.${i}.item`, message: `素材 ${i + 1} 没写是什么`, blocking: true });
    if (!nonEmpty(a.owner)) {
      blocking.push({ code: `assets.${i}.owner`, message: `素材「${a.item ?? i + 1}」没写谁提供`, blocking: true });
    }
    if (!nonEmpty(a.due)) {
      blocking.push({ code: `assets.${i}.due`, message: `素材「${a.item ?? i + 1}」没写截止时间`, blocking: true });
    }
  });

  // ⑦ 交付有版本列表
  const dels = (b.deliverables ?? []).filter(Boolean);
  if (!dels.length) {
    blocking.push({
      code: "deliverables.empty",
      message: "第 9 步缺交付清单（deliverables）：主片/横竖版/封面/字幕/工程文件要逐项列",
      blocking: true,
    });
  }
  dels.forEach((d, i) => {
    if (!nonEmpty(d.type)) blocking.push({ code: `deliverables.${i}.type`, message: `交付物 ${i + 1} 没写类型`, blocking: true });
    if (!nonEmpty(d.spec)) blocking.push({ code: `deliverables.${i}.spec`, message: `交付物 ${i + 1} 没写规格`, blocking: true });
  });

  // 判断项：用户到底定过几件事（形态 + 四档位 + 情绪 + 参考）
  const judged = [
    nonEmpty(b.form),
    nonEmpty(b.density),
    nonEmpty(b.motionLevel),
    nonEmpty(b.transitionTone),
    nonEmpty(b.effects),
    (b.mood ?? []).filter(nonEmpty).length > 0,
    refs.length > 0 || String(b.noRefReason ?? "").trim().length >= 8,
  ].filter(Boolean).length;
  if (judged < 3) {
    warnings.push({
      code: "judged.few",
      message: `只定了 ${judged} 项审美判断（形态/密度/动感/转场/特效/情绪/参考）。少于 3 项时，agent 只能靠默认值硬猜`,
      blocking: false,
    });
  }

  const assumed = (b.assumed ?? []).filter(nonEmpty);
  if (assumed.length > 3) {
    warnings.push({
      code: "assumed.many",
      message: `有 ${assumed.length} 个字段是 agent 替用户定的（上限 3）：${assumed.join("、")}`,
      blocking: false,
    });
  }

  const ok = blocking.length === 0;
  return {
    ok,
    blocking,
    warnings,
    judgedFilled: judged,
    agentAssumed: assumed.length,
    summary: ok
      ? `需求契约完整 ✅（判断项 ${judged} 项${warnings.length ? `，${warnings.length} 条提醒` : ""}）`
      : `需求契约还差 ${blocking.length} 项，不能开工`,
  };
}

/** 由 brief 重新推导设计锁（form/档位/情绪变了就重算） */
export function recomputeDesignLock(brief: Brief): DesignLock {
  const lock = deriveDesignLock({
    form: brief.form,
    density: brief.density,
    motionLevel: brief.motionLevel,
    transitionTone: brief.transitionTone,
    effects: brief.effects,
    bgTone: brief.bgTone,
    mood: brief.mood,
  });

  /*
   * 插件补充规则（brief:derive）。
   *
   * 只往 `rules` 里加**说明文字**，不碰任何判定字段（maxTextElements / 白名单 / 字号）。
   * 这条边界很重要：设计锁是验收依据，如果插件能改 maxTextElements，
   * 那就等于第三方定义了"什么叫超标"，用户再也不知道该信谁。
   * 想真正参与判定需要一套更谨慎的机制（带来源标记的覆盖），不在这批。
   *
   * 好处是插件终于能让自定义问诊字段"有用"：把 `x.competitor` 这类字段
   * 翻译成一条验收时能看见的规则，而不是问完就躺在 brief.json 里。
   */
  if (!hasHook("brief:derive")) return lock;
  const v = runHook("brief:derive", {
    brief: frozenSnapshot(brief) as unknown as Record<string, unknown>,
    lock: frozenSnapshot(lock) as unknown as Record<string, unknown>,
  });
  if (!v.lockRules.length) return lock;
  return { ...lock, rules: [...lock.rules, ...v.lockRules] };
}

const ROOT = PROJECTS_ROOT;

const fileOf = (projectId: string): string => {
  if (!/^[\w-]+$/.test(projectId)) throw new Error("非法的工程 id");
  return path.join(ROOT, projectId, "brief.json");
};

export function readBrief(projectId: string): Brief | null {
  const file = fileOf(projectId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Brief;
}

export function saveBrief(projectId: string, patch: Brief): Brief {
  const file = fileOf(projectId);
  const prev = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Brief) : {};
  // 数组字段整体替换，其余字段覆盖；空字符串不覆盖已有值
  const next: Brief = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    // step（单数）= 保存第几步，下沉到服务端：API 直调也能记录进度
    // step 只是"打到第几步"的历史记录，不再和步数强绑：插件换一套问诊后，
    // 旧 brief 里可能存着超出当前步数的编号，按当前步数过滤会把历史进度悄悄抹掉
    if (k === "step" && typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 99) {
      const merged = new Set([...(next.steps ?? []), v]);
      next.steps = [...merged].sort((a, b) => a - b);
      continue;
    }
    if (k === "steps") {
      if (Array.isArray(v)) {
        const merged = new Set([...(next.steps ?? []), ...(v as number[])]);
        next.steps = [...merged].sort((a, b) => a - b);
      }
      continue;
    }
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      next[k as keyof Brief] = v as never;
    } else if (typeof v === "string" && !v.trim()) {
      continue;
    } else if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      next[k as keyof Brief] &&
      typeof next[k as keyof Brief] === "object" &&
      !Array.isArray(next[k as keyof Brief])
    ) {
      // 嵌套对象浅合并：save_brief(core={who}) 之后再 save_brief(core={believe}) 不该把 who 冲掉
      next[k as keyof Brief] = { ...(next[k as keyof Brief] as object), ...(v as object) } as never;
    } else {
      next[k as keyof Brief] = v as never;
    }
  }
  // 形态/档位/情绪变了 → 设计锁重算（显式传了 designLock 则以传入为准）
  const lockInputs = ["form", "density", "motionLevel", "transitionTone", "effects", "bgTone", "mood"] as const;
  const touchedLock = lockInputs.some((k) => Object.prototype.hasOwnProperty.call(patch, k));
  if (touchedLock && !Object.prototype.hasOwnProperty.call(patch, "designLock")) {
    next.designLock = recomputeDesignLock(next);
  }
  next.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");

  // 写后回读：复盘里出现过「save_brief 回执成功、get_brief 说还没有 brief」——
  // 当时是多实例/多数据目录（见 review-issues-plan A1），但回执伪造成功本身就是隐患。
  // 这里落盘后立刻读回比对，读不到或不一致就直接报错，绝不再返回成功。
  let back: Brief | null = null;
  try {
    back = readBrief(projectId);
  } catch {
    back = null;
  }
  if (!back || back.updatedAt !== next.updatedAt) {
    throw new Error(
      `brief 写入后回读不到（文件：${file}）。` +
        `服务端可能正在用另一份数据目录（清单里没有这个工程？先 list_projects 对一下），或者磁盘不可写。` +
        `本次没有保存成功，不要当成已保存继续往下走。`,
    );
  }
  return next;
}

/** 某一步还缺哪些必填（返回给人看的 label） */
export function stepMissingFields(stepNo: number, brief: Brief | null, steps?: BriefStep[]): string[] {
  return stepMissingDetail(stepNo, brief, steps).map((x) => x.label);
}

/** 字段是否算「有了」：空数组也算没有 —— 传了 `mustInfo: []` 不该让进度条前进 */
/**
 * 读字段值，支持 `x.foo` 这种扩展字段路径。
 *
 * 为什么需要：插件定义的问诊可以问内置 45 个字段之外的东西，
 * 那些答案落在 `brief.x` 里（见 Brief 类型的 `x` 字段）。
 * 没有路径读取的话，`required: [["x.competitor", "竞品"]]` 永远判定为"没填"，
 * 于是问诊会无限循环在第 1 步——这是最难自查的一类 bug（它不报错，只是问不完）。
 */
function readDeep(brief: Brief | null, key: string): unknown {
  if (!brief) return undefined;
  if (!key.includes(".")) return (brief as Record<string, unknown>)[key];
  let cur: unknown = brief;
  for (const seg of key.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function isFilled(brief: Brief | null, key: string): boolean {
  const v = readDeep(brief, key);
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return !!v.trim();
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** 缺哪几项，带字段名（报错要指名，不能只说"8/9"） */
export function stepMissingDetail(
  stepNo: number,
  brief: Brief | null,
  steps?: BriefStep[],
): { key: string; label: string }[] {
  // 允许调用方传入已算好的步骤表：`briefProgress` 要遍历全部步骤，
  // 不传的话每步都要重扫一遍插件目录（10 步 = 10 次扫描，纯浪费）
  const all = steps ?? briefSteps();
  const step = all.find((x) => x.no === stepNo);
  if (!step) throw new Error(`没有第 ${stepNo} 步（现有：${all.map((s) => s.no).join("/")}）`);
  return step.required
    .filter(([key]) => !isFilled(brief, String(key)))
    .map(([key, label]) => ({ key: String(key), label: String(label) }));
}

/**
 * 已退役的老字段：这些 brief 是 v4 之前写的，字段本身还在文件里但不再参与校验。
 * 不能让它表现成「数据丢了」—— 要明说重填哪一步。
 */
export function legacyFieldNotice(brief: Brief | null): string | null {
  if (!brief) return null;
  const hasLegacy = isFilled(brief, "mustInclude") || isFilled(brief, "delivery");
  const lacksNew = !isFilled(brief, "mustInfo") || !isFilled(brief, "deliverables");
  if (!hasLegacy || !lacksNew) return null;
  const steps: string[] = [];
  if (!isFilled(brief, "mustInfo")) steps.push("第 5 步（mustInfo：必须出现的信息，文本 + 位置）");
  if (!isFilled(brief, "deliverables")) steps.push("第 8 步（deliverables：交付清单，类型 + 规格）");
  return (
    `⚠️ 这份 brief 用的是已退役字段（mustInclude / delivery），新字段还缺：\n` +
    steps.map((s) => `  · ${s}`).join("\n") +
    `\n两个老字段已不再参与校验（它们和 mustInfo / deliverables 是同一件事的旧名字）。\n` +
    `补齐方式：save_brief 传新字段覆盖，或直接按第 5/8 步重答一遍。老数据不会自动迁移。`
  );
}

/**
 * 进度：按「该步必填字段是否齐」判断（steps 标记只作历史记录，不单独信任）。
 *
 * 多返回 `total` 与 `nextTitle`，是为了让调用方（回执文案）**不必再算一次步骤表** ——
 * 每次 `briefSteps()` 都要扫一遍插件目录，文案里写个"X/9"就多扫一次不值得。
 */
export function briefProgress(brief: Brief | null): {
  done: number[];
  next: number | null;
  finished: boolean;
  /** 必答步骤总数（以前写死 9） */
  total: number;
  /** 下一步的标题（没有下一步时不返回） */
  nextTitle?: string;
} {
  // 步骤表只算一次：每调一次 briefSteps() 都要扫一遍插件目录
  const steps = briefSteps();
  const cores = coreSteps(steps);
  const done = cores.filter((s) => stepMissingFields(s.no, brief, steps).length === 0).map((s) => s.no);
  const missing = cores.map((s) => s.no).filter((n) => !done.includes(n));
  const next = missing[0] ?? null;
  return {
    done,
    next,
    finished: missing.length === 0,
    total: cores.length,
    nextTitle: next === null ? undefined : steps.find((s) => s.no === next)?.title,
  };
}

/**
 * confirm_brief 会拒在哪：9 步里还缺必填的步骤 + 每步缺哪些字段。
 *
 * 抽出来只有一目的：**回执和闸口必须用同一个判定**。
 * 以前 save_brief 用 briefCoverage 说「契约完整 ✅」，confirm_brief 却按 9 步必填拒人，
 * agent 拿着「完整」的回执去确认，白撞一轮才知道还缺 8 项。
 */
export function confirmGaps(
  brief: Brief | null,
): { stepNo: number; title: string; miss: { key: string; label: string }[] }[] {
  const steps = briefSteps();
  return coreSteps(steps)
    .map((s) => ({ stepNo: s.no, title: s.title, miss: stepMissingDetail(s.no, brief, steps) }))
    .filter((g) => g.miss.length);
}

/** 缺口块（save_brief 回执 / intake 总览共用一套措辞） */
export function confirmGapText(brief: Brief | null, NL = "\n"): string {
  const gaps = confirmGaps(brief);
  if (!gaps.length) return "";
  const total = gaps.reduce((n, g) => n + g.miss.length, 0);
  return (
    `confirm_brief 还差 ${gaps.length} 步 / ${total} 项必填（现在问确认会被拒）：` +
    NL +
    gaps
      .map(
        (g) =>
          `  第 ${g.stepNo} 步「${g.title}」：${g.miss.map((m) => `${m.key}（${m.label}）`).join("、")}`,
      )
      .join(NL) +
    NL +
    `一次补齐再确认——反复一轮补一项只会一轮轮往下推。`
  );
}

/**
 * 核对记录够不够：每个 assumed 字段都要有一条原话，且原话不能太短。
 *
 * 抽成纯函数是为了能单测 —— 这段逻辑决定了「一个布尔能不能糊过去」，
 * 是整条确认链上最需要被测住的地方。
 */
export function checkAssumptionQuotes(
  assumed: readonly string[],
  provided: readonly { field?: string; userSaid?: string }[],
): {
  ok: boolean;
  missing: string[];
  tooShort: string[];
  /** 归一化后的记录（顺序与 assumed 一致） */
  checks: { field: string; userSaid: string }[];
} {
  const byField = new Map(
    provided.filter((x) => x && String(x.field ?? "").trim()).map((x) => [String(x.field).trim(), String(x.userSaid ?? "").trim()]),
  );
  const missing: string[] = [];
  const tooShort: string[] = [];
  const checks: { field: string; userSaid: string }[] = [];
  for (const f of assumed) {
    const said = byField.get(f);
    if (!said) {
      missing.push(f);
      continue;
    }
    // 「好」「可以」这种撑不起一次授权：至少 5 字，且不能只是同意词
    const bare = /^(好|行|可以|嗯|对|ok|okay|同意|没问题|你定|随便)[。.!！~]*$/i.test(said);
    if (said.length < 5 || bare) {
      tooShort.push(`${f}（「${said}」不算原话，至少要说出同意的是什么事）`);
      continue;
    }
    checks.push({ field: f, userSaid: said });
  }
  return { ok: missing.length === 0 && tooShort.length === 0, missing, tooShort, checks };
}

/** 必填字段的最小示例：报错里直接给一条能抄的，省掉"这个字段到底长什么样"的往返 */
const FIELD_HINTS: Record<string, string> = {
  goal: `goal: "让同行看懂一万音浪能到手多少"`,
  platform: `platform: "抖音"`,
  durationSec: `durationSec: 65`,
  aspect: `aspect: "9:16"（再用 set_formats 落成 concrete 宽高）`,
  style: `style: "kinetic-brutalist"（list_styles 里挑一个）`,
  layoutMode: `layoutMode: "自由画布 freeform"`,
  mustInfo: `mustInfo: [{ "text": "370 元", "where": "字幕" }]  ← 数组，每项 {text, where}`,
  assetsNote: `assetsNote: "无，全部现做"`,
  voice: `voice: "女声 vivian，语速 1.5×"`,
  subtitle: `subtitle: "硬字幕，一屏 ≤ 15 字"`,
  deliverables: `deliverables: [{ "type": "竖屏 MP4", "spec": "1080×1920 H.264" }]  ← 数组，每项 {type, spec}`,
  deadline: `deadline: "2026-11-01 18:00"`,
  brandRules: `brandRules: "无"`,
  core: `core: { "who": "谁看", "believe": "相信什么", "action": "然后做什么" }`,
  segments: `segments: [{ "startSec": 0, "endSec": 3, "content": "钩子" }]  ← 字段名是 startSec/endSec`,
};

/** 用户确认需求：9 步走完才能确认；有「替用户拍板」的字段要先逐条核对 */
export function confirmBrief(
  projectId: string,
  opts?: {
    /** @deprecated 只传这个而不传 assumptions 会被拒绝：布尔记不下用户说了什么 */
    acknowledgedAssumptions?: boolean;
    /** 逐条核对记录：每个 assumed 字段要给一句用户原话 */
    assumptions?: { field: string; userSaid: string }[];
    /** 批量确认：用户一次性认可了全部 assumed（原话只录一条，覆盖所有推断项） */
    batchAck?: boolean;
    batchUserSaid?: string;
  },
): Brief {
  const b = readBrief(projectId);
  if (!b) throw new Error("还没有 brief，先走完 9 步问诊");
  const progress = briefProgress(b);
  if (!progress.finished) {
    // 一次把所有缺口列完：以前只报「（8/9），下一步第 5 步」，
    // agent 只能补一步试一次，于是出现 6/9 → 7/9 → 8/9 三次往返。
    const gaps = confirmGaps(b);
    const total = gaps.reduce((n, g) => n + g.miss.length, 0);
    const body = gaps
      .map(
        (g) =>
          `  第 ${g.stepNo} 步「${g.title}」缺 ${g.miss.length} 项：\n` +
          g.miss
            .map(
              (m) =>
                `    · ${m.key}（${m.label}）` + (FIELD_HINTS[m.key] ? `\n      例：${FIELD_HINTS[m.key]}` : ""),
            )
            .join("\n"),
      )
      .join("\n");
    throw new Error(
      `需求还没问完（${progress.done.length}/${progress.total}），还剩 ${gaps.length} 步 / ${total} 项必填：\n` +
        body +
        `\n\n字段名就是 save_brief 的参数名，一次补齐再 confirm_brief —— 反复一轮补一项只会一轮轮往下推。`,
    );
  }
  // 防「自己填完 9 步就自己盖章」：agent 标过的推断项必须带上用户原话
  const assumed = (b.assumed ?? []).map(String).filter(Boolean);
  if (assumed.length) {
    // 批量确认通道：用户一句「都按系统推荐的来」就能过，但原话照样落盘（一条覆盖 N 项），
    // 只是不再逼 agent 把同一句话复制 N 遍（13 个字段逐条回填同一句，纯摩擦、不增加信息量）。
    const batchSaid = String(opts?.batchUserSaid ?? "").trim();
    if (opts?.batchAck && batchSaid.length >= 2) {
      opts = {
        ...opts,
        assumptions: assumed.map((field) => ({ field, userSaid: batchSaid })),
      };
    }
    const provided = (opts?.assumptions ?? []).filter((x) => x && String(x.field ?? "").trim());
    if (!provided.length) {
      throw new Error(
        `有 ${assumed.length} 个字段是你替用户定的：\n` +
          assumed.map((f, i) => `  ${i + 1}. ${f}`).join("\n") +
          `\n\n不能只传 acknowledgedAssumptions=true —— 布尔记不下用户说了什么。` +
          `把这 ${assumed.length} 条逐条问用户（「这条我按 XX 定的，对吗？」），` +
          `然后 confirm_brief(assumptions=[{field:"字段", userSaid:"他实际说的那句"}...])。\n` +
          `用户是一次性认可的（比如「都按你建议的来」），就传 confirm_brief(batchAck=true, batchUserSaid="他这句原话")——` +
          `一条原话覆盖全部 ${assumed.length} 项，同样落盘可审计。\n` +
          `用户要改就先 save_brief 覆盖，并从 assumed 里删掉。`,
      );
    }
    const check = checkAssumptionQuotes(assumed, provided);
    if (!check.ok) {
      const near = check.missing.length
        ? `\n提示：assumptions[].field 要**逐字复制** assumed 里的那条原文（不是字段名、不是你自己概括的短语）。` +
          `可直接照抄：\n` +
          check.missing.map((f) => `  field: ${JSON.stringify(f)}`).join("\n")
        : "";
      throw new Error(
        (check.missing.length ? `这 ${check.missing.length} 段 assumed 还没有对应原话：${check.missing.join("、")}\n` : "") +
          (check.tooShort.length
            ? `这几条原话太短，无法判断用户到底同意了什么：${check.tooShort.join("、")}\n`
            : "") +
          `\n「用户同意了」不算原话 —— 要贴他实际说的那句。` +
          near,
      );
    }
    opts = { ...opts, assumptions: check.checks };
  }
  // v4 闸口：不只看"填没填"，看"说清没说清"（段落表有没有内容、参考有没有指到点、素材有没有责任人）
  const cov = briefCoverage(b);
  if (!cov.ok) {
    throw new Error(
      `需求契约还不完整（差 ${cov.blocking.length} 项），不能确认开工：\n` +
        cov.blocking
          .slice(0, 14)
          .map((p) => `  · ${p.message}`)
          .join("\n") +
        (cov.blocking.length > 14 ? `\n  …还有 ${cov.blocking.length - 14} 项` : "") +
        `\n这些不是"必填没填"，是"填了但没说清"。补齐后再 confirm_brief。`,
    );
  }
  const file = fileOf(projectId);
  const now = new Date().toISOString();
  // 核对记录落盘：事后能查出「哪一条推断、用户当时说的哪句话」
  const checks = (opts?.assumptions ?? []).map((x) => ({
    field: String(x.field).trim(),
    userSaid: String(x.userSaid ?? "").trim(),
    at: now,
  }));
  const next: Brief = {
    ...b,
    designLock: b.designLock ?? recomputeDesignLock(b),
    ...(checks.length ? { assumptionChecks: checks } : {}),
    confirmedAt: now,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function briefToText(b: Brief | null): string {
  if (!b) {
    return "还没有 brief。先用 intake 看第 1 组要问什么，问完 save_brief 保存。";
  }
  const progress = briefProgress(b);
  const cov = briefCoverage(b);
  const NL = "\n";

  // v4 的结构化字段单独成段渲染（不摊成一行 JSON），其余老字段继续平铺
  const V4 = new Set<string>([
    "core",
    "form",
    "segments",
    "open3",
    "ending",
    "mustInfo",
    "bans",
    "shots",
    "refs",
    "assets",
    "deliverables",
    "acceptance",
    "designLock",
    "density",
    "motionLevel",
    "transitionTone",
    "effects",
    "bgTone",
    "voiceSpec",
    "bgm",
    "scriptTone",
    "bulleted",
    "form",
  ]);
  const lines = Object.entries(b)
    .filter(
      ([k, v]) =>
        k !== "updatedAt" &&
        k !== "steps" &&
        k !== "assumed" &&
        k !== "confirmedAt" &&
        !V4.has(k) &&
        v !== undefined &&
        v !== "" &&
        !(Array.isArray(v) && !v.length),
    )
    .map(([k, v]) => `- ${k}：${Array.isArray(v) ? v.join("、") : v}`);

  const blocks: string[] = [];

  /* ── 内容骨架 ── */
  const core = b.core ?? {};
  if (core.who || core.believe || core.action) {
    blocks.push(
      `【内容骨架】让「${core.who ?? "?"}」看完，相信「${core.believe ?? "?"}」，然后「${core.action ?? "?"}」`,
    );
  }
  if (b.form) {
    const lock = b.designLock ?? recomputeDesignLock(b);
    blocks.push(
      `形态「${b.form}」· 密度 ${lock.density} · 动感 ${lock.motion} · 转场 ${lock.transition} · 特效 ${lock.effects} · ${lock.bg}底`,
    );
  }
  const segs = b.segments ?? [];
  if (segs.length) {
    blocks.push(
      "段落表：" +
        NL +
        segs
          .map(
            (s, i) =>
              `  ${i + 1}. ${s.startSec ?? "?"}–${s.endSec ?? "?"}s ${s.content ?? "（没写内容）"}`,
          )
          .join(NL),
    );
  }
  const o3 = b.open3 ?? {};
  if (o3.firstFrame || o3.firstLine || o3.bgmStart) {
    blocks.push(
      `开头 3 秒：第一帧「${o3.firstFrame ?? "?"}」/ 第一句「${o3.firstLine ?? "?"}」/ BGM ${o3.bgmStart ?? "?"}`,
    );
  }
  const en = b.ending ?? {};
  if (en.lastLine || en.cta || en.qr || en.date || en.logo) {
    blocks.push(
      `结尾：最后一句「${en.lastLine ?? "?"}」/ 动作「${en.cta ?? "?"}」/ 二维码 ${en.qr ?? "无"} / 时间 ${en.date ?? "无"} / Logo ${en.logo ?? "无"}`,
    );
  }
  const mustInfo = (b.mustInfo ?? []).filter((x) => nonEmpty(x.text));
  if (mustInfo.length) {
    blocks.push(
      `必须出现（${mustInfo.length} 项）：` +
        mustInfo.map((m) => `${m.text}${m.where ? `（${m.where}）` : ""}`).join("、"),
    );
  }
  if ((b.bans ?? []).length) blocks.push(`绝对不出现：${(b.bans ?? []).join("、")}`);

  /* ── 画面清单 ── */
  const shots = b.shots ?? [];
  if (shots.length) {
    blocks.push(
      `【画面清单】${shots.length} 条` +
        NL +
        shots
          .map((s, i) => {
            const meta = [s.subject, s.location, s.productState, s.durationSec ? `${s.durationSec}s` : ""]
              .filter(Boolean)
              .join(" / ");
            return `  ${i + 1}. ${s.desc ?? "（没描述）"}${meta ? ` — ${meta}` : ""}`;
          })
          .join(NL),
    );
  }

  /* ── 声音字幕与参考 ── */
  const vs = b.voiceSpec ?? {};
  if (vs.gender || vs.speed || vs.isHuman !== undefined) {
    blocks.push(
      `【声音】${[vs.gender, vs.speed, vs.isHuman === undefined ? "" : vs.isHuman ? "真人原声" : "AI 合成"].filter(Boolean).join(" / ")}`,
    );
  }
  const bgm = b.bgm ?? {};
  if (bgm.mood || bgm.energy) blocks.push(`BGM：${[bgm.mood, bgm.energy].filter(Boolean).join(" / ")}`);
  if (b.scriptTone || b.bulleted !== undefined) {
    blocks.push(`口播语气：${b.scriptTone ?? "（默认）"}${b.bulleted ? " · 分点讲" : ""}`);
  }
  const refs = b.refs ?? [];
  if (!refs.length && String(b.noRefReason ?? "").trim()) {
    blocks.push(`参考：客户确认没有参考；风格依据「${b.noRefReason}」`);
  }
  if (refs.length) {
    blocks.push(
      "参考：" +
        NL +
        refs
          .map(
            (r, i) =>
              `  ${i + 1}. ${r.source ?? "?"} @ ${r.range ?? "（没指时间点）"} — 参考 ${(r.aspect ?? []).join("/") || "?"}${
                (r.antiAspect ?? []).length ? `；不参考 ${(r.antiAspect ?? []).join("/")}` : ""
              }`,
          )
          .join(NL),
    );
  }

  /* ── 素材与交付 ── */
  const assets = b.assets ?? [];
  if (assets.length) {
    blocks.push(
      "【素材】" +
        assets
          .map((a) => `${a.item ?? "?"}（${a.owner ?? "没责任人"}${a.due ? ` / ${a.due}` : " / 没截止"}）`)
          .join("、"),
    );
  }
  const dels = b.deliverables ?? [];
  if (dels.length) {
    blocks.push(`【交付】${dels.map((d) => `${d.type ?? "?"}${d.spec ? `(${d.spec})` : "(没规格)"}`).join("、")}`);
  }
  const ac = b.acceptance;
  if (ac) {
    blocks.push(
      `【验收】${ac.approver ?? "没写谁拍板"} · 判据 ${(ac.criteria ?? []).join("/") || "没写"} · ${ac.reviseRounds ?? "?"} 轮修改`,
    );
  }

  /* ── 设计锁 ── */
  if (b.designLock) {
    blocks.push(`【设计锁】${NL}${b.designLock.rules.map((r) => `  · ${r}`).join(NL)}`);
  }

  // v4 优先用"4 组"叙述；老工程没有 v4 字段时退回 9 步进度
  // 判定必须与 confirm_brief 同源（confirmGaps），否则会出现「回执说完整、确认说缺 8 项」
  const v4Ready = !!(b.core && (b.core.who || b.core.action) && (b.segments ?? []).length);
  const gaps = confirmGaps(b);
  const readyToConfirm = cov.ok && v4Ready && !gaps.length;
  const head = readyToConfirm
    ? "需求 4 组已问完、契约完整 ✅（confirm_brief 现在能过）"
    : cov.ok && v4Ready
      ? `内容契约完整 ✅，但还不能确认——${gaps.length} 步必填项还空着（见下）`
      : progress.finished
        ? `需求已问完 ${progress.total} 步 ✅（但契约还不完整，见下方）`
        : `需求进度：${progress.done.length}/${progress.total}，下一步该问第 ${progress.next} 步（${progress.nextTitle ?? ""}）`;
  const lockedNote = b.confirmedAt ? `${NL}已由用户确认开工（${b.confirmedAt}）` : "";
  const covNote =
    `${NL}契约完整性：${cov.summary}` +
    (cov.blocking.length
      ? NL + cov.blocking.slice(0, 8).map((p) => `  ✗ ${p.message}`).join(NL) +
        (cov.blocking.length > 8 ? `${NL}  …还有 ${cov.blocking.length - 8} 项（intake 看全部）` : "")
      : "") +
    (cov.warnings.length ? NL + cov.warnings.map((p) => `  ⚠️ ${p.message}`).join(NL) : "");

  const assumed = (b.assumed ?? []).filter(Boolean);
  const assumedNote = assumed.length
    ? `\n⚠️ 以下字段是 agent 替用户定的（用户没明确回答）：${assumed.join("、")}\n` +
      `   确认前必须逐条跟用户核对，否则 confirm_brief 会拒绝。`
    : "";
  const gapText = confirmGapText(b, NL);
  const gapNote = gapText ? `${NL}${gapText}` : "";
  return `${head}${lockedNote}\n${lines.join("\n")}${blocks.length ? NL + blocks.join(NL) : ""}${covNote}${gapNote}${assumedNote}`;
}
