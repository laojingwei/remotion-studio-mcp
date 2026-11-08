import fs from "node:fs";
import path from "node:path";

import type { Brief } from "./brief.service";
import { briefCoverage } from "./brief.service";
import { PROJECTS_ROOT } from "./paths";
import type { Review } from "./review.service";
import type { StylePicks } from "../shared/builtin-styles";
import {
  SHOT_RELATION_LABEL,
  storyboardDesignNotes,
  type Shot,
  type ShotRelation,
  type Storyboard,
} from "./storyboard.service";
import { getMeta } from "../shared/sceneMetas";
import { SUBTITLE_LIMITS } from "../shared/subtitleText";

/**
 * 设计稿（design card）：分镜之后、建场景之前给人看的那份东西。
 *
 * 为什么要有它：
 * 分镜表是给 agent 看的（JSON + type 名 + props），用户读不懂也改不动；成片是给人看的，
 * 但那时候改一幕要重建场景。中间缺一层"人能直接读、改一句就能落到分镜"的交付物，
 * 于是用户第一次真正理解这部片子长什么样，是在它已经做完了之后。
 *
 * 这份稿子刻意只写"用户能判断的东西"：每幕屏幕上出现什么字、口播说什么、这一幕承担
 * 什么关系、有没有踩禁忌。**不写** type 名与 props 结构——那是实现细节，用户改不动，
 * 写进去只会让他以为要懂技术。
 */

export type DesignGap = {
  /** block = 不修就不该建场景（信息缺失 / 事实风险）；warn = 可以边做边改 */
  level: "block" | "warn";
  text: string;
};

export type DesignCard = {
  markdown: string;
  gaps: DesignGap[];
  stats: {
    shots: number;
    totalSec: number;
    relationCount: number;
    plainCount: number;
    unsetCount: number;
  };
};

/** 归一化后比对：全角/半角、空格、标点都不参与，只比"字" */
const norm = (s: unknown): string =>
  String(s ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。！？、；：""''（）()《》·—–\-…,.!?;:'"()<>[\]{}]/g, "")
    .toLowerCase();

const cell = (s: string, max = 46): string => {
  const t = String(s ?? "").replace(/\|/g, "/").replace(/\n+/g, " ").trim();
  if (!t) return "—";
  return [...t].length > max ? `${[...t].slice(0, max).join("")}…` : t;
};

const looksLikeMachine = (s: string): boolean =>
  /^(#[0-9a-f]{3,8}|rgba?\(|https?:\/\/|\/[a-z0-9_-]+\/)/i.test(s) ||
  /^[a-z0-9_-]{1,2}$/i.test(s) ||
  /\.(png|jpe?g|webp|mp4|mp3|wav|ttf|otf)$/i.test(s);

/** 从 props 里挑出"用户能在画面上看到的字"：标题、条目、数字，忽略色值/路径/id */
/** 这些 key 上的数字是排版参数不是内容（counter 的 decimals、坐标、时长……），收进"屏幕字"全是噪音 */
const NUM_PARAM_KEYS = new Set([
  "decimals", "duration", "durationInFrames", "startSec", "endSec", "x", "y", "w", "h",
  "width", "height", "size", "radius", "rotation", "opacity", "frames", "delay", "order",
  "index", "level", "fps", "from", "to", "step", "progress",
]);

function seenOnScreen(props: Record<string, unknown> | undefined, depth = 0): string[] {
  if (!props || depth > 2) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "string") {
      const s = v.trim();
      if (!s || s.length > 60 || looksLikeMachine(s)) continue;
      out.push(s);
    } else if (typeof v === "number" && Number.isFinite(v)) {
      // counter 的 value=60 是屏幕上最大的字，丢了它逐幕表只剩 "%"；
      // 但 decimals=0 这类参数数字不能收——用 key 名单挡
      if (!NUM_PARAM_KEYS.has(k) && Math.abs(v) < 1_000_000) out.push(String(v));
    } else if (Array.isArray(v)) {
      for (const item of v.slice(0, 4)) {
        if (typeof item === "string") {
          if (item.trim() && !looksLikeMachine(item.trim()) && item.length <= 60) out.push(item.trim());
        } else if (item && typeof item === "object") {
          out.push(...seenOnScreen(item as Record<string, unknown>, depth + 1));
        }
      }
    } else if (v && typeof v === "object") {
      out.push(...seenOnScreen(v as Record<string, unknown>, depth + 1));
    }
    if (out.length >= 6) break;
  }
  return out;
}

