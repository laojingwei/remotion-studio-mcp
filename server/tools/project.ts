/**
 * 工程 / 元素 / 模板的生命周期操作：删元素、进出工程文件、回滚、版式对齐、删模板/素材/工程。
 *
 * 从原 scene3d.ts 里拆出来的（该文件此前混着工程/稿件/分镜类工具）。
 * 约定：这些工具由 mcp-tools.ts 按固定顺序 spread 回 TOOLS，顺序影响 tool_search 的同分排序。
 */

import { z } from "zod";
import {
  BASE,
  ProjectLite,
  ROOT,
  api,
  fmtSummary,
  resolveProject,
  sceneMissingMessage,
  setCurrentProject,
} from "./_shared";
import type { ToolDef } from "./_shared";

import fs from "node:fs";
import path from "node:path";

export const PROJECT_TOOLS: ToolDef[] = [
  {
    name: "remove_element",
    description:
      "删除场景里的自由元素。elementId 见 get_project 的 elements 列表。模板/版式自带的元素删不掉（会提示）；删错可 restore_rev 回滚。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string(),
      elementId: z.string(),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "remove_element", sceneId: a.sceneId, elementId: a.elementId }],
        }),
      });
      return fmtSummary(res.summary) || "已删除";
    },
  },
  {
    name: "export_project",
    description:
      "把工程导出成本机 .zip 工程包（含 project.json、assets、manifest），默认写到 out/project-bundles/。用于备份、换机器或发给别人；导出后把路径告诉用户。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      path: z.string().optional().describe("保存路径（.zip）；不传则写 out/project-bundles/<工程名>.zip"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await fetch(`${BASE}/api/projects/${p.id}/export`);
      if (!res.ok) throw new Error(`导出失败（${res.status}）`);
      const buf = Buffer.from(await res.arrayBuffer());
      const safe = (p.name || p.id).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || p.id;
      const file = a.path ? path.resolve(a.path) : path.join(ROOT, "out", "project-bundles", `${safe}.zip`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      return `已导出「${p.name}」到 ${file}（${(buf.length / 1024).toFixed(0)} KB，含素材）`;
    },
  },
  {
    name: "import_project",
    description:
      "从本机 .zip 工程包导入成一个新工程（id 会重新生成，不覆盖现有工程）。导入后返回新工程 id；Web 端要用户自己在工程菜单里切过去。",
    shape: {
      path: z.string().describe("本机 .zip 路径（export_project 产出的，或用户给的工程包）"),
      name: z.string().optional().describe("新工程名，不传用包里的名字"),
    },
    run: async (a) => {
      const file = path.resolve(a.path);
      if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(file)], { type: "application/zip" }), path.basename(file));
      const res = await fetch(`${BASE}/api/projects/import`, { method: "POST", body: form });
      const data = (await res.json()) as { project?: any; error?: string; warnings?: string[] };
      if (!res.ok || !data.project) throw new Error(data.error ?? `导入失败（${res.status}）`);
      if (a.name?.trim()) {
        await api(`/api/projects/${data.project.id}/ops`, {
          method: "POST",
          body: JSON.stringify({
            actor: "agent",
            ops: [{ op: "update_project", patch: { name: a.name.trim() } }],
          }),
        });
        data.project.name = a.name.trim();
      }
      setCurrentProject(data.project.id); // 导入的工程就是要接着干的工程
      const warn = data.warnings?.length ? `\n注意：${data.warnings.join("；")}` : "";
      return `已导入工程「${data.project.name}」（id=${data.project.id}，${data.project.scenes.length} 个场景，rev=1），并已切换为当前工程。${warn}`;
    },
  },
  {
    name: "restore_rev",
    description:
      "把工程回滚到某个历史 rev（磁盘快照，保留最近 50 个）。先用 get_history 看有哪些 rev 带 snapshot。回滚本身也会记一条新历史，可以再回滚回来。",
    shape: {
      rev: z.number().int().positive().describe("目标 rev，见 get_history"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<{ project: ProjectLite; summary: string[] }>(
        `/api/projects/${p.id}/restore/${a.rev}`,
        { method: "POST" },
      );
      return `已回滚到 rev ${a.rev}，当前 rev=${res.project.rev}。${fmtSummary(res.summary)}`;
    },
  },
  {
    name: "layout_grid",
    description:
      "纯计算：把 N 个元素排成网格，返回每个元素的中心坐标和尺寸（画面百分比）。配合 add_element / apply_ops 用，省得手算坐标。不写工程。",
    shape: {
      count: z.number().int().min(1).max(24).describe("要排几个"),
      cols: z.number().int().min(1).max(6).optional().describe("列数，默认 2"),
      gap: z.number().min(0).max(20).optional().describe("格子间距（百分比），默认 4"),
      area: z
        .object({
          x1: z.number(),
          x2: z.number(),
          y1: z.number(),
          y2: z.number(),
        })
        .optional()
        .describe("可用区域（百分比），默认 x 8-92 / y 8-92"),
      sizeRatio: z
        .number()
        .min(0.2)
        .max(1)
        .optional()
        .describe("元素尺寸占格子短边的比例，默认 0.85"),
    },
    run: async (a) => {
      const count = a.count;
      const cols = Math.max(1, Math.min(count, a.cols ?? 2));
      const rows = Math.ceil(count / cols);
      const gap = a.gap ?? 4;
      const area = a.area ?? { x1: 8, x2: 92, y1: 8, y2: 92 };
      const cw = (area.x2 - area.x1 - gap * (cols - 1)) / cols;
      const ch = (area.y2 - area.y1 - gap * (rows - 1)) / rows;
      const ratio = a.sizeRatio ?? 0.85;
      const cells = Array.from({ length: count }, (_, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        return {
          x: Number((area.x1 + col * (cw + gap) + cw / 2).toFixed(1)),
          y: Number((area.y1 + row * (ch + gap) + ch / 2).toFixed(1)),
          size: Number(Math.max(4, Math.min(34, Math.min(cw, ch) * ratio)).toFixed(1)),
        };
      });
      return JSON.stringify(cells);
    },
  },
  {
    name: "align_elements",
    description:
      "把场景里几个元素对齐/等距分布：left/centerX/right/top/centerY/bottom/distributeX/distributeY。按元素中心坐标操作（尺寸差异大时边缘可能不齐），直接写库。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string().describe("元素所在场景"),
      elementIds: z.array(z.string()).describe("要操作的元素 id 列表（≥2）"),
      mode: z
        .enum([
          "left",
          "centerX",
          "right",
          "top",
          "centerY",
          "bottom",
          "distributeX",
          "distributeY",
        ])
        .describe("对齐方式"),
    },
    run: async (a) => {
      if (a.elementIds.length < 2) throw new Error("至少给两个元素");
      const p = await resolveProject(a.projectId);
      const scene = p.scenes.find((s) => s.id === a.sceneId);
      if (!scene) throw new Error(sceneMissingMessage(p, p.scenes, a.sceneId));
      const els = (scene.elements ?? []).filter((e) => a.elementIds.includes(e.id));
      if (els.length < 2) throw new Error("场景里没找到这些元素（检查 id 和 sceneId）");
      const pick = (e: any) => ({ id: e.id, x: e.x ?? 50, y: e.y ?? 52, size: e.size ?? 20 });

      if (a.mode === "distributeX" || a.mode === "distributeY") {
        const axis = a.mode === "distributeX" ? "x" : "y";
        const sorted = els.map(pick).sort((u, v) => u[axis] - v[axis]);
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const step = (last[axis] - first[axis]) / (sorted.length - 1);
        const patches = sorted.map((e, i) => ({
          id: e.id,
          value: Number((first[axis] + step * i).toFixed(1)),
        }));
        const ops = patches.map((pt) => ({
          op: "update_element" as const,
          sceneId: a.sceneId,
          elementId: pt.id,
          patch: { [axis]: pt.value } as Record<string, number>,
        }));
        const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({ actor: "agent", ops }),
        });
        return fmtSummary(res.summary);
      }

      const list = els.map(pick);
      const xs = list.map((e) => e.x);
      const ys = list.map((e) => e.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      let targetX: number | null = null;
      let targetY: number | null = null;
      switch (a.mode) {
        case "left":
          targetX = minX;
          break;
        case "centerX":
          targetX = (minX + maxX) / 2;
          break;
        case "right":
          targetX = maxX;
          break;
        case "top":
          targetY = minY;
          break;
        case "centerY":
          targetY = (minY + maxY) / 2;
          break;
        case "bottom":
          targetY = maxY;
          break;
      }
      const ops = list.map((e) => ({
        op: "update_element" as const,
        sceneId: a.sceneId,
        elementId: e.id,
        patch:
          targetX != null
            ? { x: Number(targetX.toFixed(1)) }
            : { y: Number((targetY as number).toFixed(1)) },
      }));
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      return fmtSummary(res.summary);
    },
  },
];
