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
  palette?: string;
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

  /** 已完成的步骤（1–9） */
  steps?: number[];
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
    questions: ["竖屏 9:16、横屏 16:9 还是 1:1？", "要几版（只要竖屏 / 竖+横 / 多语言）？"],
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
    ],
  },
  {
    no: 8,
    title: "交付",
    required: [
      ["delivery", "交付要求"],
      ["deadline", "截止时间"],
    ],
    questions: ["交付格式 / 画幅 / 要不要字幕文件 / 封面？", "什么时候要？"],
  },
  {
    no: 9,
    title: "其它约束",
    required: [["brandRules", "品牌规范（没有写「无」）"]],
    questions: ["有品牌规范吗（禁用色 / logo 规则）？没有就写「无」", "需要多语言版本吗？有发布限制吗？"],
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

/** 进度：按「该步必填字段是否齐」判断（steps 标记只作历史记录，不单独信任） */
export function briefProgress(brief: Brief | null): { done: number[]; next: number | null; finished: boolean } {
  const done = BRIEF_STEPS.filter((s) => stepMissingFields(s.no, brief).length === 0).map((s) => s.no);
  const missing = BRIEF_STEPS.map((s) => s.no).filter((n) => !done.includes(n));
  return { done, next: missing[0] ?? null, finished: missing.length === 0 };
}

/** 用户确认需求：9 步走完才能确认 */
export function confirmBrief(projectId: string): Brief {
  const b = readBrief(projectId);
  if (!b) throw new Error("还没有 brief，先走完 9 步问诊");
  const progress = briefProgress(b);
  if (!progress.finished) {
    throw new Error(
      `需求还没问完（${progress.done.length}/9），下一步第 ${progress.next} 步；问完再确认`,
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
        v !== undefined &&
        v !== "" &&
        !(Array.isArray(v) && !v.length),
    )
    .map(([k, v]) => `- ${k}：${Array.isArray(v) ? v.join("、") : v}`);
  const head = progress.finished
    ? "需求已问完 9 步 ✅"
    : `需求进度：${progress.done.length}/9，下一步该问第 ${progress.next} 步（${BRIEF_STEPS.find((s) => s.no === progress.next)?.title}）`;
  return `${head}\n${lines.join("\n")}`;
}