const shotScreenText = (s: Shot): string => {
  const seen = seenOnScreen(s.props).slice(0, 3).join(" / ");
  return seen || (s.name ?? "");
};

/** 一幕的长度：显式 durationInFrames 优先，否则按版式默认 */
const shotFrames = (s: Shot): number => {
  if (Number(s.durationInFrames) > 0) return Number(s.durationInFrames);
  return getMeta(s.type)?.duration?.default ?? 90;
};

/** 分镜里所有"会被看到的文字"（含 props），用于 mustInfo / bans 的覆盖判断 */
function allVisibleText(shots: Shot[]): string {
  const parts: string[] = [];
  for (const s of shots) {
    parts.push(s.text ?? "", s.name ?? "", seenOnScreen(s.props).join(" "));
  }
  return parts.join(" ");
}

/**
 * 设计稿要用户确认的缺口。
 *
 * 只报"用户能听懂、agent 能立即改"的：不写"缺少 relation 字段"这种内部术语，
 * 而写"第 3、7 幕看不出在讲什么变化"。
 */
export function designGaps(input: {
  brief: Brief | null;
  shots: Shot[];
  review: Review | null;
  fps: number;
  totalSec: number;
}): DesignGap[] {
  const { brief, shots, review, fps, totalSec } = input;
  const gaps: DesignGap[] = [];
  const visible = allVisibleText(shots);
  const normVisible = norm(visible);

  // ① 必须出现的信息：真去画面/口播里找，不是"brief 里写了就算"
  for (const m of brief?.mustInfo ?? []) {
    const t = String(m.text ?? "").trim();
    if (!t) continue;
    const keys = t
      .split(/[、,，/／]|\s{2,}/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 2);
    const hit = (keys.length ? keys : [t]).every((k) => normVisible.includes(norm(k)));
    if (!hit) {
      gaps.push({
        level: "block",
        text: `必须出现的信息「${t}」在分镜里找不到（${m.where ? `要求在${m.where}` : "不限位置"}）——建出来也不会出现`,
      });
    }
  }

  // ② 禁用词：出现在任何一幕都是硬伤（合规/客户明确要求）。
  //    按「哪一幕 + 上下文」报：bans 里写「第一」会命中文案里的「第一句」，
  //    没有上下文的话 agent 没法一眼判断是真违规还是量词误伤，只能来回猜
  for (const b of [...(brief?.bans ?? []), ...(brief?.forbidden ?? [])]) {
    const w = String(b ?? "").trim();
    if (!w || w.length < 2) continue;
    const nw = norm(w);
    const hits: string[] = [];
    shots.forEach((s, i) => {
      const hay = norm(`${s.text ?? ""} ${s.name ?? ""} ${seenOnScreen(s.props).join(" ")}`);
      const idx = hay.indexOf(nw);
      if (idx >= 0) {
        hits.push(`第 ${i + 1} 幕「…${hay.slice(Math.max(0, idx - 8), idx + nw.length + 8)}…」`);
      }
    });
    if (hits.length) {
      gaps.push({
        level: "block",
        text:
          `禁用词「${w}」命中 ${hits.length} 处：${hits.slice(0, 3).join("；")}` +
          `——先看上下文：若是普通量词（如「第一句」）请把 bans 写得更具体（如「全网第一」）；确属宣传用语就改文案`,
      });
    }
  }

  // ③ 关系覆盖（storyboardDesignNotes 已经算过，这里转成人话）
  const design = storyboardDesignNotes(shots);
  for (const line of design.lines) {
    const text = line.replace(/^·\s*/, "");
    // 通用自检那一条不放进"缺口清单"，它属于提醒而不是待办
    if (text.startsWith("设计期自检两条")) continue;
    gaps.push({ level: "warn", text });
  }

  // ④ 风格样张：用户第一次看到画面不该是成片
  if (!review?.probeAt && !review?.chosenStyle) {
    gaps.push({
      level: "warn",
      text: "还没做过风格样张：用户第一次看到画面会是成片。建第一幕之后用 probe_style 出一张给他看",
    });
  }

  // ⑤ 时长与目标
  const target = Number(brief?.durationSec ?? 0);
  if (target > 0 && totalSec > 0) {
    const diff = Math.abs(totalSec - target) / target;
    if (diff > 0.15) {
      gaps.push({
        level: "warn",
        text: `分镜合计 ${totalSec.toFixed(1)}s，目标 ${target}s（差 ${(diff * 100).toFixed(0)}%）——先确认是这个长度，还是漏/多了段落`,
      });
    }
  }

  // ⑥ 单幕字幕超长：一屏读不完是硬伤，check_project 会拦，但那时候已经建完了
  const longShots: string[] = [];
  shots.forEach((s, i) => {
    const lines = String(s.text ?? "")
      .split("\n")
      .map((x) => [...x.trim()].length)
      .filter((n) => n > 0);
    const worst = lines.length ? Math.max(...lines) : 0;
    if (worst > SUBTITLE_LIMITS.max) longShots.push(`第 ${i + 1} 幕 ${worst} 字`);
  });
  if (longShots.length) {
    gaps.push({
      level: "warn",
      text: `这些幕的一句话超过 ${SUBTITLE_LIMITS.max} 字（${longShots.slice(0, 5).join("、")}${longShots.length > 5 ? " 等" : ""}）——字幕会挤成两行或一闪而过，先拆句`,
    });
  }

  // ⑦ 空幕：既没有画面文字也没有口播，建出来是几秒的空白
  const emptyShots = shots
    .map((s, i) => ({ i: i + 1, empty: !shotScreenText(s) && !String(s.text ?? "").trim() }))
    .filter((x) => x.empty)
    .map((x) => `第 ${x.i} 幕`);
  if (emptyShots.length) {
    gaps.push({
      level: "warn",
      text: `${emptyShots.slice(0, 5).join("、")} 既没有画面文字也没有口播——建出来是几秒空白，加字或删掉`,
    });
  }

  // ⑦.5 字幕与大标题逐字相同：观众会在同一屏看到同一句话两遍。
  //    这是最典型的"PPT 感"来源之一——用户说不出哪里不对，但会觉得难受，所以要机器替他指出来
  const dupSubs = shots
    .map((s, i) => {
      const t = norm(s.text);
      if (!t) return "";
      const heading = ["heading", "title", "quote"]
        .map((k) => (s.props as Record<string, unknown> | undefined)?.[k])
        .find((v) => typeof v === "string" && v.trim());
      return heading && norm(heading as string) === t ? `第 ${i + 1} 幕` : "";
    })
    .filter(Boolean);
  if (dupSubs.length) {
    gaps.push({
      level: "warn",
      text:
        `${dupSubs.slice(0, 4).join("、")}的字幕和大标题逐字相同——同一屏同一句话出现两遍。` +
        `字幕删掉（大字已经承担了），或改成衔接上一幕的句子`,
    });
  }

  // ⑧ 时长过短：一眨眼就过去，观众读不完
  const tooShort = shots
    .map((s, i) => ({ i: i + 1, sec: shotFrames(s) / fps }))
    .filter((x) => x.sec < 1.2)
    .map((x) => `第 ${x.i} 幕 ${x.sec.toFixed(1)}s`);
  if (tooShort.length) {
    gaps.push({
      level: "warn",
      text: `${tooShort.slice(0, 5).join("、")} 不到 1.2 秒——观众读不完这一屏，除非是刻意快切`,
    });
  }

  // ⑨ 读窗不够：字数 × 0.25s + 0.3s 的落字时间还没走完，幕就切走了
  //    （和 ⑥ 的"超 18 字"不是一回事：那条管单屏太长，这条管这幕给的时间不够读完）
  const tooFast = shots
    .map((s, i) => {
      const chars = [...String(s.text ?? "").replace(/\s/g, "")].length;
      const need = chars * 0.25 + 0.3;
      const have = shotFrames(s) / fps;
      return { i: i + 1, chars, need, have };
    })
    .filter((x) => x.chars > 0 && x.have < x.need)
    .map((x) => `第 ${x.i} 幕 ${x.chars} 字只给了 ${x.have.toFixed(1)}s（需 ${x.need.toFixed(1)}s）`);
  if (tooFast.length) {
    gaps.push({
      level: "warn",
      text: `${tooFast.slice(0, 4).join("、")}${tooFast.length > 4 ? " 等" : ""}——读不完，观众只能"看到"不能"读到"。拆句或加时长（见 get_guide("text-events") 第一节）`,
    });
  }

  // ⑩ brief 自身的机器缺口：只取影响画面内容的那几类（core / form / segments）。
  // 参考标注、素材责任人、交付清单属于流程文件，放进"设计稿待确认"只会稀释信号。
  if (brief) {
    const cov = briefCoverage(brief);
    for (const b of cov.blocking.filter((x) => /^(core\.|form$|segments\.)/.test(x.code)).slice(0, 4)) {
      gaps.push({ level: "warn", text: `需求里还缺（补一句就能过）：${b.message}` });
    }
  } else {
    gaps.push({ level: "warn", text: "没有需求档案（brief）：这份设计稿只有画面，目标/受众/禁忌都没法校验" });
  }

  return gaps;
}

