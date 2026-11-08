/**
 * 需求契约（brief）相关：intake、逐步填写、自审、确认，以及开工前的 check_project 自检。
 *
 * 从原 scene3d.ts 里拆出来的（该文件此前混着工程/稿件/分镜类工具）。
 * 约定：这些工具由 mcp-tools.ts 按固定顺序 spread 回 TOOLS，顺序影响 tool_search 的同分排序。
 */

import { z } from "zod";
import {
  BASE,
  BRK,
  ROOT,
  api,
  auditSubtitles,
  briefImpactLog,
  describeBriefImpact,
  pickReviewFormat,
  platformSafeArea,
  probeOne,
  resolveProject,
  text,
} from "./_shared";
import type { ToolDef } from "./_shared";

import fs from "node:fs";
import path from "node:path";
import { briefSteps, briefStepsSource, CONFIRM_GROUPS, coreSteps, briefCoverage, briefProgress, briefToText, confirmBrief, confirmGapText, legacyFieldNotice, readBrief, recomputeDesignLock, sceneCountHint, stepMissingFields, type Brief } from "../brief.service";
import { FORM_SPECS, designLockSummary, normalizeForm } from "../../shared/designLock";
import { auditBriefAgainstProject, auditToText } from "../brief-audit.service";
import { densitySummary, projectDensity, rhythmIssues } from "../../shared/density";
import { readScript } from "../script.service";

import { readStoryboard } from "../storyboard.service";

import { sceneSpans, totalDuration } from "../../shared/schema";
import { animLandingIssues, freeElSchema, normalizeFreeElement } from "../../shared/freeform";

