/**
 * 分镜表相关：保存/读取/校验分镜、一次建成整片（build_storyboard / build_film）。
 *
 * 从原 scene3d.ts 里拆出来的（该文件此前混着工程/稿件/分镜类工具）。
 * 约定：这些工具由 mcp-tools.ts 按固定顺序 spread 回 TOOLS，顺序影响 tool_search 的同分排序。
 */

import { z } from "zod";
import {
  SKIPPED_NOTE,
  TRANSITION_DEFAULT_FRAMES,
  alignScenesToStoryboard,
  api,
  assertNarrationHeard,
  processGateBypass,
  resolveProject,
  text,
} from "./_shared";
import type { ToolDef } from "./_shared";

import fs from "node:fs";
import path from "node:path";
import { briefProgress, readBrief, stepMissingFields } from "../brief.service";

import { densitySummary, projectDensity, rhythmIssues } from "../../shared/density";
import { readScript } from "../script.service";
import { readReview } from "../review.service";
import { readStoryboard, saveStoryboard, storyboardToText, type Storyboard } from "../storyboard.service";
import { getMeta } from "../../shared/sceneMetas";
import { TRANSITION_TYPES } from "../../shared/transitions";

import { staggerAnim } from "../../shared/freeform";
import { SUBTITLE_LIMITS, normalizeSubtitle, subtitleToField } from "../../shared/subtitleText";

import { lintScriptLines } from "../../shared/copyLint";

