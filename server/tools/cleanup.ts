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
    name: "archive_project",
    description:
      "归档 / 取消归档工程：**只从默认列表里收起来，一个文件都不删**。\n" +
      "用途：`data/projects/` 攒了一堆自检、模板试建、随手建的工程，真作品被淹没。归档后 list_projects 与编辑器切换面板默认不再列它，" +
      "但工程照样能打开、渲染、导出、被显式 id 修改。\n" +
      "和 delete_project 的区别（别混）：删是不可逆的（工程、素材、成片一起没）；归档随时 `archived:false` 拿回来。" +
      "用户说「这些测试的别老列出来」→ 用它；用户说「删掉」→ 才用 delete_project。\n" +
      "**不会默认作用在当前工程上**：必须给 projectId 或 batch，避免顺手把正在做的片子收起来。",
    shape: {
      projectId: z.string().optional().describe("要归档的工程 id（list_projects 查）。与 batch 二选一"),
      batch: z
        .array(z.string())
        .optional()
        .describe("一次处理多个：工程 id 数组（清理测试工程用）。与 projectId 二选一"),
      archived: z
        .boolean()
        .optional()
        .describe("true（默认）= 归档收进抽屉；false = 取消归档，重新出现在列表里"),
      note: z.string().optional().describe("归档原因，如「自检产生」「模板试建」——以后看列表能想起为什么收起来"),
    },
    run: async (a) => {
      const nl = String.fromCharCode(10);
      const ids = (a.batch?.length ? a.batch : a.projectId ? [a.projectId] : []).filter(Boolean);
      if (!ids.length) {
        throw new Error(
          "要归档哪个工程？传 projectId（list_projects 查 id），或用 batch 一次归档多个。" +
            "这个工具不默认作用于「当前工程」——把正在做的片子静默收起来代价太大。",
        );
      }
      const on = a.archived !== false;
      const ok: string[] = [];
      const bad: string[] = [];
      for (const id of ids) {
        try {
          const res = await api<{ ok: boolean; archivedAt: string | null }>(`/api/projects/${id}/archive`, {
            method: "POST",
            body: JSON.stringify({ archived: on, note: a.note }),
          });
          ok.push(`${id}${res.archivedAt ? `（${res.archivedAt.slice(0, 10)}）` : ""}`);
        } catch (err) {
          bad.push(`${id}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      let tail = "";
      try {
        const { projects } = await api<{ projects: { id: string; archivedAt?: string }[] }>("/api/projects");
        const live = projects.filter((p) => !p.archivedAt).length;
        const arch = projects.length - live;
        tail =
          `${nl}现在：在用 ${live} 个` +
          (arch ? `，已归档 ${arch} 个（list_projects 默认不列；要连归档一起看：includeArchived:true）` : "") +
          (lastProjectId && projects.find((p) => p.id === lastProjectId)?.archivedAt
            ? `${nl}⚠️ 当前默认工程 ${lastProjectId} 就是已归档的那个——继续改它没问题，只是列表里不再默认显示`
            : "");
      } catch {
        /* 统计只是锦上添花 */
      }
      const body = ok.length
        ? `${on ? "已归档" : "已取消归档"} ${ok.length} 个工程：${ok.join("、")}` +
          (on ? `${nl}（没删任何东西：工程、素材、成片都还在。要拿回来就 archived:false）` : "")
        : "";
      const failNote = bad.length ? `${nl}失败 ${bad.length} 个：${nl}- ${bad.join(`${nl}- `)}` : "";
      return [body, failNote.trim(), tail.trim()].filter(Boolean).join(nl);
    },
  },
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
      "会一并清掉它的素材（assets/projects/<id>/）与渲染产物（out/projects/<id>/）；被别的工程或素材库还引用的素材文件会保留。\n" +
      "**只是想让它别出现在列表里**（测试工程太多）用 archive_project——归档可逆且不删文件；这个删了找不回来。",
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
