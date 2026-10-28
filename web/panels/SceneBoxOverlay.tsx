import React, { useEffect, useMemo, useRef, useState } from "react";
import { sceneBoxRegistry } from "../../src/scenes/ui";
import { sceneSpans } from "@shared/schema";
import type { SceneBox } from "@shared/sceneBox";
import { useDoc } from "../store";

/**
 * 画布上的「画中画框」：直接在预览里拖小窗、拖角点缩放。
 *
 * 为什么单独一个组件，而不是塞进 EditOverlay：
 *  - EditOverlay 的盒子是**元素**（写 transforms / elements），画中画框是**整幕**（写 scene.box），
 *    两者坐标语义和落库字段都不一样，混在一个手势机里迟早互相污染；
 *  - 元素编辑要能点进小窗内部改字，所以**选中的小窗只让标题条和角点可点**，
 *    非选中的小窗整块可点（它上面的元素本来也不归当前编辑）。
 *
 * 拖动过程只改外层草稿（Player 的 inputProps），松手才发一条 set_scene_box = 一步撤销。
 */

type Frame = { id: string; left: number; top: number; width: number; height: number };

type Props = {
  canvasRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  /** 画布逻辑尺寸（未缩放），算百分比用 */
  canvasW: number;
  canvasH: number;
  selectedId: string | null;
  /** 播放中才需要每帧跟随；暂停时画面不动，按需测一次就够 */
  playing: boolean;
  onSelectScene: (id: string) => void;
  onPreview: (sceneId: string, box: Partial<SceneBox>) => void;
  onCommit: (sceneId: string, box: Partial<SceneBox>) => void;
};

type Drag = {
  sceneId: string;
  mode: "move" | "scale";
  startX: number;
  startY: number;
  base: SceneBox;
  /** 拖动过程中算出的新值（松手时用它落库，别去读 store —— 那时 store 还是旧值） */
  next: Partial<SceneBox>;
  /** 缩放以框中心为锚 */
  cx: number;
  cy: number;
  startDist: number;
};

/** 拖动时把 x/y 吸到画面中线，省得"差一点点居中"（阈值：画面 0.8%） */
const snapCenter = (v: number) => (Math.abs(v - 50) < 0.8 ? 50 : v);

