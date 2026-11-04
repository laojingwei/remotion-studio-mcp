/**
 * 收尾类删除操作：删模板、删素材、删工程（与 project.ts 分开是为了保持工具注册顺序不变）。
 *
 * 从原 scene3d.ts 里拆出来的（该文件此前混着工程/稿件/分镜类工具）。
 * 约定：这些工具由 mcp-tools.ts 按固定顺序 spread 回 TOOLS，顺序影响 tool_search 的同分排序。
 */

import { z } from "zod";
import {
  api,
  formatBytes,
  lastProjectId,
  resolveProject,
  setCurrentProject,
} from "./_shared";
import type { ToolDef } from "./_shared";
import { toAssetId } from "../../shared/assetLibrary";

export const CLEANUP_TOOLS: ToolDef[] = [
  {
    name: "delete_template",
    description:
      "删除「我的模板」（不可撤销，内置模板删不掉）。id 见 list_templates。文件会向用户确认，agent 调用即代表用户已要求删除。",
    shape: {
      templateId: z.string().describe("模板 id（tpl_ 开头，list_templates 里查）"),
    },
    run: async (a) => {
      const res = await api<{ ok: boolean }>(`/api/templates/${a.templateId}`, { method: "DELETE" });
      return `已删除模板 ${a.templateId}（ok=${res.ok}）。用 list_templates 确认。`;
    },
  },
  {
    name: "delete_asset",
    description:
      "从素材库删除一个素材条目并回收文件（不可撤销）。仍在被工程引用的文件会自动保留，只删条目。删除前建议先和用户确认。",
    shape: {
      assetId: z.string().optional().describe("素材条目 id（list_assets 里查；带不带 asset: 前缀都认）"),
      id: z.string().optional().describe("同 assetId（别名）"),
    },
    run: async (a) => {
      const raw = a.assetId ?? a.id;
      if (!raw) throw new Error("缺少 assetId（素材条目 id，list_assets 里查；也认 id）");
      /**
       * 两种写法都认：`asset:as_xxx`（upload_asset / list_assets 回执给的）与 `as_xxx`（接口用的）。
       * 以前只认裸 id，agent 照抄上传回执里的 id 会得到「素材库里没有 asset:as_xxx」——
       * 明明刚上传成功，很难不怀疑到别处去。
       */
      const id = toAssetId(raw);
      const res = await api<{ removed: any; reclaimed: number }>(`/api/library/${id}`, {
        method: "DELETE",
      });
      const n = Number(res.reclaimed ?? 0);
      const tail = n > 0 ? `，已回收 ${n} 个文件` : "（文件仍被工程引用，只删了条目、文件保留）";
      return `已删除素材条目 ${id}${tail}`;
    },
  },
  {
    name: "delete_project",
    description:
      "删除整个工程（含它的历史快照），不可撤销。demo 示例工程删不掉，只能用「重置 demo」恢复。\n" +
      "会一并清掉它的素材（assets/projects/<id>/）与渲染产物（out/projects/<id>/）；被别的工程或素材库还引用的素材文件会保留。",
    shape: {
      projectId: z.string().describe("要删除的工程 id"),
      confirm: z.boolean().describe("必须显式传 true —— 这是不可撤销的操作"),
    },
    run: async (a) => {
      if (a.confirm !== true) {
        throw new Error("删除工程不可撤销：确认要删再进行，调用时传 confirm: true");
      }
      if (a.projectId === "demo") throw new Error("demo 是示例工程，不能删除");
      // resolveProject 不改指针，prev 一定还是「删除前」的当前工程（v2 N-01 的根因就在这里）
      const prev = lastProjectId;
      const p = await resolveProject(a.projectId);
      const res = await api<{
        assets?: { removed: number; kept: number; freedBytes: number };
        renders?: { removed: number; freedBytes: number };
      }>(`/api/projects/${a.projectId}`, { method: "DELETE" });
      const nl = String.fromCharCode(10);
      const assets = res?.assets;
      const renders = res?.renders;
      const assetLine = [
        assets
          ? `素材目录：清掉 ${assets.removed} 个文件（${formatBytes(assets.freedBytes)}）` +
            (assets.kept ? `，${assets.kept} 个仍被别的工程/素材库引用，保留` : "")
          : "",
        renders && renders.removed
          ? `产物目录：清掉 ${renders.removed} 个成片/关键帧/字幕（${formatBytes(renders.freedBytes)}）`
          : "",
      ]
        .filter(Boolean)
        .join(nl);
      if (prev && prev !== p.id) {
        // 删的是别的工程：指针还原，别把当前工程冲掉
        setCurrentProject(prev);
        return `已删除工程「${p.name}」（id=${p.id}）${nl}${assetLine}${nl}当前工程仍是 ${prev}（未受影响）。`;
      }
      // 删的就是当前工程：明说接下来落在哪个工程上
      const { projects } = await api<{ projects: { id: string; name: string }[] }>("/api/projects");
      const next = projects[0];
      setCurrentProject(next?.id ?? null);
      return (
        `已删除工程「${p.name}」（id=${p.id}）${nl}` +
        assetLine +
        nl +
        (next
          ? `当前工程已切到「${next.name}」（id=${next.id}）——之后不带 projectId 的调用落在这里，要换工程用 switch_project。`
          : "已经没有工程了，用 create_project 新建。")
      );
    },
  },
];