export const BRIEF_TOOLS: ToolDef[] = [
  {
    name: "confirm_brief",
    description:
      "记录「用户已确认需求」。4 组问完、契约完整后，把 brief 总结发给用户，用户确认后调用它；没有确认过，build_storyboard 会拒绝。\n" +
      "闸口是**内容判据**而不是「必填有没有填」：段落表每段有时长+内容、镜头清单能直接排拍摄（动画片换成元素清单）、参考指到时间点、素材有责任人+截止、交付有版本列表。缺了会逐条告诉你缺什么。\n" +
      "采纳过整片配方（brief.recipe，技法不算）还会校验槽位对账：recipeSlots 不能空、每格 actual 不能空——配方只给骨架，产品名/网址/文案照抄就是事故。\n" +
      "如果 brief 里有 assumed（你替用户拍板的字段），**必须带上用户原话**：confirm_brief(assumptions=[{field, userSaid}])。\n" +
      "用户是一次性认可的（「都按你建议的来」）就传 batchAck=true + batchUserSaid=\"他那句原话\"，一条原话覆盖全部推断项。\n" +
      "只传 acknowledgedAssumptions=true 会被拒绝——布尔记不下用户说了什么，事后也查不出他同意了哪几条。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      summary: z
        .string()
        .optional()
        .describe("发给用户确认的那份总结（可选，便于留档）"),
      assumptions: z
        .array(
          z.object({
            field: z.string().describe("assumed 里的那个字段名（要一字不差）"),
            userSaid: z.string().describe("用户对这条的实际原话（不是「同意」，是他说的那句）"),
          }),
        )
        .optional()
        .describe("逐条核对记录：brief 里每个 assumed 字段都要有一条。缺一条就拒绝确认"),
      acknowledgedAssumptions: z
        .boolean()
        .optional()
        .describe("已废弃：只传 true 而不传 assumptions 会被拒绝（布尔记不下用户说了什么）"),
      batchAck: z
        .boolean()
        .optional()
        .describe(
          "用户一次性认可了全部 assumed（如「都按你建议的来」）时传 true，配合 batchUserSaid 一句原话覆盖全部推断项",
        ),
      batchUserSaid: z
        .string()
        .optional()
        .describe("批量确认时用户的原话（≥2 字）；会落盘成每条 assumed 的核对记录，事后可审计"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const before = readBrief(p.id);
      const assumed = (before?.assumed ?? []).filter(Boolean);
      const brief = confirmBrief(p.id, {
        acknowledgedAssumptions: a.acknowledgedAssumptions === true,
        assumptions: a.assumptions,
        batchAck: a.batchAck === true,
        batchUserSaid: a.batchUserSaid,
      });
      const nl = String.fromCharCode(10);
      // 不再写「已核对」——工具无法验证，只能说「你提供了这些记录」
      const checks = brief.assumptionChecks ?? [];
      const isBatch = a.batchAck === true && String(a.batchUserSaid ?? "").trim().length >= 2;
      const assumedNote = checks.length
        ? `${nl}你提供的核对记录（${checks.length} 项，已落盘可审计；工具无法验证真伪）` +
          (isBatch ? `——**批量确认**：${checks.length} 项共用同一句原话` : "") +
          "：" +
          (isBatch
            ? `${nl}  · 全部 ← 「${String(a.batchUserSaid).trim()}」` +
              checks.map((c) => `${nl}  · 覆盖 ${c.field}`).join("")
            : checks.map((c) => `${nl}  · ${c.field} ← 「${c.userSaid}」`).join(""))
        : "";
      const lock = brief.designLock ?? recomputeDesignLock(brief);
      const cov = briefCoverage(brief);
      const countHint = sceneCountHint(brief);
      return (
        `需求已确认（${brief.confirmedAt}）${a.summary ? `${nl}确认单：${a.summary}` : ""}${assumedNote}` +
        `${nl}${designLockSummary(lock)}` +
        `${nl}契约检查：${cov.summary}` +
        (countHint ? `${nl}${countHint}` : "") +
        `${nl}设计锁随 brief 落盘：build_storyboard / check_project / brief_audit 都会按它检查——` +
        `改档位只需 save_brief(density=...) 一次，全片跟随，不要逐幕手改。` +
        `${nl}下一步：intake(10) 定稿件类型 → save_script 写稿 → confirm_script 请用户过目；` +
        `${nl}再 intake(11) 定观感五项（mood / 安全区 / 封面 / 字幕规格 / 音效）→ save_brief(step=11)；` +
        `${nl}然后 list_styles 选风格 → save_storyboard 写分镜`
      );
    },
  },
  {
    name: "check_project",
    description:
      "只读诊断：场景/时长/文案/音频/字幕/素材/画幅的潜在问题，返回清单（不改工程）。交付前或每轮修改后跑一次，按提示修。\n" +
      "画幅相关的检查（安全区 / 竖屏构图 / 字幕距底）默认按 brief 里的画幅挑；多画幅工程只查交付那一版，要查另一版传 format。",
    shape: {
      projectId: z.string().optional().describe("要体检的工程 id，不传 = 当前默认工程"),
      format: z.string().optional().describe("按哪个画幅做画幅体检（formats 里的 key）；不传按 brief.aspect，再退到工程第一个画幅"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const issues: string[] = [];
      const scenes = p.scenes ?? [];
      if (!scenes.length) issues.push("⚠️ 工程没有场景");

      const total = totalDuration(p as any);
      const spans = sceneSpans(scenes as any[]);
      const KEY_TEXT = ["title", "heading", "text", "quote", "leftTitle", "rightTitle", "value"];

      // 幕序 vs 分镜表：build_storyboard 按调用顺序 append，先建样板再补中间幕就会错位，
      // 而画面每一幕单看都是对的 —— 人眼和抽帧都发现不了，只有对顺序才查得出（复盘坑 #1）
      {
        const sbNow = readStoryboard(p.id);
        const known = new Set(scenes.map((s) => s.id));
        const intended = (sbNow?.shots ?? [])
          .map((s) => s.sceneId)
          .filter((id): id is string => !!id && known.has(id));
        if (intended.length >= 2) {
          const pos = intended.map((id) => scenes.findIndex((s) => s.id === id));
          const jump = pos.findIndex((v, i) => i > 0 && v < pos[i - 1]);
          if (jump > 0) {
            const want = intended[jump];
            const at = pos[jump] + 1;
            const shotNo = (sbNow?.shots ?? []).findIndex((s) => s.sceneId === want) + 1;
            issues.push(
              `⚠️ 幕序和分镜表不一致：分镜第 ${shotNo} 幕对应的场景排在第 ${at} 位` +
                `（应该是第 ${shotNo} 位）。这种错位单看每一幕都正常，播起来却是「先给答案再给推理」` +
                ` → reorder_scenes(按分镜顺序的完整 id, reflow=true)`,
            );
          }
          const extra = scenes.filter((s) => !intended.includes(s.id));
          if (extra.length) {
            issues.push(
              `⚠️ 有 ${extra.length} 幕不在分镜表里：${extra
                .map((s) => `「${s.name}」`)
                .slice(0, 6)
                .join("、")}${extra.length > 6 ? " 等" : ""}` +
                ` —— 模板开场/结尾、风格样张这类中间产物，成片前要 remove_scene 或 build_storyboard(replace=true)`,
            );
          }
        }
        const temp = scenes.filter((s) => /样张|风格候选|STYLE PROBE/i.test(String(s.name ?? "")));
        if (temp.length && !intended.length) {
          issues.push(`⚠️ 工程里有样张幕（${temp.map((s) => `「${s.name}」`).join("、")}）：成片前删掉，别混进片子`);
        }
      }

      for (const sc of scenes as any[]) {
        if (sc.durationInFrames < 30) {
          issues.push(`⚠️「${sc.name}」只有 ${sc.durationInFrames} 帧，短到看不清`);
        }
        const props = sc.props ?? {};
        const isFreeform =
          sc.type === "freeform" && Array.isArray((props as any).elements) && (props as any).elements.length > 0;
        // KEY_TEXT 只认字符串会误伤两类真实场景：counter 的 value 是数字（60 不是 "60"）、
        // maskreveal 的 lines 是字符串数组——这俩都有画面文字，报「没有文案」是噪音
        const hasText =
          isFreeform ||
          KEY_TEXT.some((k) => {
            const v = (props as any)[k];
            return (typeof v === "string" && v.trim()) || (typeof v === "number" && Number.isFinite(v));
          }) ||
          Object.values(props).some(
            (v) => Array.isArray(v) && v.some((x) => typeof x === "string" && x.trim()),
          ) ||
          String(sc.subtitle ?? "").trim().length > 0 ||
          (sc.elements ?? []).some((e: any) => e.kind === "text" && String(e.text ?? "").trim());
        if (!hasText) issues.push(`ℹ️「${sc.name}」没有文案（空场景？）`);
        const hasAudio = (sc.elements ?? []).some((e: any) => e.kind === "audio");
        if (hasAudio && !String(sc.subtitle ?? "").trim()) {
          issues.push(`ℹ️「${sc.name}」有旁白但没有字幕（set_subtitle 或 tts_narration）`);
        }
      }

      // 画幅与 brief 对齐：用户说「只要竖屏」，工程里却留着横屏 →
      // 编辑器顶栏多一个画幅按钮、预览和渲染也多出一版，用户会以为 agent 没按要求做
      {
        const briefNow = readBrief(p.id);
        const aspect = String((briefNow as any)?.aspect ?? "").trim();
        const allFmt = (((p as any).formats ?? []) as { key: string; label: string; width: number; height: number }[]);
        const m = aspect.replace(/：/g, ":").match(/(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)/);
        if (m && allFmt.length > 1 && Number(m[1]) > 0 && Number(m[2]) > 0) {
          const want = Number(m[1]) / Number(m[2]);
          const best = allFmt.reduce(
            (acc, f) => (Math.abs(f.width / f.height - want) < Math.abs(acc.width / acc.height - want) ? f : acc),
            allFmt[0],
          );
          const extra = allFmt.filter((f) => f.key !== best.key);
          if (extra.length) {
            issues.push(
              `ℹ️ brief 要的画幅是 ${aspect}（≈「${best.label}」），工程里还留着 ${extra.length} 个：${extra
                .map((f) => `${f.label} ${f.width}×${f.height}`)
                .join("、")} —— 预览/渲染默认会一起出，编辑器顶栏也会多出按钮，用户容易以为没按要求做。` +
                `只要一版：set_formats(只传 ${best.key})；确实是多画幅工程就忽略这条`,
            );
          }
        }
      }

      {
        // 字幕：又臭又长是成片观感的第一杀手（一屏几十字 + 标点全上屏）
        const audit = auditSubtitles(p);
        issues.push(...audit.hard.map((x) => `⚠️ ${x}`), ...audit.issues);
        if (audit.hard.length) {
          issues.push("  → 修法：fix_subtitles(dryRun=true) 先看预演，确认后 fix_subtitles 落盘");
        }
      }

      // 多轨：同轨重叠 / 画中画挂旁白 / 画中画忘了缩小
      const byTrack = new Map<number, typeof spans>();
      for (const sp of spans) {
        const list = byTrack.get(sp.track) ?? [];
        list.push(sp);
        byTrack.set(sp.track, list);
      }
      for (const [track, list] of byTrack) {
        list.sort((a, b) => a.start - b.start);
        for (let i = 1; i < list.length; i++) {
          if (list[i].start < list[i - 1].end) {
            const prev = (scenes as any[]).find((s) => s.id === list[i - 1].id)?.name;
            const cur = (scenes as any[]).find((s) => s.id === list[i].id)?.name;
            issues.push(
              `⚠️ 轨道 ${track}：「${prev}」和「${cur}」时间重叠（同轨只能串行，要叠着放请 move_scene 换轨道）`,
            );
          }
        }
      }
      for (const sc of scenes as any[]) {
        const track = sc.track ?? 0;
        if (track <= 0 && !sc.box) continue;
        if ((sc.elements ?? []).some((e: any) => e.kind === "audio")) {
          issues.push(`ℹ️「${sc.name}」是画中画但挂了旁白：所有轨道的声音都会播，容易和主轨撞车`);
        }
        if (track > 0 && !sc.box) {
          issues.push(
            `ℹ️「${sc.name}」在轨道 ${track} 但仍是全屏大小，会把下面的画面整块盖住（用 set_scene_box 缩小）`,
          );
        }
      }

      // 素材缺失
      const refs = new Set<string>();
      for (const sc of scenes as any[]) {
        for (const el of sc.elements ?? []) {
          if (typeof el.src === "string" && el.src.startsWith("/assets/")) refs.add(el.src);
        }
      }
      const proj = p as any;
      if (proj.audio?.src) refs.add(String(proj.audio.src));
      for (const t of proj.audioTracks ?? []) {
        if (typeof t?.src === "string" && t.src.startsWith("/assets/")) refs.add(t.src);
      }
      for (const src of refs) {
        const file = path.join(ROOT, "public", src.replace(/^\/+/, ""));
        if (!fs.existsSync(file)) issues.push(`⚠️ 素材缺失：${src}`);
      }

      // freeform 元素级体检（踩坑清单第 2 轮 §3/§9 的手写脚本，内置成诊断）：
      // 提前消失 / 永不出现 / 空 svg / 可疑 viewBox / 同幕 y 不一致
      for (const sc of scenes as any[]) {
        if (sc.type !== "freeform") continue;
        const els = (sc.props?.elements ?? []) as any[];
        if (!els.length) continue;
        const dur = Number(sc.durationInFrames) || 0;
        const ys: { label: string; y: number }[] = [];
        els.forEach((el, i) => {
          const label = el.id ? `元素 ${el.id}` : `元素 #${i + 1}`;
          const isAmbient = el.type === "fx" || el.id === "paper" || el.id === "bg";
          const from = Number(el.from ?? 0);
          const d = el.durationInFrames === undefined ? undefined : Number(el.durationInFrames);
          if (from >= dur) {
            issues.push(`⚠️「${sc.name}」${label} 起点 ${from} ≥ 幕长 ${dur}，永远不会出现（from 要 < 幕长）`);
          } else if (d !== undefined && dur - (from + d) > 3) {
            issues.push(
              `⚠️「${sc.name}」${label} 在第 ${from + d} 帧提前消失（幕长 ${dur} 帧）。` +
                `想一直显示到幕尾就不要传 durationInFrames（或传到幕尾的帧数）`,
            );
          }
          if (el.type === "svg") {
            if (!el.svg) issues.push(`⚠️「${sc.name}」${label} 是 svg 但没有 svg 内容（空元素）`);
            else if (String(el.viewBox ?? "0 0 24 24") === "0 0 24 24" && String(el.svg).length > 150) {
              issues.push(
                `⚠️「${sc.name}」${label} 的 viewBox 还是默认值 0 0 24 24，但 svg 内容不小 —— ` +
                  `不是 24×24 图标的话整层会被压成一个点（update 时 svg 和 viewBox 要一起传）`,
              );
            }
          }
          if (!isAmbient && el.y !== undefined) ys.push({ label, y: Number(el.y) });
          // 基础 y 与动画落点是两笔账：只改 el.y 不改 anim[].to.y，动画播完会回到旧位置；
          // 反过来 at 的结束帧留在幕中间，元素会在中途**跳回**基础值。静态抽帧常常正好
          // 抽在动画窗口外，看不出问题（复盘坑 #3），所以读一次就体检一遍。
          // 判据集中在 shared/freeform.ts#animLandingIssues，单测锁着，避免这里越改越窄。
          for (const issue of animLandingIssues(el as never, dur)) {
            if (issue.kind === "dead") {
              issues.push(
                `⚠️「${sc.name}」${label} 第 ${issue.segment} 段关键帧没有可动画的 to（数值）—— 这段不会生效：` +
                  `数值动画必须写 to（例：anim:[{at:[0,30], to:{y:40}}]），只写 from 是空转`,
              );
              continue;
            }
            if (isAmbient) continue; // fx 氛围层的位移多为装饰，不追这条
            const far = Math.abs((issue.toY as number) - (issue.baseY as number)) > 8;
            const sev = far ? "⚠️" : "ℹ️";
            if (issue.kind === "landing") {
              issues.push(
                `${sev}「${sc.name}」${label}：基础 y=${issue.baseY}，动画落点 to.y=${issue.toY} —— ` +
                  `播完停在 ${issue.toY}%，基础 y 只在第 ${issue.endFrame} 帧之前有效。` +
                  `要挪位置用 update_freeform_element（会自动同步关键帧），手写 patch 要连 anim 一起改；` +
                  `若 ${issue.toY} 就是想要的落点，把 y 改成一致`,
              );
            } else {
              issues.push(
                `${sev}「${sc.name}」${label}：关键帧在第 ${issue.endFrame} 帧就结束（元素可见到第 ${issue.visibleEnd} 帧），` +
                  `之后会跳回基础 y=${issue.baseY} —— 把 at 的结束帧延到幕尾，或让 y 与落点 ${issue.toY} 一致`,
              );
            }
          }
        });
        // 只报「差一点点」的错位：差 5% 以内说明本来想对齐、手抖了。
        // 差 20% 是两行内容，本来就该不同 y —— 以前按「y 值不止一个」判，一屏多行永远在报（实测 50 条噪音）
        const near: string[] = [];
        for (let i = 0; i < ys.length; i++) {
          for (let j = i + 1; j < ys.length; j++) {
            const d = Math.abs(ys[i].y - ys[j].y);
            if (d > 0.2 && d <= 5) {
              near.push(`${ys[i].label}(y=${ys[i].y}) 与 ${ys[j].label}(y=${ys[j].y}) 差 ${d.toFixed(1)}%`);
            }
          }
        }
        if (near.length) {
          issues.push(
            `ℹ️「${sc.name}」有元素看着该对齐却差了一点（5% ≈ 27px 就能看出错位）：${BRK}  - ` +
              near.slice(0, 3).join(`${BRK}  - `) +
              `${BRK}  同一行请统一成同一个 y；真是两行内容就不用管`,
          );
        }
      }

      // 音频超出可用时长
      for (const sc of scenes as any[]) {
        for (const el of sc.elements ?? []) {
          if (el.kind !== "audio" || typeof el.src !== "string" || !el.src.startsWith("/assets/")) continue;
          const pr = await probeOne(el.src);
          const room = Math.max(1, sc.durationInFrames - (el.from ?? 0));
          if (pr && pr.frames > room + 2) {
            issues.push(
              `⚠️「${sc.name}」旁白 ${pr.frames} 帧 > 场景可用 ${room} 帧，后面会被截断（set_scene_timing 改场景时长）`,
            );
          }
        }
      }

      const nl = String.fromCharCode(10);
      // 安全区体检（提醒级，不阻渲染）：出框可能是设计，但字幕/二维码压进平台 UI 是真事故
      {
        const briefNow = readBrief(p.id);
        const allFmt = (((p as any).formats ?? []) as { key?: string; width?: number; height?: number }[]);
        const picked = pickReviewFormat(allFmt, a.format, briefNow?.aspect);
        const fmt0 = picked.fmt;
        const W = Number(fmt0?.width ?? 1080);
        const H = Number(fmt0?.height ?? 1920);
        const portrait = H >= W;
        // 比例用真实宽高算，别信 key（key 可能是自定义名）
        const ratio = W / H;
        const aspect = ratio < 0.95 ? "9:16" : ratio > 1.05 ? "16:9" : "1:1";
        if (picked.others.length) {
          issues.push(
            `ℹ️ 画幅体检只覆盖「${fmt0?.key}」（${W}×${H}，${picked.why}）：` +
              `这个工程还有 ${picked.others.join("、")}，两版版式未必一样，另一版要单独查 → check_project(format="...")`,
          );
        }
        const sa = platformSafeArea(briefNow?.platform, aspect);
        const short = Math.min(W, H);
        const hits: string[] = [];
        for (const sc of scenes as any[]) {
          // 自由画布 / 声明 layoutFree 的幕**不做元素级安全区审计**：落字、文字海、
          // 文字完全飞出画面都是正常动画语言，按「别贴边」查全是误伤（这是动画工具不是 PPT）。
          // 画中画小窗与字幕仍要查——压到平台按钮/文案区是真事故。
          // 画中画小窗：x/y 是中心百分比，scale 是缩放
          if (sc.box) {
            const bx = Number(sc.box.x ?? 50);
            const by = Number(sc.box.y ?? 50);
            const sc2 = Number(sc.box.scale ?? 1);
            const halfW = (sc2 * 100) / 2;
            const halfH = ((sc2 * 100 * W) / H) / 2;
            if (sa.right && 100 - (bx + halfW) < sa.right) hits.push(`「${sc.name}」画中画右边缘进了右侧 ${sa.right}% 按钮栏`);
            if (100 - (by + halfH) < sa.bottom) hits.push(`「${sc.name}」画中画下边缘进了底部 ${sa.bottom}% 文案区`);
            if (by - halfH < sa.top) hits.push(`「${sc.name}」画中画上边缘进了顶部 ${sa.top}% 状态栏`);
          }
          // 字幕位置：bottomPct 才是「按画面高度」的真百分比（渲染端 Video.tsx 优先用它），
          // bottom 是短边百分比 —— 只按 bottom 算会把设了 bottomPct 的字幕误判成压底栏
          if (portrait && String(sc.subtitle ?? "").trim()) {
            const st = (sc.subtitleStyle ?? {}) as { bottom?: number; bottomPct?: number };
            const bottomPct =
              st.bottomPct !== undefined
                ? Number(st.bottomPct)
                : ((Number(st.bottom ?? 6.5) / 100) * short) / H * 100;
            if (bottomPct < sa.bottom) {
              hits.push(
                `「${sc.name}」字幕距底约 ${bottomPct.toFixed(1)}%` +
                  (st.bottomPct !== undefined ? `（bottomPct=${st.bottomPct}）` : `（bottom=${Number(st.bottom ?? 6.5)}）`) +
                  `，在底部 ${sa.bottom}% 文案区内`,
              );
            }
          }
        }
        if (hits.length) {
          issues.push(
            `ℹ️ 安全区提醒（${sa.note}；数字是粗估，出框可能是设计，真机检查确认一下）：${nl}  - ` +
              hits.slice(0, 6).join(`${nl}  - `) +
              (hits.length > 6 ? `${nl}  - …还有 ${hits.length - 6} 处` : "") +
              `${nl}  要挪：字幕 set_subtitle_style(bottomPct=18~22)（按画面高度）、元素 add_freeform_element/update_freeform_element 改 y`,
          );
        }

        // 竖屏构图（提醒级）：竖屏上下各 20% 是平台 UI 与拇指的地盘，主体放进去就被压
        // 判「元素中心」而不是边缘：出血/延伸是常见设计，中心在禁区才是真的「放错地方」。
        // 自由画布 / layoutFree 幕不查元素——雨从顶部落下、字从底部滚出去都是正常动画，
        // 只查画中画小窗（那才是"放错地方的主体"）。
        if (portrait) {
          const TOP = 20;
          const BOTTOM = 80;
          const off: string[] = [];
          for (const sc of scenes as any[]) {
            if (sc.box) {
              const by = Number(sc.box.y ?? 50);
              if (by < TOP) off.push(`「${sc.name}」画中画中心在顶部 ${TOP}% 内（状态栏区）`);
              if (by > BOTTOM) off.push(`「${sc.name}」画中画中心在底部 ${100 - BOTTOM}% 内（字幕/平台 UI 区）`);
            }
          }
          if (off.length) {
            issues.push(
              `ℹ️ 竖屏构图提醒（9:16 上方 20% / 下方 20% 不放主体，内容应在中间 60% 且垂直居中）：${nl}  - ` +
                off.slice(0, 5).join(`${nl}  - `) +
                (off.length > 5 ? `${nl}  - …还有 ${off.length - 5} 处` : "") +
                `${nl}  要挪：元素的 y 改到 30–70；有字幕的幕整体上移 8%；确实要出血就把元素铺满整屏（size≥100）当背景，别把主体放进去`,
            );
          }
        }
      }

      // 密度节奏：判"有没有起伏"，不是"某一幕够不够满"。
      // 36%–55% 单幕完全正常；那次返工的真问题是 18 幕几乎全在同一档，看下来平且空。
      {
        const allFmt = ((p as any).formats ?? []) as { key: string; label: string; width: number; height: number }[];
        const wantKey = (a as { format?: string }).format;
        const fmt = wantKey ? allFmt.find((f) => f.key === wantKey) ?? allFmt[0] : allFmt[0];
        if (fmt) {
          const dens = projectDensity(scenes as never[], fmt);
          const rhythm = rhythmIssues(dens, fmt);
          if (rhythm.length) {
            issues.push(
              `⚠️ 密度节奏（${fmt.label}）：${nl}  - ${rhythm.map((x) => x.message).join(`${nl}  - `)}` +
                `${nl}  ${densitySummary(dens)}（单幕 36%–55% 本身正常，问题只在"连续多幕同一档、没有穿插"）`,
            );
          }
        }
      }

      // 转场 × 文字密度：circle/wipe/flip 在文字页上看着脏（不是不能，是不划算）
      {
        const collectStrings = (v: unknown, out: string[] = []): string[] => {
          if (typeof v === "string") out.push(v);
          else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
          else if (v && typeof v === "object") for (const x of Object.values(v)) collectStrings(x, out);
          return out;
        };
        const risky: string[] = [];
        (scenes as { subtitle?: string; elements?: { text?: string }[]; props?: unknown; transitionIn?: { type?: string } }[]).forEach(
          (sc, i) => {
            const t = sc.transitionIn;
            if (!t || !["flip", "circle", "wipe"].includes(String(t.type))) return;
            const txt = [
              String(sc.subtitle ?? ""),
              ...(sc.elements ?? []).map((e) => String(e.text ?? "")),
              ...collectStrings(sc.props ?? {}),
            ]
              .join("")
              .replace(/\s/g, "");
            if (txt.length >= 16) risky.push(`第 ${i + 1} 幕`);
          },
        );
        if (risky.length) {
          issues.push(
            `ℹ️ ${risky.length} 幕是文字页却用 flip/circle/wipe 入场：${risky.slice(0, 6).join("、")}${
              risky.length > 6 ? " 等" : ""
            }` +
              `${nl}  → 文字页用 硬切 / blur / 短 fade 更干净；这几类在文字多的时候会显得像"画面在抖"`,
          );
        }
      }

      // 契约体检（和 brief_audit 同一套逻辑）：只报"说了没做到"，不报风格偏好。
      // 放在 check_project 里是为了「一个工具看全」——用户不该为了知道漏了什么去开三个工具。
      {
        const bForAudit = readBrief(p.id);
        if (bForAudit?.confirmedAt) {
          // 只有走过 v4 确认（有 designLock）或明确定了形态的工程才查设计锁：
          // 存量 brief 没有形态信息，硬推一套锁会刷一堆和用户意图无关的警告
          const lockForAudit = bForAudit.designLock ?? (bForAudit.form ? recomputeDesignLock(bForAudit) : undefined);
          const r = auditBriefAgainstProject(bForAudit, p as never, lockForAudit);
          for (const x of r.blocking) issues.push(`⚠️ 契约：${x}`);
          for (const x of r.warnings.slice(0, 4)) issues.push(`ℹ️ 契约：${x}`);
          if (r.warnings.length > 4) {
            issues.push(`ℹ️ 契约：还有 ${r.warnings.length - 4} 条提醒（brief_audit 看全部）`);
          }
        }
      }

      const head =
        `工程「${p.name}」：${scenes.length} 场景 / ${total} 帧（${(total / (p.fps || 30)).toFixed(1)}s）` +
        `${nl}（⚠️ = 要修 · ℹ️ = 确认一下，可能是故意的 · 💡 = 可选优化）`;
      if (!issues.length) return `${head}${nl}✅ 没有发现明显问题。${nl}自检清单见 get_guide(\"qa\")`;
      // 封顶 30 条：误报多时全量吐出来只会把真问题淹掉
      const CAP = 30;
      const shown = issues.slice(0, CAP);
      const more = issues.length > CAP ? `${nl}…还有 ${issues.length - CAP} 条没列出（先修已列出的，多数会连带消失；需要全量再说）` : "";
      return `${head}${nl}发现 ${issues.length} 条（${CAP < issues.length ? `显示前 ${CAP} 条` : "全部"}）：${nl}${shown.join(nl)}${more}`;
    },
  },
  {
    name: "intake",
    description:
      "需求问诊。**默认按 4 组走**（内容骨架 → 画面清单 → 声音字幕 → 素材交付）：每组必须拿到明确产出才往下走，不传 group 返回 4 组总览 + 当前契约缺口。\n" +
      "问诊只问「用户能判断的东西」：形态、段落、镜头、参考、素材责任人、交付版本。动画/转场/特效/背景**不问实现类型，只收档位**（克制/标准/活泼 等），具体参数由设计锁推导。\n" +
      "用户答「你定 / 随便」时不要硬问：按形态默认值填，并把该字段写进 assumed。\\n" +
      "⚠ 但 assumed 里的每一条，**confirm_brief 时都要带上用户原话**（assumptions:[{field,userSaid}]），只传布尔会被拒——\\n" +
      "   布尔记不下他说了什么：一句「可以，先试试」常被错记成「全部确认，往下走」。\\n" +
      "第 10 步「稿件」在 brief 确认之后单独走（save_script → confirm_script）。",
    shape: {
      group: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe("第几组：1=内容骨架 2=画面清单 3=声音字幕 4=素材与交付（新流程用这个）"),
      step: z.number().int().min(1).max(11).optional().describe("老接口：第几步（1–11）"),
      mode: z
        .enum(["quick", "full"])
        .optional()
        .describe(
          "quick = 快问三题（给谁看 / 多久 / 画面里有没有东西在动），其余按默认值走并写进 assumed；full = 默认的 4 组详问",
        ),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const nl = String.fromCharCode(10);
      const p = await resolveProject(a.projectId);
      const brief = readBrief(p.id);
      const progress = briefProgress(brief);

      const cov = briefCoverage(brief);
      const script = readScript(p.id);

      // 问诊模板只探一次：每次 briefStepsSource() 都要扫一遍插件目录
      const stepSrc = briefStepsSource();
      const covBlock = [
        // 装了问诊插件才提这一行：内置是默认状态，每次都报一遍只是噪音
        ...(stepSrc.source === "plugin"
          ? [
              `问诊模板：插件「${stepSrc.pluginId}」（${stepSrc.mode === "append" ? "追加在内置之后" : "替换内置"}，` +
                `共 ${stepSrc.steps.length} 步 / 必答 ${coreSteps(stepSrc.steps).length} 步）` +
                (stepSrc.issues.length ? `\n  ⚠️ ${stepSrc.issues.join("\n  ⚠️ ")}` : ""),
            ]
          : []),
        `契约完整性：${cov.summary}`,
        ...(legacyFieldNotice(brief) ? [legacyFieldNotice(brief) as string] : []),
        ...cov.blocking.slice(0, 10).map((x) => `  ✗ ${x.message}`),
        ...(cov.blocking.length > 10 ? [`  …还有 ${cov.blocking.length - 10} 项`] : []),
        ...cov.warnings.map((x) => `  ⚠️ ${x.message}`),
        // 契约规则通过 ≠ 能确认：confirm_brief 还按 9 步必填拦，两处口径必须一起报
        ...(confirmGapText(brief, nl) ? [confirmGapText(brief, nl)] : []),
      ].join(nl);

      // 快问：低表达欲用户不该被 9 步问诊拖着走三四个来回（复盘问题 2）。
      // 只问「用户能一句话答完、且答错代价最大」的三件；其余全部按默认值走，但必须写进 assumed。
      if (a.mode === "quick") {
        return [
          "快问三题（一次问完，用户答完就能开工）：",
          "1. 给谁看？（平台 + 受众，一句话）→ 决定画幅与安全区",
          "2. 多久？（秒数；不确定就说个大概）→ 决定段落表",
          "3. **画面里有没有东西在动？**",
          "   · 有具体的东西在动（天体运行、机械原理、数据流转）→ 这幕用 freeform，逐帧摆位置",
          "   · 只是一组并列的信息（清单/对比/参数）→ 用内置版式，快且稳",
          "   ↳ 这一问比「用哪个版式」重要：答成「文字卡片」而用户想的是「科普动画」，就会整片重做",
          "",
          "提交（照抄改字即可）：",
          'save_brief(core:{who:"给谁看"}, durationSec:30, form:"动画演示", motionLevel:"标准")',
          "",
          "其余没答的字段一律按默认值走，但**必须逐条写进 assumed**，confirm_brief 时要带用户原话；",
          "想按 4 组详问就传 intake(mode=\"full\")。",
          "",
          "⚠️ 闸口⓪ 开工第一问快问也不能省：问用户「要不要去编辑器风格库挑提示词和风格」，他明说不需要才跳过。",
          "",
          covBlock,
        ].join(nl);
      }

      if (a.group) {
        const g = CONFIRM_GROUPS.find((x) => x.no === a.group);
        if (!g) throw new Error(`没有第 ${a.group} 组（只有 1–4）`);
        return [
          `第 ${g.no} 组：${g.title}（覆盖${g.covers}）`,
          `这一组要拿到：${g.output}`,
          "问用户（一次问完，别一条一条抛）：",
          ...g.questions.map((q) => `- ${q}`),
          ...(g.no === 1
            ? [
                "",
                "⚠️ 闸口⓪ 开工第一问过了吗：动手前先问过用户「要不要去编辑器风格库挑提示词和风格」吗？没问先补这一问（他挑好了 → get_prompt_pick() / get_style_pick() 读）；他明说「不需要」才继续。",
              ]
            : []),
          "",
          `要提交的字段（就是 save_brief 的参数名）：${g.fields.join(" / ")}`,
          `一条能直接抄的：save_brief(${g.sample})`,
          "",
          covBlock,
          "",
          `保存：save_brief 一次传齐本组字段（不用带 step）；4 组都齐了再 confirm_brief。`,
        ].join(nl);
      }

      if (!a.step) {
        const groupDone = (no: number): boolean => {
          if (no === 1) {
            const c = brief?.core ?? {};
            return !!(c.who && c.believe && c.action && brief?.form && (brief?.segments ?? []).length);
          }
          if (no === 2) return (brief?.shots ?? []).length > 0 || FORM_SPECS[normalizeForm(brief?.form)].shots === "list";
          if (no === 3) return (brief?.refs ?? []).length > 0;
          return (brief?.deliverables ?? []).length > 0;
        };
        return [
          "需求问诊（4 组，按生产依赖排序；intake(group=N) 取某一组的问题）：",
          "⚠️ 闸口⓪ 开工第一问：动手前必须先问用户「要不要去编辑器风格库挑提示词和风格」——他挑好了让你读时用 get_prompt_pick() / get_style_pick()；他明说「不需要」才按正常步骤走。没问就开干 = 跳闸口。",
          ...CONFIRM_GROUPS.map(
            (g) => `${g.no}. ${g.title}（${g.covers}）${groupDone(g.no) ? " ✅" : ""}${nl}   产出：${g.output}`,
          ),
          "",
          covBlock,
          "",
          "⚠️ 不要一次把 20 个问题全抛给用户：先给「我读完内容的理解 + 假设清单」让他改错，再逐组确认。",
          "  更好的是把能用眼睛判断的项做成图让他选（密度、动感、转场性格各三档），别让他描述。",
          progress.finished
            ? script?.confirmedAt
              ? "第 10 步稿件：已确认 ✅"
              : `第 10 步稿件：${brief?.scriptType ? `类型「${brief.scriptType}」，稿子${script?.segments?.length ? "写好了但还没请用户确认" : "还没写"}` : "类型还没定"} → intake(10)`
            : "第 10 步「稿件」要等 4 组问完、brief 确认之后再走。",
          (() => {
            const miss = stepMissingFields(11, brief);
            return miss.length
              ? `第 11 步观感与规格：还缺 ${miss.join("、")} → intake(11)（不填齐，request_review 会拒绝）`
              : "第 11 步观感与规格：齐了 ✅";
          })(),
        ].join(nl);
      }

      const step = briefSteps().find((s) => s.no === a.step);
      if (!step) throw new Error(`没有第 ${a.step} 步（现有：${briefSteps().map((s) => s.no).join("/")}）`);
      const missing = stepMissingFields(step.no, brief);
      return [
        `第 ${step.no} 步：${step.title}`,
        "必填：" + step.required.map(([, l]) => l).join("、"),
        "要问用户：",
        ...step.questions.map((q) => `- ${q}`),
        "",
        missing.length
          ? `还缺：${missing.join("、")}——问完用 save_brief(step=${step.no}, ...) 保存`
          : "这一步需要的都填了，可以 save_brief(step=" + step.no + ") 标记完成",
        `进度：${progress.done.length}/9`,
        "",
        covBlock,
      ].join(nl);
    },
  },
  {
    name: "save_brief",
    description:
      "保存创作需求（开工前先问用户，确认后落盘）。**带 step 时会校验该步必填**（如 step=2 必须有 durationSec），缺了报错；**不传 step 则不强制必填**，字段齐不齐用 intake 看进度（进度按字段是否齐判断，不看 step 标记）。\n不传 step 的批量通道只用于「用户已一次性把信息给全」；凡是用户没明确回答、你自己判断的字段，必须写进 assumed，否则 confirm_brief 会以为全是用户说的。\n之后随时 get_brief 对照。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      step: z
        .number()
        .int()
        .min(1)
        .max(99)
        .optional()
        .describe(
          "第几步（编号见 intake 返回的步骤表：内置问诊是 1–11，其中 1–9 必答；" +
            "装了问诊插件的话按插件定义的步骤数）。带 step 时会校验该步必填",
        ),
      x: z
        .record(z.any())
        .optional()
        .describe(
          "扩展字段（插件问诊用）：键 = 步骤里 `x.` 后面的名字，如 {\"competitor\":\"竞品 A\"}。" +
            "**只作记录，不参与设计锁推导**（填了不会改变密度/转场/音效的档位）",
        ),
      editMode: z
        .string()
        .optional()
        .describe("工程归属：新增 / 改已有（改已有要先 list_projects 跟用户确认改哪个）"),
      changeScope: z
        .string()
        .optional()
        .describe("改已有工程时：这次只动什么（只改文案 / 换风格 / 重做分镜 / 加幕 / 重配音）"),
      scriptType: z
        .string()
        .optional()
        .describe("稿件类型（第 10 步）：口播稿 / 屏幕文案 / 双轨 / 无稿 / 用户已给稿"),
      mood: z
        .array(z.string())
        .optional()
        .describe("情绪基准（第 11 步）：3 个形容词，如 [\"高级\",\"克制\",\"有质感\"]"),
      safeArea: z
        .string()
        .optional()
        .describe("安全区（第 11 步）：投放端 UI 要避让的区域，如「抖音竖屏：右侧 12% / 底部 16% 不放字，二维码放中上」"),
      cover: z
        .string()
        .optional()
        .describe("封面（第 11 步）：用片头第一帧 / 单独做一张 / 不要；以及封面文案"),
      subtitleSpec: z
        .string()
        .optional()
        .describe("字幕规格（第 11 步）：字号 / 位置 / 描边或底色 / 逐句高亮 / 双语"),
      sfx: z
        .string()
        .optional()
        .describe("音效层（第 11 步）：只放 BGM / 要声音设计（转场、文字入场、重点重音）"),
      goal: z.string().optional().describe("要达成什么"),
      format: z
        .string()
        .optional()
        .describe("用途类型（get_guide(\"formats\") 的 A–I，如「B 产品宣传」）——写分镜前先按它定结构"),
      benchmark: z.string().optional().describe("对标：1–2 个参考作品，学什么 / 不学什么"),
      structure: z.string().optional().describe("3 个候选结构 → 选哪个、为什么"),
      signals: z.array(z.string()).optional().describe("风格辨识信号：挑 2–3 个，翻掉哪些俗套"),
      takeaway: z.string().optional().describe("观众记住的一句话或一个画面"),
      hook: z.string().optional().describe("前 1 秒发生什么"),
      signature: z.string().optional().describe("记忆点：第几秒、什么手法"),
      palette: z.string().optional().describe("配色（具体色值或风格）"),
      type: z.string().optional().describe("字体/排版方案"),
      motion: z.string().optional().describe("运动气质"),
      texture: z.string().optional().describe("材质/纹理"),
      forbidden: z.array(z.string()).optional().describe("这支片子的禁止清单"),
      audience: z.string().optional().describe("给谁看"),
      platform: z.string().optional().describe("投放平台（抖音/小红书/B站/视频号）"),
      durationSec: z.number().optional().describe("目标时长（秒）"),
      aspect: z.string().optional().describe("画幅，如 9:16 / 16:9 / 1:1"),
      style: z.string().optional().describe("风格：色调、节奏、参考对标"),
      layoutMode: z
        .string()
        .optional()
        .describe("版式体系：内置场景（75 个现成版式）/ 自由画布 freeform / 混合"),
      avoid: z.array(z.string()).optional().describe("禁止出现的词/竞品/品牌规范"),
      assetsNote: z.string().optional().describe("可用素材情况"),
      voice: z.string().optional().describe("配音：音色/语言/语速/是否要字幕"),
      music: z.string().optional().describe("BGM 风格与音量"),
      soundPlan: z
        .string()
        .optional()
        .describe("声音计划：BGM/音效来源（素材库/用户提供/关闭）、情绪曲线、人声避让（get_guide(\"sound\")）"),
      // 2026-10-31 退役：delivery（自由文本）→ deliverables（类型 + 规格的结构化数组）。
      // 同一件事两个名字，会让 agent 填了一个仍被判「缺必填」。只留 deliverables。
      pace: z.string().optional().describe("节奏：快剪 / 慢叙 / 卡点"),
      versions: z.string().optional().describe("版本数量：只竖屏 / 竖+横 / 多语言"),
      copySource: z.string().optional().describe("文案来源：用户给稿 / agent 写 / 改写已有"),
      assetConstraints: z.string().optional().describe("素材约束：版权 / 品牌规范"),
      subtitle: z.string().optional().describe("字幕方式：硬字幕 / 只出 SRT / 都不要"),
      brandRules: z.string().optional().describe("品牌规范（没有写「无」）"),
      release: z.string().optional().describe("发布限制（可公开 / 敏感信息）"),
      languages: z.string().optional().describe("多语言版本"),
      deadline: z.string().optional().describe("什么时候要"),
      notes: z.string().optional().describe("其他补充"),
      assumed: z
        .array(z.string())
        .optional()
        .describe(
          "来源存证：哪些字段是你替用户拍板的（用户没明确回答）。写进来 → confirm_brief 会拦一次，逼你先跟用户逐条核对",
        ),

      /* ── v4：制作前确认十步（结构化；对应 intake 的 4 组） ── */
      core: z
        .object({
          who: z.string().optional().describe("让【谁】看"),
          believe: z.string().optional().describe("知道/相信【什么】，一句话 ≤40 字"),
          action: z.string().optional().describe("然后去做【什么动作】"),
        })
        .optional()
        .describe("第 1 步：一句话内容。拆三段才能校验「动作有没有落地」"),
      form: z
        .string()
        .optional()
        .describe("第 2 步：主形态 —— 口播讲解/产品演示/情景剧/客户证言/前后对比/动画演示/混剪"),
      segments: z
        .array(
          z.object({
            startSec: z.number().optional().describe("起始秒"),
            endSec: z.number().optional().describe("结束秒"),
            content: z.string().optional().describe("这一段的一句话内容（不是标题）"),
            shotIds: z.array(z.string()).optional(),
          }),
        )
        .optional()
        .describe("第 2 步：段落表 —— 分镜的单一真源。每段要有时长 + 内容，合计≈总时长（±5%）"),
      open3: z
        .object({
          firstFrame: z.string().optional().describe("第一帧画面是什么"),
          firstLine: z.string().optional().describe("第一句台词/字幕"),
          bgmStart: z.string().optional().describe("BGM 是否直接起：是 / 否 / 入场后起"),
        })
        .optional()
        .describe("第 3 步：开头 3 秒 —— 唯一能靠抽帧自动校验的字段"),
      ending: z
        .object({
          lastLine: z.string().optional().describe("最后一句口播"),
          cta: z.string().optional().describe("让观众做什么（一个动作）"),
          qr: z.string().optional().describe("二维码/联系方式放哪儿"),
          date: z.string().optional().describe("活动时间"),
          logo: z.string().optional().describe("Logo 怎么出现"),
        })
        .optional()
        .describe("第 3 步：结尾动作"),
      mustInfo: z
        .array(
          z.object({
            text: z.string().optional(),
            where: z.string().optional().describe("出现位置：字幕 / 画面正文 / 结尾 / 封面"),
          }),
        )
        .optional()
        .describe("第 4 步：必须出现的信息。brief_audit 会逐条全文匹配，漏一条阻断渲染"),
      bans: z.array(z.string()).optional().describe("第 4 步：绝对不出现（禁用词 / 竞品 / 人物）"),
      shots: z
        .array(
          z.object({
            id: z.string().optional(),
            desc: z.string().optional().describe("这一镜发生什么"),
            subject: z.string().optional().describe("谁出镜：真人/演员/手部/无人出镜/客户"),
            location: z.string().optional().describe("在哪拍；动画片写「无实拍」"),
            productState: z.string().optional().describe("全新/使用中/特写/对比/拆解"),
            durationSec: z.number().optional(),
            segmentId: z.string().optional().describe("归属段落（段落序号，从 1 开始）"),
          }),
        )
        .optional()
        .describe("第 5 步：镜头清单。实拍形态必填；动画/混剪改成「元素/图解点」"),
      voiceSpec: z
        .object({
          gender: z.string().optional().describe("男声/女声/AI"),
          speed: z.string().optional().describe("语速，如「稍快」「4.5 字/秒」"),
          isHuman: z.boolean().optional().describe("真人原声 = true"),
        })
        .optional()
        .describe("第 6 步：配音规格"),
      bgm: z
        .object({ mood: z.string().optional(), energy: z.string().optional().describe("克制/中/强") })
        .optional()
        .describe("第 6 步：BGM 情绪与强度"),
      refs: z
        .array(
          z.object({
            source: z.string().optional().describe("链接 / 作品名 / 客户往期片"),
            range: z.string().optional().describe("**必填**：参考哪一段，如 00:03–00:08"),
            aspect: z.array(z.string()).optional().describe("节奏/字幕/色调/转场/BGM/叙事结构"),
            antiAspect: z.array(z.string()).optional().describe("明确不参考什么"),
          }),
        )
        .optional()
        .describe("第 7 步：参考标注。range 必填 —— 只给链接等于没说"),
      noRefReason: z
        .string()
        .optional()
        .describe(
          "第 7 步的出口：客户确实没有参考时写「没有参考，风格按 X 定」（≥8 字）。空着 = 缺参考，会阻断确认",
        ),
      assets: z
        .array(
          z.object({
            item: z.string().optional(),
            owner: z.string().optional().describe("谁提供；工具不负责的写 n/a"),
            due: z.string().optional().describe("截止时间"),
            license: z.string().optional().describe("肖像权 / 音乐字体版权 / 场地授权"),
          }),
        )
        .optional()
        .describe("第 8 步：素材清单。每条要有 owner + due"),
      deliverables: z
        .array(
          z.object({
            type: z.string().optional().describe("主片/竖版/横版/封面/字幕文件/无字幕版/压缩版/工程文件"),
            spec: z.string().optional().describe("1080×1920 / H.264 / 30fps…"),
          }),
        )
        .optional()
        .describe("第 9 步：交付版本列表"),
      acceptance: z
        .object({
          approver: z.string().optional().describe("谁拍板"),
          criteria: z.array(z.string()).optional().describe("信息准确/品牌合规/字幕无误/节奏/画质"),
          reviseRounds: z.number().optional().describe("允许几轮修改"),
          feedbackMode: z.string().optional().describe("一次集中给 / 随时提"),
        })
        .optional()
        .describe("第 10 步：验收标准 + 修改轮次"),
      density: z
        .string()
        .optional()
        .describe("档位：信息密度 杂志/讲稿/海报（不问实现，只收档位）"),
      motionLevel: z.string().optional().describe("档位：动感 克制/标准/活泼"),
      transitionTone: z.string().optional().describe("档位：转场性格 利落/柔和/动感"),
      effects: z.string().optional().describe("档位：特效 关/点缀/允许（默认关）"),
      bgTone: z.string().optional().describe("档位：背景 浅/深"),
      scriptTone: z.string().optional().describe("口播语气：专业讲解/朋友聊天/情绪独白/广告腔"),
      bulleted: z.boolean().optional().describe("要不要分点讲（1、2、3 列举）"),

      /* ── 配方（提示词库 PMxxx / TKxxx）：只借骨架，内容看 recipeSlots ── */
      recipe: z
        .object({
          id: z.string().optional().describe("配方编号，如 PM010 / TK003"),
          name: z.string().optional().describe("名称，如「FigPad 产品宣传」"),
          file: z.string().optional().describe("相对项目根的 md 路径（agent 读正文用）"),
          kind: z
            .enum(["recipe", "tech"])
            .optional()
            .describe("recipe=整片骨架（照它拍一条）/ tech=往某一幕加的一招（不能照它拍整片）"),
        })
        .optional()
        .describe("用户采纳的配方引用（get_prompt_pick 给什么就存什么）"),
      recipeSlots: z
        .array(
          z.object({
            slot: z.string().optional().describe("槽位名，对齐配方的「## 槽位」，如 产品/品牌/画幅/时长"),
            recipe: z.string().optional().describe("配方原值（模板值，不许直接进成片）"),
            actual: z.string().optional().describe("用户实际值；还没定就留空，别编"),
            conflict: z.string().optional().describe("配方值≠实际值时按谁走，如「按用户 30s 竖屏，保留三幕结构」"),
          }),
        )
        .optional()
        .describe(
          "配方槽位对账。**配方是骨架不是内容**：产品名/网址/文案这些格必须以 actual 为准。" +
            "缺的格先一次性问用户，别一格一问、也不许自己补",
        ),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      // 存一份改之前的，用来算「需求改口的影响面」
      const prevBrief = readBrief(p.id);
      // projectId 只是定位工程，不写进 brief
      const { projectId: _ignored, step: _step, ...briefFields } = a;
      // 9 步问诊：按 step 校验那一步的必填项，缺了不落盘，逼 agent 回去问用户
      const step = a.step;
      const fields: Record<string, unknown> = { ...briefFields };
      if (step !== undefined) {
        // 步数由当前生效的问诊模板决定（插件可换），不再硬编码 1–11
        const stepTable = briefSteps();
        if (!stepTable.some((s) => s.no === step)) {
          throw new Error(
            `step 只能是 ${stepTable.map((s) => s.no).join("/")}（收到 ${step}）。` +
              `编号见 intake 的步骤表；换过问诊模板的话编号也会变`,
          );
        }
        const merged = { ...(readBrief(p.id) ?? {}), ...fields } as Brief;
        const missing = stepMissingFields(step, merged, stepTable);
        if (missing.length) {
          throw new Error(
            `第 ${step} 步还缺必填：${missing.join("、")}。先问用户，补齐后 save_brief(step=${step}, ...)。`,
          );
        }
        fields.steps = [step];
      }
      const { brief } = await api<{ brief: unknown }>(`/api/projects/${p.id}/brief`, {
        method: "PUT",
        body: JSON.stringify(fields),
      });

      // 需求改口的影响面：改之前 vs 改之后，哪些下游会跟着变。
      // 复盘问题 3：从「无配音」改成「要 AI 配音」时，scriptType/段落表/幕长全要重算，
      // 工具不说话，agent 只能自己推——推漏了就是成片对不上稿。
      const impact = describeBriefImpact(prevBrief, brief as Brief);
      // 累计：本次之外、之前提过的影响也要再露一次，避免分两次写 brief 时前一段被覆盖
      const logged = briefImpactLog.get(p.id) ?? [];
      const earlier = logged.filter((x) => !impact.includes(x));
      briefImpactLog.set(p.id, [...logged, ...impact.filter((x) => !logged.includes(x))]);
      const progress = briefProgress(brief as never);
      // 批量通道（不带 step）不校验必填：把还缺的步骤明说，别让 agent 以为存完就过了
      const missingSteps =
        step === undefined
          ? coreSteps().filter((s) => stepMissingFields(s.no, brief as never).length > 0).map((s) => s.no)
          : [];
      const batchWarn = missingSteps.length
        ? `${String.fromCharCode(10)}⚠️ 批量通道不校验步骤：还差第 ${missingSteps.join("、")} 步的必填项，` +
          `且这些值必须来自用户原话——自己拍的要写进 assumed`
        : "";
      const cov = briefCoverage(brief as never);
      const lock = (brief as Brief).designLock;
      // 契约规则过了不代表能确认：把 confirm_brief 真正会拦的缺口一起说清
      const gapText = confirmGapText(brief as never, String.fromCharCode(10));
      const nextTip =
        cov.ok && !gapText
          ? `需求契约已完整 ✅ 把总结发给用户确认（重点：段落表 / 镜头清单 / 必现信息 / 参考指到点），点头后 confirm_brief`
          : cov.ok
            ? `${String.fromCharCode(10)}${gapText}`
            : `下一步：补齐上面的契约缺口 → 4 组都齐了再 confirm_brief（intake 不带参数可看全部）`;
      const lockNote = lock
        ? `${String.fromCharCode(10)}${designLockSummary(lock)}` +
          `${String.fromCharCode(10)}（档位变了会自动重算；改一次全片跟随，不用逐幕改）`
        : "";
      return (
        `已保存 brief（工程 ${p.id}）` +
        String.fromCharCode(10) +
        briefToText(brief as never) +
        (impact.length || earlier.length
          ? `${String.fromCharCode(10)}🧭 需求改口的影响面：${String.fromCharCode(10)}${
              impact.length
                ? impact.map((x) => `  · ${x}`).join(String.fromCharCode(10))
                : `  · （本次没有新变化）`
            }${
              earlier.length
                ? `${String.fromCharCode(10)}  之前这次改动里已经提醒过（同样要回头看）：${String.fromCharCode(10)}` +
                  earlier.map((x) => `  · ${x}`).join(String.fromCharCode(10))
                : ""
            }`
          : "") +
        batchWarn +
        lockNote +
        String.fromCharCode(10) +
        nextTip
      );
    },
  },
  {
    name: "get_brief",
    description: "读取创作需求 brief（开工前/创作中对照用）。",
    shape: { projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const b = readBrief(p.id);
      const notice = legacyFieldNotice(b);
      return notice ? `${briefToText(b)}\n\n${notice}` : briefToText(b);
    },
  },
  {
    name: "probe_param",
    description:
      "**参数最小实验**：给 1 个元素 + 1 组参数，渲 1 张图看它到底长什么样。\n" +
      "为什么需要：maxWidth / bottom / stroke / textAlign 这些语义不直观，直接铺到整片再改要动几十幕。\n" +
      "先用它把参数摸清，再全量铺。探针写在一个叫「参数探针」的 freeform 幕里，不碰你正在做的那几幕。\n" +
      'element 用的是 **freeform 元素** 的字段（与 add_freeform_element 的 element 同一套，未知键会被严格拒绝）：\n' +
      '  {type:"text", text:"账面音浪", x:50, y:50, size:4, maxWidth:82, color:"#fff", bg:"#000"}\n' +
      "  常用：type（text / svg / shape / image / fx）· x/y（画面百分比，中心点）· size（短边百分比）· maxWidth（折行宽度）· " +
      "width/height（矩形单独定，不传=size）· color / fill · bg · style（camelCase 内联样式，如 {fontWeight:900}）· viewBox（改 svg 必须一起给）。\n" +
      "  没有 fontSize / fontWeight 这类顶层键：字号是 size，字重写在 style 里。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程"),
      element: z.record(z.any()).describe("一个 freeform 元素，如 {type:'text', text:'账面音浪', x:50, y:50, size:4, maxWidth:82}"),
      note: z.string().optional().describe("这次想验证什么（只写进回执，例如「maxWidth 82 会不会折行」）"),
      format: z.string().optional().describe("画幅 key，不传用工程第一个"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const nl = String.fromCharCode(10);
      const el = normalizeFreeElement({ id: "probe", ...(a.element as Record<string, unknown>) });
      const parsed = freeElSchema.strict().safeParse(el);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((x: { path: (string | number)[]; message: string }) => `${x.path.join(".") || "(根)"}：${x.message}`)
          .join("；");
        // 只报「不认识的键」等于让 agent 猜字段名：把可用键和两个常见笔误一起给出来
        const allowed = Object.keys((freeElSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {}).join(" / ");
        throw new Error(
          `探测元素本身不合法：${detail}\n可用字段：${allowed}\n` +
            `常见笔误：字号是 size（不是 fontSize）、字重写 style:{fontWeight:900}（不是 fontWeight）；` +
            `改 svg 要一起给 viewBox。`,
        );
      }

      const existing = (p.scenes ?? []).find((x: { name?: string }) => String(x.name ?? "") === "参数探针");
      let sceneId = (existing as { id?: string } | undefined)?.id;
      const props = {
        background: { kind: "solid", colors: ["#111114"] },
        elements: [parsed.data],
      };
      if (sceneId) {
        await api(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({
            actor: "agent",
            ops: [{ op: "update_scene", sceneId, patch: { props, durationInFrames: 90 } }],
          }),
        });
      } else {
        const created = await api<{ createdSceneIds: string[] }>(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({
            actor: "agent",
            ops: [
              { op: "add_scene", type: "freeform", name: "参数探针", durationInFrames: 90, props },
            ],
          }),
        });
        sceneId = created.createdSceneIds?.[0];
      }
      if (!sceneId) throw new Error("探针场景创建失败");

      const fresh = await api<{ project: any }>(`/api/projects/${p.id}`);
      const idx = (fresh.project.scenes ?? []).findIndex((x: { id?: string }) => x.id === sceneId);
      const span = sceneSpans((fresh.project.scenes ?? []) as never[])[idx];
      const frame = (span?.start ?? 0) + Math.max(0, Math.floor((span?.dur ?? 30) * 0.6));

      const stills = await api<{ stills: { format: string; url: string }[] }>(
        `/api/projects/${p.id}/stills`,
        { method: "POST", body: JSON.stringify({ frame, tag: "probe", formats: a.format ? [a.format] : undefined }) },
      );
      const urls = stills.stills.map((x) => `${BASE}${encodeURI(x.url)}`);
      return (
        `参数探针已出图${a.note ? `（验证：${a.note}）` : ""}：${nl}${urls.join(nl)}` +
        `${nl}就是 1 个元素、1 张图，不改你正在做的幕。` +
        `${nl}看懂之后再去全量铺——别拿整片当实验场。` +
        `${nl}（探针幕叫「参数探针」，交付前删掉它或 build_film(replace:true) 会一并清掉）`
      );
    },
  },
  {
    name: "brief_audit",
    description:
      "契约体检：拿当前成片去对 brief —— 只查「说了有没有做到」，不查风格偏好。\n" +
      "查这些：① 必须出现的信息是否逐条出现（漏了=违约，会挡 render_video）② 禁用清单是否被违反 " +
      "③ 开头第一句与契约是否一致 ④ 结尾动作在不在 ⑤ 实际时长与段落表的偏差 ⑥ 设计锁违约（元素数/转场白名单/转场时长/字号）。\n" +
      "什么时候跑：铺开之后、验收之前；每轮改完也可以跑（只读，不改工程）。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const brief = readBrief(p.id);
      if (!brief) throw new Error("还没有 brief：先走 intake 4 组问诊，再 save_brief");
      // 老工程没有 form / designLock 时不硬推一套锁，只做信息类比对（mustInfo / 禁词 / 时长）
      const lock = brief.designLock ?? (brief.form ? recomputeDesignLock(brief) : undefined);
      const r = auditBriefAgainstProject(brief, p as never, lock);
      const nl = String.fromCharCode(10);
      const lockLine = lock
        ? `${nl}${nl}设计锁：${designLockSummary(lock)}`
        : `${nl}${nl}（这份 brief 没有形态信息，跳过设计锁检查；下次确认需求时定 form 就会锁定）`;
      return (
        auditToText(r) +
        lockLine +
        (r.ok
          ? `${nl}下一步：request_review 请用户看片 → 验收后 render_video`
          : `${nl}下一步：先把上面「必须修」的补掉；没补之前 render_video 会拒绝（确实要强行出片：render_video(forceContract=true)）`)
      );
    },
  },
];
