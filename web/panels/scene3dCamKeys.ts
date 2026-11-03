/**
 * 相机关键帧的采样（web 层）。
 *
 * 为什么不在 `shared/scene3dKeys.ts` 里：相机求值要算 `follow` 段跟随节点的世界位置，
 * 那需要矩阵运算；shared 不能引 three（server 也要 import 它）。所以数据翻译放 shared，
 * 采样放这里，用渲染器**同一个** `dslCamera` —— 编辑器的数值和画面必须一致。
 */
import type { Scene3DDsl } from "@shared/scene3dDsl";
import type { EaseKind } from "@shared/scene3dAnim";
import { type CamKey, camKeyFrames } from "@shared/scene3dKeys";
import { dslCamera } from "../../src/scenes/scene3d/DslScene";

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** 相机运镜的关键帧列表（端点帧逐个采样成世界坐标） */
export const camKeysOf = (graph: Scene3DDsl, fps: number): CamKey[] => {
  const frames = camKeyFrames(graph.camera);
  if (!frames.length) return [];
  const anims = graph.camera?.anim ?? [];
  return frames.map((frame) => {
    const c = dslCamera(graph, frame / fps, fps);
    let ease: EaseKind = "easeInOut";
    for (const a of anims) {
      if (frame >= a.at[0] && frame < a.at[1]) {
        ease = (a.ease ?? "easeInOut") as EaseKind;
        break;
      }
    }
    return {
      frame,
      pos: [r4(c.worldPos[0]), r4(c.worldPos[1]), r4(c.worldPos[2])],
      target: [r4(c.worldTarget[0]), r4(c.worldTarget[1]), r4(c.worldTarget[2])],
      fov: r4(c.fov),
      ease,
    };
  });
};
