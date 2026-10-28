import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import type { OverlayElement } from "@shared/schema";
import { sceneSpans } from "@shared/schema";
import { useDoc } from "../store";
import { framesForAsset } from "../assetDuration";
import { CtxMenu } from "./CtxMenu";
import { elementFromLibrary } from "@shared/elementLibrary";
import { assetIdOf, assetToElement, isAssetLibraryId } from "@shared/assetLibrary";

/** 固定像素/帧：时间轴长度只由内容决定，靠横向滚动条看，不靠缩放 */
export const PX_PER_FRAME = 3;
const SNAP_PX = 6;
const MIN_DUR = 3;
const HEAD_W = 118;
const ROW_H = 26;

/* ── 轨道头上的小图标 ── */
const EyeOnIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const EyeOffIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M3 3l18 18" />
    <path d="M10.6 10.6a2 2 0 002.8 2.8" />
    <path d="M9.9 5.2A10.9 10.9 0 0112 5c6.5 0 10 7 10 7a18 18 0 01-3 3.8" />
    <path d="M6.6 6.6A18 18 0 002 12s3.5 7 10 7a10.7 10.7 0 004.2-.9" />
  </svg>
);
const SoundOnIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    <path d="M17 9a4 4 0 010 6" />
  </svg>
);
const SoundOffIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    <path d="M17 9l4 6M21 9l-4 6" />
  </svg>
);
const RULER_H = 15;

type DragState = {
  mode: "move" | "resize" | "trim";
  primaryId: string;
  anchors: { id: string; from: number; dur: number; startFrom: number }[];
  startX: number;
  startY: number;
  sceneDur: number;
};

/**
 * 场景小时间轴：只处理**当前场景内部**的元素。
 * 每个元素独占一行（图层轨道），同一时间点的元素不会互相盖住。
 *  - 拖动块改起点、右边缘拉伸改时长；拖动期间直接改 DOM，不触发 React 重渲染
 *  - 拖动轨道头上下排序 = 调整图层层级
 *  - Shift/Ctrl 加选、空白框选、多选整组拖动、吸附、分割元素
 */
