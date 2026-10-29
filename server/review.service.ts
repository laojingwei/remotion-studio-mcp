import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";

/**
 * 成片验收（review）：渲染前的最后一道闸口。
 *
 * 为什么要有它：`preview_frames` 只能抽几帧看版式，看不出节奏、转场突兀、
 * 音画错位、字幕停留太短——这些只有「整片播一遍」才暴露，而播片的地方是编辑器。
 * 所以渲染前必须让用户自己去编辑器看一遍工程，看完点头才渲染；
 * 用户愿意自己点导出也行（那本来就是他的片子）。
 */
export type Review = {
  /** 什么时候请用户去看的（request_review 写入） */
  requestedAt?: string;
  /** 用户看完说「可以」的时间（confirm_review 写入） */
  confirmedAt?: string;
  /** 用户在编辑器里提出的问题（留档，便于逐条改） */
  feedback?: string[];
  /** 用户决定自己导出时记一笔（agent 不再渲染） */
  selfRender?: boolean;
  /** 开工前的风格样张：抽过帧给用户看过没有（probe_style 写入） */
  probeAt?: string;
  /** 样张用过的风格 slug */
  probeSlugs?: string[];
  /** 用户挑定的风格（confirm_style_probe 写入） */
  chosenStyle?: string;
  updatedAt?: string;
};

const ROOT = path.join(PROJECT_ROOT, "data", "projects");

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
export function markReviewConfirmed(projectId: string, feedback?: string[]): Review {
  const prev = readReview(projectId) ?? {};
  return write(projectId, {
    ...prev,
    confirmedAt: new Date().toISOString(),
    feedback: feedback?.length ? [...(prev.feedback ?? []), ...feedback] : prev.feedback,
  });
}

export function markNeedsWork(projectId: string, feedback: string[]): Review {
  const prev = readReview(projectId) ?? {};
  return write(projectId, {
    ...prev,
    confirmedAt: undefined,
    feedback: [...(prev.feedback ?? []), ...feedback],
  });
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
