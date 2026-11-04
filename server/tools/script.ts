/**
 * 稿件相关：按段保存稿件、读回、记录用户确认。
 *
 * 从原 scene3d.ts 里拆出来的（该文件此前混着工程/稿件/分镜类工具）。
 * 约定：这些工具由 mcp-tools.ts 按固定顺序 spread 回 TOOLS，顺序影响 tool_search 的同分排序。
 */

import { z } from "zod";
import {
  resolveProject,
  text,
} from "./_shared";
import type { ToolDef } from "./_shared";

import fs from "node:fs";
import path from "node:path";
import { readBrief, saveBrief, type Brief } from "../brief.service";

import { readScript, saveScript, confirmScript, scriptToText, estimateSeconds, scriptChars, SCRIPT_TYPES, type Script } from "../script.service";

import { detectFlavor } from "../../shared/aiFlavor";
import { lintScriptLines } from "../../shared/copyLint";

export const SCRIPT_TOOLS: ToolDef[] = [
  {
    name: "save_script",
    description:
      "保存稿件（brief 确认之后、写分镜之前）：按段写，一段一句。改稿会让上一次的用户确认失效，必须重新 confirm_script。\n稿件类型见 brief.scriptType（口播稿 / 屏幕文案 / 双轨 / 无稿 / 用户已给稿），写法和字数换算见 get_guide(\"script\")。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      type: z
        .string()
        .optional()
        .describe(`稿件类型：${SCRIPT_TYPES.join(" / ")}（不传沿用 brief.scriptType）`),
      segments: z
        .array(
          z.object({
            text: z.string().describe("这一段要念 / 要显示的话（一句一意）"),
            note: z.string().optional().describe("配什么画面（给自己的备注）"),
            sceneId: z.string().optional().describe("对应幕的 id（写完分镜再回填也行）"),
          }),
        )
        .optional()
        .describe("稿件分段：一段一幕最省事"),
      sourceText: z
        .string()
        .optional()
        .describe("用户已给稿时把原文放这里（保留原样，便于对照改了哪里）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const brief = readBrief(p.id);
      if (!brief?.confirmedAt) {
        throw new Error("brief 还没请用户确认：先走完 9 步问诊 + confirm_brief，再写稿（稿子要照着确认过的需求写）");
      }
      const script = saveScript(p.id, {
        type: a.type ?? brief.scriptType,
        segments: (a.segments ?? []) as Script["segments"],
        sourceText: a.sourceText,
      });
      // 类型以稿件为准回写 brief，避免两处说法不一致
      if (a.type && a.type !== brief.scriptType) saveBrief(p.id, { scriptType: a.type } as Brief);
      const nl = String.fromCharCode(10);
      // 机械体检：空洞词 / 数字缺参照 / 句子太长 / AI 味。
      // 查不出「没意思」，但能挡掉一半废话和几乎所有「一眼 AI」的句式
      const kind = (a.type ?? brief.scriptType) === "屏幕文案" ? ("screen" as const) : ("voice" as const);
      const items = script.segments.map((seg, i) => ({ text: seg.text, kind, label: `第 ${i + 1} 段` }));
      const lint = lintScriptLines(items);
      const warnCount = script.segments.reduce(
        (n, seg) => n + detectFlavor(seg.text, kind).filter((h) => h.level === "warn").length,
        0,
      );
      const lintNote = lint.length
        ? `${nl}文案体检（提醒，不阻断）${warnCount ? `：其中 AI 味 ${warnCount} 处建议改` : ""}：${nl}- ${lint
            .slice(0, 10)
            .join(`${nl}- `)}` +
          `${nl}（规则见 get_guide("content")；去 AI 味的词表与改写对照：get_guide("content","AI 味")）`
        : "";
      return (
        `已保存稿件${nl}${scriptToText(script, brief.durationSec)}${lintNote}${nl}` +
        `下一步：把稿子整段发给用户过目（尤其口播语气、幕数、有没有事实要核），点头后 confirm_script`
      );
    },
  },
  {
    name: "get_script",
    description: "读取稿件（带每段预估秒数、与目标时长的差异、是否已被用户确认）。",
    shape: { projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      return scriptToText(readScript(p.id), readBrief(p.id)?.durationSec);
    },
  },
  {
    name: "confirm_script",
    description:
      "记录「用户已确认稿件」。稿子是整片骨架：没确认过，build_storyboard 会拒绝（brief.scriptType 为无稿时除外）。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      summary: z.string().optional().describe("发给用户确认的那份稿子摘要（可选，便于留档）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const s = confirmScript(p.id);
      const nl = String.fromCharCode(10);
      const total = (s.segments ?? []).reduce((n, x) => n + scriptChars(x.text), 0);
      return (
        `稿件已确认（${s.confirmedAt}，${(s.segments ?? []).length} 段 / ${total} 字 / 约 ${estimateSeconds((s.segments ?? []).map((x) => x.text).join(""))}s）` +
        `${a.summary ? `${nl}确认稿摘要：${a.summary}` : ""}` +
        `${nl}下一步：每幕的 text 直接取自稿件分段 → save_storyboard → build_storyboard(shot=1) 验风格帧`
      );
    },
  },
];