const fmtSec = (n: number): string => (n >= 60 ? `${Math.floor(n / 60)}分${(n % 60).toFixed(1)}秒` : `${n.toFixed(1)}秒`);

/** 生成设计稿 markdown。纯函数：同样的输入必须出同样的稿子，否则测试无从断言 */
export function buildDesignCard(input: {
  project: { name: string; fps: number; formats?: { key: string; label: string; width: number; height: number }[] };
  brief: Brief | null;
  storyboard: Storyboard | null;
  picks?: StylePicks | null;
  review?: Review | null;
  now?: Date;
}): DesignCard {
  const { project, brief, storyboard, picks, review } = input;
  const shots = storyboard?.shots ?? [];
  const fps = project.fps > 0 ? project.fps : 30;
  const totalSec = shots.reduce((n, s) => n + shotFrames(s), 0) / fps;

  const relationCount = shots.filter((s) => s.relation && s.relation !== "plain").length;
  const plainCount = shots.filter((s) => s.relation === "plain").length;
  const unsetCount = shots.filter((s) => !s.relation).length;

  const gaps = designGaps({ brief, shots, review: review ?? null, fps, totalSec });
  const blocks = gaps.filter((g) => g.level === "block");
  const warns = gaps.filter((g) => g.level === "warn");

  const L: string[] = [];
  const at = (() => {
    const d = input.now ?? new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    // 不能直接用 toISOString：那是 UTC，东八区生成 02:00 的稿子会显示成前一天 18:00
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();

  L.push(`# 设计稿 · ${project.name}`);
  L.push("");
  L.push(
    `> ${shots.length} 幕 ｜ 合计 ${fmtSec(totalSec)} ｜ ${project.formats?.[0] ? `${project.formats[0].width}×${project.formats[0].height}` : "画幅未定"} ｜ ${fps}fps ｜ 生成于 ${at}`,
  );
  L.push(">");
  L.push(
    "> **这是给人看的一版，还没建任何场景。** 看的时候只判断两件事：每幕的字是不是你要说的、连起来是不是一个完整故事。",
  );
  L.push("> 要改直接说位置和改法（「第 3 幕大字改成 X」「第 5 幕删掉」），我改分镜再重出这份，不用重建场景。");
  L.push("");

  // ── 一、这部片子是什么
  L.push("## 一、这部片子是什么");
  L.push("");
  const core = brief?.core;
  if (core) {
    L.push(
      `- **一句话**：让【${core.who ?? "?"}】知道/相信【${core.believe ?? "?"}】，然后去做【${core.action ?? "?"}】`,
    );
  } else {
    L.push("- **一句话**：需求里还没写（第 1 步的 who / believe / action）");
  }
  L.push(
    `- **形态与时长**：${brief?.form ?? "未定"} ｜ 目标 ${brief?.durationSec ? `${brief.durationSec}s` : "未定"} ｜ 实际排 ${fmtSec(totalSec)}`,
  );
  L.push(`- **给谁看 / 发在哪**：${brief?.audience ?? "未写"} ｜ ${brief?.platform ?? "未写"}`);
  if (brief?.takeaway) L.push(`- **要记住的一句**：${brief.takeaway}`);
  if (brief?.hook) L.push(`- **前 1 秒**：${brief.hook}`);
  L.push("");

  // ── 二、结构
  const segs = (brief?.segments ?? []).filter((s) => s && (s.content || s.startSec !== undefined));
  if (segs.length) {
    L.push("## 二、结构");
    L.push("");
    L.push("| 段 | 时间 | 这一段说什么 |");
    L.push("|---|---|---|");
    segs.forEach((s, i) => {
      const range =
        s.startSec !== undefined && s.endSec !== undefined ? `${s.startSec}–${s.endSec}s` : "—";
      L.push(`| ${i + 1} | ${range} | ${cell(String(s.content ?? ""), 52)} |`);
    });
    L.push("");
  }

  // ── 三、逐幕表（核心）
  L.push("## 三、逐幕表");
  L.push("");
  if (!shots.length) {
    L.push("_还没有分镜。先用 save_storyboard 写下每一幕。_");
    L.push("");
  } else {
    L.push("| # | 时长 | 屏幕上出现什么字 | 口播 / 字幕 | 这一幕让观众看懂什么变化 |");
    L.push("|---|---|---|---|---|");
    shots.forEach((s, i) => {
      // plain 是"封面/转场/落版"，它本来就不承担关系，催它写变化是错的
      const change = s.relation === "plain"
        ? `换页${s.change ? `：${s.change}` : ""}`
        : `${s.relation ? `${SHOT_RELATION_LABEL[s.relation] ?? s.relation}｜` : ""}${s.change ?? "（没写变化）"}`;
      const screen = shotScreenText(s);
      L.push(
        `| ${i + 1} | ${(shotFrames(s) / fps).toFixed(1)}s | ${cell(screen)} | ${cell(s.text ?? "", 40)} | ${cell(change, 40)} |`,
      );
    });
    L.push("");
  }

  // ── 四、关系覆盖
  if (shots.length) {
    const pct = Math.round((relationCount / shots.length) * 100);
    const byRel = new Map<ShotRelation, number>();
    shots.forEach((s) => {
      if (s.relation) byRel.set(s.relation, (byRel.get(s.relation) ?? 0) + 1);
    });
    const dist = [...byRel.entries()]
      .filter(([k]) => k !== "plain") // plain 下面单独有一行，混进分布里会显得"封面也在讲关系"
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${SHOT_RELATION_LABEL[k]}×${n}`)
      .join("、");
    L.push("## 四、这几幕在讲关系吗");
    L.push("");
    L.push(
      `- 真正承担关系的：**${relationCount}/${shots.length} 幕（${pct}%）**${dist ? ` —— ${dist}` : ""}`,
    );
    L.push(`- 只是换页（封面/转场/落版）：${plainCount} 幕${unsetCount ? `，另有 ${unsetCount} 幕没标` : ""}`);
    if (relationCount === 0) {
      L.push("- ⚠ 一幕都没有承担关系：观众会觉得「像 PPT」，这不是加动效能救的（见 get_guide(\"meaning\")）");
    } else if (plainCount + unsetCount > shots.length / 2) {
      L.push("- ⚠ 过半是换页：每屏都在换内容但没有一条线把它们串起来，观众记不住");
    }
    L.push("");
  }

  // ── 五、视觉
  L.push("## 五、视觉");
  L.push("");
  const builtinPicks = picks?.builtinSlugs ?? [];
  L.push(`- **风格**：${brief?.style ?? "未定"}${builtinPicks.length ? `（内置：${builtinPicks.join("、")}）` : ""}`);
  // 设计稿里不再单列「参考画风」：参考风格库已拆掉，画风现在就等于 builtinSlugs 里的 slug
  if (builtinPicks.length && picks?.note) L.push(`- **风格备注**：${picks.note}`);
  L.push(`- **情绪**：${(brief?.mood ?? []).join("、") || "未定"} ｜ **动感**：${brief?.motion ?? "未定"}`);
  if (brief?.palette) L.push(`- **配色**：${brief.palette}`);
  if (brief?.type) L.push(`- **字体 / 排版**：${brief.type}`);
  if (brief?.signature) L.push(`- **记忆点**：${brief.signature}`);
  const avoid = [...(brief?.forbidden ?? []), ...(brief?.bans ?? [])];
  if (avoid.length) L.push(`- **绝对不出现**：${avoid.join("、")}`);
  L.push("");

  // ── 六、声音
  const soundBits = [
    brief?.voice ? `配音：${brief.voice}` : "",
    brief?.bgm?.mood ? `BGM：${brief.bgm.mood}${brief.bgm.energy ? ` / ${brief.bgm.energy}` : ""}` : "",
    brief?.soundPlan ? `声音计划：${brief.soundPlan}` : "",
    brief?.sfx ? `音效：${brief.sfx}` : "",
  ].filter(Boolean);
  if (soundBits.length) {
    L.push("## 六、声音");
    L.push("");
    for (const b of soundBits) L.push(`- ${b}`);
    L.push("");
  }

  // ── 七、要你拍板的
  L.push("## 七、要你拍板的");
  L.push("");
  if (!gaps.length) {
    L.push("没有发现硬伤。剩下就是审美判断：这些字是不是你要说的、这个顺序顺不顺。");
  } else {
    if (blocks.length) {
      L.push(`**必须修（${blocks.length} 条，不修的话建出来就是错的）**`);
      L.push("");
      for (const g of blocks) L.push(`- [ ] ${g.text}`);
      L.push("");
    }
    if (warns.length) {
      L.push(`**建议改（${warns.length} 条，边做边改也行）**`);
      L.push("");
      for (const g of warns) L.push(`- [ ] ${g.text}`);
      L.push("");
    }
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push(
    `确认无误就说「就按这个建」，我 build_storyboard 一次建成。要改就按上面的编号说（例如「第 3 幕大字换成…」「把第七幕删掉」）。`,
  );

  return {
    markdown: L.join("\n"),
    gaps,
    stats: { shots: shots.length, totalSec, relationCount, plainCount, unsetCount },
  };
}

const designFileOf = (projectId: string): string => {
  if (!/^[\w-]+$/.test(projectId)) throw new Error("非法的工程 id");
  return path.join(PROJECTS_ROOT, projectId, "design.md");
};

export function writeDesignCard(projectId: string, markdown: string): string {
  const file = designFileOf(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, markdown, "utf8");
  return file;
}

export function readDesignCard(projectId: string): string | null {
  const file = designFileOf(projectId);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}
