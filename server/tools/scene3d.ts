/**
 * 3D 场景图（scene3d）相关的工具：节点/灯光/几何的增删改、相机运镜、关键帧。
 *
 * 这批工具是 2026-11 做 3D 编辑器时集中长出来的（约 2300 行），在原来的 mcp-tools.ts
 * 里占了四分之一。它们和"分镜/文案/音频"那些工具几乎不共享逻辑，只有下面这些底座依赖，
 * 所以是最适合先拆出来的一块。
 *
 * 约定：新增 scene3d 工具加在本文件的 SCENE3D_TOOLS 里；它会被 mcp-tools.ts 按原位
 * 用 spread 拼回 TOOLS（顺序影响 tool_search 结果，别随意挪）。
 */

import { z } from "zod";
import {
  BASE,
  BRK,
  ProjectLite,
  ROOT,
  SKIPPED_NOTE,
  TRANSITION_DEFAULT_FRAMES,
  alignScenesToStoryboard,
  api,
  assertNarrationHeard,
  auditSubtitles,
  briefImpactLog,
  describeBriefImpact,
  fmtSummary,
  formatBytes,
  lastProjectId,
  pickReviewFormat,
  platformSafeArea,
  probeOne,
  processGateBypass,
  resolveProject,
  setCurrentProject,
  text,
} from "./_shared";
import type { ToolDef } from "./_shared";
import fs from "node:fs";
import path from "node:path";
import { BRIEF_STEPS, CONFIRM_GROUPS, CORE_STEPS, briefCoverage, briefProgress, briefToText, confirmBrief, legacyFieldNotice, readBrief, recomputeDesignLock, saveBrief, sceneCountHint, stepMissingFields, type Brief } from "../brief.service";
import { FORM_SPECS, designLockSummary, lockViolations, normalizeForm } from "../../shared/designLock";
import { auditBriefAgainstProject, auditToText } from "../brief-audit.service";
import { densitySummary, projectDensity, rhythmIssues } from "../../shared/density";
import { readScript, saveScript, confirmScript, scriptToText, estimateSeconds, scriptChars, SCRIPT_TYPES, type Script } from "../script.service";
import { readReview, markReviewRequested, markReviewConfirmed, markNeedsWork, markSelfRender, markProbe, markChosenStyle, reviewToText } from "../review.service";
import { readStoryboard, saveStoryboard, storyboardToText, type Storyboard } from "../storyboard.service";
import { getMeta, normalizeProps, describeTypeDeep } from "../../shared/sceneMetas";
import { TRANSITION_TYPES } from "../../shared/transitions";
import { customEffectSchema, MAX_VOLUME, sceneSpans, totalDuration } from "../../shared/schema";
import { animLandingIssues, freeElSchema, normalizeFreeElement, staggerAnim } from "../../shared/freeform";
import { SUBTITLE_LIMITS, normalizeSubtitle, subtitleToField } from "../../shared/subtitleText";
import { detectFlavor } from "../../shared/aiFlavor";
import { lintCopyLines, lintScriptLines } from "../../shared/copyLint";

