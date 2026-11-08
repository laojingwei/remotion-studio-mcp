/**
 * 风格勾选：用户在「风格库」面板里挑了哪几个内置风格。
 *
 * 为什么单独一个文件、而不并进 `styles.service.ts`：两者的"事实来源"不同。
 * 前者读磁盘上的风格文件（库是什么），后者读 `data/style-picks.json`（用户选了什么）。
 * 混在一个文件里，测试想验"读风格"就得先造一份 picks，反过来也一样。
 *
 * 历史：这里原来存两组——`ids`（341 条参考风格的编号，要翻译才能落地）和
 * `builtinSlugs`（能直接 apply_style）。参考风格拆掉后只剩一组，
 * 但**"能直接套 / 要翻译"这个区分本身没有消失**：它变成了"内置风格 / 提示词库"两个分区。
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "./paths";
import { listBuiltinStyles } from "./styles.service";
import type { StylePicks } from "../shared/builtin-styles";

const PICKS_FILE = path.join(DATA_ROOT, "style-picks.json");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

export function readPicks(): StylePicks | null {
  const p = readJson<StylePicks | null>(PICKS_FILE, null);
  if (!p) return null;
  // 老文件可能没有这个字段（参考风格时期写的），补成空数组，省得每个调用点都写 ?? []
  if (!Array.isArray(p.builtinSlugs)) p.builtinSlugs = [];
  return p;
}

/**
 * 写勾选。
 *
 * 会顺手把库里已不存在的 slug 剔掉并回告 —— 用户删了某个风格（或库重建过），
 * 旧的 picks 里还留着它时，agent 会拿一个过期 slug 去 apply_style，
 * 报错点离真正原因很远（"风格不存在"而不是"你上次选的那个被删了"）。
 */
export function writePicks(input: {
  builtinSlugs?: string[];
  note?: string;
  projectId?: string;
}): { picks: StylePicks; dropped: string[] } {
  const builtinAll = new Set(listBuiltinStyles().map((b) => b.slug));
  const slugs = [...new Set((input.builtinSlugs ?? []).map((s) => s.trim()).filter(Boolean))];
  const dropped = slugs.filter((s) => !builtinAll.has(s));

  const picks: StylePicks = {
    at: new Date().toISOString(),
    builtinSlugs: slugs.filter((s) => builtinAll.has(s)),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
  writeJson(PICKS_FILE, picks);
  return { picks, dropped };
}

/**
 * agent 侧排版用：把勾选渲染成几行文字，省得它自己拼。
 *
 * 这里必须写清「下一步做什么」，因为这是整条链路上最容易出错的地方：
 * 勾的是能一键套的风格，agent 却去"翻译"它，等于白扔一份现成预设；
 * 反过来，把风格规则当配色表硬套，会得到一片不对的东西。
 */
export function picksSummary(): string {
  const p = readPicks();
  const slugs = p?.builtinSlugs ?? [];
  if (!slugs.length) return "用户还没在编辑器里挑风格。";

  const all = listBuiltinStyles();
  const out: string[] = [];
  out.push(`用户挑了 ${slugs.length} 个风格（${p!.at.slice(0, 16).replace("T", " ")}）：`);
  out.push("");
  for (const slug of slugs) {
    const b = all.find((x) => x.slug === slug);
    out.push(`· ${slug} ${b?.name ?? ""}${b && !b.hasPreset ? "（只有规则没有预设，要手动套）" : ""}`);
  }
  out.push(
    "→ 这些都能 `apply_style(slug)` 一次落 palette/font/radius/转场/推荐版式/禁止项，**不要翻译**。多个候选就让用户挑，别一次全套；套完用 preview_frames 抽一帧确认没掉字。",
  );
  if (p?.note) out.push("", `备注：${p.note}`);
  return out.join("\n");
}
