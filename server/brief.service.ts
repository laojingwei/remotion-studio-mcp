import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";

/**
 * 创作需求（brief）：9 步问诊，每步有必填项。
 *
 * 为什么要分步：一次性问 9 个问题，agent 容易漏、用户容易烦；
 * 按步骤走，每步只问 2–3 个必答项，问完才往下做——这是作品质量的保证。
 */
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

  /** 已完成的步骤（1–9） */
  steps?: number[];
  /**
   * 来源存证：哪些字段是 agent 替用户拍板的（用户没有明确回答）。
   * 存在的意义：缺了它，「9 步问诊」可以全程零交互地自己填完，
   * 好模型能编出一份自洽到用户看不出破绽的 brief。写完 confirm_brief 会拦一次。
   */
  assumed?: string[];
  /** 用户确认需求的时间（confirm_brief 写入；没有它不允许开建） */
  confirmedAt?: string;
  updatedAt?: string;
};

export type BriefStep = {
  no: number;
  title: string;
  /** [key, label]：缺失时用它提示 agent 去问 */
  required: [keyof Brief, string][];
  /** 建议问的问题（示范） */
  questions: string[];
};

export const BRIEF_STEPS: BriefStep[] = [
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
      "版式怎么来：内置 39 种现成场景（快）／自由画布 freeform 自己排版（独特）／混合？",
      "配色 / 字体有要求吗？",
      "绝对不能出现什么（视觉俗套 / 竞品元素）？",
      "对标：1–2 个参考作品，学它什么、**不学它什么**？（写进 benchmark——没有对标，风格和分镜只能靠猜）",
      "用 3 个形容词描述你希望看完的感觉（高级 / 亲切 / 燃 / 冷静 / 好笑…）→ 写进 mood；风格名是行业语，情绪才是验收标准",
    ],
  },
  {
    no: 5,
    title: "内容要点",
    required: [["mustInclude", "必须出现的信息"]],
    questions: [
      "必须出现的信息（产品名 / 价格 / 口号 / 二维码 / 时间地点）？",
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
    required: [
      ["delivery", "交付要求"],
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
    // 第 11 步同样不进 1–9 必答：它管"好不好看"，写分镜时可以还没定，
    // 但请用户验收前必须齐（request_review 会拦）——验收标准没定，看片就是白看。
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
    // 第 10 步不进 9 步必答（briefProgress 只算 1–9，避免存量的已确认 brief 被卡住），
    // 它在 brief 确认之后单独走：先定稿件类型，再写稿、再请用户确认，然后才写分镜。
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

const ROOT = path.join(PROJECT_ROOT, "data", "projects");

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
    if (k === "step" && typeof v === "number" && v >= 1 && v <= 9) {
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
    } else {
      next[k as keyof Brief] = v as never;
    }
  }
  next.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** 某一步还缺哪些必填（返回给人看的 label） */
export function stepMissingFields(stepNo: number, brief: Brief | null): string[] {
  const step = BRIEF_STEPS.find((x) => x.no === stepNo);
  if (!step) throw new Error(`没有第 ${stepNo} 步（1–9）`);
  return step.required
    .filter(([key]) => {
      const v = (brief as Record<string, unknown> | null)?.[key];
      return v === undefined || v === null || (typeof v === "string" && !v.trim());
    })
    .map(([, label]) => label);
}

/** 问诊主体只有 1–9；第 10 步（稿件）在 brief 确认之后单独走，不参与"问完没有"的判定 */
export const CORE_STEPS = BRIEF_STEPS.filter((s) => s.no <= 9);

/** 进度：按「该步必填字段是否齐」判断（steps 标记只作历史记录，不单独信任） */
export function briefProgress(brief: Brief | null): { done: number[]; next: number | null; finished: boolean } {
  const done = CORE_STEPS.filter((s) => stepMissingFields(s.no, brief).length === 0).map((s) => s.no);
  const missing = CORE_STEPS.map((s) => s.no).filter((n) => !done.includes(n));
  return { done, next: missing[0] ?? null, finished: missing.length === 0 };
}

/** 用户确认需求：9 步走完才能确认；有「替用户拍板」的字段要先逐条核对 */
export function confirmBrief(
  projectId: string,
  opts?: { acknowledgedAssumptions?: boolean },
): Brief {
  const b = readBrief(projectId);
  if (!b) throw new Error("还没有 brief，先走完 9 步问诊");
  const progress = briefProgress(b);
  if (!progress.finished) {
    throw new Error(
      `需求还没问完（${progress.done.length}/9），下一步第 ${progress.next} 步；问完再确认`,
    );
  }
  // 防「自己填完 9 步就自己盖章」：agent 标过的推断项必须先跟用户核对
  const assumed = (b.assumed ?? []).map(String).filter(Boolean);
  if (assumed.length && !opts?.acknowledgedAssumptions) {
    throw new Error(
      `有 ${assumed.length} 个字段是 agent 替用户定的：${assumed.join("、")}。\n` +
        `先把这几条逐条说给用户（「这条我按 XX 定的，对吗？」），用户认可后再 confirm_brief(acknowledgedAssumptions=true)；` +
        `用户要改就先 save_brief 覆盖，并从 assumed 里删掉。`,
    );
  }
  const file = fileOf(projectId);
  const next: Brief = { ...b, confirmedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function briefToText(b: Brief | null): string {
  if (!b) {
    return "还没有 brief。先用 intake 看第 1 步要问什么，问完 save_brief(step=1) 保存。";
  }
  const progress = briefProgress(b);
  const lines = Object.entries(b)
    .filter(
      ([k, v]) =>
        k !== "updatedAt" &&
        k !== "steps" &&
        k !== "assumed" &&
        v !== undefined &&
        v !== "" &&
        !(Array.isArray(v) && !v.length),
    )
    .map(([k, v]) => `- ${k}：${Array.isArray(v) ? v.join("、") : v}`);
  const head = progress.finished
    ? "需求已问完 9 步 ✅"
    : `需求进度：${progress.done.length}/9，下一步该问第 ${progress.next} 步（${BRIEF_STEPS.find((s) => s.no === progress.next)?.title}）`;
  const assumed = (b.assumed ?? []).filter(Boolean);
  const assumedNote = assumed.length
    ? `\n⚠️ 以下字段是 agent 替用户定的（用户没明确回答）：${assumed.join("、")}\n` +
      `   确认前必须逐条跟用户核对，否则 confirm_brief 会拒绝。`
    : "";
  return `${head}\n${lines.join("\n")}${assumedNote}`;
}
