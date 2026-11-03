import React from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_THEME, type Project } from "@shared/schema";
import { createSeedProject } from "@shared/ops";
import { normalizeProps } from "@shared/sceneMetas";
import { useDoc } from "./store";
import { frameBus } from "./frameBus";
import type { DslNode } from "@shared/scene3dDsl";
import { Scene3DViewport } from "./panels/Scene3DViewport";
import { Scene3DInspector } from "./panels/Scene3DInspector";
import { quietThreeClockWarn } from "./quietThreeClockWarn";

quietThreeClockWarn();

const base = createSeedProject("p_vp_test");
const scene = {
  id: "scene_vp",
  type: "scene3d",
  name: "3D 视口测试",
  durationInFrames: 120,
  props: normalizeProps("scene3d", {
    look: "cyber",
    graph: {
      camera: { position: [0, 1.6, 7], target: [0, 0, 0], fov: 42 },
      nodes: [
        {
          id: "a",
          label: "红球",
          geometry: { type: "sphere", radius: 0.8 },
          material: { color: "#FF3B30", emissive: "#FF3B30", emissiveIntensity: 1.2, body: false },
          transform: { position: [-1.7, 0, 0] },
        },
        {
          id: "b",
          label: "转动的方块",
          geometry: { type: "box", width: 1.3, height: 1.3, depth: 1.3 },
          material: { color: "accent", metalness: 0.8, roughness: 0.2 },
          transform: { position: [1.7, 0, 0] },
          anim: [{ at: [0, 119], to: { rotY: 360 }, ease: "linear" }],
        },
      ],
      lights: [{ type: "point", position: [0, 0.4, 0], intensity: 16 }],
    },
  }),
} as never;

useDoc.setState({
  project: { ...base, theme: DEFAULT_THEME, scenes: [scene] } as unknown as Project,
  selectedId: "scene_vp",
  selection: ["g:a"],
  loading: false,
});

// 无头验证用：劫持 apply 记录被写回的 op（拖动手柄松手时应恰好一条 update_graph_node）
(window as unknown as { __opsLog: unknown[] }).__opsLog = [];
(window as unknown as { __useDoc: unknown }).__useDoc = useDoc;
// 跳帧入口：属性面板的"跳到这个关键帧"、关键帧列表都要靠总线驱动
(window as unknown as { __frameBus: unknown }).__frameBus = frameBus;

/**
 * 关键帧 op 在本地落地。
 *
 * 为什么只处理 anim：测试里 apply 被劫持成"只记录不落库"（不想为 e2e 起真后端），
 * 但关键帧编辑是**读—改—写**循环：打完第一颗，列表要能从数据里读回来，第二颗才知道
 * 起点在哪。所以这里只把 anim 相关的两条 op 应用回 store，其余照旧只记录——
 * M3 那批用例（复制节点、批量隐藏等）的断言依赖"数据不变"，不能被顺带改掉。
 */
const applyKeyOps = (ops: Record<string, unknown>[]) => {
  const st = useDoc.getState();
  const project = st.project;
  if (!project) return;
  let touched = false;
  const scenes = project.scenes.map((s) => {
    if (s.id !== "scene_vp") return s;
    const props = s.props as { graph?: { nodes: DslNode[]; camera?: Record<string, unknown> } };
    if (!props.graph) return s;
    let graph = props.graph;
    let local = false;
    for (const op of ops as Array<Record<string, never>>) {
      const o = op as unknown as {
        op: string;
        nodeId?: string;
        patch?: { anim?: unknown };
        camera?: { anim?: unknown };
      };
      if (o.op === "update_graph_node" && o.patch && "anim" in o.patch) {
        graph = {
          ...graph,
          nodes: graph.nodes.map((n) => (n.id === o.nodeId ? ({ ...n, anim: o.patch!.anim ?? undefined } as DslNode) : n)),
        };
        local = true;
      }
      if (o.op === "set_graph_camera" && o.camera && "anim" in o.camera) {
        graph = { ...graph, camera: { ...(graph.camera ?? {}), anim: o.camera.anim ?? undefined } };
        local = true;
      }
    }
    if (!local) return s;
    touched = true;
    return { ...s, props: { ...s.props, graph } };
  });
  if (touched) useDoc.setState({ project: { ...project, scenes } });
};

useDoc.setState((st) => ({
  ...st,
  apply: (async (ops: unknown[]) => {
    (window as unknown as { __opsLog: unknown[] }).__opsLog.push(ops);
    applyKeyOps(ops as Record<string, unknown>[]);
  }) as unknown as typeof st.apply,
}));

/**
 * 面板/视口从 store 里**响应式**取幕：直接传上面的常量 `scene` 会永远渲染初始数据，
 * 关键帧这类"读—改—写"的功能在 e2e 里就看不到更新（列表永远是空的）。
 */
const useTestScene = () => useDoc((s) => s.project?.scenes[0] ?? null);

const ViewportHost: React.FC = () => {
  const sceneNow = useTestScene();
  return sceneNow ? <Scene3DViewport scene={sceneNow} fps={30} /> : null;
};

const InspectorHost: React.FC = () => {
  const sceneNow = useTestScene();
  return sceneNow ? <Scene3DInspector scene={sceneNow} fps={30} /> : null;
};

// 视口 + 属性面板并排：M3 的大纲多选/拖拽换父级/复制都在面板的树上，没面板就没法 e2e。
// 面板要**自己滚动**（真实 app 里它占满一列、内部滚动）：不约束高度的话 panel 会被
// 内容撑到两千多像素，下面的按钮落到视口之外，e2e 的点击永远点不到（实测踩过）。
createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
    <style>{`
      .vp3d-test-panel { display: flex; flex-direction: column; min-height: 0; }
      .vp3d-test-panel > .panel { flex: 1 1 auto; min-height: 0; }
    `}</style>
    {/* 视口容器必须 position:relative + overflow:hidden：`.vp3d` 是 absolute inset:0，
        没有定位祖先时会铺到整个文档上，画布溢出到右栏、把面板的按钮全盖住（e2e 点不到） */}
    <div style={{ flex: 1, minWidth: 0, position: "relative", overflow: "hidden" }}>
      <ViewportHost />
    </div>
    <div className="vp3d-test-panel" style={{ width: 330, flex: "0 0 330px" }}>
      <InspectorHost />
    </div>
  </div>,
);
