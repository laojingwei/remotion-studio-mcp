import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import { PROJECTS_ROOT } from "./paths";
import path from "node:path";

/**
 * 成片验收（review）：渲染前的最后一道闸口。
 *
 * 为什么要有它：`preview_frames` 只能抽几帧看版式，看不出节奏、转场突兀、
 * 音画错位、字幕停留太短——这些只有「整片播一遍」才暴露，而播片的地方是编辑器。
 * 所以渲染前必须让用户自己去编辑器看一遍工程，看完点头才渲染；
 * 用户愿意自己点导出也行（那本来就是他的片子）。
 */
/**
 * 反馈的严重级别。**决定"能不能交付"，不只是分类标签**：
 *   P0 意思错了（事实/结论/因果反了）——改了才算拍完
 *   P1 观众会误解（字幕压字、顺序反了、看不出来在说什么）——必须改完才能再请他看
 *   P2 体验问题（节奏、转场突兀、音量、停留太短）——能改就改，能解释也可以过
 *   P3 打磨（错别字、间距、图标大小）——记下来，别为它重做结构
 *
 * 为什么要有级别：用户说"还行"时，agent 无法判断那是"能交付"还是"不好意思直说"。
 * 先把每条反馈标上级别，P0/P1 的存在与否就是客观答案。
 */
export type ReviewLevel = "P0" | "P1" | "P2" | "P3";

export const REVIEW_LEVELS: ReviewLevel[] = ["P0", "P1", "P2", "P3"];

/** 必须先修完才能提交的级别（approved=true 时会被拦） */
export const BLOCKING_LEVELS: ReviewLevel[] = ["P0", "P1"];

export type ReviewIssue = {
  level: ReviewLevel;
  text: string;
  /** 第几幕（1 起）；整片级问题不填 */
  scene?: number;
};

/**
 * 必须先修完才能提交的条目（P0/P1）。
 *
 * 抽成纯函数是因为这条判断要能被测试直接覆盖：它决定"能不能渲染"，
 * 而它的失败方式是**安静地放行**——放行一次，返工的就是整片。
 */
export function blockingIssues(issues: ReviewIssue[] | undefined): ReviewIssue[] {
  return (issues ?? []).filter((x) => BLOCKING_LEVELS.includes(x.level));
}

export type Review = {
  /** 什么时候请用户去看的（request_review 写入） */
  requestedAt?: string;
  /** 用户看完说「可以」的时间（confirm_review 写入） */
  confirmedAt?: string;
  /** 用户在编辑器里提出的问题（留档，便于逐条改） */
  feedback?: string[];
  /** 带级别的反馈：与 feedback 并存（feedback 保留原话，这里保留判断） */
  issues?: ReviewIssue[];
  /** 用户决定自己导出时记一笔（agent 不再渲染） */
  selfRender?: boolean;
  /** 开工前的风格样张：抽帧给用户看过没有（probe_style 写入） */
  probeAt?: string;
  /** 样张用过的风格 slug */
  probeSlugs?: string[];
  /** 用户挑定的风格（confirm_style_probe 写入） */
  chosenStyle?: string;
  /** 设计稿出给用户看的时间（export_design 写入）：建场景前该有这一笔 */
  designAt?: string;
  updatedAt?: string;
};

const ROOT = PROJECTS_ROOT;

const fileOf = (projectId: string): string => {
  if (!/^[\w-]+$/.test(projectId)) throw new Error("非法的工程 id");
  return path.join(ROOT, projectId, "review.json");
};

export function readReview(projectId: string): Review | null {
  const file = fileOf(projectId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Review;
}

function write(projectId: string, next: Review): Review {
  const payload: Review = { ...next, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(fileOf(projectId)), { recursive: true });
  fs.writeFileSync(fileOf(projectId), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

export function markReviewRequested(projectId: string): Review {
  return write(projectId, { ...(readReview(projectId) ?? {}), requestedAt: new Date().toISOString() });
}

/**
 * 记录用户验收结果。
 * 通过：confirmedAt 写入；不通过：confirmedAt 清掉 + 反馈留档（防止"上版通过"被误用于这一版）。
 */
export function markReviewConfirmed(projectId: string, feedback?: string[], issues?: ReviewIssue[]): Review {
  const prev = readReview(projectId) ?? {};
  return write(projectId, {
    ...prev,
    confirmedAt: new Date().toISOString(),
    feedback: feedback?.length ? [...(prev.feedback ?? []), ...feedback] : prev.feedback,
    // 通过时也可能有一堆 P2/P3：留档，别因为它们不阻断就丢掉
    ...(issues?.length ? { issues: [...(prev.issues ?? []), ...issues] } : {}),
  });
}

export function markNeedsWork(projectId: string, feedback: string[], issues?: ReviewIssue[]): Review {
  const prev = readReview(projectId) ?? {};
  return write(projectId, {
    ...prev,
    confirmedAt: undefined,
    feedback: [...(prev.feedback ?? []), ...feedback],
    // 新一轮的 issues 追加在旧的前面：旧的多半已修，新的才是当前要看的
    ...(issues?.length ? { issues: [...issues, ...(prev.issues ?? [])] } : {}),
  });
}

/**
 * 记一笔"设计稿出过了"。
 *
 * 用途不是闸门，是让 build_storyboard 能提醒：50 幕一次建完再让用户看，
 * 等于让他第一次读到这部片子是在成片里 —— 那时候改一句要重建场景。
 */
export function markDesignExported(projectId: string): Review {
  return write(projectId, { ...(readReview(projectId) ?? {}), designAt: new Date().toISOString() });
}

export function markSelfRender(projectId: string): Review {
  return write(projectId, { ...(readReview(projectId) ?? {}), selfRender: true, confirmedAt: new Date().toISOString() });
}

export function markProbe(projectId: string, slugs: string[]): Review {
  const prev = readReview(projectId) ?? {};
  return write(projectId, { ...prev, probeAt: new Date().toISOString(), probeSlugs: slugs });
}

export function markChosenStyle(projectId: string, slug: string): Review {
  const prev = readReview(projectId) ?? {};
  return write(projectId, {
    ...prev,
    probeAt: prev.probeAt ?? new Date().toISOString(),
    chosenStyle: slug,
  });
}

export function reviewToText(r: Review | null): string {
  if (!r?.requestedAt) return "还没进入验收：先 request_review 请用户去编辑器看一遍。";
  const nl = String.fromCharCode(10);
  const state = r.selfRender
    ? "用户决定自己导出（agent 不再渲染）"
    : r.confirmedAt
      ? `用户已验收通过（${r.confirmedAt}）✅`
      : `已请用户查看（${r.requestedAt}），还没点头 —— 等用户回话再渲染`;
  const fb = r.feedback?.length ? `${nl}用户反馈：${nl}${r.feedback.map((x) => `- ${x}`).join(nl)}` : "";
  return `${state}${fb}`;
}