export const STORYBOARD_TOOLS: ToolDef[] = [
  {
    name: "save_storyboard",
    description:
      "保存分镜表（brief 之后、搭场景之前的计划）：每幕给 type / props / durationInFrames / text（口播字幕）/ note。先确认分镜，再 build_storyboard 一次建成。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      useNarrationTiming: z
        .boolean()
        .optional()
        .describe("true = 用 tts_narration(mode='timing') 落盘的真实时长回填每幕 durationInFrames（口播片强烈建议）"),
      append: z
        .boolean()
        .optional()
        .describe("true = 追加到现有分镜表后面（分多次提交长片分镜用；默认整份替换）"),
      shots: z
        .array(
          z.object({
            type: z.string().describe("场景类型，见 list_scene_types"),
            name: z.string().optional(),
            durationInFrames: z.number().int().optional().describe("不传按类型默认"),
            props: z.record(z.any()).optional().describe("场景业务数据（直传 add_scene 的 props）"),
            text: z.string().optional().describe("这一幕的口播/字幕文本（一行一句）"),
            change: z
              .string()
              .optional()
              .describe("连续叙事三问①：这一幕让观众看懂什么变化（get_guide(\"craft\") §3）"),
            carry: z.string().optional().describe("连续叙事三问②：从上一幕承接什么（主体/位置/颜色）"),
            note: z.string().optional().describe("给自己的备注：要传达什么"),
          }),
        )
        .min(1)
        .describe("分镜：一幕一项，顺序就是出场顺序"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);

      // 口播片：幕长取自配音实测，不是估算。
      // 这一步放在校验之前 —— 回填出来的时长也要过一遍各类型的 min/max。
      let timingNote = "";
      if (a.useNarrationTiming) {
        const t = await api<{
          timing: { fps: number; totalSec: number; segments: { text: string; suggested: number }[] } | null;
        }>(`/api/projects/${p.id}/narration-timing`);
        const timing = t.timing;
        if (!timing) {
          throw new Error(
            "还没有旁白时间骨架：先 tts_narration(mode=\"timing\", segments=[...]) 跑一遍（一幕一段），再回来存分镜",
          );
        }
        // 用配音骨架排幕长 = 绑定了这版语音，必须先让用户听过
        await assertNarrationHeard(p.id, "按配音骨架存分镜");
        if (timing.segments.length !== a.shots.length) {
          throw new Error(
            `段数对不上：TTS 有 ${timing.segments.length} 段，分镜有 ${a.shots.length} 幕。` +
              `口播片要一幕一段 —— 先对齐（要么改分镜，要么重跑 tts_narration(mode="timing")），别硬存`,
          );
        }
        a = {
          ...a,
          shots: a.shots.map((shot: Record<string, unknown>, i: number) => ({
            ...shot,
            durationInFrames: timing.segments[i].suggested,
          })),
        };
        const planned = Number(readBrief(p.id)?.durationSec ?? 0);
        const dev =
          planned > 0
            ? `；brief 计划 ${planned}s → 实测 ${timing.totalSec.toFixed(1)}s（${(((timing.totalSec - planned) / planned) * 100).toFixed(0)}%）`
            : "";
        timingNote = `\n幕长已按配音回填（${timing.segments.length} 段 / ${timing.totalSec.toFixed(1)}s${dev}）`;
      }

      // 写分镜时就按各类型 schema 校验，别等 build 整批原子失败
      for (const [i, shot] of a.shots.entries()) {
        const meta = getMeta(shot.type);
        if (!meta) throw new Error(`第 ${i + 1} 幕：未知场景类型「${shot.type}」（先 list_scene_types）`);
        const parsed = meta.schema.safeParse({ ...meta.defaultProps, ...(shot.props ?? {}) });
        if (!parsed.success) {
          const errs = parsed.error.issues
            .map((e) => `${e.path.join(".") || "(根)"}：${e.message}`)
            .join("；");
          throw new Error(`第 ${i + 1} 幕（${shot.type}）props 校验失败：${errs}`);
        }
      }
      const prevShots = a.append ? (readStoryboard(p.id)?.shots ?? []) : [];
      const sb = saveStoryboard(p.id, { shots: [...prevShots, ...(a.shots as Storyboard["shots"])] });
      // 分镜是最后一次「只动文字」的机会：这里不体检，等铺开再改就要重建场景
      const shotLint = lintScriptLines(
        sb.shots.flatMap((s, i) => {
          const out: { text: string; kind: "screen" | "voice"; label: string }[] = [];
          if (s.text) out.push({ text: s.text, kind: "voice", label: `第 ${i + 1} 幕口播` });
          const head = (s.props as Record<string, unknown> | undefined)?.title;
          if (typeof head === "string" && head.trim()) {
            out.push({ text: head, kind: "screen", label: `第 ${i + 1} 幕大字` });
          }
          return out;
        }),
      );
      const lintNote = shotLint.length
        ? `${String.fromCharCode(10)}文案体检（提醒，不阻断；现在改最便宜）：${String.fromCharCode(10)}- ${shotLint
            .slice(0, 8)
            .join(`${String.fromCharCode(10)}- `)}`
        : "";
      return `${timingNote ? `${timingNote}${String.fromCharCode(10)}` : ""}已保存分镜表${a.append ? `（追加 ${a.shots.length} 幕，共 ${sb.shots.length} 幕）` : ""}${String.fromCharCode(10)}${storyboardToText(sb)}${lintNote}${String.fromCharCode(10)}下一步：确认分镜后 build_storyboard 一次建成（会顺带写字幕）`;
    },
  },
  {
    name: "get_storyboard",
    description: "读取当前分镜表（开工前/搭建中对照用）。",
    shape: { projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      return storyboardToText(readStoryboard(p.id));
    },
  },
  {
    name: "build_storyboard",
    description:
      "按分镜表建成场景：每幕 add_scene（type/props/时长/名字），口播文本写成字幕，并把 sceneId 回填分镜。replace=true 会先清掉工程现有场景。\n别一次铺满再给用户看：先 build_storyboard(shot=1) 只建第 1 幕 → preview_frame 给用户过目 → 满意再 build_storyboard(replace=true) 全量建（会重建第 1 幕，属正常）。\n⚠️ 建出来的幕转场是默认 fade 12 帧——brief 设计锁里的转场档位（如「利落」= zoom 8 帧）不会被继承，建完用 set_transitions 按设计锁补一遍，否则 check_project 会报转场违约。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      shot: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("只建第 N 幕（1 起）——风格帧验证专用；只建单幕时忽略 replace"),
      replace: z.boolean().optional().describe("先删掉工程现有场景再建（默认 false：追加）"),
      attachSubtitle: z.boolean().optional().describe("把每幕 text 写成字幕，默认 true"),
      skipChecks: z
        .boolean()
        .optional()
        .describe(
          "跳过流程闸口（需求问诊 / 需求确认 / 风格样张 / 稿件确认 / 配音试听）。用户明确说「直接建 / 不用问了」才传；验收与契约闸口不受影响",
        ),
      skipReason: z
        .string()
        .optional()
        .describe("用户让你跳过的原话（至少 2 字）；skipChecks=true 时必填，会记录在回执里"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const bypass = processGateBypass(a);
      const skippedGates: string[] = [];
      /** 流程性闸口统一处理：不旁路就挡，旁路就留痕 */
      const gate = (blocked: boolean, message: string, label: string) => {
        if (!blocked) return;
        if (bypass) {
          skippedGates.push(label);
          return;
        }
        throw new Error(message);
      };
      // 需求 9 步没问完就不许开建（重要配置不能自己定）
      const brief = readBrief(p.id);
      const progress = briefProgress(brief);
      gate(
        !progress.finished,
        `需求还没问完（${progress.done.length}/9），下一步该问第 ${progress.next} 步。` +
          `先用 intake(${progress.next}) 看要问什么，save_brief(step=${progress.next}) 逐步补齐，再 build_storyboard。` +
          `（用户明确说「直接建」时：skipChecks=true + skipReason=他的原话）`,
        `需求问诊未完成（${progress.done.length}/9）`,
      );
      gate(
        !(brief as any)?.confirmedAt,
        "需求还没请用户确认：把 9 步总结发给用户，用户确认后调用 confirm_brief，再 build_storyboard。",
        "需求未确认",
      );
      // 开工前给用户看过样张：方向错了，后面 50 幕全是白做
      const probe = readReview(p.id);
      gate(
        !probe?.probeAt,
        "开工前还没让用户看过效果：先 probe_style(slugs=[...]) 出 1–3 张风格样张 → 把图发给用户挑 → " +
          "confirm_style_probe(slug)，再写分镜。\n" +
          "这一步省不得：方向不对的话，现在改一张图；等 50 幕铺完再改，是全线返工。",
        "风格样张未确认",
      );

      // 稿子没确认就别写分镜（无稿类除外）：分镜每一幕的 text 都该来自稿件，不该临场编
      const briefScriptType = (brief as any)?.scriptType as string | undefined;
      const needsScript = !!briefScriptType && !/无稿/.test(briefScriptType);
      if (needsScript) {
        const sc = readScript(p.id);
        gate(
          !sc || (!sc.segments?.length && !sc.sourceText),
          `稿件类型是「${briefScriptType}」，但还没有稿件：` +
            `intake(10) 看该问什么 → save_script 写稿 → confirm_script 请用户过目，再写分镜。`,
          "稿件未写",
        );
        gate(
          !sc?.confirmedAt,
          "稿件还没请用户确认：把稿子（每段 + 预估秒数）发给用户过目，点头后 confirm_script，再 save_storyboard / build_storyboard。",
          "稿件未确认",
        );
      }
      // 配音闸口：没让用户听过这一版，不许铺开画面
      if (bypass) {
        skippedGates.push("配音试听未确认");
      } else {
        await assertNarrationHeard(p.id, "建幕");
      }
      const skipNote = skippedGates.length ? SKIPPED_NOTE(skippedGates, bypass as string) + "\n" : "";
      const sb = readStoryboard(p.id);
      if (!sb?.shots?.length) throw new Error("还没有分镜表，先用 save_storyboard 写");
      // 观感（mood / 安全区 / 封面 / 字幕 / 音效）没定不拦写分镜，但要说一句：
      // 这几项拖到验收前才定，版式和字幕规格大概率要返工
      const visionMissing = stepMissingFields(11, brief);
      // shot=N：只建第 N 幕做风格帧。全量铺开前先验证调性，方向错了只重做 1 幕
      const onlyIdx = a.shot ? a.shot - 1 : -1;
      if (onlyIdx >= 0 && (a.shot as number) > sb.shots.length) {
        throw new Error(`分镜只有 ${sb.shots.length} 幕，shot 只能是 1–${sb.shots.length}`);
      }
      const targets = onlyIdx >= 0 ? [sb.shots[onlyIdx]] : sb.shots;

      const ops: Record<string, unknown>[] = [];
      if (onlyIdx < 0 && a.replace) {
        for (const sc of p.scenes ?? []) ops.push({ op: "remove_scene", sceneId: sc.id });
      }
      // 单幕模式要**插到分镜里前一幕的后面**，不能一律 append：
      // 先建第 1、6 幕当样板、再补第 2–18 幕，append 出来的时间轴是 1→6→2→3…（坑 #1，会毁片）。
      // 找不到「已建的前一幕」时不插（末尾追加），后面 alignScenesToStoryboard 还会兜一次底。
      const aliveIds = new Set((p.scenes ?? []).map((s: { id: string }) => s.id));
      const anchorFor = (shotIdx: number): string | undefined => {
        for (let k = shotIdx - 1; k >= 0; k--) {
          const id = sb.shots[k]?.sceneId;
          if (id && aliveIds.has(id)) return id;
        }
        return undefined;
      };
      const anchor = onlyIdx >= 0 ? anchorFor(onlyIdx) : undefined;
      for (const shot of targets) {
        ops.push({
          op: "add_scene",
          type: shot.type,
          ...(shot.name ? { name: shot.name } : {}),
          ...(shot.durationInFrames ? { durationInFrames: shot.durationInFrames } : {}),
          ...(shot.props ? { props: shot.props } : {}),
          ...(anchor ? { afterSceneId: anchor } : {}),
        });
      }
      const res = await api<{ createdSceneIds: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      const ids = res.createdSceneIds ?? [];

      // 转场继承设计锁：不套的话每幕都是版本默认 fade 12 帧，
      // 契约里写的「利落（none/zoom ≤10 帧）」当场违约，之后还得手动补一次 set_transitions
      const lock: any = (brief as any)?.designLock;
      const lockTypes: string[] = Array.isArray(lock?.transitionWhitelist) ? lock.transitionWhitelist : [];
      let lockNote = "";
      if (lockTypes.length && !lockTypes.includes("none") && ids.length) {
        const t = {
          type: lockTypes[0],
          durationInFrames: Number(lock.transitionMaxFrames) || TRANSITION_DEFAULT_FRAMES,
        };
        await api(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({
            actor: "agent",
            ops: ids.map((sceneId: string) => ({ op: "update_scene", sceneId, patch: { transitionIn: t } })),
          }),
        });
        lockNote = `转场已按设计锁套用：${t.type} ${t.durationInFrames} 帧（白名单 ${lockTypes.join(" / ")}；要改就再 set_transitions）`;
      }

      // 字幕：一律先拆段再落库。分镜的 text 是「这一幕说的话」，经常是一整句甚至两句，
      // 直接上屏就是一屏几十字；这里拆好，后面 set_subtitle_style 调字号也不会再变长
      const subReport: string[] = [];
      if (a.attachSubtitle !== false) {
        const subOps: Record<string, unknown>[] = [];
        targets.forEach((shot, i) => {
          if (!shot.text || !ids[i]) return;
          const norm = normalizeSubtitle(shot.text, { maxChars: SUBTITLE_LIMITS.max });
          subOps.push({ op: "set_subtitle", sceneId: ids[i], text: subtitleToField(norm.lines) });
          if (norm.lines.length > 1) subReport.push(`第 ${i + 1} 幕拆成 ${norm.lines.length} 屏`);
          if (norm.lines.some((l) => [...l].length > SUBTITLE_LIMITS.max)) {
            subReport.push(`第 ${i + 1} 幕有句子拆不开（长英文/无标点），建议改稿`);
          }
        });
        if (subOps.length) {
          await api(`/api/projects/${p.id}/ops`, {
            method: "POST",
            body: JSON.stringify({ actor: "agent", ops: subOps }),
          });
        }
      }

      // sceneId 回填，和分镜一一对应（单幕模式只回填那一幕，其余保持原值）
      const saved = saveStoryboard(p.id, {
        ...sb,
        shots: sb.shots.map((s, i) =>
          onlyIdx >= 0 ? (i === onlyIdx ? { ...s, sceneId: ids[0] } : s) : { ...s, sceneId: ids[i] },
        ),
      });

      // 幕序自愈：建完立刻和分镜顺序对一遍。这一步不做，片子会「看起来完整、内部已经错位」
      const align = await alignScenesToStoryboard(p.id, saved);
      const nl = String.fromCharCode(10);
      const visionNote = visionMissing.length
        ? `${nl}💬 观感还没定（${visionMissing.join("、")}）：intake(11) 问一下再收尾——request_review 会因为这几项没填而拒绝。`
        : "";
      const subNote = subReport.length
        ? `${nl}字幕已按屏拆好（每屏 ≤${SUBTITLE_LIMITS.max} 字、不带标点）：${subReport.slice(0, 6).join("；")}${
            subReport.length > 6 ? `…共 ${subReport.length} 处` : ""
          }`
        : "";
      const orderNote = align.notes.length ? `${nl}🔧 ${align.notes.join(`${nl}🔧 `)}` : "";
      const leftoverNote = align.extraCount
        ? `${nl}⚠️ 工程里还有 ${align.extraCount} 幕不在分镜表里（模板开场/结尾、风格样张之类）：` +
          `确认要不要 remove_scene 掉；要全部重建就 build_storyboard(replace=true)。` +
          `不清掉它们会混进成片。`
        : "";
      if (onlyIdx >= 0) {
        return (
          skipNote +
          visionNote +
          (visionNote ? nl : "") +
          `已建第 ${onlyIdx + 1} 幕做风格帧（${sb.shots[onlyIdx]?.type}，id=${ids[0]}）。${nl}` +
          `下一步：preview_frames 抽 1–3 帧给用户过目（场景 id=${ids[0]}）——` +
          `配色/字体/版式方向 OK 再 build_storyboard(replace=true) 全量铺开（会重建这一幕，正常）；` +
          `不对就 save_storyboard 改这一幕再 build_storyboard(shot=${onlyIdx + 1})，只重做 1 幕。${subNote}${orderNote}${lockNote ? `${nl}${lockNote}` : ""}`
        );
      }
      // 建完顺手判一次"空"：在用户看到之前报，而不是等他第一眼说"太空旷"
      const densityNote = await (async () => {
        try {
          const fresh = await api<{ project: { formats?: { key: string; label: string; width: number; height: number }[]; scenes?: unknown[] } }>(
            `/api/projects/${p.id}`,
          );
          const fmts = fresh.project.formats ?? [];
          const fmt = fmts[0];
          if (!fmt) return "";
          const dens = projectDensity((fresh.project.scenes ?? []) as never[], fmt);
          const rhythm = rhythmIssues(dens, fmt);
          if (!rhythm.length) return "";
          return (
            `${nl}⚠️ 密度节奏（${fmt.label}）：` +
            rhythm.map((x) => `${nl}  · ${x.message}`).join("") +
            `${nl}  ${densitySummary(dens)}`
          );
        } catch {
          return "";
        }
      })();
      return `${skipNote}已按分镜建了 ${ids.length} 幕：${nl}${ids.map((id, i) => `${i + 1}. ${id}（${sb.shots[i]?.type}）`).join(nl)}${lockNote ? `${nl}${lockNote}` : ""}${nl}下一步：tts_narration 配音（applyToScenes=true 自动对齐场景时长和字幕）${orderNote}${leftoverNote}${subNote}${visionNote}${densityNote}`;
    },
  },
  {
    name: "build_film",
    description:
      "**一次提交整片**：给一幕幕的「类型 + 内容」，剩下的坐标、字幕、转场、入场动画由系统按规则展开成一条 apply_ops（整批原子、只涨 1 个 rev）。\n" +
      "为什么需要它：逐幕 add_scene + set_subtitle + set_transitions 要几十次往返才能建成整片；这里一次说完。\n" +
      "用法：scenes 按出场顺序给；freeform 幕直接给 elements（会自动补 id、按 stagger 挂入场动画）；\n" +
      "内置版式幕给 props（按该类型 schema 校验，错了当场报第几幕哪个字段）。\n" +
      "⚠️ 别拿它当「第一版」：先 probe_style 挑风格 → build_storyboard(shot=1) 建 1 幕给用户过目 → 再 build_film 全量。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程"),
      replace: z.boolean().optional().describe("true = 先清空工程现有场景（首次全量建时用）"),
      scenes: z
        .array(
          z.object({
            as: z.string().optional().describe("批内别名，默认 s1/s2…（回执会列出真实 id）"),
            type: z.string().describe("场景类型（list_scene_types）"),
            name: z.string().optional(),
            durationInFrames: z.number().int().min(1).optional().describe("不传按类型默认"),
            props: z.record(z.any()).optional().describe("内置版式的业务数据"),
            elements: z
              .array(z.record(z.any()))
              .optional()
              .describe("freeform 幕的元素数组（type/text/x/y/size/fill…，会自动补 id）"),
            text: z.string().optional().describe("这一幕的口播/字幕文本（会写成字幕）"),
            subtitle: z.string().optional().describe("直接给字幕文本（不给就用 text）"),
            transitionIn: z
              .object({ type: z.string(), durationInFrames: z.number().int().min(0).max(120) })
              .nullable()
              .optional(),
            transitionOut: z
              .object({ type: z.enum(TRANSITION_TYPES), durationInFrames: z.number().int().min(0).max(120) })
              .nullable()
              .optional(),
          }),
        )
        .min(1)
        .describe("分镜：一幕一项，顺序就是出场顺序"),
      transitions: z
        .object({ type: z.enum(TRANSITION_TYPES), durationInFrames: z.number().int().min(0).max(120).optional() })
        .optional()
        .describe("统一入场转场（各幕 transitionIn 优先）；不传则沿用各类型默认"),
      animations: z
        .object({
          preset: z.enum(["stagger", "none"]).optional().describe("stagger = 文字元素逐个淡入上浮，默认 stagger"),
          step: z.number().min(0).max(20).optional().describe("错峰间距（帧），默认 3"),
          inFrames: z.number().min(1).max(60).optional().describe("单元素入场时长（帧），默认 14"),
        })
        .optional()
        .describe("freeform 元素的入场动画预设（元素自带 anim 时以元素为准）"),
      subtitles: z.boolean().optional().describe("写不写字幕，默认 true（有 text/subtitle 才写）"),
      skipChecks: z
        .boolean()
        .optional()
        .describe("跳过流程闸口（需求确认 / 配音试听）。用户明确说「直接建 / 不用问了」才传；验收与契约闸口不受影响"),
      skipReason: z
        .string()
        .optional()
        .describe("用户让你跳过的原话（至少 2 字）；skipChecks=true 时必填，会记录在回执里"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const bypass = processGateBypass(a);
      const skippedGates: string[] = [];
      const brief = readBrief(p.id);
      if (!(brief as any)?.confirmedAt) {
        if (bypass) skippedGates.push("需求未确认");
        else
          throw new Error("brief 还没确认：先走完 4 组问诊 + confirm_brief，再 build_film（否则建出来的东西没人认过）");
      }
      // 配音闸口：合成过但没人听过 → 不许建幕（建了就等于把幕长锁死在这版语音上）
      if (bypass) {
        skippedGates.push("配音试听未确认");
      } else {
        await assertNarrationHeard(p.id, "建整片");
      }
      const skipNote = skippedGates.length ? SKIPPED_NOTE(skippedGates, bypass as string) + "\n" : "";
      const nl = String.fromCharCode(10);
      const fps = p.fps || 30;
      const ops: Record<string, unknown>[] = [];

      if (a.replace) {
        for (const sc of p.scenes ?? []) ops.push({ op: "remove_scene", sceneId: (sc as any).id });
      }

      const animPreset = a.animations?.preset ?? "stagger";
      const step = a.animations?.step ?? 3;
      const inFrames = a.animations?.inFrames ?? 14;
      const aliases: Record<string, string> = {};
      const problems: string[] = [];
      let lockApplied = 0;

      for (const [i, sc] of a.scenes.entries()) {
        const meta = getMeta(sc.type);
        if (!meta) throw new Error(`第 ${i + 1} 幕：未知场景类型「${sc.type}」（先 list_scene_types）`);
        const alias = (sc.as ?? `s${i + 1}`).trim();
        const dur = sc.durationInFrames ?? meta.duration.default;

        // props：内置版式按 schema 校验并填默认值；错了立刻报第几幕哪个字段（别等整批原子失败）
        let props: Record<string, unknown> = { ...meta.defaultProps, ...(sc.props ?? {}) };
        if (sc.elements?.length) {
          if (sc.type !== "freeform") {
            throw new Error(
              `第 ${i + 1} 幕（${sc.type}）不是 freeform，不支持 elements —— 用 props 传业务数据，或把 type 改成 freeform`,
            );
          }
          props = {
            ...props,
            elements: sc.elements.map((el: Record<string, unknown>, j: number) => {
              const y = Number((el as { y?: number }).y ?? 50);
              const base = { id: `e${j + 1}`, ...el } as Record<string, unknown>;
              const hasAnim = Array.isArray((el as { anim?: unknown[] }).anim);
              if (animPreset === "none" || hasAnim) return base;
              return { ...base, anim: staggerAnim({ y, index: j, sceneDur: dur, step, inFrames }) };
            }),
          };
        }

        const parsed = meta.schema.safeParse(props);
        if (!parsed.success) {
          const errs = parsed.error.issues
            .map((e) => `${e.path.join(".") || "(根)"}：${e.message}`)
            .join("；");
          throw new Error(`第 ${i + 1} 幕（${sc.type}）props 校验失败：${errs}`);
        }

        ops.push({
          op: "add_scene",
          type: sc.type,
          name: sc.name ?? meta.name,
          durationInFrames: dur,
          props: parsed.data as Record<string, unknown>,
          as: alias,
        });

        const subText = sc.subtitle ?? sc.text;
        if (a.subtitles !== false && subText && String(subText).trim()) {
          ops.push({
            op: "set_subtitle",
            sceneId: `@${alias}`,
            text: subtitleToField(normalizeSubtitle(String(subText), { maxChars: SUBTITLE_LIMITS.max }).lines),
          });
        }

        // 转场取值优先级：单幕显式 > 本次统一参数 > **设计锁**（brief.designLock 的白名单 + 帧数上限）
        // 少最后一档时，建幕会用版式默认 fade 12 帧，把契约里的「利落」冲掉，之后还得手动补 set_transitions
        const lock: any = (brief as any)?.designLock;
        const lockTypes: string[] = Array.isArray(lock?.transitionWhitelist) ? lock.transitionWhitelist : [];
        const lockFrames = Number(lock?.transitionMaxFrames ?? 0);
        const lockPick =
          lockTypes.length && !lockTypes.includes("none")
            ? { type: lockTypes[0], durationInFrames: lockFrames > 0 ? lockFrames : TRANSITION_DEFAULT_FRAMES }
            : undefined;
        const tin =
          sc.transitionIn !== undefined
            ? sc.transitionIn
            : a.transitions
              ? { type: a.transitions.type, durationInFrames: a.transitions.durationInFrames ?? TRANSITION_DEFAULT_FRAMES }
              : lockPick;
        const patch: Record<string, unknown> = {};
        if (tin !== undefined) patch.transitionIn = tin;
        if (sc.transitionOut !== undefined) patch.transitionOut = sc.transitionOut;
        if (Object.keys(patch).length) ops.push({ op: "update_scene", sceneId: `@${alias}`, patch });
        if (!a.transitions && sc.transitionIn === undefined && lockPick) lockApplied++;
      }

      const res = await api<{
        project: { rev: number; scenes: { id: string; durationInFrames: number }[] };
        createdIds?: Record<string, string>;
      }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });

      const ids = res.createdIds ?? {};
      const built = a.scenes.map((sc: { as?: string; type: string }, i: number) => {
        const alias = (sc.as ?? `s${i + 1}`).trim();
        aliases[alias] = ids[alias] ?? "?";
        return { alias, id: ids[alias] ?? "?", type: sc.type };
      }).filter((x: { alias: string; id: string; type: string }) => x.id !== "?");

      const totalFrames = (res.project.scenes ?? []).reduce((n: number, s: { durationInFrames?: number }) => n + Number(s.durationInFrames ?? 0), 0);
      const totalSec = totalFrames / fps;
      const planned = Number((brief as any)?.durationSec ?? 0);
      const devNote =
        planned > 0
          ? `；brief 计划 ${planned}s → 实际 ${totalSec.toFixed(1)}s（${(((totalSec - planned) / planned) * 100).toFixed(0)}%）`
          : "";
      if (planned > 0 && Math.abs(totalSec - planned) / planned > 0.15) {
        problems.push(`总时长偏离 brief 超过 15%：段落表 / 稿子 / 幕长需要重新对齐（口播片以 TTS 实测为准）`);
      }

      return (
        skipNote +
        `已建成 ${built.length} 幕${a.replace ? "（已清空原有场景）" : "（追加）"}，rev=${res.project.rev}` +
        `${nl}共 ${totalFrames} 帧 / ${totalSec.toFixed(1)}s${devNote}` +
        `${nl}别名：${built.map((x: { alias: string; id: string }) => `${x.alias} → ${x.id}`).join("、")}` +
        (lockApplied
          ? `${nl}转场已按设计锁套用（${lockApplied} 幕）：${(brief as any)?.designLock?.transitionWhitelist?.join(" / ") ?? ""} ` +
            `${Number((brief as any)?.designLock?.transitionMaxFrames ?? 0) || TRANSITION_DEFAULT_FRAMES} 帧（单幕显式指定优先）`
          : "") +
        (problems.length ? `${nl}⚠️ ${problems.join(`${nl}⚠️ `)}` : "") +
        `${nl}下一步：render_preview_clip 出一段 6 秒看动态（转场/字幕/BGM）→ 再 check_project 自检 → request_review`
      );
    },
  },
];