export const SceneTimeline: React.FC<{ playerRef: React.RefObject<PlayerRef | null> }> = ({
  playerRef,
}) => {
  const project = useDoc((s) => s.project);
  const selectedId = useDoc((s) => s.selectedId);
  const selection = useDoc((s) => s.selection);
  const setSelection = useDoc((s) => s.setSelection);
  const apply = useDoc((s) => s.apply);

  const [frame, setFrame] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; x1: number } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [ppf, setPpf] = useState(PX_PER_FRAME);
  const [splitElTarget, setSplitElTarget] = useState<{ elementId: string; at: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    elementId: string;
    frame: number;
  } | null>(null);
  const durRef = useRef(1);
  const [dragHeadId, setDragHeadId] = useState<string | null>(null);
  /**
   * 竖直拖动块改层级（不必去拖左边的轨道头）。
   * `to` = 目标行号（按当前显示顺序），拖动中直接用它重排 `displayRows` 做实时预览，
   * 松手才发 op 落库（一次拖动 = 一步撤销）。
   */
  const [layerDrag, setLayerDrag] = useState<{ id: string; to: number } | null>(null);
  const layerDragRef = useRef<{ id: string; to: number } | null>(null);

  const lanesRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef(new Map<string, HTMLDivElement>());
  const snapRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<Record<string, { from: number; dur: number; startFrom?: number }>>({});
  /** 元素 id → 素材总长（帧）；右边缘拉伸不能超过它，否则后面是空白/静音 */
  const mediaDurRef = useRef<Record<string, number>>({});

  // 帧更新用 Player 的 frameupdate 事件（seek/播放都会派发）：rAF 在页面不可见时会被暂停
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;
    const onFrame = (data: { detail: { frame: number } }) => {
      const f = data.detail?.frame;
      if (typeof f === "number") setFrame(f);
    };
    const bind = () => {
      if (disposed) return;
      const p = playerRef.current;
      if (!p) {
        setTimeout(bind, 120);
        return;
      }
      const now = p.getCurrentFrame?.();
      if (typeof now === "number") setFrame(now);
      p.addEventListener("frameupdate", onFrame);
      cleanup = () => p.removeEventListener("frameupdate", onFrame);
    };
    bind();
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [playerRef]);

  const idx = project && selectedId ? project.scenes.findIndex((s) => s.id === selectedId) : -1;
  const scene = idx >= 0 ? project!.scenes[idx] : null;
  durRef.current = scene?.durationInFrames ?? 1;
  const sceneStart = useMemo(
    () => (project && idx >= 0 ? (sceneSpans(project.scenes)[idx]?.start ?? 0) : 0),
    [project, idx],
  );

  const sceneDur = scene?.durationInFrames ?? 1;

  // 音视频元素：量一次素材总长（按元素 id 缓存，不落库）
  useEffect(() => {
    for (const el of scene?.elements ?? []) {
      if (
        (el.kind === "audio" || el.kind === "video") &&
        el.src &&
        !mediaDurRef.current[el.id]
      ) {
        void framesForAsset(el.src, useDoc.getState().project?.fps ?? 30).then((frames) => {
          if (frames) mediaDurRef.current[el.id] = frames;
        });
      }
    }
  }, [scene?.elements]);
  const local = Math.min(sceneDur - 1, Math.max(0, frame - sceneStart));
  const els = scene?.elements ?? [];
  const selectedIds = useMemo(
    () => selection.filter((id) => id.startsWith("ov:")).map((id) => id.slice(3)),
    [selection],
  );

  /** 显示顺序：z 大的在上（和画布层级一致） */
  const rows = useMemo(() => [...els].sort((a, b) => b.z - a.z), [els]);
  /** 拖动中算目标行号要用「拖动前」的顺序，不能跟着实时预览一起变 */
  const rowsRef = useRef<OverlayElement[]>([]);
  rowsRef.current = rows;

  /** 层级拖动中的实时预览顺序：被拖的块直接在列表里换位置 */
  const displayRows = useMemo(() => {
    if (!layerDrag) return rows;
    const ids = rows.map((r) => r.id);
    const from = ids.indexOf(layerDrag.id);
    if (from < 0) return rows;
    const to = Math.max(0, Math.min(ids.length - 1, layerDrag.to));
    if (from === to) return rows;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)!).filter(Boolean);
  }, [rows, layerDrag]);

  const allElsHidden = els.length > 0 && els.every((e) => e.hidden);
  const sceneAudios = els.filter((e) => e.kind === "audio" || e.kind === "video");
  const allAudioMuted = sceneAudios.length > 0 && sceneAudios.every((e) => e.muted);
  const toggleAllHidden = () => {
    if (!scene) return;
    const next = !allElsHidden;
    void apply(
      els.map((e) => ({
        op: "update_element" as const,
        sceneId: scene.id,
        elementId: e.id,
        patch: { hidden: next },
      })),
    );
  };
  const toggleAllMuted = () => {
    if (!scene) return;
    const next = !allAudioMuted;
    void apply(
      sceneAudios.map((e) => ({
        op: "update_element" as const,
        sceneId: scene.id,
        elementId: e.id,
        patch: { muted: next },
      })),
    );
  };

  /** 素材从左侧拖到小时间轴：落到哪个帧，就从哪个帧开始；时长按素材真实时长 */
  const onDropLibrary = async (e: React.DragEvent) => {
    const libId =
      e.dataTransfer.getData("text/x-element") || e.dataTransfer.getData("text/plain");
    if (!libId || !scene) return;
    e.preventDefault();
    e.stopPropagation();
    const lanes = lanesRef.current;
    if (!lanes) return;
    const r = lanes.getBoundingClientRect();
    const frame = Math.max(
      0,
      Math.min(scene.durationInFrames - 1, Math.round((e.clientX - r.left) / ppf)),
    );
    let base: any = null;
    let asset: { duration?: number } | undefined;
    if (isAssetLibraryId(libId)) {
      asset = useDoc.getState().assets.find((a) => a.id === assetIdOf(libId));
      if (!asset) return;
      base = assetToElement(asset as never, undefined, fps);
    } else {
      base = elementFromLibrary(libId, { x: 50, y: 52 });
    }
    if (!base) return;
    // 音频/视频没带时长（旧素材或没量过）→ 现问服务端要真实时长
    if ((base.kind === "audio" || base.kind === "video") && !base.durationInFrames) {
      const frames = await framesForAsset(base.src as string, fps, asset?.duration);
      if (frames) base = { ...base, durationInFrames: frames };
    }
    const id = `el_${(globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 8)}`;
    const isAudio = base.kind === "audio";
    void apply([
      {
        op: "add_element",
        sceneId: scene.id,
        element: {
          ...base,
          id,
          from: frame,
          // 音频/视频有真实时长就用它；没有就给默认（音频到场景结尾，其它 3 秒）
          ...(base.durationInFrames
            ? {}
            : isAudio
              ? {}
              : { durationInFrames: Math.min(90, scene.durationInFrames - frame) }),
        },
      },
    ]);
    setSelection([`ov:${id}`]);
  };

  const elementEnd = (e: OverlayElement) =>
    (e.from ?? 0) + (e.durationInFrames ?? sceneDur - (e.from ?? 0));

  const seekLocal = (clientX: number) => {
    const el = lanesRef.current;
    if (!el || !scene) return;
    const r = el.getBoundingClientRect();
    const f = Math.round((clientX - r.left) / ppf);
    playerRef.current?.seekTo(sceneStart + Math.min(sceneDur - 1, Math.max(0, f)));
  };

  /** 拖动 / 拉伸：直接改 DOM，不 setState，保证顺滑 */
  useEffect(() => {
    if (!drag) return;
    const primary = drag.anchors.find((a) => a.id === drag.primaryId);
    if (!primary) return;

    /**
     * 手势意图判定：横向 = 改时间，纵向 = 改层级。
     * 只有「单选 + mode=move」才可能切到改层级；拉伸/裁头永远是横向。
     * 定下来之后就只往一个方向走，但允许「改层级 → 退回改时间」（判错时不能卡住）。
     * 纵向要超过 0.9 行高、且明显比横向大（1.4 倍）才认——横拖时手抖几十像素很常见。
     */
    let axis: "none" | "time" | "layer" =
      drag.mode === "move" && drag.anchors.length === 1 ? "none" : "time";
    /** 层级判定用的行区间，进入 layer 模式时量一次（不每帧读 rect） */
    let laneRect: DOMRect | null = null;

    const applyBox = (id: string, from: number, dur: number) => {
      const node = blockRefs.current.get(id);
      if (!node) return;
      node.style.left = `${from * ppf}px`;
      node.style.width = `${Math.max(18, dur * ppf)}px`;
      const t = node.querySelector(".stl-block-time");
      if (t) t.textContent = `${from}f`;
    };

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (axis === "none") {
        const adx = Math.abs(dx);
        const ady = Math.abs(dy);
        if (ady > ROW_H * 0.9 && ady > adx * 1.4) {
          axis = "layer";
          // 判定前可能已走了一两帧横向预览，先把块还原成真实位置，别留下错位
          applyBox(primary.id, primary.from, primary.dur);
          previewRef.current = {};
          laneRect = lanesRef.current?.getBoundingClientRect() ?? null;
          if (snapRef.current) snapRef.current.style.display = "none";
        } else if (adx > 8) {
          axis = "time";
        }
      }
      if (axis === "layer") {
        // 判错了（其实是想左右挪时间）：横向明显压过纵向就退回「改时间」，
        // 否则用户一开始手往上飘一下，整段拖动就卡在改层级上不动了
        if (Math.abs(dx) > Math.abs(dy) * 1.5 + 30) {
          axis = "time";
          layerDragRef.current = null;
          setLayerDrag(null);
        } else {
          const n = rowsRef.current.length;
          if (!laneRect || !n) return;
          const raw = Math.floor((e.clientY - laneRect.top - RULER_H) / ROW_H);
          const to = Math.max(0, Math.min(n - 1, raw));
          if (layerDragRef.current?.to !== to || layerDragRef.current?.id !== drag.primaryId) {
            layerDragRef.current = { id: drag.primaryId, to };
            setLayerDrag(layerDragRef.current);
          }
          return;
        }
      }
      const deltaFrames = Math.round(dx / ppf);
      const exclude = new Set(drag.anchors.map((a) => a.id));
      const points = [0, drag.sceneDur, local];
      for (const el of els) {
        if (exclude.has(el.id)) continue;
        points.push(el.from ?? 0, elementEnd(el));
      }
      const tol = Math.max(2, SNAP_PX / ppf);

      const next: Record<string, { from: number; dur: number; startFrom?: number }> = {};
      let snappedAt: number | null = null;

      if (drag.mode === "move") {
        let targetFrom = primary.from + deltaFrames;
        let bestDist = tol;
        for (const p of points) {
          const d = Math.abs(targetFrom - p);
          if (d < bestDist) {
            bestDist = d;
            targetFrom = p;
            snappedAt = p;
          }
        }
        const realDelta = targetFrom - primary.from;
        for (const a of drag.anchors) {
          const from = Math.min(Math.max(0, drag.sceneDur - 1), Math.max(0, a.from + realDelta));
          const dur = Math.min(a.dur, drag.sceneDur - from);
          next[a.id] = { from, dur };
          applyBox(a.id, from, dur);
        }
      } else if (drag.mode === "trim") {
        // 裁头：把窗口左端往右拖。
        // 窗口右端固定不动，左端右移 → 时长变短；素材同步跳过同样的帧数（startFrom），
        // 这样窗口里看到的始终是素材的同一段内容（旁白开头的空白就这么裁掉了）。
        const rawDelta = deltaFrames;
        // 不能往回裁超过素材本身已跳过的量（startFrom 归零就是素材第 0 帧）
        const minDelta = -primary.startFrom;
        let d = Math.max(rawDelta, minDelta);
        // 时长不能短于 MIN_DUR
        d = Math.min(d, primary.dur - MIN_DUR);
        // 左端不能跑到 0 之前（from 增加量至少 -from）
        d = Math.max(d, -primary.from);
        let snappedFrom = primary.from + d;
        let bestDist = tol;
        for (const p of points) {
          const dist = Math.abs(snappedFrom - p);
          if (dist < bestDist) {
            bestDist = dist;
            snappedFrom = p;
            snappedAt = p;
          }
        }
        const realD = snappedFrom - primary.from;
        const dur = Math.max(MIN_DUR, primary.dur - realD);
        next[primary.id] = {
          from: primary.from + realD,
          dur,
          startFrom: primary.startFrom + realD,
        };
        applyBox(primary.id, primary.from + realD, dur);
      } else {
        const end = primary.from + primary.dur + deltaFrames;
        let snappedEnd = end;
        let bestDist = tol;
        for (const p of points) {
          const d = Math.abs(end - p);
          if (d < bestDist) {
            bestDist = d;
            snappedEnd = p;
            snappedAt = p;
          }
        }
        const mediaMax = mediaDurRef.current[primary.id];
      const cap = mediaMax
        ? Math.max(MIN_DUR, mediaMax - primary.startFrom)
        : Number.POSITIVE_INFINITY;
      // 音视频不能拉得比素材本身还长（后面会空白/静音）
      const dur = Math.max(
        MIN_DUR,
        Math.min(cap, drag.sceneDur - primary.from, snappedEnd - primary.from),
      );
        next[primary.id] = { from: primary.from, dur };
        applyBox(primary.id, primary.from, dur);
      }

      if (snapRef.current) {
        if (snappedAt != null) {
          snapRef.current.style.display = "block";
          snapRef.current.style.left = `${snappedAt * ppf}px`;
        } else {
          snapRef.current.style.display = "none";
        }
      }
      previewRef.current = next;
    };

    const onUp = async () => {
      const next = previewRef.current;
      const sceneIdNow = scene?.id;
      const layer = layerDragRef.current;
      previewRef.current = {};
      layerDragRef.current = null;
      setDrag(null);
      setLayerDrag(null);
      if (snapRef.current) snapRef.current.style.display = "none";
      // 竖直拖动 = 改层级：松手才落库（一次拖动 = 一步撤销）
      if (layer) {
        if (!sceneIdNow) return;
        const ids = rowsRef.current.map((r) => r.id);
        const from = ids.indexOf(layer.id);
        const to = Math.max(0, Math.min(ids.length - 1, layer.to));
        if (from < 0 || from === to) return;
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        const n = ids.length;
        await apply(
          ids.map((id, i) => ({
            op: "update_element" as const,
            sceneId: sceneIdNow,
            elementId: id,
            // 从上到下 z 依次递减：列表最上面 = 画面最上层
            patch: { z: n - 1 - i },
          })),
        );
        return;
      }
      if (!next || !sceneIdNow || !Object.keys(next).length) return;
      const ops = Object.entries(next).map(([elementId, p]) => ({
        op: "update_element" as const,
        sceneId: sceneIdNow,
        elementId,
        patch: {
          from: p.from,
          durationInFrames: p.dur,
          ...(p.startFrom !== undefined ? { startFrom: p.startFrom } : {}),
        },
      }));
      await apply(ops);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, scene, apply, local, els, ppf]);

  // 滚轮：Ctrl 缩放、Shift 左右滚动、普通滚轮上下滚动
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const fit = el.clientWidth / Math.max(1, durRef.current);
        const minPpf = Math.min(0.2, fit);
        setPpf((p) => Math.min(14, Math.max(minPpf, Number((p * factor).toFixed(3)))));
        return;
      }
      if (e.shiftKey) {
        const max = el.scrollWidth - el.clientWidth;
        if (max <= 0) return;
        e.preventDefault();
        el.scrollLeft = Math.max(0, Math.min(max, el.scrollLeft + e.deltaY));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scene?.id]);

  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (e: MouseEvent) => seekLocal(e.clientX);
    const onUp = () => setScrubbing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing, sceneDur, sceneStart, ppf]);

  /** 空白处：拖动 = 框选，点一下 = seek */
  useEffect(() => {
    if (!marquee) return;
    const onUp = (e: MouseEvent) => {
      const rect = lanesRef.current?.getBoundingClientRect();
      if (!rect) {
        setMarquee(null);
        return;
      }
      const moved = Math.abs(e.clientX - (marquee.x0 + rect.left));
      if (moved < 4) {
        seekLocal(e.clientX);
        setSelection([]);
      } else {
        const a = Math.min(marquee.x0, marquee.x1);
        const b = Math.max(marquee.x0, marquee.x1);
        const hit = els
          .filter((el) => {
            const left = (el.from ?? 0) * ppf;
            const right = elementEnd(el) * ppf;
            return right >= a && left <= b;
          })
          .map((el) => `ov:${el.id}`);
        setSelection(hit);
      }
      setMarquee(null);
    };
    const onMove = (e: MouseEvent) => {
      const rect = lanesRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMarquee((m) => (m ? { ...m, x1: e.clientX - rect.left } : m));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marquee, els, sceneDur]);

  if (!project || !scene) return null;

  const fps = project.fps;
  const localSec = (local / fps).toFixed(2);
  const laneWidth = Math.max(sceneDur * ppf, 120);
  const px = (v: number) => `${v * ppf}px`;

  const toggleSelect = (el: OverlayElement, additive: boolean) => {
    if (!additive) {
      setSelection([`ov:${el.id}`]);
      return;
    }
    const next = selectedIds.includes(el.id)
      ? selectedIds.filter((id) => id !== el.id)
      : [...selectedIds, el.id];
    setSelection(next.map((id) => `ov:${id}`));
  };

  /** 轨道头拖拽排序 = 调整层级：新顺序从上到下，z 依次 n-1 … 0 */
  const onDropHead = async (targetId: string) => {
    if (!scene || !dragHeadId || dragHeadId === targetId) return;
    const ids = rows.map((r) => r.id);
    const from = ids.indexOf(dragHeadId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    const n = ids.length;
    setDragHeadId(null);
    await apply(
      ids.map((id, i) => ({
        op: "update_element" as const,
        sceneId: scene.id,
        elementId: id,
        patch: { z: n - 1 - i },
      })),
    );
  };

  const canSplitEl =
    selectedIds.length === 1 &&
    (() => {
      const el = els.find((x) => x.id === selectedIds[0]);
      if (!el) return false;
      const from = el.from ?? 0;
      return local > from + MIN_DUR && local < elementEnd(el) - MIN_DUR;
    })();

  const splitElementAt = (el: OverlayElement, at: number) => {
    if (!scene) return;
    const from = el.from ?? 0;
    const end = elementEnd(el);
    const cut = Math.round(at);
    if (cut <= from + 2 || end - cut <= 2) {
      useDoc.getState().notify("分割点离元素边缘太近");
      return;
    }
    const newId = `el_${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36)).slice(0, 8)}`;
    void apply([
      {
        op: "update_element",
        sceneId: scene.id,
        elementId: el.id,
        patch: { durationInFrames: cut - from },
      },
      {
        op: "add_element",
        sceneId: scene.id,
        element: { ...el, id: newId, from: cut, durationInFrames: end - cut },
      },
    ]);
    setSplitElTarget(null);
  };

  const startDrag = (e: React.MouseEvent, el: OverlayElement, mode: "move" | "resize" | "trim") => {
    e.stopPropagation();
    if (mode === "move" && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      toggleSelect(el, true);
      return;
    }
    const groupIds =
      selectedIds.includes(el.id) && selectedIds.length > 1 ? selectedIds : [el.id];
    const anchors = groupIds
      .map((id) => els.find((x) => x.id === id))
      .filter((x): x is OverlayElement => !!x)
      .map((x) => ({
        id: x.id,
        from: x.from ?? 0,
        dur: x.durationInFrames ?? Math.max(MIN_DUR, sceneDur - (x.from ?? 0)),
        startFrom: x.startFrom ?? 0,
      }));
    setDrag({ mode, primaryId: el.id, anchors, startX: e.clientX, startY: e.clientY, sceneDur });
      setSelection(groupIds.map((id) => `ov:${id}`));
  };

  const startMarquee = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const rect = lanesRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMarquee({ x0: e.clientX - rect.left, x1: e.clientX - rect.left });
  };

  return (
    <div className="scene-tl" data-scrubbing={scrubbing ? "1" : "0"} data-layer-drag={layerDrag ? "1" : "0"}>
      <div className="scene-tl-head">
        <span className="stl-title">场景时间轴 · {scene.name}</span>
        <div className="stl-actions">
          <button
            className={`stl-btn stl-global ${allElsHidden ? "is-off" : ""}`}
            onClick={toggleAllHidden}
            disabled={!els.length}
            title={allElsHidden ? "显示本场景全部图层" : "隐藏本场景全部图层"}
          >
            {allElsHidden ? <EyeOffIcon /> : <EyeOnIcon />}
          </button>
          {sceneAudios.length ? (
            <button
              className={`stl-btn stl-global ${allAudioMuted ? "is-off" : ""}`}
              onClick={toggleAllMuted}
              title={allAudioMuted ? "打开本场景全部声音" : "静音本场景全部声音"}
            >
              {allAudioMuted ? <SoundOffIcon /> : <SoundOnIcon />}
            </button>
          ) : null}
          {splitElTarget ? (
            <span className="split-bar">
              分割位置 {(splitElTarget.at / fps).toFixed(2)}s
              <button
                className="split-bar-ok"
                onClick={() => {
                  const el = els.find((x) => x.id === splitElTarget.elementId);
                  if (el) splitElementAt(el, splitElTarget.at);
                }}
              >
                确认分割
              </button>
              <button className="split-bar-cancel" onClick={() => setSplitElTarget(null)}>
                取消
              </button>
            </span>
          ) : null}
          <span className="stl-meta">
            {els.length} 个元素 · {(sceneDur / fps).toFixed(1)}s · {localSec}s / {local}f
          </span>
        </div>
      </div>

      <div className="scene-tl-viewport">
        <div
          className="scene-tl-body"
          ref={bodyRef}
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("text/x-element")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={onDropLibrary}
        >
        <div className="scene-tl-heads" style={{ width: HEAD_W }}>
          <div className="stl-ruler-spacer" style={{ height: RULER_H }} />
          {displayRows.map((el) => {
            const active = selection.includes(`ov:${el.id}`);
            const lifting = layerDrag?.id === el.id;
            return (
              <div
                key={el.id}
                className={`stl-head ${active ? "is-active" : ""} ${lifting ? "is-lifting" : ""}`}
                style={{ height: ROW_H }}
                title={`${el.name}（拖动可调整图层层级）`}
                draggable
                onDragStart={() => setDragHeadId(el.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => void onDropHead(el.id)}
                onDragEnd={() => setDragHeadId(null)}
                onClick={(e) => toggleSelect(el, e.shiftKey || e.ctrlKey || e.metaKey)}
              >
                <span className="stl-head-grip">⋮⋮</span>
                <span className={`stl-head-name ${el.hidden ? "is-hidden" : ""}`}>{el.name}</span>
                <button
                  className={`stl-eye ${el.hidden ? "is-off" : ""}`}
                  title={el.hidden ? "显示这个图层" : "隐藏这个图层"}
                  onClick={(e) => {
                    e.stopPropagation();
                    void apply([
                      {
                        op: "update_element",
                        sceneId: scene.id,
                        elementId: el.id,
                        patch: { hidden: !el.hidden },
                      },
                    ]);
                  }}
                >
                  {el.hidden ? <EyeOffIcon /> : <EyeOnIcon />}
                </button>
                {el.kind === "audio" || el.kind === "video" ? (
                  <button
                    className={`stl-sound ${el.muted ? "is-off" : ""}`}
                    title={el.muted ? "打开声音" : "静音"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void apply([
                        {
                          op: "update_element",
                          sceneId: scene.id,
                          elementId: el.id,
                          patch: { muted: !el.muted },
                        },
                      ]);
                    }}
                  >
                    {el.muted ? <SoundOffIcon /> : <SoundOnIcon />}
                  </button>
                ) : null}
                <button
                  className="stl-head-x"
                  title="删除这个元素（可 Ctrl+Z 撤销）"
                  onClick={(e) => {
                    e.stopPropagation();
                    void apply([{ op: "remove_element", sceneId: scene.id, elementId: el.id }]);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        <div
          className="scene-tl-lanes"
          ref={lanesRef}
          style={{ width: laneWidth }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            // 点标尺/空白 = seek（块的 mousedown 会 stopPropagation）
            seekLocal(e.clientX);
            setSelection([]);
          }}
        >
          <div className="scene-tl-ruler" style={{ height: RULER_H }}>
            {[0, 0.25, 0.5, 0.75, 1].map((p) => (
              <span key={p} style={{ left: `${p * 100}%` }}>
                {((p * sceneDur) / fps).toFixed(1)}s
              </span>
            ))}
          </div>

          {displayRows.length ? (
            displayRows.map((el) => {
              const from = el.from ?? 0;
              const d = el.durationInFrames ?? Math.max(1, sceneDur - from);
              const active = selection.includes(`ov:${el.id}`);
              const lifting = layerDrag?.id === el.id;
              // 只有带素材的元素才能裁头（裁的是素材开头，不是窗口）
              const trimmable = el.kind === "audio" || el.kind === "video";
              const skip = el.startFrom ?? 0;
              return (
                <div
                  className="stl-lane"
                  key={el.id}
                  style={{ height: ROW_H }}
                  onMouseDown={startMarquee}
                >
                  <div
                    className={`stl-block ${active ? "is-active" : ""} ${lifting ? "is-lifting" : ""}`}
                    ref={(node) => {
                      if (node) blockRefs.current.set(el.id, node);
                      else blockRefs.current.delete(el.id);
                    }}
                    style={{ left: px(from), width: px(d) }}
                    title={
                      trimmable
                        ? `${el.name} · ${from}f 起 · ${(d / fps).toFixed(1)}s` +
                          (skip ? ` · 素材从第 ${skip}f 开始` : "") +
                          `（左右拖动改时间，上下拖动改层级，右边缘拉伸，左边缘裁掉素材开头）`
                        : `${el.name} · ${from}f 起 · ${(d / fps).toFixed(1)}s（左右拖动改时间，上下拖动改层级，右边缘拉伸）`
                    }
                    onMouseDown={(e) => startDrag(e, el, "move")}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const lanes = lanesRef.current;
                      if (!lanes) return;
                      const rect = lanes.getBoundingClientRect();
                      const frame = Math.round((e.clientX - rect.left) / ppf);
                      setCtxMenu({
                        x: e.clientX,
                        y: e.clientY,
                        elementId: el.id,
                        frame,
                      });
                    }}
                  >
                    <span className="stl-block-name">{el.name}</span>
                    <span className="stl-block-time">{from}f</span>
                    {trimmable ? (
                      <div
                        className="stl-handle stl-handle-left"
                        onMouseDown={(e) => startDrag(e, el, "trim")}
                        title="裁掉素材开头（窗口右端不动，素材同步后移）"
                      />
                    ) : null}
                    <div className="stl-handle" onMouseDown={(e) => startDrag(e, el, "resize")} />
                    {splitElTarget && splitElTarget.elementId === el.id ? (
                      <div
                        className="split-line stl-split-line"
                        style={{ left: (splitElTarget.at - from) * ppf }}
                        title="拖动调整分割位置，点「分割」确认"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const lanes = lanesRef.current;
                          if (!lanes) return;
                          const rect = lanes.getBoundingClientRect();
                          const onMove = (ev: MouseEvent) => {
                            const at = Math.round((ev.clientX - rect.left) / ppf);
                            setSplitElTarget({
                              elementId: el.id,
                              at: Math.max(from + 2, Math.min(elementEnd(el) - 2, at)),
                            });
                          };
                          const onUp = () => {
                            window.removeEventListener("mousemove", onMove);
                            window.removeEventListener("mouseup", onUp);
                          };
                          window.addEventListener("mousemove", onMove);
                          window.addEventListener("mouseup", onUp);
                        }}
                      >
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="stl-lane" style={{ height: ROW_H }}>
              <span className="stl-empty">这个场景还没有元素——把素材拖到画面上，就会出现在这里</span>
            </div>
          )}

          {marquee ? (
            <div
              className="stl-marquee"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                width: Math.abs(marquee.x1 - marquee.x0),
              }}
            />
          ) : null}

          <div ref={snapRef} className="stl-snap" style={{ display: "none", top: 0 }} />

        </div>
        </div>

        {/* 播放头固定在可视层（不随内容纵向滚动），横向跟着时间位置走 */}
        <div
          className="stl-playhead-overlay"
          style={{ left: HEAD_W + local * ppf - scrollLeft }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setScrubbing(true);
            seekLocal(e.clientX);
          }}
          title="拖动定位"
        />
        {layerDrag ? (
          <div className="stl-layer-hint">
            第 {rowsRef.current.length - layerDrag.to} 层 / 共 {rowsRef.current.length} 层
          </div>
        ) : null}
      {ctxMenu ? (
        <CtxMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={[
            {
              label: "分割",
              onClick: () => {
                const el = els.find((x) => x.id === ctxMenu.elementId);
                if (!el) return;
                const from0 = el.from ?? 0;
                const end0 = elementEnd(el);
                setSplitElTarget({
                  elementId: el.id,
                  at: Math.max(from0 + 2, Math.min(end0 - 2, ctxMenu.frame)),
                });
              },
            },
            {
              label: "复制元素",
              onClick: () => {
                const el = els.find((x) => x.id === ctxMenu.elementId);
                if (!el || !scene) return;
                const id = `el_${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36)).slice(0, 8)}`;
                void apply([
                  { op: "add_element", sceneId: scene.id, element: { ...el, id } },
                ]);
              },
            },
            {
              label: "显示 / 隐藏",
              onClick: () => {
                const el = els.find((x) => x.id === ctxMenu.elementId);
                if (!el || !scene) return;
                void apply([
                  {
                    op: "update_element",
                    sceneId: scene.id,
                    elementId: el.id,
                    patch: { hidden: !el.hidden },
                  },
                ]);
              },
            },
            {
              label: "删除元素",
              onClick: () => {
                const el = els.find((x) => x.id === ctxMenu.elementId);
                if (!el || !scene) return;
                void apply([
                  { op: "remove_element", sceneId: scene.id, elementId: el.id },
                ]);
              },
            },
          ]}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
      </div>
    </div>
  );
};
