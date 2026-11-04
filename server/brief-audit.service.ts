/**
 * 契约体检：拿成片去对 brief。
 *
 * 为什么必须有这一层：
 * 复盘里最大的坑不是"没问"，是"问了不算数" —— mustInfo 填了、成片里一条没出现，
 * 没有任何环节会报警（check_project 只读 brief.aspect）。没有这个比对，
 * 前面所有"需求确认"都只是更长的表。
 *
 * 原则：只报"说了没做到"（可判定），不报风格偏好（不可判定）。
 */
import { totalDuration } from "../shared/schema";
import { lockViolations, type DesignLock } from "../shared/designLock";
import { sceneAuditElements } from "../shared/sceneElements";
import type { Brief } from "./brief.service";

export type AuditResult = {
  ok: boolean;
  /** 必须修，否则交付就是违约（mustInfo 漏项 / 禁词命中） */
  blocking: string[];
  /** 提醒：可能是有意的 */
  warnings: string[];
  /** 通过项，给用户看"你要求的东西都在" */
  passed: string[];
};

type AnyElement = { kind?: string; name?: string; text?: string };
type AnyScene = {
  id?: string;
  name?: string;
  type?: string;
  durationInFrames?: number;
  subtitle?: string;
  transitionIn?: { type?: string; durationInFrames?: number } | null;
  transitionOut?: { type?: string; durationInFrames?: number } | null;
  elements?: AnyElement[];
  props?: Record<string, unknown>;
};
type AnyProject = {
  fps?: number;
  scenes?: AnyScene[];
  audio?: unknown;
};

/** 归一化：去空白、去标点、小写 —— 只用于"有没有说过"，不用于排版比对 */
export function normForMatch(s: unknown): string {
  return String(s ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。！？、；：""''（）()《》〈〉·—–\-…,.!?;:'"()<>]/g, "")
    .toLowerCase();
}

/** 看起来像颜色/URL/枚举值，不是"给人看的字" —— 不进契约语料，避免误判与噪音 */
const NON_TEXT = /^(#[0-9a-f]{3,8}|\/|https?:|rgba?\(|hsla?\()/i;
const NON_TEXT_KEYS = new Set(["type", "kind", "src", "url", "id", "fontFamily", "style", "filter", "blendMode", "fit", "textAlign", "direction", "mode", "place", "shape", "easing"]);

/** 递归摊平内置版式 props 里的文字（heading / items[].text / rows / value+label…） */
function collectPropStrings(v: unknown, key: string, out: string[], depth = 0): void {
  if (v === null || v === undefined || depth > 6) return;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t || NON_TEXT.test(t) || NON_TEXT_KEYS.has(key)) return;
    // 纯数字/纯序号不进语料（时长、序号之类），但 "1 音浪 = 0.1 元" 这种混合文本要留
    out.push(t);
    return;
  }
  if (typeof v === "number" || typeof v === "boolean") return;
  if (Array.isArray(v)) {
    for (const item of v) collectPropStrings(item, key, out, depth + 1);
    return;
  }
  if (typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      collectPropStrings(val, k, out, depth + 1);
    }
  }
}

/** 把工程里所有"看得见的字"摊平：字幕 + 元素文本 + 内置版式 props 文字 */
export function collectProjectText(project: AnyProject): {
  all: string;
  perScene: string[];
  subtitleLines: string[];
} {
  const perScene: string[] = [];
  const subtitleLines: string[] = [];
  const scenes = project.scenes ?? [];
  for (const s of scenes) {
    const parts: string[] = [];
    const sub = String(s.subtitle ?? "").trim();
    if (sub) {
      for (const line of sub.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        subtitleLines.push(t);
        parts.push(t);
      }
    }
    // 自由画布的元素在 props.elements 里，只看 s.elements 会漏掉整幕文字（见 shared/sceneElements.ts）
    for (const el of sceneAuditElements(s)) {
      const t = String(el?.text ?? "").trim();
      if (t) parts.push(t);
    }
    // 内置版式的正文（heading / items[].text / rows / value+label）也要进语料：
    // 契约讲的是"画面上有没有出现"，只看字幕等于强迫所有项目都配字幕（复盘问题 5）
    collectPropStrings(s.props ?? {}, "", parts);
    perScene.push(parts.join(" "));
  }
  return { all: perScene.join(" "), perScene, subtitleLines };
}

/** 从设计锁里挑出给审计用的那几项（lock 可能是存量 brief 里没有的） */
function sceneLockView(scenes: AnyScene[]) {
  return scenes.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    durationInFrames: s.durationInFrames,
    subtitle: s.subtitle,
    transitionIn: s.transitionIn ?? null,
    transitionOut: s.transitionOut ?? null,
    // 必须走归一化：freeform 的元素在 props.elements，直接读 s.elements 会让字号/元素数检查空转
    elements: sceneAuditElements(s).map((e) => ({
      kind: e.kind,
      name: e.name,
      text: e.text,
      size: e.size,
    })),
  }));
}

/**
 * 主入口：brief × 成片。
 * @param lock 设计锁（不传则只查信息类项）
 */