export const SCENE3D_TOOLS: ToolDef[] = [
  {
    name: "get_graph",
    description:
      "看 scene3d 某一幕的**场景图大纲**：每个节点的 id / 显示名 / 几何体与关键参数 / 颜色与贴图 / 位置 / 父子层级 / 关键帧段数，外加相机、光源、粒子、辉光。\n" +
      "改节点之前先调它拿 nodeId——不要整份读 get_scene 再从几千行 JSON 里找 id。\n" +
      "没有 graph 的场景表示它用的是**预置场景**（preset），没有节点可改。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string(),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const s = p.scenes.find((x) => x.id === a.sceneId);
      if (!s) throw new Error(`找不到场景 ${a.sceneId}`);
      if (s.type !== "scene3d") {
        throw new Error(
          `「${s.name}」是 ${s.type} 版式，没有 3D 场景图。get_graph 只对 scene3d 生效`,
        );
      }
      const props = s.props as {
        preset?: string;
        graph?: {
          nodes: {
            id: string;
            label?: string;
            parent?: string;
            hidden?: boolean;
            locked?: boolean;
            geometry: { type: string; [k: string]: unknown };
            material?: { color?: string; emissive?: string; map?: { src?: string }; wireframe?: boolean };
            transform?: { position?: number[] };
            anim?: unknown[];
          }[];
          camera?: {
            position: number[];
            target: number[];
            fov: number;
            orbit?: { degPerSec: number };
            anim?: unknown[];
          };
          lights?: { type: string; position: number[]; intensity: number; color: string }[];
          particles?: { count: number; size: number };
          post?: { bloom?: number; threshold?: number };
        };
      };
      const g = props.graph;
      if (!g) {
        return (
          `「${s.name}」用的是预置场景（preset=${props.preset ?? "blank"}），没有节点可改。\n` +
          `要逐节点编辑，先 update_scene(sceneId:"${s.id}", props:{graph:{nodes:[…]}})；` +
          `最小骨架与字段表见 get_guide("scene3d")。`
        );
      }
      const keyNums = ["radius", "innerRadius", "outerRadius", "width", "height", "depth", "count", "duty"];
      const geoOf = (geo: { type: string; [k: string]: unknown }) =>
        [geo.type, ...keyNums.filter((k) => typeof geo[k] === "number").map((k) => `${k}=${geo[k]}`)]
          .slice(0, 4)
          .join(" ");
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      const depthOf = (id: string) => {
        let d = 0;
        let cur = byId.get(id);
        while (cur?.parent && d < 32) {
          d++;
          cur = byId.get(cur.parent);
        }
        return d;
      };
      const lines = g.nodes.map((n) => {
        const bits = [geoOf(n.geometry)];
        const m = n.material;
        if (m?.color) bits.push(m.color);
        if (m?.emissive) bits.push(`自发光 ${m.emissive}`);
        if (m?.map?.src) bits.push(`贴图 ${m.map.src.split("/").pop()}`);
        if (m?.wireframe) bits.push("线框");
        const pos = n.transform?.position;
        if (pos) bits.push(`pos(${pos.join(",")})`);
        if ((n.anim ?? []).length) bits.push(`anim×${n.anim!.length}`);
        if (n.hidden) bits.push("[隐藏]");
        if (n.locked) bits.push("[锁定]");
        const pad = "  ".repeat(depthOf(n.id));
        return `${pad}- ${n.id}${n.label ? `（${n.label}）` : ""} | ${bits.join(" | ")}`;
      });
      const out = [`「${s.name}」sceneId=${s.id} · ${g.nodes.length} 个节点`, ...lines];
      if (g.camera) {
        const c = g.camera;
        /**
         * 锁定/跟随段必须显式报出来：agent 看到"target 写了却没变化"时，
         * 最常见的原因就是这一段被 lookAt 覆盖了——不报它，agent 会一直去改 target。
         */
        const segs = (c.anim ?? []) as Array<{ at: [number, number]; lookAt?: string; follow?: string }>;
        const locks = segs.filter((a) => a.lookAt);
        const follows = segs.filter((a) => a.follow);
        out.push(
          `相机：pos[${c.position.join(",")}] → target[${c.target.join(",")}] fov${c.fov}` +
            (c.orbit?.degPerSec ? ` 环绕${c.orbit.degPerSec}°/s` : "") +
            ((c.anim ?? []).length ? ` anim×${c.anim!.length}` : "") +
            (locks.length ? ` 锁定×${locks.length}` : "") +
            (follows.length ? ` 跟随×${follows.length}` : ""),
        );
        if (locks.length) {
          out.push(
            `　锁定段：${locks.map((a) => `「${a.lookAt}」f${a.at[0]}–f${a.at[1]}`).join("；")}` +
              `（这些段的 target 由节点位置每帧决定，改 targetX/Y/Z 无效；退出锁定=下一段不给 lookAt 且不写 from.target）`,
          );
        }
      } else out.push("相机：自动取景");
      if (g.lights?.length) {
        out.push(`光源 ${g.lights.length} 盏：${g.lights.map((l) => `${l.type}@[${l.position.join(",")}] i=${l.intensity}`).join("；")}`);
      }
      if (g.particles) out.push(`粒子：${g.particles.count} 个，size ${g.particles.size}`);
      if (g.post) out.push(`辉光：×${g.post.bloom ?? 1}${g.post.threshold != null ? ` 阈值 ${g.post.threshold}` : ""}`);
      out.push(
        "改单个节点：update_graph_node(sceneId, nodeId, patch:{…})（不要整份覆盖 graph）；" +
          "节点增删：add_graph_node / remove_graph_node；相机·灯光·粒子·辉光：set_graph_scene。",
      );
      return out.join("\n");
    },
  },
  {
    name: "update_graph_node",
    description:
      "改 scene3d 场景图里的**一个节点**（按 nodeId 局部写回，不重发整张图）。\n" +
      "常用：patch:{geometry:{radius:2.4}} 改半径（同形状只改给的参数，其余保留；换 type 则整份重来）、" +
      "patch:{material:{color:\"#FFD27A\", emissive:\"#FF8A3D\"}} 改颜色/自发光（深合并）、" +
      "patch:{transform:{position:[0,1,0]}} 移动（position/rotation/scale 整个替换，其余保留）、" +
      "patch:{label:\"地球\"} 起名、patch:{hidden:true} 临时隐藏（子树一起）、" +
      "patch:{parent:\"sun\"} 换父级（**保持世界位置不变**，做卫星就靠它）、patch:{anim:[…]} 整段替换关键帧、anim:null 清空。\n" +
      "轨迹想走曲线：段里加 curve:{out:[x,y,z], in:[x,y,z]}（相对直线方向的偏移，世界单位；不写=直线；两个给相同值=这段朝那个方向鼓）。\n" +
      "⚠️ 节点有关键帧时，基础 transform 在关键帧区间内会被覆盖——改了看不到变化就检查 anim。\n" +
      "nodeId 从 get_graph 拿。不知道有什么节点就先 get_graph，别整份改 graph。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string(),
      nodeId: z.string().describe("节点 id（get_graph 第一列）"),
      patch: z
        .record(z.any())
        .optional()
        .describe("要改的字段：geometry/material/transform/anim/label/hidden/locked/parent"),
      geometry: z.record(z.any()).optional().describe("几何体参数（同形状增量合并，换 type 则整份替换）"),
      material: z.record(z.any()).optional().describe("材质（深合并；map:null 去掉贴图）"),
      transform: z.record(z.any()).optional().describe("变换（深合并：position/rotation/scaleXYZ 整个替换）"),
      anim: z.array(z.any()).nullable().optional().describe("关键帧数组（整表替换），null 清空"),
      label: z.string().nullable().optional().describe("大纲里显示的名字"),
      hidden: z.boolean().optional().describe("true = 连子树一起不渲染"),
      locked: z.boolean().optional().describe("true = 编辑器里锁住（渲染照常）"),
      parent: z.string().nullable().optional().describe("新父级节点 id；null = 提到根层级"),
    },
    run: async (a) => {
      const { projectId, sceneId, nodeId, patch, ...flat } = a as Record<string, any>;
      const merged: Record<string, unknown> = { ...(patch ?? {}) };
      for (const [k, v] of Object.entries(flat)) if (v !== undefined) merged[k] = v;
      if (!Object.keys(merged).length) {
        throw new Error("update_graph_node 没有要改的字段：给 patch:{…} 或平铺 geometry/material/transform/…");
      }
      const p = await resolveProject(projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "update_graph_node", sceneId, nodeId, patch: merged }],
        }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "add_graph_node",
    description:
      "往 scene3d 场景图里加一个节点（上限 48 个）。至少给 geometry，例如 {type:\"sphere\", radius:0.5}；" +
      "可选 id（不给自动起 n1/n2…）、parent（挂在某个节点下，跟着它公转）、transform:{position:[…]}、material:{…}、label。\n" +
      "几何体白名单：box/sphere/cylinder/cone/torus/torusKnot/plane/capsule/icosahedron/dodecahedron/octahedron/ring/dashRing。" +
      "画行星轨道用 dashRing（扁平虚线，torus 会变成甜甜圈）。返回新节点 id。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string(),
      node: z.record(z.any()).optional().describe("完整节点对象，如 {id:\"moon\", geometry:{type:\"sphere\",radius:0.15}, parent:\"earth\", transform:{position:[1,0,0]}}"),
      afterId: z.string().optional().describe("插到这个节点之后（决定渲染顺序与大纲顺序）"),
      id: z.string().optional().describe("节点 id（不传自动 n1/n2…）"),
      parent: z.string().optional().describe("父节点 id"),
      geometry: z.record(z.any()).optional().describe("几何体，如 {type:\"sphere\", radius:0.5}"),
      material: z.record(z.any()).optional().describe("材质，如 {color:\"#5AC8FA\"}"),
      transform: z.record(z.any()).optional().describe("变换，如 {position:[2,0,0]}"),
      label: z.string().optional().describe("大纲里显示的名字"),
    },
    run: async (a) => {
      const { projectId, sceneId, node, afterId, ...flat } = a as Record<string, any>;
      let nodeObj: Record<string, unknown>;
      if (node && typeof node === "object") {
        nodeObj = { ...(node as Record<string, unknown>) };
        for (const [k, v] of Object.entries(flat)) if (v !== undefined && nodeObj[k] === undefined) nodeObj[k] = v;
      } else {
        nodeObj = {};
        for (const [k, v] of Object.entries(flat)) if (v !== undefined) nodeObj[k] = v;
      }
      if (!nodeObj.geometry) {
        throw new Error(
          'add_graph_node 缺少 geometry：如 node:{geometry:{type:"sphere", radius:0.5}}' +
            "（几何体白名单见 get_guide(\"scene3d\")）",
        );
      }
      const p = await resolveProject(projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "add_graph_node", sceneId, node: nodeObj, ...(afterId ? { afterId } : {}) }],
        }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "remove_graph_node",
    description:
      "删 scene3d 场景图里的一个节点。默认**连子树一起删**（withChildren 默认 true）；" +
      "只删父节点会留下孤儿，所以 withChildren:false 遇到子节点会直接拒绝并列出它们。" +
      "场景图至少要留一个节点。删错可 restore_rev 回滚。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string(),
      nodeId: z.string().describe("节点 id（get_graph 第一列）"),
      withChildren: z.boolean().optional().describe("默认 true = 连子节点一起删"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "remove_graph_node", sceneId: a.sceneId, nodeId: a.nodeId, withChildren: a.withChildren }],
        }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "set_graph_scene",
    description:
      "改 scene3d 的**场景级**设置（不是某个节点）：相机、光源、粒子、辉光。只传要改的那几项，其余保持原样；传 null 表示清掉（恢复默认）。\n" +
      "相机：{position:[0,2,8], target:[0,0,0], fov:42, orbit:{degPerSec:6}}；" +
      "运镜段里想**锁定看向某个会动的节点**（行星、飘的物体）用 anim[].lookAt:\"节点id\"" +
      "（target 每帧重算，targetX/Y/Z 在该段失效；退出锁定=下一段不给 lookAt 且不写 from.target，镜头会自动接上）；" +
      "想让镜头走弧线用 anim[].curve:{out,in}（相对直线的偏移，绕拍/甩镜）；" +
      "光源（给了就顶掉预设打光，最多 8 盏）：[{type:\"point\", position:[0,0,0], intensity:20, color:\"#FFE9B0\"}]" +
      "（point/spot 按 1/距离² 衰减，距离 2 时要 20 上下才亮；directional 1~3 就够）；" +
      "粒子：{count:800, spread:[6,4,6], size:0.06, drift:0.3}；辉光：{bloom:1.2}。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string(),
      camera: z
        .record(z.any())
        .nullable()
        .optional()
        .describe(
          "相机；null = 交还自动取景。anim[] 里可用 lookAt:\"节点id\" 锁定看向（段内 target 每帧重算）",
        ),
      lights: z.array(z.any()).nullable().optional().describe("整组光源；null 或 [] = 撤掉自定义光"),
      particles: z.record(z.any()).nullable().optional().describe("粒子层；null = 关掉"),
      post: z.record(z.any()).nullable().optional().describe("后期（bloom/threshold）；null = 回到默认"),
    },
    run: async (a) => {
      const ops: Record<string, unknown>[] = [];
      if (a.camera !== undefined) ops.push({ op: "set_graph_camera", sceneId: a.sceneId, camera: a.camera });
      if (a.lights !== undefined) ops.push({ op: "set_graph_lights", sceneId: a.sceneId, lights: a.lights });
      if (a.particles !== undefined) ops.push({ op: "set_graph_particles", sceneId: a.sceneId, particles: a.particles });
      if (a.post !== undefined) ops.push({ op: "set_graph_post", sceneId: a.sceneId, post: a.post });
      if (!ops.length) {
        throw new Error("set_graph_scene 没有要改的东西：给 camera / lights / particles / post 之一");
      }
      const p = await resolveProject(a.projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      return fmtSummary(res.summary);
    },
  },
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
      if (!scene) throw new Error(`没有场景 ${a.sceneId}`);
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
  {
    name: "confirm_brief",
    description:
      "记录「用户已确认需求」。4 组问完、契约完整后，把 brief 总结发给用户，用户确认后调用它；没有确认过，build_storyboard 会拒绝。\n" +
      "闸口是**内容判据**而不是「必填有没有填」：段落表每段有时长+内容、镜头清单能直接排拍摄（动画片换成元素清单）、参考指到时间点、素材有责任人+截止、交付有版本列表。缺了会逐条告诉你缺什么。\n" +
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
        const hasText =
          isFreeform ||
          KEY_TEXT.some((k) => typeof props[k] === "string" && props[k].trim()) ||
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
          // freeform 元素：x/y 是中心百分比，size 是短边百分比
          if (sc.type === "freeform") {
            const els = (sc.props?.elements ?? []) as any[];
            els.forEach((el, i) => {
              if (el.type === "fx" || el.x === undefined || el.y === undefined) return;
              const size = Number(el.size ?? 0);
              if (!size) return;
              // width/height 不给就回落到 size（矩形现在可以单独定宽高）
              const wPct = Number(el.width ?? size);
              const hPct = Number(el.height ?? size);
              // size 是短边百分比 → 换算成「占画面宽/高的百分比」的半宽半高
              // 之前这里多乘了 100，导致任何元素都被判成几百 % 宽，安全区提醒全是误报
              const halfW = (wPct / 2) * (short / W);
              const halfH = (hPct / 2) * (short / H);
              const x = Number(el.x);
              const y = Number(el.y);
              // 满屏元素是背景/出血，边缘一定贴着画面，报了就是噪音
              if (Math.max(wPct, hPct) >= 80) return;
              const label = el.id ? `元素 ${el.id}` : `元素 #${i + 1}`;
              if (sa.right && 100 - (x + halfW) < sa.right) hits.push(`「${sc.name}」${label} 右边缘进了右侧 ${sa.right}% 按钮栏`);
              if (100 - (y + halfH) < sa.bottom) hits.push(`「${sc.name}」${label} 下边缘进了底部 ${sa.bottom}% 文案区`);
              if (y - halfH < sa.top) hits.push(`「${sc.name}」${label} 上边缘进了顶部 ${sa.top}% 状态栏`);
            });
          }
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
        // 判「元素中心」而不是边缘：出血/延伸是常见设计，中心在禁区才是真的「放错地方」
        if (portrait) {
          const TOP = 20;
          const BOTTOM = 80;
          const off: string[] = [];
          for (const sc of scenes as any[]) {
            if (sc.type === "freeform") {
              const els = (sc.props?.elements ?? []) as any[];
              els.forEach((el, i) => {
                if (el.type === "fx" || el.y === undefined) return;
                const size = Number(el.size ?? 0);
                // 满屏背景不算主体（出血是设计），只查真正被看见的那几个元素
                if (size >= 80) return;
                const y = Number(el.y);
                const label = el.id ? `元素 ${el.id}` : `元素 #${i + 1}`;
                if (y < TOP) off.push(`「${sc.name}」${label} 中心在顶部 ${TOP}% 内（状态栏/下拉刷新区）`);
                if (y > BOTTOM) off.push(`「${sc.name}」${label} 中心在底部 ${100 - BOTTOM}% 内（字幕/平台文案/按钮区）`);
              });
            }
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

      const covBlock = [
        `契约完整性：${cov.summary}`,
        ...(legacyFieldNotice(brief) ? [legacyFieldNotice(brief) as string] : []),
        ...cov.blocking.slice(0, 10).map((x) => `  ✗ ${x.message}`),
        ...(cov.blocking.length > 10 ? [`  …还有 ${cov.blocking.length - 10} 项`] : []),
        ...cov.warnings.map((x) => `  ⚠️ ${x.message}`),
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

      const step = BRIEF_STEPS.find((s) => s.no === a.step);
      if (!step) throw new Error(`没有第 ${a.step} 步（1–11）`);
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
        .max(11)
        .optional()
        .describe("第几步（1–11）。1–9 是接单问诊；10 = 稿件类型；11 = 观感与规格"),
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
        if (step < 1 || step > 11) throw new Error(`step 只能是 1–11（收到 ${step}）`);
        const merged = { ...(readBrief(p.id) ?? {}), ...fields } as Brief;
        const missing = stepMissingFields(step, merged);
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
          ? CORE_STEPS.filter((s) => stepMissingFields(s.no, brief as never).length > 0).map((s) => s.no)
          : [];
      const batchWarn = missingSteps.length
        ? `${String.fromCharCode(10)}⚠️ 批量通道不校验步骤：还差第 ${missingSteps.join("、")} 步的必填项，` +
          `且这些值必须来自用户原话——自己拍的要写进 assumed`
        : "";
      const cov = briefCoverage(brief as never);
      const lock = (brief as Brief).designLock;
      const nextTip = cov.ok
        ? `需求契约已完整 ✅ 把总结发给用户确认（重点：段落表 / 镜头清单 / 必现信息 / 参考指到点），点头后 confirm_brief`
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
      "先用它把参数摸清，再全量铺。探针写在一个叫「参数探针」的 freeform 幕里，不碰你正在做的那几幕。",
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
        throw new Error(`探测元素本身不合法：${detail}`);
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
              .object({ type: z.enum(TRANSITION_TYPES), durationInFrames: z.number().int().min(0).max(120) })
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
      assetId: z.string().optional().describe("素材条目 id（list_assets 里查）"),
      id: z.string().optional().describe("同 assetId（别名）"),
    },
    run: async (a) => {
      const id = a.assetId ?? a.id;
      if (!id) throw new Error("缺少 assetId（素材条目 id，list_assets 里查；也认 id）");
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