export const SceneBoxOverlay: React.FC<Props> = ({
  canvasRef,
  zoom,
  canvasW,
  canvasH,
  selectedId,
  playing,
  onSelectScene,
  onPreview,
  onCommit,
}) => {
  const project = useDoc((s) => s.project);
  const [frames, setFrames] = useState<Frame[]>([]);
  const lastRef = useRef<Frame[]>([]);
  const dragRef = useRef<Drag | null>(null);
  /** 拖动中合帧用：一次 pointermove 只测一次 */
  const measureRafRef = useRef(0);

  /**
   * 有画中画的场景（id 串）。**没有画中画就一次都不测。**
   *
   * 这里原来是常驻 `requestAnimationFrame` 轮询：就算整个工程没有一个画中画，
   * 也每帧对着 registry 里**每一个场景**调 `getBoundingClientRect()`。
   * 那是强制同步 layout，60fps × N 个场景，叠在属性面板的每次重渲染上，
   * 表现就是"改个字号整个页面卡住"。现在改成按需测量：
   *  - 暂停时：项目改动 / 缩放 / 切场景各测一次就够（DOM 不会自己动）
   *  - 播放中：每帧跟随（元素在动，必须跟）
   *  - 拖动中：pointermove 合帧测一次
   */
  const pipKey = useMemo(
    () =>
      (project?.scenes ?? [])
        .filter((s) => s.box)
        .map((s) => s.id)
        .join(","),
    [project],
  );

  /** 当前有画中画的场景 id 集合：measure 只收这些，免得把主画面也当成框 */
  const pipSetRef = useRef<Set<string>>(new Set());
  pipSetRef.current = new Set(pipKey ? pipKey.split(",") : []);

  /** 量一次并把结果推给 React（变化 < 0.5px 就不 setState，避免无意义重渲染） */
  const measureRef = useRef<() => void>(() => {});
  measureRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pipSet = pipSetRef.current;
    if (!pipSet.size) {
      if (lastRef.current.length) {
        lastRef.current = [];
        setFrames([]);
      }
      return;
    }
    const base = canvas.getBoundingClientRect();
    const next: Frame[] = [];
    for (const [key, node] of sceneBoxRegistry) {
      if (!key.startsWith("sc:")) continue;
      const id = key.slice(3);
      if (!pipSet.has(id)) continue;
      if (!node.isConnected) continue;
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      next.push({
        id,
        left: (r.left - base.left) / zoom,
        top: (r.top - base.top) / zoom,
        width: r.width / zoom,
        height: r.height / zoom,
      });
    }
    const last = lastRef.current;
    const changed =
      next.length !== last.length ||
      next.some((f, i) => {
        const p = last[i];
        return (
          !p ||
          p.id !== f.id ||
          Math.abs(p.left - f.left) > 0.5 ||
          Math.abs(p.top - f.top) > 0.5 ||
          Math.abs(p.width - f.width) > 0.5 ||
          Math.abs(p.height - f.height) > 0.5
        );
      });
    if (changed) {
      lastRef.current = next;
      setFrames(next);
    }
  };

  // 暂停时：项目改动 / 缩放 / 换场景 → 测一次。
  // 例外是「刚变成画中画」：那一刻 Player 还没把新容器渲染出来，registry 里暂时没有它，
  // 所以这里**跟着测到框齐为止**（最多 1 秒），齐了就立刻停 —— 暂停时不会持续轮询。
  useEffect(() => {
    if (!pipKey) {
      lastRef.current = [];
      setFrames((prev) => (prev.length ? [] : prev));
      return;
    }
    const need = pipKey.split(",").length;
    let alive = true;
    let raf = 0;
    const t0 = performance.now();
    const tick = () => {
      if (!alive) return;
      measureRef.current();
      // 框都量到了，或者已经等了 1 秒（Player 那边可能还没挂上），就不再跟
      if (lastRef.current.length >= need || performance.now() - t0 > 1000) return;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [pipKey, zoom, selectedId, project?.rev]);

  // 播放中：每帧跟随（元素/画面在动，位置只能实测）
  useEffect(() => {
    if (!pipKey || !playing) return;
    let alive = true;
    let raf = 0;
    const tick = () => {
      if (!alive) return;
      measureRef.current();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [pipKey, playing]);

  /** 手势：移动 / 角点缩放 */
  const cbRef = useRef({ onPreview, onCommit });
  cbRef.current = { onPreview, onCommit };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      if (d.mode === "move") {
        const dx = ((e.clientX - d.startX) / zoom / Math.max(1, canvasW)) * 100;
        const dy = ((e.clientY - d.startY) / zoom / Math.max(1, canvasH)) * 100;
        d.next = {
          x: snapCenter(Number((d.base.x + dx).toFixed(2))),
          y: snapCenter(Number((d.base.y + dy).toFixed(2))),
        };
      } else {
        // 缩放：离框中心越远越大，比例跟手（不做自由长宽比，画中画要保持画面比例）
        const dist = Math.hypot(e.clientX - d.cx, e.clientY - d.cy);
        const k = dist / Math.max(1, d.startDist);
        d.next = { scale: Math.min(1, Math.max(0.05, Number((d.base.scale * k).toFixed(3)))) };
      }
      cbRef.current.onPreview(d.sceneId, d.next);
      // 草稿已经进了 Player 的 inputProps，等这一帧渲染完再量框的位置
      if (!measureRafRef.current) {
        measureRafRef.current = requestAnimationFrame(() => {
          measureRafRef.current = 0;
          measureRef.current();
        });
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      document.body.classList.remove("is-pip-dragging");
      if (!d) return;
      const next = d.next;
      const moved =
        Math.abs((next.x ?? d.base.x) - d.base.x) > 0.01 ||
        Math.abs((next.y ?? d.base.y) - d.base.y) > 0.01 ||
        Math.abs((next.scale ?? d.base.scale) - d.base.scale) > 0.001;
      if (!moved) return; // 点一下选中而已，不写库
      cbRef.current.onCommit(d.sceneId, next);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [zoom, canvasW, canvasH]);

  if (!project || !frames.length) return null;

  // 一次算好：每个 frame 各调一次 sceneSpans 是 O(n²)，场景一多就白烧
  const spans = sceneSpans(project.scenes);
  const sceneById = new Map(project.scenes.map((s) => [s.id, s]));

  const start = (frame: Frame, mode: Drag["mode"], box: SceneBox, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelectScene(frame.id);
    dragRef.current = {
      sceneId: frame.id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      base: { ...box },
      next: {},
      cx: e.clientX,
      cy: e.clientY,
      startDist: 1,
    };
    // 缩放需要从**框中心**量距离，不是从指针起点
    if (mode === "scale") {
      const rect = (e.currentTarget as HTMLElement).closest(".pip-frame")?.getBoundingClientRect();
      if (rect) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        dragRef.current.cx = cx;
        dragRef.current.cy = cy;
        dragRef.current.startDist = Math.max(1, Math.hypot(e.clientX - cx, e.clientY - cy));
      }
    }
    document.body.classList.add("is-pip-dragging");
  };

  return (
    <>
      {frames.map((frame) => {
        const scene = sceneById.get(frame.id);
        if (!scene?.box) return null;
        const box = scene.box;
        const selected = selectedId === scene.id;
        const span = spans.find((s) => s.id === scene.id);
        return (
          <div
            key={frame.id}
            className={`pip-frame ${selected ? "is-selected" : "is-idle"}`}
            data-pip-scene={scene.id}
            style={{
              left: frame.left,
              top: frame.top,
              width: frame.width,
              height: frame.height,
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              // 选中的小窗：整块不接手势，让里面的元素可以点（移动靠顶部标题条）
              if (selected && !(e.target as HTMLElement).closest(".pip-bar")) return;
              start(frame, "move", box, e);
            }}
            title={selected ? "拖动标题条移动小窗，拖四角缩放" : `${scene.name}（点击选中）`}
          >
            <div className="pip-bar">
              <span className="pip-bar-label">画中画 · 轨 {span?.track ?? 1}</span>
              <span className="pip-bar-scale">{Math.round(box.scale * 100)}%</span>
            </div>
            {selected
              ? (["nw", "ne", "sw", "se"] as const).map((c) => (
                  <div
                    key={c}
                    className={`pip-handle ${c}`}
                    onPointerDown={(e) => start(frame, "scale", box, e)}
                  />
                ))
              : null}
          </div>
        );
      })}
    </>
  );
};
