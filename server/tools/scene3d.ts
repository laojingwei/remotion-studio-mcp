/**
 * 3D 场景图（scene3d）的工具：看大纲、加/改/删节点、把节点挂到某一幕。
 *
 * 历史上这个文件叫 scene3d.ts，但里面混着工程/稿件/分镜类工具（拆分时一并搬走）。
 * 现在只剩真正的 3D 场景图工具（5 个）——加 3D 相关工具加在这里；
 * 工程类 → project.ts，需求契约 → brief.ts，稿件 → script.ts，分镜 → storyboard.ts。
 *
 * 约定：这些数组由 mcp-tools.ts 按固定顺序 spread 回 TOOLS，顺序影响 tool_search 的同分排序。
 */

import { z } from "zod";
import {
  api,
  fmtSummary,
  resolveProject,
  sceneMissingMessage,
} from "./_shared";
import type { ToolDef } from "./_shared";

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
      if (!s) throw new Error(sceneMissingMessage(p, p.scenes, a.sceneId));
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
      /**
       * 按父子关系做一趟 DFS 展开，不能拿数组顺序 + 缩进硬套。
       *
       * 原来就是直接 `g.nodes.map(...)` 配 `depthOf()` 缩进，等于假设数组是「父节点后面紧跟着它的子树」。
       * 实际数据不保证：太阳系的 saturn_ring / piv_moon 排在数组末尾，缩进对了、
       * 视觉上却落在最后一个同级节点（海王星）下面——agent 读到的层级是错的，
       * 照着改就会把土星环当成海王星的子节点。
       *
       * 这里只改**展示顺序**，节点本身与父引用原样不动。
       */
      const childMap = new Map<string, typeof g.nodes>();
      const roots: typeof g.nodes = [];
      for (const n of g.nodes) {
        const pid = n.parent && byId.has(n.parent) ? n.parent : null;
        if (!pid) roots.push(n);
        else {
          const arr = childMap.get(pid);
          if (arr) arr.push(n);
          else childMap.set(pid, [n]);
        }
      }
      const walked = new Set<string>();
      const ordered: Array<{ n: (typeof g.nodes)[number]; depth: number; note?: string }> = [];
      const walk = (n: (typeof g.nodes)[number], depth: number) => {
        // 父子互相指/自己指自己时会成环，直接断开，别让输出无限递归
        if (walked.has(n.id)) return;
        walked.add(n.id);
        const dangling = n.parent && !byId.has(n.parent) ? `父节点 ${n.parent} 不存在` : undefined;
        ordered.push({ n, depth, note: dangling });
        for (const c of childMap.get(n.id) ?? []) walk(c, depth + 1);
      };
      for (const r of roots) walk(r, 0);
      // 环里的节点从根走不到，补在末尾并标明，否则它们会凭空从输出里消失
      for (const n of g.nodes) {
        if (!walked.has(n.id)) ordered.push({ n, depth: 0, note: "父子成环，已断开显示" });
      }
      const lines = ordered.map(({ n, depth, note }) => {
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
        if (note) bits.push(`⚠ ${note}`);
        const pad = "  ".repeat(depth);
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
];
