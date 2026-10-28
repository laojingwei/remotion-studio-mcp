import React, { useEffect, useRef } from "react";
import { useDoc } from "./store";
import { uploadAsset } from "./apiClient";
import { framesForAsset } from "./assetDuration";
import type { OverlayElement } from "@shared/schema";

/**
 * 全局文件拖放：图片 / 视频 / 音频拖进窗口任意位置都能用。
 *
 * 落点决定放哪（不再一律入库）：
 *  - 素材库「我的」区域 → 登记进「我的素材」
 *  - 画面（.stage）→ 临时上传，放进当前场景，位置按落点
 *  - 小时间轴（.scene-tl）→ 临时上传，放进当前场景，从落点帧开始
 *  - 大时间轴（.tl-viewport）→ 音频 → 音效轨；其它 → 落点场景
 *
 * 不显示全屏提示层（拖拽时只给电脑光标反馈）。
 */
export const GlobalDropZone: React.FC = () => {
  const notify = useDoc((s) => s.notify);
  const depth = useRef(0);

  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current++;
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };

    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;

      const targetEl = document.elementFromPoint(e.clientX, e.clientY);
      // 拖到素材库「我的」框里：交给 ElementLibrary 的 onDrop 去入库
      const overLibrary = !!targetEl?.closest(".lib-drop, .lib-grid-mine, .lib-mine-head");
      if (overLibrary) return;

      const inSmall = !!targetEl?.closest(".scene-tl");
      const inBig = !!targetEl?.closest(".tl-viewport");
      const inStage = !!targetEl?.closest(".stage");

      const files = [...(e.dataTransfer?.files ?? [])].filter(
        (f) =>
          f.type.startsWith("image/") ||
          f.type.startsWith("video/") ||
          f.type.startsWith("audio/"),
      );
      if (!files.length) {
        notify("只支持图片 / 视频 / 音频文件");
        return;
      }

      const st = useDoc.getState();
      const project = st.project;
      if (!project) return;
      const sceneId = st.selectedId;
      const sceneIdx = project.scenes.findIndex((s) => s.id === sceneId);
      const scene = sceneIdx >= 0 ? project.scenes[sceneIdx] : null;

      const frameAt = (selector: string): number => {
        const lanes = document.querySelector(selector) as HTMLElement | null;
        if (!lanes) return 0;
        const r = lanes.getBoundingClientRect();
        return Math.max(0, Math.round((e.clientX - r.left) / 3));
      };

      let placed = 0;
      for (const file of files.slice(0, 10)) {
        let url = "";
        let name = file.name;
        try {
          const up = await uploadAsset(project.id, file);
          url = up.url;
        } catch (err) {
          notify(err instanceof Error ? err.message : "上传失败");
          continue;
        }
        placed++;
        if (!scene || !sceneId) continue;

        const isAudio = file.type.startsWith("audio/");
        const isVideo = file.type.startsWith("video/");

        if (inBig && isAudio) {
          void st.apply([
            { op: "add_audio_track", clip: { src: url, name, from: frameAt(".tl-lanes") } },
          ]);
          continue;
        }

        // 构造元素：图片 / 视频 / 音频
        const base: Partial<OverlayElement> = isAudio
          ? { kind: "audio", src: url, name, size: 10, audioVolume: 1 }
          : isVideo
            ? { kind: "video", src: url, name, size: 30, muted: false, loop: false, startFrom: 0 }
            : { kind: "image", src: url, name, size: 30 };
        const id = `el_${(globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 8)}`;
        const el: any = { ...base, id };
        if (isAudio || isVideo) {
          const frames = await framesForAsset(url, project.fps ?? 30);
          if (frames) el.durationInFrames = frames;
        }

        if (inStage) {
          const canvas = document.querySelector(".canvas-shell") as HTMLElement | null;
          const r = canvas?.getBoundingClientRect();
          if (r) {
            el.x = Math.min(98, Math.max(2, ((e.clientX - r.left) / r.width) * 100));
            el.y = Math.min(98, Math.max(2, ((e.clientY - r.top) / r.height) * 100));
          }
        } else if (inSmall) {
          el.from = Math.min(scene.durationInFrames - 1, frameAt(".scene-tl-lanes"));
        }

        void st.apply([{ op: "add_element", sceneId, element: el as OverlayElement }]);
      }
      if (placed) notify(`已放入 ${placed} 个文件`);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [notify]);

  return null;
};
