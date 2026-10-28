import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";

/**
 * 分镜表（storyboard）：brief 之后、搭场景之前的中间层。
 *
 * agent 先把「每一幕：类型 / 文案 / 时长 / 口播 / 备注」写成结构化计划，
 * 用户确认后再一次性建成场景。好处：
 *  - 改分镜只改这一个文件，不用反复改工程；
 *  - 建立时能一次 apply_ops 批量建，省往返；
 *  - 每幕的 sceneId 回写到分镜里，后续对得上。
 */
export type Shot = {
  id?: string;
  /** 场景类型（list_scene_types 里的 key） */
  type: string;
  name?: string;
  /** 不传按类型默认时长 */
  durationInFrames?: number;
  /** 场景业务数据（直传给 add_scene 的 props） */
  props?: Record<string, unknown>;
  /** 这一幕的口播/字幕文本（一行一句）；build 时会写成 subtitle */
  text?: string;
  /** 连续叙事三问①：这一幕让观众看懂什么变化（craft.md §3） */
  change?: string;
  /** 连续叙事三问②：从上一幕承接什么（主体/位置/颜色/图形关系） */
  carry?: string;
  /** 给 agent 自己的备注：要传达什么、要注意什么 */
  note?: string;
  /** build 后回填 */
  sceneId?: string;
};

export type Storyboard = {
  shots: Shot[];
  updatedAt?: string;
};

const ROOT = path.join(PROJECT_ROOT, "data", "projects");

const fileOf = (projectId: string): string => {
  if (!/^[\w-]+$/.test(projectId)) throw new Error("非法的工程 id");
  return path.join(ROOT, projectId, "storyboard.json");
};

export function readStoryboard(projectId: string): Storyboard | null {
  const file = fileOf(projectId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Storyboard;
}

export function saveStoryboard(projectId: string, sb: Storyboard): Storyboard {
  if (!Array.isArray(sb.shots) || !sb.shots.length) {
    throw new Error("分镜表至少要有一幕");
  }
  for (const [i, shot] of sb.shots.entries()) {
    if (!shot?.type) throw new Error(`第 ${i + 1} 幕缺少 type`);
  }
  const next: Storyboard = {
    shots: sb.shots,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(fileOf(projectId)), { recursive: true });
  fs.writeFileSync(fileOf(projectId), JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** 分镜表 → 给人看的纯文本 */
export function storyboardToText(sb: Storyboard | null): string {
  if (!sb?.shots?.length) {
    return "还没有分镜表。先用 save_storyboard 写一幕幕的计划（type / props / durationInFrames / text / change / carry / note），确认后再 build_storyboard 一次建成。";
  }
  const lines = sb.shots.map((s, i) => {
    const dur = s.durationInFrames ? ` ${s.durationInFrames}f` : "";
    const name = s.name ? `「${s.name}」` : "";
    const id = s.sceneId ? ` [${s.sceneId}]` : "";
    const text = s.text ? ` 口播：${s.text.replace(/\n/g, " / ")}` : "";
    const change = s.change ? ` 变化：${s.change}` : "";
    const carry = s.carry ? ` 承接：${s.carry}` : "";
    const note = s.note ? ` 备注：${s.note}` : "";
    return `${i + 1}. ${s.type}${name}${dur}${id}${text}${change}${carry}${note}`;
  });
  const head = `共 ${sb.shots.length} 幕${sb.updatedAt ? `（更新于 ${sb.updatedAt}）` : ""}：`;
  const tail =
    sb.shots.length > 12
      ? "\n⚠ 幕数超过 12：建议按章组织（每章 6–10 幕，name/note 标章），分章制作音频与验收——见 get_guide(\"long-form\")。"
      : "";
  return `${head}\n${lines.join("\n")}${tail}`;
}
