/**
 * 问诊步骤的插件来源。
 *
 * 这个文件只负责**找到并读出原始 JSON**，不负责理解它——
 * 校验与类型转换在 `server/brief.service.ts` 的 `normalizeSteps` 里做。
 * 这样切开是为了避免循环依赖：brief.service 要调这里，这里不能反过来 import 它的类型。
 *
 * ## 为什么问诊是单例
 *
 * 一个工程只有一份 brief，也就只能有一套问诊流程。多个插件都提供时
 * 必须选一个（按 id 排序取第一个）并**明确告诉用户其余的没生效**——
 * 静默取一个会让"我装了两个怎么只有一套"变成无法自查的问题。
 */

import fs from "node:fs";
import { pluginFiles } from "./discovery";

export type RawBriefSteps = {
  /** replace = 换掉内置问诊；append = 接在内置后面（编号自动顺延） */
  mode: "replace" | "append";
  steps: unknown[];
  pluginId: string;
  file: string;
};

export type BriefStepsLookup = {
  raw: RawBriefSteps | null;
  /** 读取或协议层面的问题（结构校验的结论由调用方补充） */
  issues: string[];
};

export function pluginBriefSteps(): BriefStepsLookup {
  const files = pluginFiles("brief.steps", ".json");
  if (!files.length) return { raw: null, issues: [] };

  const issues: string[] = [];
  // pluginFiles 已按插件 id 排序，取第一个即"id 最小"的那个，结果稳定
  const first = files[0];
  if (files.length > 1) {
    const others = files.slice(1).map((f) => f.pluginId).join("、");
    issues.push(
      `有 ${files.length} 个插件都提供了问诊步骤，只用了「${first.pluginId}」，忽略：${others}。` +
        `问诊是单例（一个工程只可能有一份 brief），要换用哪套请停用其余插件`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(first.file, "utf8"));
  } catch (err) {
    return {
      raw: null,
      issues: [...issues, `问诊步骤文件解析失败（${first.pluginId}）：${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // 允许直接写数组（最常见的写法），也允许 { mode, steps } 包一层
  const container = Array.isArray(parsed) ? { mode: "replace", steps: parsed } : (parsed as Record<string, unknown>);
  const steps = Array.isArray(container?.steps) ? (container.steps as unknown[]) : [];
  if (!steps.length) {
    return {
      raw: null,
      issues: [...issues, `问诊步骤为空（${first.pluginId}）：需要 {"steps": [...]} 或直接一个数组`],
    };
  }

  const mode = container?.mode === "append" ? "append" : "replace";
  return { raw: { mode, steps, pluginId: first.pluginId, file: first.file }, issues };
}
