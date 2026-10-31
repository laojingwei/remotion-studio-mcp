import fs from "node:fs";
import path from "node:path";
import { ROOT as PROJECT_ROOT } from "./root";

/**
 * 决策审计日志：记录「agent 声称用户在某个闸口点了头」这件事。
 *
 * ## 为什么需要它
 *
 * 事故复盘（`检讨-配音交付流程失误.md`）里，agent 四次把用户的确认权挪给自己：
 * `confirm_brief(acknowledgedAssumptions=true)`、绕过配音确认、`render_video(force=true)`。
 *
 * 工具**无法验证**用户是否真的说过那句话——那是自然语言层面的事。
 * 但它可以做两件更实在的事：
 *
 * 1. **要求原话**：不给原话就拒绝，逼 agent 去问用户（问了就会留下真实原话）；
 * 2. **落盘留痕**：事后审计能看出「哪句话被当成了授权」，而不是只有一个 `true`。
 *
 * 这两个合起来，比一个布尔闸口强得多：布尔只能说"我确认了"，
 * 原话能说明"用户到底说了什么"——而很多事故恰恰是**用户的话被理解错了**
 * （例：用户说「可以，先合成配音试听」，被记成「稿子确认完毕，可以往下走」）。
 */

export type DecisionKind =
  /** 需求确认时，逐条核对 agent 替用户拍板的字段 */
  | "assumption-checked"
  /** 用户听过配音 */
  | "narration-heard"
  /** 跳过验收直接渲染 */
  | "force-render"
  /** 跳过契约体检直接渲染 */
  | "force-contract"
  /** 跳过 6 秒预览直接渲染（如果启用） */
  | "force-preview";

export type Decision = {
  at: string;
  kind: DecisionKind;
  /** 用户原话片段（唯一有审计价值的东西） */
  userQuote: string;
  /** 补充说明：agent 认为用户授权了什么 */
  note?: string;
  /** 结构化附加：如 assumption 的字段名、配音的合成版本 */
  meta?: Record<string, unknown>;
};

const dirOf = (projectId: string): string => {
  if (!/^[\w-]+$/.test(projectId)) throw new Error("非法的工程 id");
  return path.join(PROJECT_ROOT, "data", "projects", projectId);
};

const fileOf = (projectId: string): string => path.join(dirOf(projectId), "decisions.jsonl");

/** 原话太短不算「用户说过」——「嗯」「好」「可以」这种撑不起一次授权 */
export const MIN_QUOTE_CHARS = 5;

export function quoteIssue(quote: string | undefined | null): string | null {
  const q = String(quote ?? "").trim();
  if (!q) return "必须带用户原话（不是「用户同意了」，而是他实际说的那句话）";
  if (q.length < MIN_QUOTE_CHARS) {
    return `原话太短（「${q}」）：至少要 ${MIN_QUOTE_CHARS} 个字，否则无法判断用户到底同意了什么`;
  }
  return null;
}

export function appendDecision(projectId: string, d: Omit<Decision, "at">): Decision {
  const rec: Decision = { ...d, at: new Date().toISOString() };
  const file = fileOf(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
  return rec;
}

export function readDecisions(projectId: string): Decision[] {
  const file = fileOf(projectId);
  if (!fs.existsSync(file)) return [];
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((x) => x.trim())
      .map((x) => JSON.parse(x) as Decision);
  } catch {
    return [];
  }
}

/** 最近一次某类决策（用来判断"这个闸口有没有被原话支撑过"） */
export function lastDecision(projectId: string, kind: DecisionKind): Decision | null {
  const all = readDecisions(projectId).filter((d) => d.kind === kind);
  return all.length ? all[all.length - 1] : null;
}
