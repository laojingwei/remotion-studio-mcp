import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import { PROJECTS_ROOT } from "./paths";
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
/**
 * 这一幕让观众看懂哪一类变化（见 get_guide("meaning") 第二节）。
 *
 * 为什么是枚举而不是自由文本：自由文本每个人写法都不同，没法统计也没法校验；
 * 枚举才能回答"这部片子里有几幕真的承担了关系"。`plain` 是诚实的出口——
 * 封面、转场、落版本来就不承担关系，但 plain 过半就说明整片在逐句贴卡。
 */
export const SHOT_RELATIONS = [
  "cause", // 因果：A 先变，经可见路径影响 B
  "contrast", // 否定对比：不是 A 而是 B（保留同一比较维度）
  "whole", // 部分整体：从真实分件装配
  "scale", // 尺度：同一对象拉远逐层揭示
  "tradeoff", // 取舍：分支与代价同时显现
  "accumulate", // 累积：时间轴/留痕/增长
  "feeling", // 感受转变：姿态/空间/色/速度共同变
  "plain", // 不承担关系：封面 / 转场 / 落版
] as const;

export type ShotRelation = (typeof SHOT_RELATIONS)[number];

export const SHOT_RELATION_LABEL: Record<ShotRelation, string> = {
  cause: "因果",
  contrast: "否定对比",
  whole: "部分整体",
  scale: "尺度",
  tradeoff: "取舍",
  accumulate: "累积",
  feeling: "感受转变",
  plain: "不承担关系",
};

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
  /** 连续叙事三问③：关键变化与幕切换是否落在 BGM 重拍/口播重音上（craft.md §3） */
  sync?: string;
  /** 关系类型：这一幕承载七类关系里的哪一类；不写等于放弃说明"为什么有这一幕" */
  relation?: ShotRelation;
  /** 给 agent 自己的备注：要传达什么、要注意什么 */
  note?: string;
  /** build 后回填 */
  sceneId?: string;
};

export type Storyboard = {
  shots: Shot[];
  updatedAt?: string;
};

const ROOT = PROJECTS_ROOT;

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
    const rel = s.relation ? ` 〔${SHOT_RELATION_LABEL[s.relation] ?? s.relation}〕` : "";
    const text = s.text ? ` 口播：${s.text.replace(/\n/g, " / ")}` : "";
    const change = s.change ? ` 变化：${s.change}` : "";
    const carry = s.carry ? ` 承接：${s.carry}` : "";
    const sync = s.sync ? ` 同步：${s.sync}` : "";
    const note = s.note ? ` 备注：${s.note}` : "";
    return `${i + 1}. ${s.type}${name}${dur}${id}${rel}${text}${change}${carry}${sync}${note}`;
  });
  const head = `共 ${sb.shots.length} 幕${sb.updatedAt ? `（更新于 ${sb.updatedAt}）` : ""}：`;
  const tail =
    sb.shots.length > 12
      ? "\n⚠ 幕数超过 12：建议按章组织（每章 6–10 幕，name/note 标章），分章制作音频与验收——见 get_guide(\"long-form\")。"
      : "";
  return `${head}\n${lines.join("\n")}${tail}`;
}

/** 一句话写不出画面的空词：写进 note 等于没写，因为它不指向任何操作 */
const EMPTY_NOTE_WORDS = [
  "丝滑",
  "有质感",
  "大气",
  "高级感",
  "炫酷",
  "震撼",
  "科技感",
  "电影感",
  "氛围感",
  "国际化",
];

/**
 * 分镜阶段的设计体检（不阻断）。
 *
 * 为什么放在这一步：设计错误在写分镜时定型，等到 qa.md 的三肉身测试（第 14 步）才发现，
 * 改一幕要重建场景。这里能拦住的三件事——
 *   ① 关系覆盖：一幕都没标 relation，几乎必然做成逐句贴卡
 *   ② 空词：note 里写"丝滑/大气"这类词，等于把判断留给了运气
 *   ③ 两条人判据：遮住标题看正文 / 只读大字能否讲完故事
 */
export function storyboardDesignNotes(shots: Shot[]): { lines: string[]; relationCount: number; plainCount: number } {
  const n = shots.length;
  const relationCount = shots.filter((s) => s.relation && s.relation !== "plain").length;
  const plainCount = shots.filter((s) => s.relation === "plain").length;
  const unset = shots.filter((s) => !s.relation).length;
  const out: string[] = [];

  if (n >= 3) {
    if (relationCount === 0) {
      out.push(
        `· 没有一幕标了 relation（七类关系见 get_guide("meaning") §2）：这通常就是"逐句贴卡"。` +
          `挑 2–3 幕真正要讲清的关系补上，其余老实写 plain。`,
      );
    } else if (plainCount + unset > n / 2) {
      out.push(
        `· 承担关系的只有 ${relationCount}/${n} 幕（plain ${plainCount} / 未标 ${unset}）：` +
          `过半是换页，观众会觉得"像 PPT"，不是加动效能救的。`,
      );
    }
  }

  // 按词聚合，别按幕重复：同一个词出现在三幕，说一次就够（重复三遍会让人当噪音跳过）
  const wordHits = new Map<string, number[]>();
  shots.forEach((s, i) => {
    const hay = `${s.note ?? ""} ${s.change ?? ""}`;
    for (const w of EMPTY_NOTE_WORDS) {
      if (!hay.includes(w)) continue;
      wordHits.set(w, [...(wordHits.get(w) ?? []), i + 1]);
    }
  });
  if (wordHits.size) {
    const detail = [...wordHits.entries()]
      .map(([w, scenes]) => `「${w}」第 ${scenes.join("/")} 幕`)
      .slice(0, 5)
      .join("；");
    out.push(
      `· 这些词无法执行（${detail}）：换成"谁 / 从哪里 / 变成什么 / 多久"，` +
        `例如"标题从下方 40px 升起，0.4 秒停稳"`,
    );
  }

  // 两条通用自检只在"没有具体问题"时出现：每次都念会变成模板噪音，agent 会习惯性跳过
  if (!out.length && n >= 2) {
    out.push(
      `· 设计期自检两条（现在改最便宜）：① 遮住所有大字，还能看出每幕在说什么吗？` +
        `② 把所有幕的大字连成一段读，是完整故事还是一堆标签？——见 get_guide("meaning") §6`,
    );
  }

  return { lines: out, relationCount, plainCount };
}