export function auditBriefAgainstProject(
  brief: Brief,
  project: AnyProject,
  lock?: DesignLock,
): AuditResult {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const passed: string[] = [];

  const scenes = project.scenes ?? [];
  const text = collectProjectText(project);
  const corpus = normForMatch(text.all);
  const NL = "\n";

  /* ① 必须出现的信息 —— 漏一条就算违约（这是"必须说的话真的说了"的唯一保证） */
  const must = (brief.mustInfo ?? []).filter((m) => String(m?.text ?? "").trim());
  if (must.length) {
    const missing = must.filter((m) => !corpus.includes(normForMatch(m.text)));
    if (missing.length) {
      blocking.push(
        `必须出现的信息漏了 ${missing.length}/${must.length} 项：` +
          missing.map((m) => `「${m.text}」`).join("、") +
          `${NL}    → 补进字幕或画面正文（不是"大概提到了"，要逐字出现）；这些是你明确要求过的`,
      );
    } else {
      passed.push(`必须出现的信息 ${must.length} 项全部出现`);
    }
  }

  /* ② 禁用词 / 竞品 —— 命中即违约 */
  const bans = (brief.bans ?? []).filter((b) => String(b ?? "").trim());
  if (bans.length) {
    const hit = bans.filter((b) => corpus.includes(normForMatch(b)));
    if (hit.length) {
      blocking.push(`出现禁用内容：${hit.map((b) => `「${b}」`).join("、")} —— 这是你要求绝对不能出现的`);
    } else {
      passed.push(`禁用清单 ${bans.length} 条均未出现`);
    }
  }

  /* ③ 开头第一句 —— 唯一能靠文案自动比对的"开头 3 秒" */
  const firstLine = String(brief.open3?.firstLine ?? "").trim();
  if (firstLine) {
    const actual = text.subtitleLines[0] ?? "";
    if (actual) {
      const a = normForMatch(actual);
      const w = normForMatch(firstLine);
      if (!a.includes(w) && !w.includes(a)) {
        warnings.push(
          `开头第一句对不上：契约是「${firstLine}」，成片第一条字幕是「${actual}」` +
            `${NL}    → 开头 3 秒是最贵的位置，不一致通常是稿子后来改了没回填 brief`,
        );
      } else {
        passed.push("开头第一句与契约一致");
      }
    } else {
      warnings.push(`还没有字幕，无法校验开头第一句（契约：「${firstLine}」）`);
    }
  }

  /* ④ 结尾动作 */
  const cta = String(brief.ending?.cta ?? "").trim();
  if (cta) {
    const lastSceneText = text.perScene[text.perScene.length - 1] ?? "";
    const inEnd = normForMatch(lastSceneText).includes(normForMatch(cta)) || corpus.includes(normForMatch(cta));
    if (!inEnd) {
      warnings.push(
        `结尾动作「${cta}」在成片文本（字幕 + 画面文案）里没找到 → 要么补一句同义表述，要么它只以二维码/图片形式出现（人工看末帧）`,
      );
    } else {
      passed.push("结尾动作在成片里能找到");
    }
  }

  /* ⑤ 段落表计划时长 vs 实际时长（这次 75s 估成 98.3s，所有帧位重算） */
  const segs = (brief.segments ?? []).filter((s) => Number(s?.endSec) > Number(s?.startSec));
  if (segs.length) {
    const planned = segs.reduce((n, s) => n + (Number(s.endSec) - Number(s.startSec)), 0);
    const fps = Number(project.fps || 30);
    const actualSec = totalDuration(project as never) / fps;
    if (planned > 0 && actualSec > 0) {
      const dev = (actualSec - planned) / planned;
      if (Math.abs(dev) > 0.1) {
        warnings.push(
          `时长偏离段落表：计划 ${planned.toFixed(1)}s，实际 ${actualSec.toFixed(1)}s（${dev > 0 ? "+" : ""}${(dev * 100).toFixed(0)}%）` +
            `${NL}    → 口播片以 TTS 实际时长为准；偏差 >10% 说明段落表和稿子已经脱节，转场/动画帧位要重算`,
        );
      } else {
        passed.push(`时长与段落表一致（${actualSec.toFixed(1)}s vs ${planned.toFixed(1)}s）`);
      }
    }
  }

  /* ⑥ 设计锁违约：元素数超标 / 转场不在白名单 / 转场过长 / 字号偏离 */
  if (lock) {
    const v = lockViolations(lock, sceneLockView(scenes));
    for (const x of v) {
      warnings.push(`${x.sceneName}：${x.message}`);
    }
    if (!v.length) passed.push("设计锁无违约（元素数 / 转场白名单 / 转场时长 / 字号）");
  }

  /* ⑦ 交付清单 —— 只做提醒，因为渲染产物不一定在工程里 */
  const dels = (brief.deliverables ?? []).filter((d) => String(d?.type ?? "").trim());
  if (dels.length) {
    passed.push(`交付清单 ${dels.length} 项：${dels.map((d) => d.type).join("、")}（导出时逐项核对）`);
  }

  return { ok: blocking.length === 0, blocking, warnings, passed };
}

/** 给人看的一段话（工具回执直接用） */
export function auditToText(r: AuditResult): string {
  const NL = "\n";
  const head = r.ok
    ? `契约体检通过 ✅（${r.passed.length} 项确认）`
    : `契约体检不通过 ❌（${r.blocking.length} 项违约）`;
  const block = r.blocking.length
    ? `${NL}必须修：${NL}` + r.blocking.map((x) => `  ✗ ${x}`).join(NL)
    : "";
  const warn = r.warnings.length
    ? `${NL}提醒：${NL}` + r.warnings.map((x) => `  ⚠️ ${x}`).join(NL)
    : "";
  const pass = r.passed.length ? `${NL}已确认：${NL}` + r.passed.map((x) => `  ✓ ${x}`).join(NL) : "";
  return `${head}${block}${warn}${pass}`;
}
